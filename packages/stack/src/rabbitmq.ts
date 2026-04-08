import {DependencyContainer, forgeServiceKey, type ServiceKey} from '@deltic/dependency-injection';
import type {MessageConsumer, MessageDispatcher, StreamDefinition} from '@deltic/messaging';
import {
    AMQPConnectionProvider,
    type ConnectionUrl,
    type AMQPConnectionProviderOptions,
} from '@deltic/messaging/amqp/connection-provider';
import {AMQPChannelPool, type AMQPChannelPoolOptions} from '@deltic/messaging/amqp/channel-pool';
import {
    AMQPMessageDispatcher,
    type ExchangeResolver,
    type RoutingKeyResolver,
} from '@deltic/messaging/amqp/message-dispatcher';
import {AMQPMessageRelay} from '@deltic/messaging/amqp/message-relay';

// ============ Key Generation ============

const DEFAULT_KEY_PREFIX = 'rabbitmq';

function generateKey<T>(name: string, prefix: string = DEFAULT_KEY_PREFIX): ServiceKey<T> {
    return forgeServiceKey<T>(`${prefix}:${name}`);
}

// ============ RabbitMQ Infrastructure Setup ============

/**
 * Optional overrides for auto-generated service keys.
 */
export interface RabbitMQServiceKeys {
    connectionProvider?: ServiceKey<AMQPConnectionProvider>;
    channelPool?: ServiceKey<AMQPChannelPool>;
}

/**
 * Configuration for setting up RabbitMQ infrastructure.
 */
export interface RabbitMQConfig {
    /**
     * AMQP connection URL(s). Can be a single URL, an array of URLs for failover,
     * or a function returning URL(s) for dynamic credential resolution.
     */
    connectionUrl: ConnectionUrl;

    /**
     * Optional configuration for the AMQP connection provider.
     * Allows customizing heartbeat interval and backoff strategy.
     */
    connectionOptions?: AMQPConnectionProviderOptions;

    /**
     * Optional configuration for the AMQP channel pool.
     * Allows customizing pool size, connection naming, and prefetch count.
     */
    channelPoolOptions?: AMQPChannelPoolOptions;

    /**
     * Optional service keys for the registered services.
     * If not provided, keys will be auto-generated.
     */
    serviceKeys?: RabbitMQServiceKeys;
}

/**
 * Return type containing service keys for all registered RabbitMQ services.
 */
export interface RabbitMQServices {
    /**
     * Service key for the AMQP connection provider.
     */
    connectionProvider: ServiceKey<AMQPConnectionProvider>;

    /**
     * Service key for the AMQP channel pool.
     */
    channelPool: ServiceKey<AMQPChannelPool>;
}

/**
 * Sets up shared RabbitMQ infrastructure by registering the connection provider
 * and channel pool in the dependency container.
 *
 * Both services include cleanup handlers for graceful shutdown.
 *
 * @example
 * ```typescript
 * const rabbitmq = setupRabbitMQ(container, {
 *     connectionUrl: 'amqp://localhost',
 *     channelPoolOptions: {min: 5, max: 50},
 * });
 *
 * // The channel pool is now available for dispatchers and relays
 * const pool = container.resolve(rabbitmq.channelPool);
 * ```
 */
export function setupRabbitMQ(
    container: DependencyContainer,
    config: RabbitMQConfig,
): RabbitMQServices {
    const keys: RabbitMQServices = {
        connectionProvider:
            config.serviceKeys?.connectionProvider ??
            generateKey<AMQPConnectionProvider>('connectionProvider'),
        channelPool:
            config.serviceKeys?.channelPool ??
            generateKey<AMQPChannelPool>('channelPool'),
    };

    container.register(keys.connectionProvider, {
        factory: () => new AMQPConnectionProvider(
            config.connectionUrl,
            config.connectionOptions,
        ),
        cleanup: async (provider) => await provider.close(),
    });

    container.register(keys.channelPool, {
        factory: (c) => new AMQPChannelPool(
            c.resolve(keys.connectionProvider),
            config.channelPoolOptions,
        ),
        cleanup: async (pool) => await pool.close(),
    });

    return keys;
}

// ============ RabbitMQ Dispatcher Setup ============

/**
 * Configuration for setting up an AMQP message dispatcher.
 */
export interface RabbitMQDispatcherConfig<Stream extends StreamDefinition> {
    /**
     * Service key for the AMQP channel pool to use for publishing.
     */
    channelPool: ServiceKey<AMQPChannelPool>;

    /**
     * The exchange to publish messages to. Can be a static string or a function
     * that resolves the exchange per message.
     */
    exchange: ExchangeResolver<Stream>;

    /**
     * Optional routing key resolver. Defaults to using the message type as the routing key.
     */
    routingKey?: RoutingKeyResolver<Stream>;

    /**
     * Maximum number of publish attempts before failing. Defaults to 1.
     */
    maxTries?: number;

    /**
     * Optional service key override. When the exchange is a string, the key is
     * auto-generated as `rabbitmq:dispatcher:<exchange>`. For function-based
     * exchange resolvers, defaults to `rabbitmq:dispatcher`.
     */
    serviceKey?: ServiceKey<MessageDispatcher<Stream>>;
}

