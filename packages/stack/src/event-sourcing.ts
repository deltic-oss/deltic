import type {DependencyContainer} from '@deltic/dependency-injection';
import {forgeServiceKey, type ServiceKey} from '@deltic/dependency-injection';
import {
    EventSourcedAggregateRepository,
    type AggregateRepository,
    type AggregateRootFactory,
    type AggregateStream,
} from '@deltic/event-sourcing';
import {
    AggregateRootRepositoryWithSnapshotting,
    type AggregateRootFactoryWithSnapshotting,
    type AggregateStreamWithSnapshotting,
} from '@deltic/event-sourcing/snapshotting';
import type {
    MessageConsumer,
    MessageDecorator,
    MessageDispatcher,
    MessageRepository,
} from '@deltic/messaging';
import {MessageConsumerChain} from '@deltic/messaging/message-consumer-chain';
import {MessageDispatcherChain} from '@deltic/messaging/message-dispatcher-chain';
import {ConsumingMessageDispatcher} from '@deltic/messaging/consuming-message-dispatcher';
import {OutboxMessageDispatcher, type OutboxRepository} from '@deltic/messaging/outbox';
import {
    SchemaVersionMessageDecorator,
    UpcastingMessageRepository,
    UpcastingOutboxRepository,
    type UpcastersForVersionedStream,
    type VersionedStreamDefinition,
} from '@deltic/messaging/upcasting';

import type {InfrastructureProvider} from './infrastructure-provider.js';

/**
 * Service keys that can be optionally provided.
 * If not provided, keys will be auto-generated based on a naming convention.
 */
export interface EventSourcingServiceKeys<Stream extends AggregateStream<Stream>> {
    aggregateRepository?: ServiceKey<AggregateRepository<Stream>>;
    messageRepository?: ServiceKey<MessageRepository<Stream>>;
    outboxRepository?: ServiceKey<OutboxRepository<Stream>>;
    messageDispatcher?: ServiceKey<MessageDispatcher<Stream>>;
    messageDecorator?: ServiceKey<MessageDecorator<Stream>>;
}

/**
 * Configuration for snapshot support.
 * Only applicable when Stream extends AggregateStreamWithSnapshotting.
 */
export interface SnapshotConfig<Stream extends AggregateStreamWithSnapshotting<Stream>> {
    /**
     * The database table name for storing snapshots.
     */
    snapshotTable: string;

    /**
     * The snapshot schema version. This version is stored with each snapshot
     * and used to invalidate snapshots when the schema changes.
     * Increment this value when the snapshot format changes.
     */
    snapshotVersion: number;

    /**
     * When true, snapshots are considered authoritative and events after
     * the snapshot version are not replayed. Defaults to false.
     */
    authoritativeSnapshots?: boolean;

    /**
     * Factory function that creates an aggregate root factory with snapshot support.
     * This overrides the main factory when snapshotting is enabled.
     */
    factory(container: DependencyContainer): AggregateRootFactoryWithSnapshotting<Stream>;
}

/**
 * Base configuration for setting up event sourcing.
 */
export interface EventSourcingConfigBase<Stream extends AggregateStream<Stream>> {
    /**
     * The database table name for storing events.
     */
    eventTable: string;

    /**
     * The database table name for the transactional outbox.
     */
    outboxTable: string;

    /**
     * Factory function that creates the aggregate root factory.
     * Receives the dependency container for resolving dependencies.
     */
    factory(container: DependencyContainer): AggregateRootFactory<Stream>;

    /**
     * Optional service keys for the registered services.
     * If not provided, keys will be auto-generated.
     */
    serviceKeys?: EventSourcingServiceKeys<Stream>;

    /**
     * Service keys of synchronous message consumers that will be invoked
     * when events are dispatched (before the transaction commits).
     */
    synchronousConsumers?: ServiceKey<MessageConsumer<Stream>>[];

    /**
     * Prefix used for auto-generated service keys.
     * Prevents key conflicts when setupEventSourcing is used multiple times.
     * Defaults to 'event-sourcing'.
     */
    prefix?: string;
}

/**
 * Helper type to extract snapshotting config based on Stream capabilities.
 */
