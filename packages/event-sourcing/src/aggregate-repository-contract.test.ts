import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool, TransactionManagerUsingPg} from '@deltic/async-pg-pool';
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

    describe('event payloads', () => {
        test('round-trips nested objects, unicode, null and empty collections', async () => {
            const order = await repository.retrieve(orderId);
            order.placeFor('Frank de Jonge 🎉 日本', 0);
            order.addItem('sku-with-üñïçø∂é', 1);
            await repository.persist(order);

            const stored = await collect(events.retrieveAllForAggregate(orderId));

            expect(stored[0].payload).toEqual({customer: 'Frank de Jonge 🎉 日本', total: 0});
            expect(stored[1].payload).toEqual({sku: 'sku-with-üñïçø∂é', quantity: 1});
            const reloaded = await repository.retrieve(orderId);
            expect(reloaded.currentState().items).toEqual({'sku-with-üñïçø∂é': 1});
        });

        test('does not pollute the object prototype when a payload carries a proto key', async () => {
            const hostilePayload = JSON.parse('{"sku": "__proto__", "quantity": 1, "polluted": "yes"}') as {
                sku: string;
                quantity: number;
            };
            const nestedProto = JSON.parse('{"sku": "regular", "quantity": 1, "__proto__": {"polluted": "yes"}}') as {
                sku: string;
                quantity: number;
            };
            const order = Order.place(orderId, 'frank', 100);
            order.addItem(hostilePayload.sku, hostilePayload.quantity);
            await repository.persist(order);
            await events.persist(orderId, [
                {
                    type: 'item_was_added',
                    payload: nestedProto,
                    headers: {aggregate_root_id: orderId, aggregate_root_version: 3},
                },
            ]);

            const reloaded = await repository.retrieve(orderId);

            expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
            expect(Object.keys(reloaded.currentState().items).sort()).toEqual(['__proto__', 'regular']);
        });
    });
});

