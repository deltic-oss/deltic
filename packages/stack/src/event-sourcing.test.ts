import * as uuid from 'uuid';
import {DependencyContainer} from '@deltic/dependency-injection';
import {EventSourcedAggregateRepository} from '@deltic/event-sourcing';
import {AggregateRootRepositoryWithSnapshotting} from '@deltic/event-sourcing/snapshotting';
import {OutboxMessageDispatcher} from '@deltic/messaging/outbox';
import {MessageDispatcherChain} from '@deltic/messaging/message-dispatcher-chain';

import {setupEventSourcing} from './event-sourcing.js';
import {InfrastructureProviderUsingMemory} from './memory.js';
import type {InfrastructureProvider} from './infrastructure-provider.js';
import {
    TestAggregateRoot,
    TestAggregateRootFactory,
    TestSnapshottedAggregateRoot,
    TestSnapshottedAggregateRootFactory,
    type TestSnapshotStream,
    type TestStream,
} from './test-stream.stubs.js';
import {
    providerSetups,
    createTestContext,
    createSnapshotTestContext,
    collect,
    type ProviderTestSetup,
} from './test-utilities.js';
const generateId = () => uuid.v7();

function registerMemoryProvider(container: DependencyContainer) {
    return container.register(`test:provider:${Date.now()}:${Math.random()}`, {
        factory: () => new InfrastructureProviderUsingMemory(),
    });
}

// ============ Tests that don't need describe.each (memory-only, configuration tests) ============

describe('setupEventSourcing', () => {
    describe('service key generation', () => {
        test('generates default service keys when none provided', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
            });

            expect(services.aggregateRepository).toContain('event-sourcing:');
            expect(services.messageRepository).toContain('event-sourcing:');
            expect(services.outboxRepository).toContain('event-sourcing:');
            expect(services.messageDispatcher).toContain('event-sourcing:');
            expect(services.messageDecorator).toContain('event-sourcing:');
        });

        test('uses custom prefix for auto-generated keys', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
                prefix: 'orders',
            });

            expect(services.aggregateRepository).toContain('orders:');
            expect(services.messageRepository).toContain('orders:');
            expect(services.outboxRepository).toContain('orders:');
            expect(services.messageDispatcher).toContain('orders:');
            expect(services.messageDecorator).toContain('orders:');
        });

        test('uses provided service keys when specified', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
                serviceKeys: {
                    aggregateRepository: 'custom:aggregate' as any,
                    messageRepository: 'custom:messages' as any,
                },
            });

            expect(services.aggregateRepository).toBe('custom:aggregate');
            expect(services.messageRepository).toBe('custom:messages');
            // Other keys should still be auto-generated
            expect(services.outboxRepository).toContain('event-sourcing:');
        });
    });

    describe('dispatcher configuration', () => {
        test('without consumers, dispatcher is OutboxMessageDispatcher', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
            });

            const dispatcher = container.resolve(services.messageDispatcher);
            expect(dispatcher).toBeInstanceOf(OutboxMessageDispatcher);
        });

        test('with consumers, dispatcher is MessageDispatcherChain', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const consumerKey = container.register('consumer', {
                factory: () => ({consume: async () => {}}),
            });

            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
                synchronousConsumers: [consumerKey],
            });

            const dispatcher = container.resolve(services.messageDispatcher);
            expect(dispatcher).toBeInstanceOf(MessageDispatcherChain);
        });

        test('with empty consumers array, dispatcher is OutboxMessageDispatcher', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
                synchronousConsumers: [],
            });

            const dispatcher = container.resolve(services.messageDispatcher);
            expect(dispatcher).toBeInstanceOf(OutboxMessageDispatcher);
        });
    });

    describe('snapshotting configuration', () => {
        test('without snapshotting, repository is EventSourcedAggregateRepository', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
            });

            const repo = container.resolve(services.aggregateRepository);
            expect(repo).toBeInstanceOf(EventSourcedAggregateRepository);
        });

        test('with snapshotting, repository is AggregateRootRepositoryWithSnapshotting', () => {
            const container = new DependencyContainer();
            const providerKey = registerMemoryProvider(container);
            const services = setupEventSourcing<TestSnapshotStream>(
                container,
                providerKey,
                {
                    eventTable: 'events',
                    outboxTable: 'outbox',
                    factory: () => new TestSnapshottedAggregateRootFactory(),
                    snapshotting: {
                        snapshotTable: 'snapshots',
                        snapshotVersion: 1,
                        factory: () => new TestSnapshottedAggregateRootFactory(),
                    },
                },
            );

            const repo = container.resolve(services.aggregateRepository);
            expect(repo).toBeInstanceOf(AggregateRootRepositoryWithSnapshotting);
        });
    });
});

