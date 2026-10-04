import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {DependencyContainer, forgeServiceKey, type ServiceKey} from '@deltic/dependency-injection';
import {AggregateRootBehavior, type AggregateRootFactory} from '@deltic/event-sourcing';
import type {AnyMessageFrom, MessageConsumer, MessageDispatcher, MessageRepository} from '@deltic/messaging';
import type {StaticMutex} from '@deltic/mutex';
import {CollectingMessageConsumer} from '@deltic/messaging/collecting-message-consumer';
import {
    SchemaVersionMessageDecorator,
    UpcastingMessageRepository,
    UpcastingOutboxRepository,
    type DefineVersionedStream,
    type UpcastersForVersionedStream,
} from '@deltic/messaging/upcasting';

import {setupEventSourcing} from './event-sourcing.js';
import {InfrastructureProviderUsingMemory} from './memory.js';
import {setupMultiOutboxRelay, setupOutboxRelay} from './outbox-relay.js';
import type {InfrastructureProvider} from './infrastructure-provider.js';
import {
    TestAggregateRoot,
    TestAggregateRootFactory,
    TestSnapshottedAggregateRootFactory,
    type TestSnapshotStream,
    type TestStream,
} from './test-stream.stubs.js';
import {collect} from './test-utilities.js';

// ============ Fixtures ============

let providerCounter = 0;

function registerProvider(container: DependencyContainer): ServiceKey<InfrastructureProvider> {
    return container.register(`test:provider:${++providerCounter}`, {
        factory: () => new InfrastructureProviderUsingMemory(),
    });
}

function throwingConsumer(error: Error): MessageConsumer<TestStream> {
    return {
        consume: async () => {
            throw error;
        },
    };
}

// ============ Versioned stream fixture, used for the upcasting wiring ============

interface ItemAddedV1 {
    readonly itemId: string;
}

interface ItemAddedV2 {
    readonly itemId: string;
    readonly quantity: number;
}

type VersionedCartStream = DefineVersionedStream<{
    aggregateRootId: string;
    messages: {
        item_added: [ItemAddedV1, ItemAddedV2];
    };
}> & {aggregateRoot: VersionedCart};

class VersionedCart extends AggregateRootBehavior<VersionedCartStream> {
    private quantities: Map<string, number> = new Map();

    addItem(itemId: string, quantity: number): void {
        this.recordThat('item_added', {itemId, quantity});
    }

    quantityOf(itemId: string): number | undefined {
        return this.quantities.get(itemId);
    }

    protected apply(message: AnyMessageFrom<VersionedCartStream>): void {
        this.quantities.set(message.payload.itemId, message.payload.quantity);
        this.aggregateRootVersionNumber = message.headers.aggregate_root_version ?? this.aggregateRootVersionNumber;
    }
}

class VersionedCartFactory implements AggregateRootFactory<VersionedCartStream> {
    async reconstituteFromEvents(
        id: string,
        events: AsyncGenerator<AnyMessageFrom<VersionedCartStream>>,
    ): Promise<VersionedCart> {
        const cart = new VersionedCart(id);

        for await (const event of events) {
            cart['apply'](event);
        }

        return cart;
    }
}

const cartUpcasters: UpcastersForVersionedStream<VersionedCartStream> = {
    item_added: [
        message => ({...message, payload: {...message.payload, quantity: 1}}),
    ],
};

function legacyItemAdded(aggregateRootId: string, itemId: string): AnyMessageFrom<VersionedCartStream> {
    return {
        type: 'item_added',
        // The stored payload predates the quantity field, the upcaster supplies it.
        payload: {itemId} as ItemAddedV2,
        headers: {
            aggregate_root_id: aggregateRootId,
            aggregate_root_version: 1,
            schema_version: 0,
        },
    };
}

// ============ Composing more than one stream in a single container ============

