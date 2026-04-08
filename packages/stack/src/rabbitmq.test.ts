import {DependencyContainer, forgeServiceKey} from '@deltic/dependency-injection';
import {AMQPConnectionProvider} from '@deltic/messaging/amqp/connection-provider';
import {AMQPChannelPool} from '@deltic/messaging/amqp/channel-pool';
import {AMQPMessageDispatcher} from '@deltic/messaging/amqp/message-dispatcher';
import {AMQPMessageRelay} from '@deltic/messaging/amqp/message-relay';

import {setupRabbitMQ, setupRabbitMQDispatcher, setupRabbitMQRelay} from './rabbitmq.js';
import type {TestStream} from './test-stream.stubs.js';

// ============ setupRabbitMQ ============

describe('setupRabbitMQ', () => {
    describe('service key generation', () => {
        test('generates default service keys when none provided', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            expect(services.connectionProvider).toContain('rabbitmq:');
            expect(services.channelPool).toContain('rabbitmq:');
        });

        test('uses provided service keys when specified', () => {
            const container = new DependencyContainer();
            const connectionProviderKey = forgeServiceKey<AMQPConnectionProvider>('custom:connection');
            const channelPoolKey = forgeServiceKey<AMQPChannelPool>('custom:pool');

            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
                serviceKeys: {
                    connectionProvider: connectionProviderKey,
                    channelPool: channelPoolKey,
                },
            });

            expect(services.connectionProvider).toBe('custom:connection');
            expect(services.channelPool).toBe('custom:pool');
        });
    });

    describe('service registration', () => {
        test('registers all services in the container', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            expect(() => container.resolve(services.connectionProvider)).not.toThrow();
            expect(() => container.resolve(services.channelPool)).not.toThrow();
        });

        test('resolves connectionProvider as AMQPConnectionProvider', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const provider = container.resolve(services.connectionProvider);
            expect(provider).toBeInstanceOf(AMQPConnectionProvider);
        });

        test('resolves channelPool as AMQPChannelPool', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const pool = container.resolve(services.channelPool);
            expect(pool).toBeInstanceOf(AMQPChannelPool);
        });
    });

    describe('configuration pass-through', () => {
        test('accepts connection options', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
                connectionOptions: {heartbeat: 30},
            });

            const provider = container.resolve(services.connectionProvider);
            expect(provider).toBeInstanceOf(AMQPConnectionProvider);
        });

        test('accepts channel pool options', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
                channelPoolOptions: {min: 5, max: 50, prefetchCount: 20},
            });

            const pool = container.resolve(services.channelPool);
            expect(pool).toBeInstanceOf(AMQPChannelPool);
        });

        test('accepts connection URL as an array', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: ['amqp://host-a', 'amqp://host-b'],
            });

            const provider = container.resolve(services.connectionProvider);
            expect(provider).toBeInstanceOf(AMQPConnectionProvider);
        });

        test('accepts connection URL as a function', () => {
            const container = new DependencyContainer();
            const services = setupRabbitMQ(container, {
                connectionUrl: () => 'amqp://dynamic-host',
            });

            const provider = container.resolve(services.connectionProvider);
            expect(provider).toBeInstanceOf(AMQPConnectionProvider);
        });
    });
});

// ============ setupRabbitMQDispatcher ============

describe('setupRabbitMQDispatcher', () => {
    describe('service key generation', () => {
        test('derives key from string exchange name', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const key = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: 'orders',
            });

            expect(key).toContain('rabbitmq:dispatcher:orders');
        });

        test('uses generic key for function-based exchange resolver', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const key = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: () => 'dynamic-exchange',
            });

            expect(key).toBe('rabbitmq:dispatcher');
        });

        test('uses provided service key when specified', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const customKey = forgeServiceKey<any>('custom:dispatcher');
            const key = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: 'orders',
                serviceKey: customKey,
            });

            expect(key).toBe('custom:dispatcher');
        });
    });

    describe('multiple dispatchers', () => {
        test('multiple dispatchers for different exchanges coexist', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const orderKey = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: 'orders',
            });

            const invoiceKey = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: 'invoices',
            });

            expect(orderKey).not.toBe(invoiceKey);
            expect(() => container.resolve(orderKey)).not.toThrow();
            expect(() => container.resolve(invoiceKey)).not.toThrow();
        });
    });

    describe('service resolution', () => {
        test('resolves as AMQPMessageDispatcher', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const key = setupRabbitMQDispatcher<TestStream>(container, {
                channelPool,
                exchange: 'orders',
            });

            const dispatcher = container.resolve(key);
            expect(dispatcher).toBeInstanceOf(AMQPMessageDispatcher);
        });
    });
});

// ============ setupRabbitMQRelay ============

describe('setupRabbitMQRelay', () => {
    describe('service key generation', () => {
        test('generates default service key', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const consumerKey = container.register('test:consumer', {
                factory: () => ({consume: async () => {}}),
            });

            const services = setupRabbitMQRelay<TestStream>(container, {
                channelPool,
                consumer: consumerKey,
                queueNames: ['test_queue'],
            });

            expect(services.relay).toContain('rabbitmq:relay');
        });

        test('uses provided service key when specified', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const consumerKey = container.register('test:consumer', {
                factory: () => ({consume: async () => {}}),
            });

            const customKey = forgeServiceKey<AMQPMessageRelay<TestStream>>('custom:relay');
            const services = setupRabbitMQRelay<TestStream>(container, {
                channelPool,
                consumer: consumerKey,
                queueNames: ['test_queue'],
                serviceKey: customKey,
            });

            expect(services.relay).toBe('custom:relay');
        });
    });

    describe('service resolution', () => {
        test('resolves as AMQPMessageRelay', () => {
            const container = new DependencyContainer();
            const {channelPool} = setupRabbitMQ(container, {
                connectionUrl: 'amqp://localhost',
            });

            const consumerKey = container.register('test:consumer', {
                factory: () => ({consume: async () => {}}),
            });

            const services = setupRabbitMQRelay<TestStream>(container, {
                channelPool,
                consumer: consumerKey,
                queueNames: ['test_queue'],
            });

            const relay = container.resolve(services.relay);
            expect(relay).toBeInstanceOf(AMQPMessageRelay);
        });
    });
});