// ============ Tests that run against all providers ============

describe.each(providerSetups)('setupEventSourcing with $name provider', (setup: ProviderTestSetup) => {
    let container: DependencyContainer;
    let provider: InfrastructureProvider;

    beforeAll(async () => {
        await setup.beforeAllFn?.();
    });

    afterAll(async () => {
        await setup.afterAllFn?.();
    });

    beforeEach(() => {
        container = new DependencyContainer();
        provider = setup.createProvider(container);
    });

    afterEach(async () => {
        await setup.afterEachFn?.();
    });

    describe('service registration', () => {
        test('registers all required services in the container', () => {
            const {services} = createTestContext(provider, container);

            expect(() => container.resolve(services.aggregateRepository)).not.toThrow();
            expect(() => container.resolve(services.messageRepository)).not.toThrow();
            expect(() => container.resolve(services.outboxRepository)).not.toThrow();
            expect(() => container.resolve(services.messageDispatcher)).not.toThrow();
            expect(() => container.resolve(services.messageDecorator)).not.toThrow();
        });

        test('resolving aggregateRepository returns EventSourcedAggregateRepository', () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            expect(repo).toBeInstanceOf(EventSourcedAggregateRepository);
        });
    });

    describe('aggregate persistence and retrieval', () => {
        test('can persist an aggregate and retrieve it', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            const retrieved = await repo.retrieve('test-id');
            expect(retrieved.getItem('item-1')).toBe('Test Item');
        });

        test('aggregate version is tracked correctly', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Item 1');
            aggregate.addItem('item-2', 'Item 2');
            await repo.persist(aggregate);

            const retrieved = await repo.retrieve('test-id');
            expect(retrieved.aggregateRootVersion()).toBe(2);
        });

        test('persisting aggregate with no new events is a no-op', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const messageRepo = container.resolve(services.messageRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test');
            await repo.persist(aggregate);

            // Retrieve and persist again without changes
            const retrieved = await repo.retrieve('test-id');
            await repo.persist(retrieved);

            const messages = await collect(messageRepo.retrieveAllForAggregate('test-id'));
            expect(messages).toHaveLength(1); // Only the original event
        });

        test('can retrieve aggregate at specific version', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            aggregate.addItem('item-3', 'Third');
            await repo.persist(aggregate);

            const atVersion2 = await repo.retrieveAtVersion('test-id', 2);
            expect(atVersion2.aggregateRootVersion()).toBe(2);
            expect(atVersion2.hasItem('item-1')).toBe(true);
            expect(atVersion2.hasItem('item-2')).toBe(true);
            expect(atVersion2.hasItem('item-3')).toBe(false);
        });
    });

    describe('message repository integration', () => {
        test('events are stored in the message repository', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const messageRepo = container.resolve(services.messageRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            const messages = await collect(messageRepo.retrieveAllForAggregate('test-id'));
            expect(messages).toHaveLength(1);
            expect(messages[0].type).toBe('item_added');
            expect(messages[0].payload).toEqual({itemId: 'item-1', name: 'Test Item'});
        });

        test('multiple events are stored in order', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const messageRepo = container.resolve(services.messageRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            aggregate.removeItem('item-1');
            await repo.persist(aggregate);

            const messages = await collect(messageRepo.retrieveAllForAggregate('test-id'));
            expect(messages).toHaveLength(3);
            expect(messages[0].type).toBe('item_added');
            expect(messages[0].payload.itemId).toBe('item-1');
            expect(messages[1].type).toBe('item_added');
            expect(messages[1].payload.itemId).toBe('item-2');
            expect(messages[2].type).toBe('item_removed');
            expect(messages[2].payload.itemId).toBe('item-1');
        });

        test('events have correct version headers', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const messageRepo = container.resolve(services.messageRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            await repo.persist(aggregate);

            const messages = await collect(messageRepo.retrieveAllForAggregate('test-id'));
            expect(messages[0].headers.aggregate_root_version).toBe(1);
            expect(messages[1].headers.aggregate_root_version).toBe(2);
        });
    });

    describe('outbox integration', () => {
        test('events are dispatched to the outbox', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const outbox = container.resolve(services.outboxRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            const pending = await outbox.numberOfPendingMessages();
            expect(pending).toBe(1);
        });

        test('outbox messages can be retrieved', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const outbox = container.resolve(services.outboxRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test');
            await repo.persist(aggregate);

            const messages = await collect(outbox.retrieveBatch(10));
            expect(messages).toHaveLength(1);
            expect(messages[0].type).toBe('item_added');
        });

        test('multiple events create multiple outbox messages', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);
            const outbox = container.resolve(services.outboxRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            await repo.persist(aggregate);

            const pending = await outbox.numberOfPendingMessages();
            expect(pending).toBe(2);
        });
    });

    describe('synchronous consumers', () => {
        test('consumers are invoked when events are persisted', async () => {
            const {services, collector} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            expect(collector.messages).toHaveLength(1);
            expect(collector.messages[0].type).toBe('item_added');
        });

        test('multiple events trigger multiple consumer calls', async () => {
            const {services, collector} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            await repo.persist(aggregate);

            expect(collector.messages).toHaveLength(2);
        });

        test('consumers receive events with correct payloads', async () => {
            const {services, collector} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            const consumed = collector.messages[0];
            expect(consumed.payload).toEqual({itemId: 'item-1', name: 'Test Item'});
        });
    });

    describe('message decorator', () => {
        test('default decorator is no-op', () => {
            const {services, createMessage} = createTestContext(provider, container);
            const decorator = container.resolve(services.messageDecorator);

            const message = createMessage('item_added', {itemId: '1', name: 'test'});
            const decorated = decorator.decorate([message]);

            expect(decorated).toHaveLength(1);
            expect(decorated[0].type).toBe('item_added');
            expect(decorated[0].payload).toEqual({itemId: '1', name: 'test'});
        });
    });

    describe('aggregate isolation', () => {
        test('different aggregates are isolated', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const agg1 = new TestAggregateRoot('agg-1');
            agg1.addItem('item-1', 'Aggregate 1 Item');
            await repo.persist(agg1);

            const agg2 = new TestAggregateRoot('agg-2');
            agg2.addItem('item-2', 'Aggregate 2 Item');
            await repo.persist(agg2);

            const retrieved1 = await repo.retrieve('agg-1');
            const retrieved2 = await repo.retrieve('agg-2');

            expect(retrieved1.getItem('item-1')).toBe('Aggregate 1 Item');
            expect(retrieved1.getItem('item-2')).toBeUndefined();
            expect(retrieved2.getItem('item-2')).toBe('Aggregate 2 Item');
            expect(retrieved2.getItem('item-1')).toBeUndefined();
        });

        test('aggregate versions are independent', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            const agg1 = new TestAggregateRoot('agg-1');
            agg1.addItem('item-1', 'Item 1');
            agg1.addItem('item-2', 'Item 2');
            await repo.persist(agg1);

            const agg2 = new TestAggregateRoot('agg-2');
            agg2.addItem('item-3', 'Item 3');
            await repo.persist(agg2);

            const retrieved1 = await repo.retrieve('agg-1');
            const retrieved2 = await repo.retrieve('agg-2');

            expect(retrieved1.aggregateRootVersion()).toBe(2);
            expect(retrieved2.aggregateRootVersion()).toBe(1);
        });
    });

    describe('incremental persistence', () => {
        test('can persist additional events to existing aggregate', async () => {
            const {services} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            // First persist
            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            await repo.persist(aggregate);

            // Retrieve and add more
            const retrieved = await repo.retrieve('test-id');
            retrieved.addItem('item-2', 'Second');
            await repo.persist(retrieved);

            // Verify final state
            const final = await repo.retrieve('test-id');
            expect(final.aggregateRootVersion()).toBe(2);
            expect(final.getItem('item-1')).toBe('First');
            expect(final.getItem('item-2')).toBe('Second');
        });

        test('outbox receives only new events on incremental persist', async () => {
            const {services, collector} = createTestContext(provider, container);
            const repo = container.resolve(services.aggregateRepository);

            // First persist
            const aggregate = new TestAggregateRoot('test-id');
            aggregate.addItem('item-1', 'First');
            await repo.persist(aggregate);

            // Clear collector
            collector.clear();

            // Retrieve and add more
            const retrieved = await repo.retrieve('test-id');
            retrieved.addItem('item-2', 'Second');
            await repo.persist(retrieved);

            // Only the new event should be consumed
            expect(collector.messages).toHaveLength(1);
            expect(collector.messages[0].payload.itemId).toBe('item-2');
        });
    });
});