describe('composing multiple event sourcing setups', () => {
    test('fails fast when the same stream is set up twice without a prefix', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const config = {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
        };

        setupEventSourcing<TestStream>(container, providerKey, config);

        expect(() => setupEventSourcing<TestStream>(container, providerKey, config)).toThrow(
            /already registered/,
        );
    });

    test('fails fast when two setups share an explicitly provided service key', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const sharedKey = forgeServiceKey<MessageRepository<TestStream>>('shared:messages');

        setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'order_events',
            outboxTable: 'order_outbox',
            prefix: 'orders',
            factory: () => new TestAggregateRootFactory(),
            serviceKeys: {messageRepository: sharedKey},
        });

        expect(() =>
            setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'invoice_events',
                outboxTable: 'invoice_outbox',
                prefix: 'invoices',
                factory: () => new TestAggregateRootFactory(),
                serviceKeys: {messageRepository: sharedKey},
            }),
        ).toThrow(/shared:messages/);
    });

    test('prefixed setups do not share repositories', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);

        const orders = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'order_events',
            outboxTable: 'order_outbox',
            prefix: 'orders',
            factory: () => new TestAggregateRootFactory(),
        });
        const invoices = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'invoice_events',
            outboxTable: 'invoice_outbox',
            prefix: 'invoices',
            factory: () => new TestAggregateRootFactory(),
        });

        const order = new TestAggregateRoot('shared-id');
        order.addItem('item-1', 'Order item');
        await container.resolve(orders.aggregateRepository).persist(order);

        const orderMessages = await collect(
            container.resolve(orders.messageRepository).retrieveAllForAggregate('shared-id'),
        );
        const invoiceMessages = await collect(
            container.resolve(invoices.messageRepository).retrieveAllForAggregate('shared-id'),
        );

        expect(orderMessages).toHaveLength(1);
        expect(invoiceMessages).toHaveLength(0);
        expect(await container.resolve(orders.outboxRepository).numberOfPendingMessages()).toBe(1);
        expect(await container.resolve(invoices.outboxRepository).numberOfPendingMessages()).toBe(0);
    });

    test('the aggregate repository writes to the repository registered under the message repository key', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
        });

        // Resolving the repository before the aggregate repository must not create a second store.
        const messageRepository = container.resolve(services.messageRepository);
        const aggregate = new TestAggregateRoot('test-id');
        aggregate.addItem('item-1', 'Test');
        await container.resolve(services.aggregateRepository).persist(aggregate);

        expect(await collect(messageRepository.retrieveAllForAggregate('test-id'))).toHaveLength(1);
        expect(container.resolve(services.messageRepository)).toBe(messageRepository);
    });
});

// ============ Composing relays in a single container ============

describe('composing outbox relays', () => {
    const poolKey = forgeServiceKey<AsyncPgPool>('test:pool');
    const mutexKey = forgeServiceKey<StaticMutex>('test:mutex');

    function relayDependencies(container: DependencyContainer, prefix: string) {
        const providerKey = registerProvider(container);
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: `${prefix}_events`,
            outboxTable: `${prefix}_outbox`,
            prefix,
            factory: () => new TestAggregateRootFactory(),
        });
        const dispatcherKey = container.register(`${prefix}:dispatcher`, {
            factory: (): MessageDispatcher<TestStream> => ({send: async () => {}}),
        });

        return {
            pool: poolKey,
            mutex: mutexKey,
            outboxRepository: services.outboxRepository,
            dispatcher: dispatcherKey,
        };
    }

    test('fails fast when two relays are registered without a prefix', () => {
        const container = new DependencyContainer();
        const orders = relayDependencies(container, 'orders');
        const invoices = relayDependencies(container, 'invoices');

        setupOutboxRelay<TestStream>(container, {...orders, channelName: 'outbox_publish__orders_outbox'});

        expect(() =>
            setupOutboxRelay<TestStream>(container, {
                ...invoices,
                channelName: 'outbox_publish__invoices_outbox',
            }),
        ).toThrow(/outbox-relay:relay/);
    });

    test('a single and a multi relay collide on the default runner key', () => {
        const container = new DependencyContainer();
        const orders = relayDependencies(container, 'orders');

        setupOutboxRelay<TestStream>(container, {...orders, channelName: 'outbox_publish__orders_outbox'});

        expect(() =>
            setupMultiOutboxRelay(container, {
                pool: orders.pool,
                mutex: orders.mutex,
                relays: {
                    orders_outbox: {
                        outboxRepository: orders.outboxRepository,
                        dispatcher: orders.dispatcher,
                    },
                },
            }),
        ).toThrow(/outbox-relay:runner/);
    });

    test('prefixed relays coexist in one container', () => {
        const container = new DependencyContainer();
        const orders = relayDependencies(container, 'orders');
        const invoices = relayDependencies(container, 'invoices');

        const first = setupOutboxRelay<TestStream>(container, {
            ...orders,
            channelName: 'outbox_publish__orders_outbox',
            prefix: 'orders-relay',
        });
        const second = setupOutboxRelay<TestStream>(container, {
            ...invoices,
            channelName: 'outbox_publish__invoices_outbox',
            prefix: 'invoices-relay',
        });

        expect(first.runner).not.toBe(second.runner);
        expect(container.resolve(first.relay)).not.toBe(container.resolve(second.relay));
    });
});

