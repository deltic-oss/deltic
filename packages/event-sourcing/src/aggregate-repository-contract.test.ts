import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import type {AnyMessageFrom, MessageRepository} from '@deltic/messaging';
import {collect} from '@deltic/messaging/helpers';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {MessageRepositoryUsingPg} from '@deltic/messaging/pg/message-repository';
import {NoopTransactionManager} from '@deltic/transaction-manager';
import {pgTestCredentials} from '../../pg-credentials.js';
import {EventSourcedAggregateRepository} from './index.js';
import {Order, type OrderStream} from './order.stubs.js';

const guardedTable = 'test__es_order_events';
const unguardedTable = 'test__es_order_events_unguarded';

let pgPool: Pool;

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);

    /**
     * The events table an event-sourced aggregate needs: the unique constraint over
     * the aggregate and its version is what turns two competing writes into one
     * winner and one loser.
     */
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${guardedTable} (
            id BIGSERIAL PRIMARY KEY,
            aggregate_root_id UUID NOT NULL,
            version BIGINT NOT NULL,
            event_type VARCHAR(255) NOT NULL,
            payload JSONB NOT NULL,
            UNIQUE (aggregate_root_id, version)
        );
    `);

    /**
     * The same table without that constraint, which is the shape every table
     * definition in this repository and in the documentation uses.
     */
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${unguardedTable} (
            id BIGSERIAL PRIMARY KEY,
            aggregate_root_id UUID NOT NULL,
            version BIGINT NOT NULL,
            event_type VARCHAR(255) NOT NULL,
            payload JSONB NOT NULL
        );
    `);
});

afterAll(async () => {
    await pgPool.query(`DROP TABLE IF EXISTS ${guardedTable}`);
    await pgPool.query(`DROP TABLE IF EXISTS ${unguardedTable}`);
    await pgPool.end();
});

const eventOfUnknownType = (id: string, version: number): AnyMessageFrom<OrderStream> =>
    ({
        type: 'an_event_from_the_future',
        payload: {reason: 'a newer writer is deployed alongside this reader'},
        headers: {aggregate_root_id: id, aggregate_root_version: version},
    }) as unknown as AnyMessageFrom<OrderStream>;

interface EventStoreUnderTest {
    create(): MessageRepository<OrderStream>;
    cleanup(): Promise<void>;
}

const memoryEventStore = (): EventStoreUnderTest => {
    return {
        create: () => new MessageRepositoryUsingMemory<OrderStream>(),
        cleanup: async () => {},
    };
};

