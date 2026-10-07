import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {DependencyContainer} from '@deltic/dependency-injection';
import type {AnyMessageFrom, MessageConsumer} from '@deltic/messaging';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import {WaitGroup} from '@deltic/wait-group';
import {pgTestCredentials} from '../../pg-credentials.js';

import {setupEventSourcing} from './event-sourcing.js';
import {setupOutboxRelay} from './outbox-relay.js';
import {InfrastructureProviderUsingPostgres} from './pg.js';
import {setupRabbitMQ, setupRabbitMQDispatcher, setupRabbitMQRelay} from './rabbitmq.js';
import {TestAggregateRoot, TestAggregateRootFactory, type TestStream} from './test-stream.stubs.js';

const eventTable = 'test_stack_pipeline_events';
const outboxTable = 'test_stack_pipeline_outbox';
const connectionUrl = 'amqp://admin:admin@localhost:35671';
const exchange = 'deltic_stack_pipeline';
const queueName = 'deltic_stack_pipeline_queue';

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

    async settled(timeout: number = 10_000): Promise<void> {
        await this.waitGroup.wait(timeout);
    }
}

let pgPool: Pool;
let asyncPool: AsyncPgPool;

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);
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
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${outboxTable} (
            id BIGSERIAL PRIMARY KEY,
            consumed BOOLEAN NOT NULL DEFAULT FALSE,
            payload JSONB NOT NULL
        );
    `);
});

beforeEach(() => {
    asyncPool = new AsyncPgPool(pgPool);
});

afterEach(async () => {
    await asyncPool.flush();
    await pgPool.query(`TRUNCATE TABLE ${eventTable} RESTART IDENTITY`);
    await pgPool.query(`TRUNCATE TABLE ${outboxTable} RESTART IDENTITY`);
});

afterAll(async () => {
    await pgPool.end();
});

describe('the assembled stack', () => {
    test('carries a recorded event from PostgreSQL through RabbitMQ to a consumer', async () => {
        const container = new DependencyContainer();
        const consumer = new AwaitableConsumer();
        const poolKey = container.register('pg:pool', {factory: () => asyncPool});
        const mutexKey = container.register('pg:mutex', {factory: () => new StaticMutexUsingMemory()});
        const providerKey = container.register('infrastructure', {
            factory: () => new InfrastructureProviderUsingPostgres({pool: poolKey}),
        });
        const consumerKey = container.register('inbound:consumer', {factory: () => consumer});

        const eventSourcing = setupEventSourcing<TestStream>(container, providerKey, {
            eventTable,
            outboxTable,
            factory: () => new TestAggregateRootFactory(),
        });
        const rabbitmq = setupRabbitMQ(container, {connectionUrl, channelPoolOptions: {min: 1, max: 5}});
        const dispatcherKey = setupRabbitMQDispatcher<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            exchange,
        });
        const outboxRelay = setupOutboxRelay<TestStream>(container, {
            pool: poolKey,
            mutex: mutexKey,
            outboxRepository: eventSourcing.outboxRepository,
            dispatcher: dispatcherKey,
            channelName: `outbox_publish__${outboxTable}`,
            pollIntervalMs: 100,
        });
        const inboundRelay = setupRabbitMQRelay<TestStream>(container, {
            channelPool: rabbitmq.channelPool,
            consumer: consumerKey,
            queueNames: [queueName],
        });

        // Declare the topology the way an operator would before the application boots.
        const channel = await container.resolve(rabbitmq.channelPool).channel();
        await channel.assertExchange(exchange, 'fanout', {durable: true});
        await channel.assertQueue(queueName, {durable: true});
        await channel.bindQueue(queueName, exchange, '');
        await channel.purgeQueue(queueName);
        await container.resolve(rabbitmq.channelPool).release(channel);

        const aggregateRootId = uuid.v7();
        const aggregate = new TestAggregateRoot(aggregateRootId);
        aggregate.addItem('item-1', 'Delivered end to end');
        await container.resolve(eventSourcing.aggregateRepository).persist(aggregate);

        consumer.expect(1);
        const inboundRunning = container.resolve(inboundRelay.relay).start();
        const outboxRunning = container.resolve(outboxRelay.runner).start();

        try {
            await consumer.settled();
        } finally {
            await container.cleanup();
        }

        await inboundRunning;
        await outboxRunning;

        expect(consumer.messages).toHaveLength(1);
        expect(consumer.messages[0].type).toBe('item_added');
        expect(consumer.messages[0].payload).toEqual({itemId: 'item-1', name: 'Delivered end to end'});
        expect(consumer.messages[0].headers.aggregate_root_id).toBe(aggregateRootId);

        const outbox = await pgPool.query(`SELECT consumed FROM ${outboxTable}`);
        expect(outbox.rows).toEqual([{consumed: true}]);
    });
});