// ============ Configuration validation ============

describe('configuration validation', () => {
    // see .claude-work/issues/stack-table-names-are-not-validated.md
    test.fails('rejects table names that are not valid SQL identifiers', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);

        expect(() =>
            setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: 'events"; DROP TABLE customers; --',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
            }),
        ).toThrow();
    });

    // see .claude-work/issues/stack-table-names-are-not-validated.md
    test.fails('rejects an empty event table name', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);

        expect(() =>
            setupEventSourcing<TestStream>(container, providerKey, {
                eventTable: '',
                outboxTable: 'outbox',
                factory: () => new TestAggregateRootFactory(),
            }),
        ).toThrow();
    });
});

// ============ Failure paths in the synchronous consumer chain ============

describe('synchronous consumer failures', () => {
    test('a failing consumer surfaces the error to the caller of persist', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const consumerKey = container.register('failing:consumer', {
            factory: () => throwingConsumer(new Error('projection exploded')),
        });
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
            synchronousConsumers: [consumerKey],
        });

        const aggregate = new TestAggregateRoot('test-id');
        aggregate.addItem('item-1', 'Test');

        await expect(container.resolve(services.aggregateRepository).persist(aggregate)).rejects.toThrow(
            'projection exploded',
        );
    });

    test('a failing consumer stops the consumers after it, since the events are rolled back', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const collector = new CollectingMessageConsumer<TestStream>();
        const failingKey = container.register('failing:consumer', {
            factory: () => throwingConsumer(new Error('projection exploded')),
        });
        const collectorKey = container.register('collecting:consumer', {
            factory: () => collector,
        });
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
            synchronousConsumers: [failingKey, collectorKey],
        });

        const aggregate = new TestAggregateRoot('test-id');
        aggregate.addItem('item-1', 'Test');

        await expect(container.resolve(services.aggregateRepository).persist(aggregate)).rejects.toThrow(
            'projection exploded',
        );
        expect(collector.messages).toHaveLength(0);
    });

    test('events are lost when a consumer fails and the transaction manager cannot roll back', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const consumerKey = container.register('failing:consumer', {
            factory: () => throwingConsumer(new Error('projection exploded')),
        });
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
            synchronousConsumers: [consumerKey],
        });

        const aggregate = new TestAggregateRoot('test-id');
        aggregate.addItem('item-1', 'Test');
        await expect(container.resolve(services.aggregateRepository).persist(aggregate)).rejects.toThrow();

        /**
         * The memory provider deliberately uses a no-op transaction manager, so the event write
         * is not undone. The aggregate released its events, which means retrying persist() does
         * not re-dispatch them either. This is why the memory provider is a testing aid only.
         */
        expect(await collect(container.resolve(services.messageRepository).retrieveAllForAggregate('test-id')))
            .toHaveLength(1);
        expect(aggregate.hasUnreleasedEvents()).toBe(false);
    });
});

// ============ Public entry point ============

describe('package entry point', () => {
    test('exposes setupEventSourcing from the package root', async () => {
        const entryPoint = await import('./index.js');

        expect(entryPoint.setupEventSourcing).toBe(setupEventSourcing);
    });

    /**
     * Consumers are resolved lazily so that they may be registered after the stream is set up.
     * A key that never gets a definition therefore only fails on the first write.
     */
    test('a consumer key without a definition fails when the dispatcher is resolved', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
            synchronousConsumers: [forgeServiceKey<MessageConsumer<TestStream>>('never:registered')],
        });

        expect(() => container.resolve(services.messageDispatcher)).toThrow(/never:registered/);
    });
});