describe('consistency between the in-memory and the Postgres event store', () => {
    const scheduledFor = new Date('2026-08-04T10:00:00.000Z');
    let memory: EventStoreUnderTest;
    let postgres: EventStoreUnderTest;

    const write = async (store: EventStoreUnderTest, orderId: string): Promise<MessageRepository<OrderStream>> => {
        const events = store.create();
        const repository = new EventSourcedAggregateRepository<OrderStream>(
            Order,
            events,
            undefined,
            undefined,
            new NoopTransactionManager(),
        );
        const order = Order.place(orderId, 'frank', 100);
        order.scheduleDelivery(scheduledFor);
        await repository.persist(order);

        return events;
    };

    beforeEach(() => {
        memory = memoryEventStore();
        postgres = postgresEventStore();
    });

    afterEach(async () => {
        await memory.cleanup();
        await postgres.cleanup();
    });

    /**
     * A NUL byte cannot be represented in a Postgres json or jsonb value, so an event
     * carrying one in a string is recorded by the aggregate and can never be stored.
     */
    test('Postgres refuses a payload with a nul byte that the in-memory store accepts', async () => {
        const orderId = uuid.v7();
        const customerWithANulByte = 'Frank\u0000de Jonge';
        const inMemoryEvents = memory.create();
        const postgresEvents = postgres.create();
        const repositoryFor = (events: MessageRepository<OrderStream>) =>
            new EventSourcedAggregateRepository<OrderStream>(
                Order,
                events,
                undefined,
                undefined,
                new NoopTransactionManager(),
            );

        await repositoryFor(inMemoryEvents).persist(Order.place(orderId, customerWithANulByte, 100));
        await expect(repositoryFor(postgresEvents).persist(Order.place(orderId, customerWithANulByte, 100))).rejects
            .toThrow(/[Uu]nicode escape/);

        expect((await repositoryFor(inMemoryEvents).retrieve(orderId)).currentState().customer).toEqual(
            customerWithANulByte,
        );
        expect(await collect(postgresEvents.retrieveAllForAggregate(orderId))).toHaveLength(0);
    });

    // see .claude-work/issues/event-sourcing-in-memory-event-store-does-not-serialise-payloads.md
    it.fails('hands back the same event payload from every implementation', async () => {
        const orderId = uuid.v7();
        const fromMemory = await collect((await write(memory, orderId)).retrieveAllForAggregate(orderId));
        const fromPostgres = await collect((await write(postgres, orderId)).retrieveAllForAggregate(orderId));

        expect(fromPostgres[1].payload).toEqual(fromMemory[1].payload);
    });

    // see .claude-work/issues/event-sourcing-negative-version-reads-the-whole-stream.md
    it.fails('reconstitutes the same aggregate at a negative version in every implementation', async () => {
        const orderId = uuid.v7();
        const stores = await Promise.all([write(memory, orderId), write(postgres, orderId)]);
        const versions = await Promise.all(
            stores.map(async events => {
                const repository = new EventSourcedAggregateRepository<OrderStream>(
                    Order,
                    events,
                    undefined,
                    undefined,
                    new NoopTransactionManager(),
                );

                return (await repository.retrieveAtVersion(orderId, -1)).aggregateRootVersion();
            }),
        );

        expect(versions[1]).toEqual(versions[0]);
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

    test('lets exactly one of two writers at the same version through', async () => {
        const orderId = uuid.v7();
        const {first, second, firstPool, secondPool} = appendersFor(guardedTable);
        await first.persist(Order.place(orderId, 'frank', 100));

        // Both readers see version 1 and decide to append version 2.
        const [oneOrder, otherOrder] = await Promise.all([first.retrieve(orderId), second.retrieve(orderId)]);
        oneOrder.addItem('sku-1', 1);
        otherOrder.addItem('sku-2', 1);

        const outcomes = await Promise.allSettled([first.persist(oneOrder), second.persist(otherOrder)]);

        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const {rows} = await pgPool.query<{version: string}>(
            `SELECT version FROM ${guardedTable} WHERE aggregate_root_id = $1 ORDER BY version`,
            [orderId],
        );
        expect(rows.map(row => Number(row.version))).toEqual([1, 2]);
        await firstPool.flush();
        await secondPool.flush();
    });

    test('lets the losing writer retry against the version that won', async () => {
        const orderId = uuid.v7();
        const {first, second, firstPool, secondPool} = appendersFor(guardedTable);
        await first.persist(Order.place(orderId, 'frank', 100));
        const [oneOrder, otherOrder] = await Promise.all([first.retrieve(orderId), second.retrieve(orderId)]);
        oneOrder.addItem('sku-1', 1);
        otherOrder.addItem('sku-2', 1);
        await first.persist(oneOrder);
        await expect(second.persist(otherOrder)).rejects.toThrow(/unique constraint/);

        const retried = await second.retrieve(orderId);
        retried.addItem('sku-2', 1);
        await second.persist(retried);

        const reloaded = await first.retrieve(orderId);
        expect(reloaded.aggregateRootVersion()).toEqual(3);
        expect(reloaded.currentState().items).toEqual({'sku-1': 1, 'sku-2': 1});
        await firstPool.flush();
        await secondPool.flush();
    });

    // see .claude-work/issues/event-sourcing-no-optimistic-concurrency-control.md
    it.fails('refuses a second write at a version that is already taken', async () => {
        const orderId = uuid.v7();
        const {first, second, firstPool, secondPool} = appendersFor(unguardedTable);
        await first.persist(Order.place(orderId, 'frank', 100));
        const [oneOrder, otherOrder] = await Promise.all([first.retrieve(orderId), second.retrieve(orderId)]);
        oneOrder.addItem('sku-1', 1);
        otherOrder.addItem('sku-2', 1);

        const outcomes = await Promise.allSettled([first.persist(oneOrder), second.persist(otherOrder)]);
        await firstPool.flush();
        await secondPool.flush();

        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const {rows} = await pgPool.query<{version: string}>(
            `SELECT version FROM ${unguardedTable} WHERE aggregate_root_id = $1 ORDER BY id`,
            [orderId],
        );
        expect(rows.map(row => Number(row.version))).toEqual([1, 2]);
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

describe('taking part in a transaction owned by the caller', () => {
    let asyncPool: AsyncPgPool;
    let transactions: TransactionManagerUsingPg;
    let events: MessageRepositoryUsingPg<OrderStream>;
    let repository: EventSourcedAggregateRepository<OrderStream>;

    const versionsFor = async (orderId: string): Promise<number[]> => {
        const {rows} = await pgPool.query<{version: string}>(
            `SELECT version FROM ${guardedTable} WHERE aggregate_root_id = $1 ORDER BY version`,
            [orderId],
        );

        return rows.map(row => Number(row.version));
    };

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pgPool);
        transactions = new TransactionManagerUsingPg(asyncPool);
        events = new MessageRepositoryUsingPg<OrderStream>(asyncPool, guardedTable);
        repository = new EventSourcedAggregateRepository<OrderStream>(
            Order,
            events,
            undefined,
            undefined,
            transactions,
        );
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query(`TRUNCATE TABLE ${guardedTable} RESTART IDENTITY`);
    });

    test('leaves no events behind when the caller rolls back', async () => {
        const orderId = uuid.v7();

        await expect(
            transactions.runInTransaction(async () => {
                await repository.persist(Order.place(orderId, 'frank', 100));
                expect(await versionsFor(orderId)).toEqual([]);
                throw new Error('the command handler changed its mind');
            }),
        ).rejects.toThrow('the command handler changed its mind');

        expect(await versionsFor(orderId)).toEqual([]);
    });

    test('commits every event of the transaction at once', async () => {
        const orderId = uuid.v7();
        const otherOrderId = uuid.v7();

        await transactions.runInTransaction(async () => {
            await repository.persist(Order.place(orderId, 'frank', 100));
            await repository.persist(Order.place(otherOrderId, 'renske', 50));
        });

        expect(await versionsFor(orderId)).toEqual([1]);
        expect(await versionsFor(otherOrderId)).toEqual([1]);
    });

    test('hands back a clean connection after a rolled back write', async () => {
        const rolledBackOrderId = uuid.v7();
        const committedOrderId = uuid.v7();
        const backendId = async (): Promise<number> => {
            const connection = await asyncPool.primary();
            const {rows} = await connection.query<{pid: number}>('SELECT pg_backend_pid() AS pid');

            return rows[0].pid;
        };
        const sessionMarker = async (): Promise<string | null> => {
            const connection = await asyncPool.primary();
            const {rows} = await connection.query<{marker: string | null}>(
                'SELECT current_setting(\'app.rolled_back_marker\', true) AS marker',
            );

            return rows[0].marker;
        };
        const backendBefore = await backendId();

        await expect(
            transactions.runInTransaction(async () => {
                const connection = await asyncPool.primary();
                await connection.query('SET app.rolled_back_marker = \'tainted\'');
                await repository.persist(Order.place(rolledBackOrderId, 'frank', 100));
                throw new Error('the command handler changed its mind');
            }),
        ).rejects.toThrow('the command handler changed its mind');

        expect(transactions.inTransaction()).toBe(false);

        // The rolled back transaction ran on the connection that the next unit of work
        // claims, so nothing it did may survive: not its rows, not its session state.
        expect(await backendId()).toEqual(backendBefore);
        expect(await sessionMarker()).toBeFalsy();

        await repository.persist(Order.place(committedOrderId, 'renske', 50));

        expect(await versionsFor(rolledBackOrderId)).toEqual([]);
        expect(await versionsFor(committedOrderId)).toEqual([1]);
    });
});