/**
 * Sets up an AMQP message dispatcher that publishes messages to a RabbitMQ exchange.
 *
 * When the exchange is a static string, the service key is automatically derived from
 * the exchange name (e.g., `rabbitmq:dispatcher:orders`), allowing multiple dispatchers
 * to coexist without requiring explicit service keys.
 *
 * @returns The service key for the registered dispatcher.
 *
 * @example
 * ```typescript
 * const rabbitmq = setupRabbitMQ(container, {connectionUrl: 'amqp://localhost'});
 *
 * // Create dispatchers for different exchanges
 * const orderDispatcher = setupRabbitMQDispatcher<OrderStream>(container, {
 *     channelPool: rabbitmq.channelPool,
 *     exchange: 'orders',
 * });
 *
 * const invoiceDispatcher = setupRabbitMQDispatcher<InvoiceStream>(container, {
 *     channelPool: rabbitmq.channelPool,
 *     exchange: 'invoices',
 * });
 * ```
 */
export function setupRabbitMQDispatcher<Stream extends StreamDefinition>(
    container: DependencyContainer,
    config: RabbitMQDispatcherConfig<Stream>,
): ServiceKey<MessageDispatcher<Stream>> {
    const keyName = typeof config.exchange === 'string'
        ? `dispatcher:${config.exchange}`
        : 'dispatcher';

    const key = config.serviceKey ?? generateKey<MessageDispatcher<Stream>>(keyName);

    container.register(key, {
        factory: (c) => new AMQPMessageDispatcher<Stream>(
            c.resolve(config.channelPool),
            {
                exchange: config.exchange,
                routingKey: config.routingKey,
                maxTries: config.maxTries,
            },
        ),
    });

    return key;
}

// ============ RabbitMQ Relay Setup (Inbound) ============

/**
 * Configuration for setting up an AMQP message relay.
 */
export interface RabbitMQRelayConfig<Stream extends StreamDefinition> {
    /**
     * Service key for the AMQP channel pool to use for consuming.
     */
    channelPool: ServiceKey<AMQPChannelPool>;

    /**
     * Service key for the message consumer that processes incoming messages.
     */
    consumer: ServiceKey<MessageConsumer<Stream>>;

    /**
     * Queue names to consume from.
     */
    queueNames: string[];

    /**
     * Maximum number of delivery attempts before dead-lettering a message.
     * Defaults to 10.
     */
    maxDeliveryAttempts?: number;

    /**
     * Number of concurrent processing partitions. Messages are partitioned
     * by aggregate root ID (via CRC32) for ordered-per-aggregate processing.
     * Defaults to 20.
     */
    maxConcurrency?: number;

    /**
     * Optional service key override. Defaults to `rabbitmq:relay`.
     */
    serviceKey?: ServiceKey<AMQPMessageRelay<Stream>>;
}

/**
 * Return type containing the service key for the registered relay.
 */
export interface RabbitMQRelayServices<Stream extends StreamDefinition> {
    /**
     * Service key for the AMQP message relay.
     * Call `start()` on the resolved relay to begin consuming.
     * The registered cleanup handler will stop the relay during container shutdown.
     */
    relay: ServiceKey<AMQPMessageRelay<Stream>>;
}

/**
 * Sets up an AMQP message relay that consumes messages from RabbitMQ queues
 * and routes them to a message consumer.
 *
 * The relay supports:
 * - Partitioned concurrent processing (ordered per aggregate root)
 * - Automatic reconnection on channel failure
 * - Dead-lettering after max delivery attempts
 * - Graceful shutdown via container cleanup
 *
 * @example
 * ```typescript
 * const rabbitmq = setupRabbitMQ(container, {connectionUrl: 'amqp://localhost'});
 *
 * const relay = setupRabbitMQRelay<OrderStream>(container, {
 *     channelPool: rabbitmq.channelPool,
 *     consumer: orderConsumerKey,
 *     queueNames: ['order_events'],
 * });
 *
 * // Start consuming (blocks until stopped)
 * const relayInstance = container.resolve(relay.relay);
 * await relayInstance.start();
 * ```
 */
export function setupRabbitMQRelay<Stream extends StreamDefinition>(
    container: DependencyContainer,
    config: RabbitMQRelayConfig<Stream>,
): RabbitMQRelayServices<Stream> {
    const key = config.serviceKey ?? generateKey<AMQPMessageRelay<Stream>>('relay');

    container.register(key, {
        factory: (c) => new AMQPMessageRelay<Stream>(
            c.resolve(config.channelPool),
            c.resolve(config.consumer),
            {
                queueNames: config.queueNames,
                maxDeliveryAttempts: config.maxDeliveryAttempts,
                maxConcurrency: config.maxConcurrency,
            },
        ),
        cleanup: async (relay) => await relay.stop(),
    });

    return {relay: key};
}

// ============ Re-exports for convenience ============

export type {ConnectionUrl, AMQPConnectionProviderOptions} from '@deltic/messaging/amqp/connection-provider';
export type {AMQPChannelPoolOptions} from '@deltic/messaging/amqp/channel-pool';
export type {ExchangeResolver, RoutingKeyResolver} from '@deltic/messaging/amqp/message-dispatcher';
