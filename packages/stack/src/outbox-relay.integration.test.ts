import {Pool, type PoolClient} from 'pg';
import * as uuid from 'uuid';
import {setTimeout as wait} from 'node:timers/promises';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {DependencyContainer, type ServiceKey} from '@deltic/dependency-injection';
import type {AnyMessageFrom, MessageConsumer, MessageDispatcher} from '@deltic/messaging';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import type {StaticMutex} from '@deltic/mutex';
import {WaitGroup} from '@deltic/wait-group';
import {pgTestCredentials} from '../../pg-credentials.js';

import {setupEventSourcing, type EventSourcingServices} from './event-sourcing.js';
import {setupMultiOutboxRelay, setupOutboxRelay} from './outbox-relay.js';
import {InfrastructureProviderUsingPostgres} from './pg.js';
import {TestAggregateRoot, TestAggregateRootFactory, type TestStream} from './test-stream.stubs.js';

const eventTable = 'test_stack_relay_events';
const primaryOutboxTable = 'test_stack_relay_outbox';
const secondaryOutboxTable = 'test_stack_relay_outbox_secondary';
const generateId = () => uuid.v7();

// ============ Collecting dispatcher that can be awaited ============

class AwaitableDispatcher implements MessageDispatcher<TestStream> {
    readonly messages: AnyMessageFrom<TestStream>[] = [];
    private readonly waitGroup = new WaitGroup();

    expect(numberOfMessages: number): void {
        this.waitGroup.add(numberOfMessages);
    }

    async send(...messages: AnyMessageFrom<TestStream>[]): Promise<void> {
        for (const message of messages) {
            this.messages.push(message);
            this.waitGroup.done();
        }
    }

    async settled(timeout: number = 5000): Promise<void> {
        await this.waitGroup.wait(timeout);
    }
}

// ============ Shared infrastructure ============

let pgPool: Pool;
let asyncPool: AsyncPgPool;
let containers: DependencyContainer[] = [];

async function createTables(): Promise<void> {
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${eventTable} (
            id BIGSERIAL PRIMARY KEY,
            tenant_id UUID,
            aggregate_root_id VARCHAR(255) NOT NULL,
            version SMALLINT NOT NULL,
            event_type VARCHAR(255) NOT NULL,
            payload JSONB NOT NULL
        );
    `);

    for (const table of [primaryOutboxTable, secondaryOutboxTable]) {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS ${table} (
                id BIGSERIAL PRIMARY KEY,
                consumed BOOLEAN NOT NULL DEFAULT FALSE,
                payload JSONB NOT NULL
            );
        `);
    }
}

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);
    await createTables();
});

beforeEach(() => {
    asyncPool = new AsyncPgPool(pgPool);
    containers = [];
});

afterEach(async () => {
    for (const container of containers) {
        await container.cleanup();
    }

    containers = [];
    await asyncPool.flush();
    await pgPool.query(`TRUNCATE TABLE ${eventTable} RESTART IDENTITY`);
    await pgPool.query(`TRUNCATE TABLE ${primaryOutboxTable} RESTART IDENTITY`);
    await pgPool.query(`TRUNCATE TABLE ${secondaryOutboxTable} RESTART IDENTITY`);
});

afterAll(async () => {
    await pgPool.end();
});

// ============ Wiring helpers ============

interface StackContext {
    container: DependencyContainer;
    poolKey: ServiceKey<AsyncPgPool>;
    mutexKey: ServiceKey<StaticMutex>;
}

function createStackContext(): StackContext {
    const container = new DependencyContainer();
    containers.push(container);

    return {
        container,
        poolKey: container.register('pg:pool', {factory: () => asyncPool}),
        mutexKey: container.register('pg:mutex', {factory: () => new StaticMutexUsingMemory()}),
    };
}

function wireEventSourcing(
    context: StackContext,
    options: {
        outboxTable?: string;
        prefix?: string;
        consumers?: MessageConsumer<TestStream>[];
    } = {},
): EventSourcingServices<TestStream> {
    const {container} = context;
    const name = options.prefix ?? 'default';
    const providerKey = container.register(`provider:${name}`, {
        factory: () => new InfrastructureProviderUsingPostgres({pool: context.poolKey}),
    });
    const consumerKeys = (options.consumers ?? []).map((consumer, index) =>
        container.register(`consumer:${name}:${index}`, {factory: () => consumer}),
    );

    return setupEventSourcing<TestStream>(container, providerKey, {
        eventTable,
        outboxTable: options.outboxTable ?? primaryOutboxTable,
        prefix: options.prefix,
        factory: () => new TestAggregateRootFactory(),
        synchronousConsumers: consumerKeys,
    });
}

async function recordItem(
    container: DependencyContainer,
    services: EventSourcingServices<TestStream>,
    itemId: string,
): Promise<string> {
    const id = generateId();
    const aggregate = new TestAggregateRoot(id);
    aggregate.addItem(itemId, `Item ${itemId}`);
    await container.resolve(services.aggregateRepository).persist(aggregate);

    return id;
}

// ============ Single stream relay ============

