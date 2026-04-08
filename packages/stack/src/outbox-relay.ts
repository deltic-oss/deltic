import {DependencyContainer, forgeServiceKey, type ServiceKey} from '@deltic/dependency-injection';
import type {MessageDispatcher, StreamDefinition} from '@deltic/messaging';
import {OutboxRelay, type OutboxRepository} from '@deltic/messaging/outbox';
import {OutboxRelayRunner} from '@deltic/messaging/pg/outbox-relay-runner';
import {MultiOutboxRelayRunner} from '@deltic/messaging/pg/multi-outbox-relay-runner';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {StaticMutex} from '@deltic/mutex';

// ============ Key Generation ============

const DEFAULT_KEY_PREFIX = 'outbox-relay';

function generateKey<T>(name: string, prefix: string = DEFAULT_KEY_PREFIX): ServiceKey<T> {
    return forgeServiceKey<T>(`${prefix}:${name}`);
}

// ============ Single Outbox Relay Setup ============

/**
 * Optional overrides for auto-generated service keys.
 */
export interface OutboxRelayServiceKeys<Stream extends StreamDefinition> {
    relay?: ServiceKey<OutboxRelay<Stream>>;
    runner?: ServiceKey<OutboxRelayRunner<Stream>>;
}

/**
 * Configuration for setting up a single-stream outbox relay.
 */
export interface OutboxRelayConfig<Stream extends StreamDefinition> {
    /**
     * Service key for the AsyncPgPool used by the relay runner.
     */
    pool: ServiceKey<AsyncPgPool>;

    /**
     * Service key for the distributed mutex used for leader election.
     * Ensures only one relay runner processes at a time.
     */
    mutex: ServiceKey<StaticMutex>;

    /**
     * Service key for the outbox repository to relay messages from.
     * Typically obtained from setupEventSourcing().
     */
    outboxRepository: ServiceKey<OutboxRepository<Stream>>;

    /**
     * Service key for the message dispatcher to relay messages to.
     * This can be any dispatcher (AMQP, in-process consumer, etc.).
     */
    dispatcher: ServiceKey<MessageDispatcher<Stream>>;

    /**
     * PostgreSQL LISTEN channel name for reactive notification-based triggering.
     * Must match the channel used by the outbox repository's NOTIFY statement.
     * For OutboxRepositoryUsingPg, this is typically `outbox_publish__<tableName>`.
     */
    channelName: string;

    /**
     * Maximum number of messages to retrieve per relay cycle. Defaults to 100.
     */
    batchSize?: number;

    /**
     * Number of messages per sub-batch commit. Defaults to 25.
     */
    commitSize?: number;

    /**
     * Fallback polling interval in milliseconds when no notifications arrive. Defaults to 2500.
     */
    pollIntervalMs?: number;

    /**
     * Retry interval in milliseconds when distributed lock acquisition fails. Defaults to 1000.
     */
    lockRetryMs?: number;

    /**
     * Prefix used for auto-generated service keys.
     * Prevents key conflicts when setupOutboxRelay is used multiple times.
     * Defaults to 'outbox-relay'.
     */
    prefix?: string;

    /**
     * Optional service key overrides.
     */
    serviceKeys?: OutboxRelayServiceKeys<Stream>;
}

/**
 * Return type containing service keys for the registered outbox relay services.
 */
export interface OutboxRelayServices<Stream extends StreamDefinition> {
    /**
     * Service key for the outbox relay (pairs outbox repository with dispatcher).
     */
    relay: ServiceKey<OutboxRelay<Stream>>;

    /**
     * Service key for the outbox relay runner (the long-running process).
     * Call `start()` on the resolved runner to begin relaying.
     * The registered cleanup handler will stop the runner during container shutdown.
     */
    runner: ServiceKey<OutboxRelayRunner<Stream>>;
}