type SnapshottingConfigPart<Stream extends AggregateStream<Stream>> =
    Stream extends AggregateStreamWithSnapshotting<infer S>
        ? S extends AggregateStreamWithSnapshotting<S>
            ? {snapshotting?: SnapshotConfig<S>}
            : {}
        : {};

/**
 * Helper type to extract upcasting config based on Stream capabilities.
 */
type UpcastingConfigPart<Stream extends AggregateStream<Stream>> =
    Stream extends VersionedStreamDefinition<infer S>
        ? S extends VersionedStreamDefinition<S>
            ? {upcasters?: UpcastersForVersionedStream<S>}
            : {}
        : {};

/**
 * Full configuration type for setupEventSourcing.
 * Includes optional snapshotting and upcasting features based on Stream type constraints.
 */
export type EventSourcingConfig<Stream extends AggregateStream<Stream>> = EventSourcingConfigBase<Stream> &
    SnapshottingConfigPart<Stream> &
    UpcastingConfigPart<Stream>;

/**
 * Return type of setupEventSourcing containing all registered service keys.
 */
export interface EventSourcingServices<Stream extends AggregateStream<Stream>> {
    /**
     * Service key for the aggregate repository.
     */
    aggregateRepository: ServiceKey<AggregateRepository<Stream>>;

    /**
     * Service key for the message repository.
     */
    messageRepository: ServiceKey<MessageRepository<Stream>>;

    /**
     * Service key for the outbox repository.
     */
    outboxRepository: ServiceKey<OutboxRepository<Stream>>;

    /**
     * Service key for the message dispatcher.
     */
    messageDispatcher: ServiceKey<MessageDispatcher<Stream>>;

    /**
     * Service key for the message decorator.
     */
    messageDecorator: ServiceKey<MessageDecorator<Stream>>;
}

/**
 * Default key prefix used for auto-generated service keys.
 */
const DEFAULT_KEY_PREFIX = 'event-sourcing';

/**
 * Generates a service key with an optional prefix.
 */
function generateKey<T>(name: string, prefix: string = DEFAULT_KEY_PREFIX): ServiceKey<T> {
    return forgeServiceKey<T>(`${prefix}:${name}`);
}

/**
 * Type guard to check if config has snapshotting configuration.
 */
function hasSnapshotting(config: {snapshotting?: unknown}): config is {snapshotting: NonNullable<unknown>} {
    return 'snapshotting' in config && config.snapshotting !== undefined;
}

/**
 * Type guard to check if config has upcasters configuration.
 */
function hasUpcasters(config: {upcasters?: unknown}): config is {upcasters: NonNullable<unknown>} {
    return 'upcasters' in config && config.upcasters !== undefined;
}

/**
 * Sets up event sourcing infrastructure by registering all necessary services
 * in the dependency container.
 *
 * @param container - The dependency container to register services in
 * @param providerKey - Service key for the infrastructure provider
 * @param config - Configuration for event sourcing setup
 * @returns Service keys for all registered services
 *
 * @example
 * ```typescript
 * const services = setupEventSourcing(container, infrastructureProviderKey, {
 *     eventTable: 'order_events',
 *     outboxTable: 'order_outbox',
 *     prefix: 'orders',
 *     factory: (c) => new OrderFactory(),
 *     synchronousConsumers: [orderProjectorKey],
 * });
 *
 * // Later, resolve the aggregate repository
 * const orderRepo = container.resolve(services.aggregateRepository);
 * ```
 */
