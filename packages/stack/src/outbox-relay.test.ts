import {DependencyContainer, forgeServiceKey, type ServiceKey} from '@deltic/dependency-injection';
import {OutboxRelay, OutboxRepositoryUsingMemory, type OutboxRepository} from '@deltic/messaging/outbox';
import {CollectingMessageDispatcher} from '@deltic/messaging/collecting-message-dispatcher';
import {OutboxRelayRunner} from '@deltic/messaging/pg/outbox-relay-runner';
import {MultiOutboxRelayRunner} from '@deltic/messaging/pg/multi-outbox-relay-runner';
import type {MessageDispatcher} from '@deltic/messaging';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {StaticMutex} from '@deltic/mutex';

import {
    setupOutboxRelay,
    setupMultiOutboxRelay,
} from './outbox-relay.js';
import type {TestStream} from './test-stream.stubs.js';

// ============ setupOutboxRelay ============

describe('setupOutboxRelay', () => {
    describe('service key generation', () => {
        test('generates default service keys when none provided', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
            });

            expect(services.relay).toContain('outbox-relay:');
            expect(services.runner).toContain('outbox-relay:');
        });

        test('uses custom prefix for auto-generated keys', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
                prefix: 'orders-relay',
            });

            expect(services.relay).toContain('orders-relay:');
            expect(services.runner).toContain('orders-relay:');
        });

        test('uses provided service keys when specified', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const relayKey = forgeServiceKey<OutboxRelay<TestStream>>('custom:relay');
            const runnerKey = forgeServiceKey<OutboxRelayRunner<TestStream>>('custom:runner');

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
                serviceKeys: {
                    relay: relayKey,
                    runner: runnerKey,
                },
            });

            expect(services.relay).toBe('custom:relay');
            expect(services.runner).toBe('custom:runner');
        });
    });

    describe('service registration', () => {
        test('relay resolves as OutboxRelay', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
            });

            const relay = container.resolve(services.relay);
            expect(relay).toBeInstanceOf(OutboxRelay);
        });

        test('runner service key is registered', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
            });

            expect(services.runner).toContain('outbox-relay:runner');
        });
    });

    describe('configuration', () => {
        test('accepts batch configuration options', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupOutboxRelay<TestStream>(container, {
                ...deps,
                channelName: 'outbox_publish__test_outbox',
                batchSize: 200,
                commitSize: 50,
                pollIntervalMs: 5000,
                lockRetryMs: 2000,
            });

            expect(services.relay).toContain('outbox-relay:');
            expect(services.runner).toContain('outbox-relay:');
        });
    });
});

// ============ setupMultiOutboxRelay ============