/**
 * Sets up a single-stream outbox relay that reads messages from an outbox table
 * and forwards them to a message dispatcher.
 *
 * The relay runner:
 * - Acquires a distributed lock for leader election
 * - Listens for PostgreSQL NOTIFY events for reactive triggering
 * - Falls back to polling when idle
 * - Processes messages in batches with configurable commit sizes
 * - Supports graceful shutdown via container cleanup
 *
 * @example
 * ```typescript
 * const orderES = setupEventSourcing<OrderStream>(container, provider, {...});
 *
 * const relay = setupOutboxRelay<OrderStream>(container, {
 *     pool: poolKey,
 *     mutex: mutexKey,
 *     outboxRepository: orderES.outboxRepository,
 *     dispatcher: orderDispatcherKey,
 *     channelName: 'outbox_publish__order_outbox',
 * });
 *
 * // Start relaying (blocks until stopped)
 * const runner = container.resolve(relay.runner);
 * await runner.start();
 * ```
 */
export function setupOutboxRelay<Stream extends StreamDefinition>(
    container: DependencyContainer,
    config: OutboxRelayConfig<Stream>,
): OutboxRelayServices<Stream> {
    const prefix = config.prefix ?? DEFAULT_KEY_PREFIX;

    const keys: OutboxRelayServices<Stream> = {
        relay:
            config.serviceKeys?.relay ??
            generateKey<OutboxRelay<Stream>>('relay', prefix),
        runner:
            config.serviceKeys?.runner ??
            generateKey<OutboxRelayRunner<Stream>>('runner', prefix),
    };

    container.register(keys.relay, {
        factory: (c) => new OutboxRelay<Stream>(
            c.resolve(config.outboxRepository),
            c.resolve(config.dispatcher),
        ),
    });

    container.register(keys.runner, {
        factory: (c) => new OutboxRelayRunner<Stream>(
            c.resolve(config.pool),
            c.resolve(config.mutex),
            c.resolve(keys.relay),
            {
                channelName: config.channelName,
                batchSize: config.batchSize,
                commitSize: config.commitSize,
                pollIntervalMs: config.pollIntervalMs,
                lockRetryMs: config.lockRetryMs,
            },
        ),
        cleanup: async (runner) => await runner.stop(),
    });

    return keys;
}

// ============ Multi Outbox Relay Setup ============

/**
 * An entry in the multi outbox relay, pairing an outbox repository with a dispatcher.
 */
export interface MultiOutboxRelayEntry {
    /**
     * Service key for the outbox repository.
     */
    outboxRepository: ServiceKey<OutboxRepository<any>>;

    /**
     * Service key for the message dispatcher.
     */
    dispatcher: ServiceKey<MessageDispatcher<any>>;
}

/**
 * Optional overrides for auto-generated service keys.
 */
export interface MultiOutboxRelayServiceKeys {
    runner?: ServiceKey<MultiOutboxRelayRunner>;
}

/**
 * Configuration for setting up a multi-stream outbox relay.
 */
export interface MultiOutboxRelayConfig {
    /**
     * Service key for the AsyncPgPool used by the relay runner.
     */
    pool: ServiceKey<AsyncPgPool>;

    /**
     * Service key for the distributed mutex used for leader election.
     */
    mutex: ServiceKey<StaticMutex>;

    /**
     * Map of relay entries keyed by identifier (typically the outbox table name).
     * The identifier is used to route PostgreSQL NOTIFY events to the correct relay.
     *
     * The keys must match the payload sent in PostgreSQL NOTIFY events.
     * OutboxRepositoryUsingPg sends the table name as the NOTIFY payload,
     * so use the outbox table name as the key.
     */
    relays: Record<string, MultiOutboxRelayEntry>;

    /**
     * PostgreSQL LISTEN channel name for the central notification channel.
     * Defaults to 'outbox_publish'.
     */
    channelName?: string;

    /**
     * Maximum number of messages to retrieve per relay cycle. Defaults to 100.
     */
    batchSize?: number;

    /**
     * Number of messages per sub-batch commit. Defaults to 25.
     */
    commitSize?: number;