export function setupEventSourcing<Stream extends AggregateStream<Stream>>(
    container: DependencyContainer,
    providerKey: ServiceKey<InfrastructureProvider>,
    config: EventSourcingConfig<Stream>,
): EventSourcingServices<Stream> {
    const prefix = config.prefix ?? DEFAULT_KEY_PREFIX;

    // Generate or use provided service keys
    const keys: EventSourcingServices<Stream> = {
        aggregateRepository:
            config.serviceKeys?.aggregateRepository ?? generateKey<AggregateRepository<Stream>>('aggregateRepository', prefix),
        messageRepository:
            config.serviceKeys?.messageRepository ?? generateKey<MessageRepository<Stream>>('messageRepository', prefix),
        outboxRepository:
            config.serviceKeys?.outboxRepository ?? generateKey<OutboxRepository<Stream>>('outboxRepository', prefix),
        messageDispatcher:
            config.serviceKeys?.messageDispatcher ?? generateKey<MessageDispatcher<Stream>>('messageDispatcher', prefix),
        messageDecorator:
            config.serviceKeys?.messageDecorator ?? generateKey<MessageDecorator<Stream>>('messageDecorator', prefix),
    };

    // Cast config to access optional properties that may exist based on Stream type
    const configWithOptionals = config as EventSourcingConfig<Stream> & {
        upcasters?: unknown;
        snapshotting?: {
            snapshotTable: string;
            snapshotVersion: number;
            authoritativeSnapshots?: boolean;
            factory(container: DependencyContainer): unknown;
        };
    };

    // Register message repository
    container.register(keys.messageRepository, {
        factory: c => {
            const baseRepo = c.resolve(providerKey).createMessageRepository<Stream>(c, {
                tableName: config.eventTable,
            });

            // Wrap with upcasting if configured
            if (hasUpcasters(configWithOptionals)) {
                return new UpcastingMessageRepository(
                    configWithOptionals.upcasters,
                    baseRepo as any,
                ) as unknown as MessageRepository<Stream>;
                // Casting
            }

            return baseRepo;
        },
    });

    // Register outbox repository
    container.register(keys.outboxRepository, {
        factory: c => {
            const baseRepo = c.resolve(providerKey).createOutboxRepository<Stream>(c, {
                tableName: config.outboxTable,
            });

            // Wrap with upcasting if configured
            if (hasUpcasters(configWithOptionals)) {
                return new UpcastingOutboxRepository(
                    configWithOptionals.upcasters as any,
                    baseRepo as any,
                ) as unknown as OutboxRepository<Stream>;
            }

            return baseRepo;
        },
    });

    // Register message decorator
    container.register(keys.messageDecorator, {
        factory: () => {
            if (hasUpcasters(configWithOptionals)) {
                return new SchemaVersionMessageDecorator(
                    configWithOptionals.upcasters as any,
                ) as unknown as MessageDecorator<Stream>;
            }

            // Default no-op decorator
            return {
                decorate: messages => messages,
            };
        },
    });

    // Register message dispatcher
    container.register(keys.messageDispatcher, {
        factory: c => {
            const outboxRepo = c.resolve(keys.outboxRepository);
            const outboxDispatcher = new OutboxMessageDispatcher(outboxRepo);

            // If no synchronous consumers, just use the outbox dispatcher
            if (!config.synchronousConsumers || config.synchronousConsumers.length === 0) {
                return outboxDispatcher;
            }

            // Resolve all synchronous consumers
            const consumers = config.synchronousConsumers.map(key => c.resolve(key));
            const consumerChain = new MessageConsumerChain<Stream>(...consumers);
            const consumingDispatcher = new ConsumingMessageDispatcher<Stream>([consumerChain]);

            // Chain both dispatchers: first outbox, then sync consumers
            return new MessageDispatcherChain<Stream>(outboxDispatcher, consumingDispatcher);
        },
    });

    // Register aggregate repository
    container.register(keys.aggregateRepository, {
        factory: c => {
            const provider = c.resolve(providerKey);
            const transactionManager = provider.createTransactionManager(c);
            const messageRepository = c.resolve(keys.messageRepository);
            const messageDispatcher = c.resolve(keys.messageDispatcher);
            const messageDecorator = c.resolve(keys.messageDecorator);

            if (hasSnapshotting(configWithOptionals)) {
                const snapshotConfig = configWithOptionals.snapshotting;
                const snapshotRepository = provider.createSnapshotRepository(c, {
                    tableName: snapshotConfig.snapshotTable,
                    version: snapshotConfig.snapshotVersion,
                });

                const factory = snapshotConfig.factory(c);

                return new AggregateRootRepositoryWithSnapshotting(
                    factory as any,
                    snapshotRepository as any,
                    messageRepository as any,
                    messageDispatcher as any,
                    messageDecorator as any,
                    snapshotConfig.authoritativeSnapshots ?? false,
                    transactionManager,
                ) as unknown as AggregateRepository<Stream>;
            }

            const factory = config.factory(c);

            return new EventSourcedAggregateRepository<Stream>(
                factory,
                messageRepository,
                messageDispatcher,
                messageDecorator,
                transactionManager,
            );
        },
    });

    return keys;
}