describe('setupOutboxRelay against PostgreSQL', () => {
    test('relays events recorded through the aggregate repository', async () => {
        const dispatcher = new AwaitableDispatcher();
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {factory: () => dispatcher});
        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${primaryOutboxTable}`,
            pollIntervalMs: 50,
        });

        await recordItem(container, services, 'item-1');
        expect(await container.resolve(services.outboxRepository).numberOfPendingMessages()).toBe(1);

        dispatcher.expect(1);
        const runner = container.resolve(relay.runner);
        const running = runner.start();
        await dispatcher.settled();
        await runner.stop();
        await running;

        expect(dispatcher.messages).toHaveLength(1);
        expect(dispatcher.messages[0].type).toBe('item_added');
        expect(await container.resolve(services.outboxRepository).numberOfPendingMessages()).toBe(0);
        expect(await container.resolve(services.outboxRepository).numberOfConsumedMessages()).toBe(1);
    });

    test('container cleanup stops a running relay', async () => {
        const dispatcher = new AwaitableDispatcher();
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {factory: () => dispatcher});
        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${primaryOutboxTable}`,
            pollIntervalMs: 50,
        });

        await recordItem(container, services, 'item-1');

        dispatcher.expect(1);
        const running = container.resolve(relay.runner).start();
        await dispatcher.settled();

        await container.cleanup();

        await expect(running).resolves.toBeUndefined();
    });

    test('container cleanup does not fail for a relay that was never started', async () => {
        const dispatcher = new AwaitableDispatcher();
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {factory: () => dispatcher});
        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${primaryOutboxTable}`,
        });

        container.resolve(relay.runner);

        await expect(container.cleanup()).resolves.toBeUndefined();
    });

    /**
     * The channel name is interpolated into `LISTEN <channel>` verbatim, so anything that is not
     * a bare identifier is rejected by PostgreSQL rather than by the setup function.
     * see .claude-work/issues/stack-table-names-are-not-validated.md
     */
    test('an invalid channel name is only rejected once the relay starts', async () => {
        const dispatcher = new AwaitableDispatcher();
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {factory: () => dispatcher});

        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: 'test stack not an identifier',
        });

        await expect(container.resolve(relay.runner).start()).rejects.toThrow(/syntax error/);
    });

    test('messages stay pending when the dispatcher fails', async () => {
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {
            factory: (): MessageDispatcher<TestStream> => ({
                send: async () => {
                    throw new Error('broker unavailable');
                },
            }),
        });
        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${primaryOutboxTable}`,
            pollIntervalMs: 50,
        });

        await recordItem(container, services, 'item-1');

        const runner = container.resolve(relay.runner);
        await expect(runner.start()).rejects.toThrow('broker unavailable');

        expect(await container.resolve(services.outboxRepository).numberOfPendingMessages()).toBe(1);
    });
});

// ============ Multi stream relay ============

describe('setupMultiOutboxRelay against PostgreSQL', () => {
    test('routes each outbox to its own dispatcher', async () => {
        const context = createStackContext();
        const {container} = context;
        const primaryDispatcher = new AwaitableDispatcher();
        const secondaryDispatcher = new AwaitableDispatcher();

        const primary = wireEventSourcing(context, {prefix: 'primary', outboxTable: primaryOutboxTable});
        const secondary = wireEventSourcing(context, {prefix: 'secondary', outboxTable: secondaryOutboxTable});
        const primaryDispatcherKey = container.register('dispatcher:primary', {factory: () => primaryDispatcher});
        const secondaryDispatcherKey = container.register('dispatcher:secondary', {
            factory: () => secondaryDispatcher,
        });

        const relay = setupMultiOutboxRelay(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            pollIntervalMs: 50,
            relays: {
                [primaryOutboxTable]: {
                    outboxRepository: primary.outboxRepository,
                    dispatcher: primaryDispatcherKey,
                },
                [secondaryOutboxTable]: {
                    outboxRepository: secondary.outboxRepository,
                    dispatcher: secondaryDispatcherKey,
                },
            },
        });

        await recordItem(container, primary, 'primary-item');
        await recordItem(container, secondary, 'secondary-item');

        primaryDispatcher.expect(1);
        secondaryDispatcher.expect(1);
        const runner = container.resolve(relay.runner);
        const running = runner.start();
        await primaryDispatcher.settled();
        await secondaryDispatcher.settled();
        await runner.stop();
        await running;

        expect(primaryDispatcher.messages.map(m => m.payload.itemId)).toEqual(['primary-item']);
        expect(secondaryDispatcher.messages.map(m => m.payload.itemId)).toEqual(['secondary-item']);
    });
});

// ============ Transactional guarantees ============