    /**
     * Fallback polling interval in milliseconds when no notifications arrive. Defaults to 2500.
     */
    pollIntervalMs?: number;

    /**
     * Retry interval in milliseconds when distributed lock acquisition fails. Defaults to 1000.
     */
    lockRetryMs?: number;

    /**
     * Prefix used for auto-generated service keys.
     * Prevents key conflicts when setupMultiOutboxRelay is used multiple times.
     * Defaults to 'outbox-relay'.
     */
    prefix?: string;

    /**
     * Optional service key overrides.
     */
    serviceKeys?: MultiOutboxRelayServiceKeys;
}

/**
 * Return type containing the service key for the registered multi outbox relay runner.
 */
export interface MultiOutboxRelayServices {
    /**
     * Service key for the multi outbox relay runner.
     * Call `start()` on the resolved runner to begin relaying.
     * The registered cleanup handler will stop the runner during container shutdown.
     */
    runner: ServiceKey<MultiOutboxRelayRunner>;
}

/**
 * Sets up a multi-stream outbox relay that reads messages from multiple outbox tables
 * and forwards each to its corresponding message dispatcher.
 *
 * Compared to running multiple single-stream relays, the multi relay:
 * - Uses a single PostgreSQL LISTEN connection for all outboxes
 * - Holds a single distributed lock
 * - Processes different outboxes concurrently (but each outbox sequentially)
 * - Routes notifications by identifier (table name) to the correct relay
 *
 * @example
 * ```typescript
 * const orderES = setupEventSourcing<OrderStream>(container, provider, {
 *     outboxTable: 'order_outbox', ...
 * });
 * const invoiceES = setupEventSourcing<InvoiceStream>(container, provider, {
 *     outboxTable: 'invoice_outbox', ...
 * });
 *
 * const orderDispatcher = setupRabbitMQDispatcher(container, {
 *     channelPool: rabbitmq.channelPool,
 *     exchange: 'orders',
 * });
 * const invoiceDispatcher = setupRabbitMQDispatcher(container, {
 *     channelPool: rabbitmq.channelPool,
 *     exchange: 'invoices',
 * });
 *
 * const relay = setupMultiOutboxRelay(container, {
 *     pool: poolKey,
 *     mutex: mutexKey,
 *     relays: {
 *         'order_outbox': {
 *             outboxRepository: orderES.outboxRepository,
 *             dispatcher: orderDispatcher,
 *         },
 *         'invoice_outbox': {
 *             outboxRepository: invoiceES.outboxRepository,
 *             dispatcher: invoiceDispatcher,
 *         },
 *     },
 * });
 *
 * // Start relaying (blocks until stopped)
 * const runner = container.resolve(relay.runner);
 * await runner.start();
 * ```
 */
export function setupMultiOutboxRelay(
    container: DependencyContainer,
    config: MultiOutboxRelayConfig,
): MultiOutboxRelayServices {
    const prefix = config.prefix ?? DEFAULT_KEY_PREFIX;
    const key = config.serviceKeys?.runner ?? generateKey<MultiOutboxRelayRunner>('runner', prefix);

    container.register(key, {
        factory: (c) => {
            const relays: Record<string, OutboxRelay<any>> = {};

            for (const [identifier, entry] of Object.entries(config.relays)) {
                relays[identifier] = new OutboxRelay(
                    c.resolve(entry.outboxRepository),
                    c.resolve(entry.dispatcher),
                );
            }

            return new MultiOutboxRelayRunner(
                c.resolve(config.pool),
                c.resolve(config.mutex),
                relays,
                {
                    channelName: config.channelName,
                    batchSize: config.batchSize,
                    commitSize: config.commitSize,
                    pollIntervalMs: config.pollIntervalMs,
                    lockRetryMs: config.lockRetryMs,
                },
            );
        },
        cleanup: async (runner) => await runner.stop(),
    });

    return {runner: key};
}