const postgresEventStore = (table: string = guardedTable): EventStoreUnderTest => {
    let asyncPool: AsyncPgPool | undefined;

    return {
        create: () => {
            asyncPool = new AsyncPgPool(pgPool);

            return new MessageRepositoryUsingPg<OrderStream>(asyncPool, table);
        },
        cleanup: async () => {
            await asyncPool?.flush();
            asyncPool = undefined;
            await pgPool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY`);
        },
    };
};

describe.each([
    ['MessageRepositoryUsingMemory', memoryEventStore()],
    ['MessageRepositoryUsingPg', postgresEventStore()],
])('an event-sourced aggregate repository backed by %s', (_name, eventStore) => {
    let events: MessageRepository<OrderStream>;
    let repository: EventSourcedAggregateRepository<OrderStream>;
    let orderId: string;

    beforeEach(() => {
        orderId = uuid.v7();
        events = eventStore.create();
        repository = new EventSourcedAggregateRepository<OrderStream>(
            Order,
            events,
            undefined,
            undefined,
            new NoopTransactionManager(),
        );
    });

    afterEach(async () => {
        await eventStore.cleanup();
    });

    describe('an aggregate that does not exist yet', () => {
        test('is reconstituted as an empty aggregate at version zero', async () => {
            const order = await repository.retrieve(orderId);

            expect(order.aggregateRootVersion()).toEqual(0);
            expect(order.currentState()).toEqual({customer: undefined, total: 0, items: {}, shipped: false});
        });

        test('starts a brand new stream at version one', async () => {
            const order = await repository.retrieve(orderId);
            order.placeFor('frank', 100);

            await repository.persist(order);

            const stored = await collect(events.retrieveAllForAggregate(orderId));
            expect(stored).toHaveLength(1);
            expect(stored[0].headers['aggregate_root_version']).toEqual(1);
        });

        test('writes nothing when no decision was recorded', async () => {
            const order = await repository.retrieve(orderId);

            await repository.persist(order);

            expect(await collect(events.retrieveAllForAggregate(orderId))).toHaveLength(0);
        });
    });

    describe('version integrity', () => {
        test('numbers events uniquely, gaplessly and strictly monotonically across writes', async () => {
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            await repository.persist(order);

            const second = await repository.retrieve(orderId);
            second.addItem('sku-2', 3);
            second.addItem('sku-3', 1);
            await repository.persist(second);

            const third = await repository.retrieve(orderId);
            third.ship('postnl', 'track-1');
            await repository.persist(third);

            const versions = (await collect(events.retrieveAllForAggregate(orderId))).map(
                message => message.headers['aggregate_root_version'],
            );
            expect(versions).toEqual([1, 2, 3, 4, 5]);
            expect(new Set(versions).size).toEqual(versions.length);
        });

        test('reports the version that a subsequent read observes', async () => {
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            await repository.persist(order);

            const reloaded = await repository.retrieve(orderId);

            expect(reloaded.aggregateRootVersion()).toEqual(order.aggregateRootVersion());
            expect(reloaded.aggregateRootVersion()).toEqual(2);
        });

        test('keeps the streams of separate aggregates apart', async () => {
            const otherOrderId = uuid.v7();
            await repository.persist(Order.place(orderId, 'frank', 100));
            const other = Order.place(otherOrderId, 'renske', 50);
            other.addItem('sku-1', 1);
            await repository.persist(other);

            const first = await repository.retrieve(orderId);
            const second = await repository.retrieve(otherOrderId);

            expect(first.aggregateRootVersion()).toEqual(1);
            expect(first.currentState().customer).toEqual('frank');
            expect(second.aggregateRootVersion()).toEqual(2);
            expect(second.currentState().customer).toEqual('renske');
        });
    });

    describe('replaying a stream', () => {
        test('reproduces the state of the aggregate that recorded the events', async () => {
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 2);
            order.addItem('sku-1', 3);
            order.ship('postnl', 'track-1');
            const stateBeforeWriting = order.currentState();
            await repository.persist(order);

            const reloaded = await repository.retrieve(orderId);

            expect(reloaded.currentState()).toEqual(stateBeforeWriting);
            expect(reloaded.currentState()).toEqual({
                customer: 'frank',
                total: 100,
                items: {'sku-1': 5},
                shipped: true,
            });
        });

        test('reconstitutes the aggregate as it was at an earlier version', async () => {
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 2);
            order.ship('postnl', 'track-1');
            await repository.persist(order);

            const beforeShipping = await repository.retrieveAtVersion(orderId, 2);

            expect(beforeShipping.aggregateRootVersion()).toEqual(2);
            expect(beforeShipping.currentState().shipped).toBe(false);
            expect(beforeShipping.currentState().items).toEqual({'sku-1': 2});
        });

        test('skips an event type it has no handler for and keeps the version sequence', async () => {
            await repository.persist(Order.place(orderId, 'frank', 100));
            await events.persist(orderId, [eventOfUnknownType(orderId, 2)]);

            const reloaded = await repository.retrieve(orderId);

            expect(reloaded.aggregateRootVersion()).toEqual(2);
            expect(reloaded.currentState().customer).toEqual('frank');

            reloaded.addItem('sku-1', 1);
            expect(reloaded.releaseEvents()[0].headers['aggregate_root_version']).toEqual(3);
        });
    });

});

describe('appending events concurrently', () => {
    const createRepository = (events: MessageRepository<OrderStream>) =>
        new EventSourcedAggregateRepository<OrderStream>(
            Order,
            events,
            undefined,
            undefined,
            new NoopTransactionManager(),
        );

    const appendersFor = (table: string) => {
        const firstPool = new AsyncPgPool(pgPool);
        const secondPool = new AsyncPgPool(pgPool);

        return {
            firstPool,
            secondPool,
            first: createRepository(new MessageRepositoryUsingPg<OrderStream>(firstPool, table)),
            second: createRepository(new MessageRepositoryUsingPg<OrderStream>(secondPool, table)),
        };
    };

    afterEach(async () => {
        await pgPool.query(`TRUNCATE TABLE ${guardedTable} RESTART IDENTITY`);
        await pgPool.query(`TRUNCATE TABLE ${unguardedTable} RESTART IDENTITY`);
    });

    test('applies both events of a corrupted stream when two writers took the same version', async () => {
        const orderId = uuid.v7();
        const {first, second, firstPool, secondPool} = appendersFor(unguardedTable);
        await first.persist(Order.place(orderId, 'frank', 100));
        const [oneOrder, otherOrder] = await Promise.all([first.retrieve(orderId), second.retrieve(orderId)]);
        oneOrder.addItem('sku-1', 1);
        otherOrder.addItem('sku-2', 1);
        await Promise.all([first.persist(oneOrder), second.persist(otherOrder)]);

        const reloaded = await first.retrieve(orderId);

        // Neither writer's decision was rejected, so the aggregate now holds a state
        // that neither of them ever validated.
        expect(reloaded.currentState().items).toEqual({'sku-1': 1, 'sku-2': 1});
        expect(reloaded.aggregateRootVersion()).toEqual(2);
        await firstPool.flush();
        await secondPool.flush();
    });
});