// ============ Snapshotting tests that run against all providers ============

describe.each(providerSetups)('setupEventSourcing with snapshotting ($name provider)', (setup: ProviderTestSetup) => {
    let container: DependencyContainer;
    let provider: InfrastructureProvider;

    beforeAll(async () => {
        await setup.beforeAllFn?.();
    });

    afterAll(async () => {
        await setup.afterAllFn?.();
    });

    beforeEach(() => {
        container = new DependencyContainer();
        provider = setup.createProvider(container);
    });

    afterEach(async () => {
        await setup.afterEachFn?.();
    });

    describe('snapshot storage and retrieval', () => {
        test('persisting aggregate stores a snapshot', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
            });
            const repo = container.resolve(services.aggregateRepository);

            const id = generateId();
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            // Retrieve should use the snapshot
            const retrieved = await repo.retrieve(id);
            expect(retrieved.getItem('item-1')).toBe('Test Item');
            expect(retrieved.aggregateRootVersion()).toBe(1);
        });

        test('retrieve uses snapshot and replays events after snapshot version', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
            });
            const repo = container.resolve(services.aggregateRepository);

            // Create and persist initial state
            const id = generateId();
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'First');
            aggregate.addItem('item-2', 'Second');
            await repo.persist(aggregate); // Snapshot at version 2

            // Add more events
            const retrieved1 = await repo.retrieve(id);
            retrieved1.addItem('item-3', 'Third');
            await repo.persist(retrieved1); // Snapshot updated to version 3

            // Retrieve and verify all items are present
            const retrieved2 = await repo.retrieve(id);
            expect(retrieved2.getItem('item-1')).toBe('First');
            expect(retrieved2.getItem('item-2')).toBe('Second');
            expect(retrieved2.getItem('item-3')).toBe('Third');
            expect(retrieved2.aggregateRootVersion()).toBe(3);
        });

        test('snapshot state is correctly serialized and deserialized', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
            });
            const repo = container.resolve(services.aggregateRepository);

            const id = generateId();
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'Value with "quotes"');
            aggregate.addItem('item-2', 'Value with special chars: <>&');
            await repo.persist(aggregate);

            const retrieved = await repo.retrieve(id);
            expect(retrieved.getItem('item-1')).toBe('Value with "quotes"');
            expect(retrieved.getItem('item-2')).toBe('Value with special chars: <>&');
        });
    });

    describe('schema version isolation', () => {
        // This test only makes sense for PostgreSQL where snapshots are persisted
        // Memory provider creates new instances, so they don't share state
        test.skipIf(setup.name === 'Memory')(
            'old snapshots are ignored when schema version changes',
            async () => {
                const id = generateId();

                // Create with version 1
                const {services: servicesV1} = createSnapshotTestContext(provider, container, {
                    snapshotTable: 'test_stack_snapshots',
                    snapshotVersion: 1,
                });
                const repoV1 = container.resolve(servicesV1.aggregateRepository);

                const aggregate = new TestSnapshottedAggregateRoot(id);
                aggregate.addItem('item-1', 'First');
                await repoV1.persist(aggregate);

                // Create new container with version 2
                const container2 = new DependencyContainer();
                const provider2 = setup.createProvider(container2);
                const {services: servicesV2} = createSnapshotTestContext(provider2, container2, {
                    snapshotTable: 'test_stack_snapshots',
                    snapshotVersion: 2,
                });
                const repoV2 = container2.resolve(servicesV2.aggregateRepository);

                // Retrieve with new schema version - should reconstitute from events, not snapshot
                const retrieved = await repoV2.retrieve(id);
                expect(retrieved.getItem('item-1')).toBe('First');
                expect(retrieved.aggregateRootVersion()).toBe(1);
            },
        );
    });

    describe('authoritative snapshots', () => {
        test('with authoritativeSnapshots=false, events after snapshot are replayed', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
                authoritativeSnapshots: false,
            });
            const repo = container.resolve(services.aggregateRepository);

            const id = generateId();

            // Create initial state with snapshot
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'First');
            await repo.persist(aggregate);

            // Add more events
            const retrieved1 = await repo.retrieve(id);
            retrieved1.addItem('item-2', 'Second');
            await repo.persist(retrieved1);

            // Retrieve - should have both items (snapshot + replayed events)
            const retrieved2 = await repo.retrieve(id);
            expect(retrieved2.getItem('item-1')).toBe('First');
            expect(retrieved2.getItem('item-2')).toBe('Second');
        });

        test('with authoritativeSnapshots=true, events after snapshot are not replayed', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
                authoritativeSnapshots: true,
            });
            const repo = container.resolve(services.aggregateRepository);
            const messageRepo = container.resolve(services.messageRepository);

            const id = generateId();

            // Create aggregate and persist (creates snapshot at version 1)
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'First');
            await repo.persist(aggregate);

            // Manually add an event to the message repo without updating the snapshot
            // This simulates a scenario where the snapshot exists but there are newer events
            const message = {
                type: 'item_added' as const,
                payload: {itemId: 'item-2', name: 'Second'},
                headers: {aggregate_root_id: id, aggregate_root_version: 2},
            };
            await messageRepo.persist(id, [message]);

            // Retrieve - with authoritative snapshots, only snapshot state should be present
            const retrieved = await repo.retrieve(id);
            expect(retrieved.getItem('item-1')).toBe('First');
            expect(retrieved.getItem('item-2')).toBeUndefined(); // Not replayed
            expect(retrieved.aggregateRootVersion()).toBe(1); // Version from snapshot
        });
    });

    describe('aggregate isolation with snapshots', () => {
        test('different aggregates have independent snapshots', async () => {
            const {services} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
            });
            const repo = container.resolve(services.aggregateRepository);

            const id1 = generateId();
            const id2 = generateId();

            const agg1 = new TestSnapshottedAggregateRoot(id1);
            agg1.addItem('item-1', 'Aggregate 1');
            await repo.persist(agg1);

            const agg2 = new TestSnapshottedAggregateRoot(id2);
            agg2.addItem('item-2', 'Aggregate 2');
            await repo.persist(agg2);

            const retrieved1 = await repo.retrieve(id1);
            const retrieved2 = await repo.retrieve(id2);

            expect(retrieved1.getItem('item-1')).toBe('Aggregate 1');
            expect(retrieved1.getItem('item-2')).toBeUndefined();
            expect(retrieved2.getItem('item-2')).toBe('Aggregate 2');
            expect(retrieved2.getItem('item-1')).toBeUndefined();
        });
    });

    describe('snapshot with consumer integration', () => {
        test('consumers still receive events when snapshotting is enabled', async () => {
            const {services, collector} = createSnapshotTestContext(provider, container, {
                snapshotTable: 'test_stack_snapshots',
                snapshotVersion: 1,
            });
            const repo = container.resolve(services.aggregateRepository);

            const id = generateId();
            const aggregate = new TestSnapshottedAggregateRoot(id);
            aggregate.addItem('item-1', 'Test Item');
            await repo.persist(aggregate);

            expect(collector.messages).toHaveLength(1);
            expect(collector.messages[0].type).toBe('item_added');
            expect(collector.messages[0].payload).toEqual({itemId: 'item-1', name: 'Test Item'});
        });
    });
});
