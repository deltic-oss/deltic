import {DependencyContainer, forgeServiceKey} from '@deltic/dependency-injection';
import type {AnyMessageFrom, MessageConsumer} from '@deltic/messaging';
import {AMQPChannelPool} from '@deltic/messaging/amqp/channel-pool';
import {AMQPConnectionProvider, ConnectionShuttingDown} from '@deltic/messaging/amqp/connection-provider';
import {WaitGroup} from '@deltic/wait-group';

import {setupRabbitMQ, setupRabbitMQDispatcher, setupRabbitMQRelay} from './rabbitmq.js';
import type {TestStream} from './test-stream.stubs.js';

const connectionUrl = 'amqp://admin:admin@localhost:35671';
const exchange = 'deltic_stack_integration';
const queueName = 'deltic_stack_integration_queue';

// ============ Helpers ============

let containers: DependencyContainer[] = [];

function createContainer(): DependencyContainer {
    const container = new DependencyContainer();
    containers.push(container);

    return container;
}

class AwaitableConsumer implements MessageConsumer<TestStream> {
    readonly messages: AnyMessageFrom<TestStream>[] = [];
    private readonly waitGroup = new WaitGroup();

    expect(numberOfMessages: number): void {
        this.waitGroup.add(numberOfMessages);
    }

    async consume(message: AnyMessageFrom<TestStream>): Promise<void> {
        this.messages.push(message);
        this.waitGroup.done();
    }

    async settled(timeout: number = 5000): Promise<void> {
        await this.waitGroup.wait(timeout);
    }
}

function itemAdded(itemId: string): AnyMessageFrom<TestStream> {
    return {
        type: 'item_added',
        payload: {itemId, name: `Item ${itemId}`},
        headers: {aggregate_root_id: 'cart-1', event_id: itemId},
    };
}

async function declareTopology(pool: AMQPChannelPool): Promise<void> {
    const channel = await pool.channel();
    await channel.assertExchange(exchange, 'fanout', {durable: true});
    await channel.assertQueue(queueName, {durable: true});
    await channel.bindQueue(queueName, exchange, '');
    await channel.purgeQueue(queueName);
    await pool.release(channel);
}

beforeEach(() => {
    containers = [];
});

afterEach(async () => {
    for (const container of containers) {
        await container.cleanup();
    }

    containers = [];
});

// ============ Outbound and inbound wiring ============

describe('RabbitMQ wiring against a live broker', () => {
    test('a dispatched message is delivered to the consumer behind the relay', async () => {
        const container = createContainer();
        const consumer = new AwaitableConsumer();
        const rabbitmq = setupRabbitMQ(container, {connectionUrl, channelPoolOptions: {min: 1, max: 5}});
        const dispatcherKey = setupRabbitMQDispatcher<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            exchange,
        });
        const consumerKey = container.register('test:consumer', {factory: () => consumer});
        const relayServices = setupRabbitMQRelay<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            consumer: consumerKey,
            queueNames: [queueName],
        });

        await declareTopology(container.resolve(rabbitmq.channelPool));

        const relay = container.resolve(relayServices.relay);
        const running = relay.start();
        consumer.expect(1);
        await container.resolve(dispatcherKey).send(itemAdded('item-1'));
        await consumer.settled();

        await container.cleanup();
        await running;

        expect(consumer.messages).toHaveLength(1);
        expect(consumer.messages[0].payload).toEqual({itemId: 'item-1', name: 'Item item-1'});
    });

    /**
     * The channel pool only finishes closing once every leased channel is released. The relay
     * holds a lease for as long as it is consuming, so a cleanup that closed the pool before
     * stopping the relay would never complete.
     */
    test('cleanup stops the relay before closing the channel pool it leases from', async () => {
        const container = createContainer();
        const consumer = new AwaitableConsumer();
        const rabbitmq = setupRabbitMQ(container, {connectionUrl, channelPoolOptions: {min: 1, max: 5}});
        const consumerKey = container.register('test:consumer', {factory: () => consumer});
        const relayServices = setupRabbitMQRelay<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            consumer: consumerKey,
            queueNames: [queueName],
        });

        const pool = container.resolve(rabbitmq.channelPool);
        const provider = container.resolve(rabbitmq.connectionProvider);
        await declareTopology(pool);
        const running = container.resolve(relayServices.relay).start();
        // Publishing and consuming a message proves the relay holds a channel lease.
        const dispatcherKey = setupRabbitMQDispatcher<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            exchange,
        });
        consumer.expect(1);
        await container.resolve(dispatcherKey).send(itemAdded('item-1'));
        await consumer.settled();

        await container.cleanup();

        await expect(running).resolves.toBeUndefined();
        await expect(provider.connection()).rejects.toThrow(ConnectionShuttingDown);
    });

    test('cleanup closes the connection provider even when nothing was published', async () => {
        const container = createContainer();
        const rabbitmq = setupRabbitMQ(container, {connectionUrl});
        const provider = container.resolve(rabbitmq.connectionProvider);
        await provider.connection();

        await container.cleanup();

        await expect(provider.connection()).rejects.toThrow(ConnectionShuttingDown);
    });

    test('the relay can be shut down before it was ever started', async () => {
        const container = createContainer();
        const consumer = new AwaitableConsumer();
        const rabbitmq = setupRabbitMQ(container, {connectionUrl});
        const consumerKey = container.register('test:consumer', {factory: () => consumer});
        const relayServices = setupRabbitMQRelay<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            consumer: consumerKey,
            queueNames: [queueName],
        });
        container.resolve(relayServices.relay);

        await expect(container.cleanup()).resolves.toBeUndefined();
    });
});

// ============ Resilience of the shutdown sequence ============

// ============ Registering more than one broker or relay ============

describe('registering RabbitMQ services more than once', () => {
    test('fails fast when RabbitMQ is set up twice without explicit service keys', () => {
        const container = createContainer();
        setupRabbitMQ(container, {connectionUrl});

        expect(() => setupRabbitMQ(container, {connectionUrl: 'amqp://localhost:5673'})).toThrow(
            /already registered/,
        );
    });

    test('two brokers can coexist when service keys are provided', () => {
        const container = createContainer();
        const primary = setupRabbitMQ(container, {connectionUrl});
        const secondary = setupRabbitMQ(container, {
            connectionUrl,
            serviceKeys: {
                connectionProvider: forgeServiceKey<AMQPConnectionProvider>('secondary:connection-provider'),
                channelPool: forgeServiceKey<AMQPChannelPool>('secondary:channel-pool'),
            },
        });

        expect(container.resolve(primary.channelPool)).not.toBe(container.resolve(secondary.channelPool));
    });

    test('fails fast when two relays are registered without explicit service keys', () => {
        const container = createContainer();
        const rabbitmq = setupRabbitMQ(container, {connectionUrl});
        const consumerKey = container.register('test:consumer', {factory: () => new AwaitableConsumer()});

        setupRabbitMQRelay<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            consumer: consumerKey,
            queueNames: ['queue_one'],
        });

        expect(() =>
            setupRabbitMQRelay<TestStream>(container, {
                channelPool: rabbitmq.channelPool,
                consumer: consumerKey,
                queueNames: ['queue_two'],
            }),
        ).toThrow(/rabbitmq:relay/);
    });
});