describe('transactional outbox guarantees', () => {
    test('a failing synchronous consumer rolls back the event and the outbox row', async () => {
        const context = createStackContext();
        const services = wireEventSourcing(context, {
            consumers: [
                {
                    consume: async () => {
                        throw new Error('projection exploded');
                    },
                },
            ],
        });

        const aggregate = new TestAggregateRoot(generateId());
        aggregate.addItem('item-1', 'Test');

        await expect(context.container.resolve(services.aggregateRepository).persist(aggregate)).rejects.toThrow(
            'projection exploded',
        );

        const events = await pgPool.query(`SELECT count(*) as count FROM ${eventTable}`);
        const outbox = await pgPool.query(`SELECT count(*) as count FROM ${primaryOutboxTable}`);
        expect(Number(events.rows[0].count)).toBe(0);
        expect(Number(outbox.rows[0].count)).toBe(0);
    });

    /**
     * The pool is wired the way the provider documents it: `new AsyncPgPool(pool)`, which falls
     * back to a memory-backed context store shared by every async flow. Two flows that overlap
     * therefore observe a single transaction: the second one never begins or commits its own.
     */
    // see .claude-work/issues/stack-shared-pool-context-merges-concurrent-transactions.md
    test.fails('a persisted aggregate is not discarded by a concurrent rollback', async () => {
        const reachedConsumer = Promise.withResolvers<void>();
        const barrier = Promise.withResolvers<void>();
        let isFirstFlow = true;
        const context = createStackContext();
        const services = wireEventSourcing(context, {
            consumers: [
                {
                    consume: async () => {
                        if (!isFirstFlow) {
                            return;
                        }

                        isFirstFlow = false;
                        reachedConsumer.resolve();
                        await barrier.promise;

                        throw new Error('projection exploded');
                    },
                },
            ],
        });
        const repository = context.container.resolve(services.aggregateRepository);

        const failingAggregate = new TestAggregateRoot(generateId());
        failingAggregate.addItem('item-1', 'First');
        const succeedingAggregate = new TestAggregateRoot(generateId());
        succeedingAggregate.addItem('item-2', 'Second');

        // The first flow keeps its transaction open while it is inside the consumer.
        const failingFlow = repository.persist(failingAggregate).catch(error => error);
        await reachedConsumer.promise;

        await repository.persist(succeedingAggregate);

        barrier.resolve();
        expect(await failingFlow).toBeInstanceOf(Error);

        const rows = await pgPool.query(
            `SELECT aggregate_root_id FROM ${eventTable} WHERE aggregate_root_id = $1`,
            [succeedingAggregate.aggregateRootId],
        );
        expect(rows.rows).toHaveLength(1);
    });

    test('events and outbox rows are committed together', async () => {
        const context = createStackContext();
        const services = wireEventSourcing(context);

        const id = await recordItem(context.container, services, 'item-1');

        const events = await pgPool.query(
            `SELECT aggregate_root_id, version FROM ${eventTable} WHERE aggregate_root_id = $1`,
            [id],
        );
        const outbox = await pgPool.query(`SELECT payload FROM ${primaryOutboxTable}`);
        expect(events.rows).toHaveLength(1);
        expect(outbox.rows).toHaveLength(1);
        expect(outbox.rows[0].payload.headers.aggregate_root_id).toBe(id);
    });
});

// ============ Reactive relaying ============

describe('reactive relaying', () => {
    async function listenOn(
        channels: string[],
        onNotification: (channel: string) => void,
    ): Promise<() => Promise<void>> {
        const connection: PoolClient = await pgPool.connect();
        connection.on('notification', notification => onNotification(notification.channel));

        for (const channel of channels) {
            await connection.query(`LISTEN ${channel}`);
        }

        return async () => {
            for (const channel of channels) {
                await connection.query(`UNLISTEN ${channel}`);
            }

            connection.removeAllListeners('notification');
            connection.release();
        };
    }

    // see .claude-work/issues/stack-postgres-outbox-never-notifies.md
    test.fails('notifies the outbox channel when events are recorded', async () => {
        const notifications: string[] = [];
        const waitGroup = new WaitGroup();
        waitGroup.add(1);
        const stop = await listenOn(
            [`outbox_publish__${primaryOutboxTable}`, 'outbox_publish'],
            channel => {
                notifications.push(channel);
                waitGroup.done();
            },
        );

        try {
            const context = createStackContext();
            const services = wireEventSourcing(context);
            await recordItem(context.container, services, 'item-1');

            await waitGroup.wait(500).catch(() => undefined);

            expect(notifications).toContain(`outbox_publish__${primaryOutboxTable}`);
        } finally {
            await stop();
        }
    });

    test('relays events without a notification by falling back to polling', async () => {
        const dispatcher = new AwaitableDispatcher();
        const context = createStackContext();
        const services = wireEventSourcing(context);
        const {container} = context;
        const dispatcherKey = container.register('relay:dispatcher', {factory: () => dispatcher});
        const relay = setupOutboxRelay<TestStream>(container, {
            pool: context.poolKey,
            mutex: context.mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${primaryOutboxTable}`,
            pollIntervalMs: 50,
        });

        const runner = container.resolve(relay.runner);
        const running = runner.start();
        // Let the runner acquire the lock and settle into its polling interval.
        await wait(200);

        dispatcher.expect(1);
        await recordItem(container, services, 'item-1');
        await dispatcher.settled();
        await runner.stop();
        await running;

        expect(dispatcher.messages).toHaveLength(1);
    });
});