describe('setupMultiOutboxRelay', () => {
    describe('service key generation', () => {
        test('generates default service key when none provided', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupMultiOutboxRelay(container, {
                pool: deps.pool,
                mutex: deps.mutex,
                relays: {
                    'test_outbox': {
                        outboxRepository: deps.outboxRepository,
                        dispatcher: deps.dispatcher,
                    },
                },
            });

            expect(services.runner).toContain('outbox-relay:runner');
        });

        test('uses custom prefix for auto-generated key', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupMultiOutboxRelay(container, {
                pool: deps.pool,
                mutex: deps.mutex,
                relays: {
                    'test_outbox': {
                        outboxRepository: deps.outboxRepository,
                        dispatcher: deps.dispatcher,
                    },
                },
                prefix: 'multi-relay',
            });

            expect(services.runner).toContain('multi-relay:');
        });

        test('uses provided service key when specified', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const runnerKey = forgeServiceKey<MultiOutboxRelayRunner>('custom:multi-runner');

            const services = setupMultiOutboxRelay(container, {
                pool: deps.pool,
                mutex: deps.mutex,
                relays: {
                    'test_outbox': {
                        outboxRepository: deps.outboxRepository,
                        dispatcher: deps.dispatcher,
                    },
                },
                serviceKeys: {runner: runnerKey},
            });

            expect(services.runner).toBe('custom:multi-runner');
        });
    });

    describe('relay entries', () => {
        test('accepts multiple relay entries', () => {
            const container = new DependencyContainer();

            const outboxA = container.register('outbox:a', {
                factory: () => new OutboxRepositoryUsingMemory<TestStream>(),
            });
            const outboxB = container.register('outbox:b', {
                factory: () => new OutboxRepositoryUsingMemory<TestStream>(),
            });
            const dispatcherA = container.register('dispatcher:a', {
                factory: () => new CollectingMessageDispatcher<TestStream>(),
            });
            const dispatcherB = container.register('dispatcher:b', {
                factory: () => new CollectingMessageDispatcher<TestStream>(),
            });

            const services = setupMultiOutboxRelay(container, {
                pool: forgeServiceKey<AsyncPgPool>('test:pool'),
                mutex: forgeServiceKey<StaticMutex>('test:mutex'),
                relays: {
                    'table_a': {
                        outboxRepository: outboxA,
                        dispatcher: dispatcherA,
                    },
                    'table_b': {
                        outboxRepository: outboxB,
                        dispatcher: dispatcherB,
                    },
                },
            });

            expect(services.runner).toContain('outbox-relay:runner');
        });

        test('accepts empty relay entries', () => {
            const container = new DependencyContainer();

            const services = setupMultiOutboxRelay(container, {
                pool: forgeServiceKey<AsyncPgPool>('test:pool'),
                mutex: forgeServiceKey<StaticMutex>('test:mutex'),
                relays: {},
            });

            expect(services.runner).toContain('outbox-relay:runner');
        });
    });

    describe('configuration', () => {
        test('accepts optional channel name', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupMultiOutboxRelay(container, {
                pool: deps.pool,
                mutex: deps.mutex,
                relays: {
                    'test_outbox': {
                        outboxRepository: deps.outboxRepository,
                        dispatcher: deps.dispatcher,
                    },
                },
                channelName: 'custom_channel',
            });

            expect(services.runner).toContain('outbox-relay:');
        });

        test('accepts batch configuration options', () => {
            const container = new DependencyContainer();
            const deps = registerDependencies(container);

            const services = setupMultiOutboxRelay(container, {
                pool: deps.pool,
                mutex: deps.mutex,
                relays: {
                    'test_outbox': {
                        outboxRepository: deps.outboxRepository,
                        dispatcher: deps.dispatcher,
                    },
                },
                batchSize: 200,
                commitSize: 50,
                pollIntervalMs: 5000,
                lockRetryMs: 2000,
            });

            expect(services.runner).toContain('outbox-relay:');
        });
    });
});

// ============ Test Helpers ============

/**
 * Dependency keys for outbox relay tests.
 *
 * The pool and mutex use forgeServiceKey because they require concrete class types
 * (AsyncPgPool, StaticMutex) that cannot be stubbed without real infrastructure.
 * The setup functions store these keys in factory closures but only resolve them
 * when the runner is started, which is not done in these unit tests.
 */
interface TestDependencies {
    pool: ServiceKey<AsyncPgPool>;
    mutex: ServiceKey<StaticMutex>;
    outboxRepository: ServiceKey<OutboxRepository<TestStream>>;
    dispatcher: ServiceKey<MessageDispatcher<TestStream>>;
}

function registerDependencies(container: DependencyContainer): TestDependencies {
    return {
        pool: forgeServiceKey<AsyncPgPool>('test:pool'),
        mutex: forgeServiceKey<StaticMutex>('test:mutex'),
        outboxRepository: container.register('test:outbox', {
            factory: () => new OutboxRepositoryUsingMemory<TestStream>(),
        }),
        dispatcher: container.register('test:dispatcher', {
            factory: () => new CollectingMessageDispatcher<TestStream>(),
        }),
    };
}