// ============ Upcasting wiring ============

describe('upcasting wiring', () => {
    function setupVersionedCart(container: DependencyContainer) {
        const providerKey = registerProvider(container);

        return setupEventSourcing<VersionedCartStream>(container, providerKey, {
            eventTable: 'cart_events',
            outboxTable: 'cart_outbox',
            factory: () => new VersionedCartFactory(),
            upcasters: cartUpcasters,
        });
    }

    test('wraps the repositories and the decorator when upcasters are configured', () => {
        const container = new DependencyContainer();
        const services = setupVersionedCart(container);

        expect(container.resolve(services.messageRepository)).toBeInstanceOf(UpcastingMessageRepository);
        expect(container.resolve(services.outboxRepository)).toBeInstanceOf(UpcastingOutboxRepository);
        expect(container.resolve(services.messageDecorator)).toBeInstanceOf(SchemaVersionMessageDecorator);
    });

    test('stamps the current schema version on newly recorded events', async () => {
        const container = new DependencyContainer();
        const services = setupVersionedCart(container);

        const cart = new VersionedCart('cart-1');
        cart.addItem('item-1', 3);
        await container.resolve(services.aggregateRepository).persist(cart);

        const messages = await collect(
            container.resolve(services.messageRepository).retrieveAllForAggregate('cart-1'),
        );
        expect(messages[0].headers.schema_version).toBe(cartUpcasters.item_added.length);
        expect(messages[0].payload).toEqual({itemId: 'item-1', quantity: 3});
    });

    test('upcasts stored events while reconstituting an aggregate', async () => {
        const container = new DependencyContainer();
        const services = setupVersionedCart(container);

        await container.resolve(services.messageRepository).persist('cart-1', [legacyItemAdded('cart-1', 'item-1')]);

        const cart = await container.resolve(services.aggregateRepository).retrieve('cart-1');
        expect(cart.quantityOf('item-1')).toBe(1);
    });

    test('upcasts messages that are relayed out of the outbox', async () => {
        const container = new DependencyContainer();
        const services = setupVersionedCart(container);
        const outbox = container.resolve(services.outboxRepository);

        await outbox.persist([legacyItemAdded('cart-1', 'item-1')]);

        const relayed = await collect(outbox.retrieveBatch(10));
        expect(relayed).toHaveLength(1);
        expect(relayed[0].payload).toEqual({itemId: 'item-1', quantity: 1});
    });
});

// ============ Snapshotting configuration ============

describe('snapshotting configuration', () => {
    test('the snapshotting factory replaces the base factory', () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        let baseFactoryCalls = 0;
        let snapshotFactoryCalls = 0;

        const services = setupEventSourcing<TestSnapshotStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => {
                baseFactoryCalls++;

                return new TestSnapshottedAggregateRootFactory();
            },
            snapshotting: {
                snapshotTable: 'snapshots',
                snapshotVersion: 1,
                factory: () => {
                    snapshotFactoryCalls++;

                    return new TestSnapshottedAggregateRootFactory();
                },
            },
        });

        container.resolve(services.aggregateRepository);

        expect(snapshotFactoryCalls).toBe(1);
        expect(baseFactoryCalls).toBe(0);
    });
});

// ============ Container shutdown ============

describe('container shutdown', () => {
    test('cleanup succeeds for a container that resolved nothing', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
        });

        await expect(container.cleanup()).resolves.toBeUndefined();
    });

    test('cleanup is idempotent for an event sourcing setup', async () => {
        const container = new DependencyContainer();
        const providerKey = registerProvider(container);
        const services = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable: 'events',
            outboxTable: 'outbox',
            factory: () => new TestAggregateRootFactory(),
        });
        container.resolve(services.aggregateRepository);

        await container.cleanup();

        await expect(container.cleanup()).resolves.toBeUndefined();
    });
});
