import {randomUUID} from 'node:crypto';
import type {ConfirmChannel} from 'amqplib';
import {WaitGroup} from '@deltic/wait-group';
import {createMessageConsumer} from '../helpers.js';
import {type Message} from '../index.js';
import {AMQPChannelPool} from './channel-pool.js';
import {AMQPConnectionProvider} from './connection-provider.js';
import {AMQPMessageDispatcher} from './message-dispatcher.js';
import {AMQPMessageRelay} from './message-relay.js';

const amqpUrl = 'amqp://admin:admin@localhost:35671';
const managementUrl = 'http://localhost:35672/api';
const managementAuth = 'Basic ' + Buffer.from('admin:admin').toString('base64');

/**
 * A virtual host and a user of its own, so a test can have the broker close its connections without
 * closing those of anything else using the same broker at the same time.
 */
interface IsolatedBrokerAccess {
    readonly amqpUrl: string;
    closeConnections(): Promise<void>;
    remove(): Promise<void>;
}

async function createIsolatedBrokerAccess(): Promise<IsolatedBrokerAccess> {
    const name = `deltic_e2e_${randomUUID()}`;
    const headers = {Authorization: managementAuth, 'content-type': 'application/json'};
    await fetch(`${managementUrl}/vhosts/${name}`, {method: 'PUT', headers});
    await fetch(`${managementUrl}/users/${name}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({password: name, tags: ''}),
    });
    await fetch(`${managementUrl}/permissions/${name}/${name}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({configure: '.*', write: '.*', read: '.*'}),
    });

    return {
        amqpUrl: `amqp://${name}:${name}@localhost:35671/${name}`,
        async closeConnections() {
            await fetch(`${managementUrl}/connections/username/${name}`, {method: 'DELETE', headers});
        },
        async remove() {
            await fetch(`${managementUrl}/vhosts/${name}`, {method: 'DELETE', headers});
            await fetch(`${managementUrl}/users/${name}`, {method: 'DELETE', headers});
        },
    };
}

/**
 * Node reports an unhandled rejection a turn of the event loop after the promise settles, so an
 * assertion that none was raised has to let that turn happen first.
 */
function tickUntilRejectionsSurface(): Promise<void> {
    return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

async function until(condition: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt < 250; attempt++) {
        if (await condition()) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 20));
    }

    return false;
}

async function declareFanout(channelPool: AMQPChannelPool, exchange: string, queue: string): Promise<void> {
    const channel = await channelPool.channel();
    await channel.assertExchange(exchange, 'fanout', {durable: true});
    await channel.assertQueue(queue, {durable: true});
    await channel.bindQueue(queue, exchange, '');
    await channel.purgeQueue(queue);
    await channelPool.release(channel);
}

interface EndToEndStream {
    aggregateRootId: string;
    messages: {
        something: {
            name: string;
        };
    };
}

describe('E2E tests for AMQP dispatcher and relay', () => {
    const exchangeName = 'deltic_e2e_test';
    const queueName = 'deltic_e2e_test_queue';
    const deadLetterExchange = 'deltic_e2e_test_dlx';
    const deadLetterQueue = 'deltic_e2e_test_dlq';

    test('can timeout while waiting for a channel', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider, {
            min: 0,
            max: 0,
        });

        await expect(channelPool.channel(10)).rejects.toThrow();
    });

    test('dispatching and consuming a message', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);

        // Set up exchange, queue, and dead letter infrastructure via a raw channel
        const setupChannel = await channelPool.channel();
        await setupChannel.assertExchange(deadLetterExchange, 'fanout', {durable: true});
        await setupChannel.assertQueue(deadLetterQueue, {durable: true});
        await setupChannel.bindQueue(deadLetterQueue, deadLetterExchange, '');
        await setupChannel.assertExchange(exchangeName, 'fanout', {durable: true});
        await setupChannel.assertQueue(queueName, {
            durable: true,
            arguments: {
                'x-dead-letter-exchange': deadLetterExchange,
            },
        });
        await setupChannel.bindQueue(queueName, exchangeName, '');
        await setupChannel.purgeQueue(queueName);
        await setupChannel.purgeQueue(deadLetterQueue);
        await channelPool.release(setupChannel);

        const waitGroup = new WaitGroup();

        // Dispatch two messages
        const dispatcher = new AMQPMessageDispatcher<EndToEndStream>(channelPool, {exchange: exchangeName});
        const message1 = {
            type: 'something' as const,
            payload: {name: 'Frank'},
            headers: {event_id: '1234'},
        };
        const message2 = {
            type: 'something' as const,
            payload: {name: 'SharkTank'},
            headers: {event_id: '2345'},
        };
        await dispatcher.send(message1, message2);

        // First relay: fails all messages, causing dead-lettering after 3 attempts
        let failureCounter = 0;
        waitGroup.add(6);
        const failingRelay = new AMQPMessageRelay<EndToEndStream>(
            channelPool,
            createMessageConsumer<EndToEndStream>(async () => {
                failureCounter++;
                waitGroup.done();
                throw new Error('Did not go so well');
            }),
            {queueNames: [queueName], maxDeliveryAttempts: 3},
        );
        void failingRelay.start();

        try {
            await waitGroup.wait(2000);
        } finally {
            await failingRelay.stop();
        }

        // Second relay: consumes dead-lettered messages successfully
        waitGroup.add(2);
        const consumedMessages: Message<'something', {name: string}>[] = [];
        const deadLetterRelay = new AMQPMessageRelay<EndToEndStream>(
            channelPool,
            createMessageConsumer<EndToEndStream>(async (message) => {
                consumedMessages.push(message);
                waitGroup.done();
            }),
            {queueNames: [deadLetterQueue]},
        );
        void deadLetterRelay.start();

        try {
            await waitGroup.wait(2000);
        } finally {
            await deadLetterRelay.stop();
            await channelPool.close();
            await connectionProvider.close();
        }

        expect(
            consumedMessages.map(m => m.payload),
        ).toEqual([message1.payload, message2.payload]);

        expect(failureCounter).toEqual(6);
    });

    test('relay recovers after server-side connection close', async () => {
        const reconnectExchange = 'deltic_e2e_reconnect_test';
        const reconnectQueue = 'deltic_e2e_reconnect_test_queue';
        const broker = await createIsolatedBrokerAccess();

        const connectionProvider = new AMQPConnectionProvider(broker.amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);

        // Set up a dedicated exchange and queue for this test
        const setupChannel = await channelPool.channel();
        await setupChannel.assertExchange(reconnectExchange, 'fanout', {durable: true});
        await setupChannel.assertQueue(reconnectQueue, {durable: true});
        await setupChannel.bindQueue(reconnectQueue, reconnectExchange, '');
        await setupChannel.purgeQueue(reconnectQueue);
        await channelPool.release(setupChannel);

        const waitGroup = new WaitGroup();
        const consumedMessages: Message<'something', {name: string}>[] = [];

        // Start a relay that consumes messages
        const relay = new AMQPMessageRelay<EndToEndStream>(
            channelPool,
            createMessageConsumer<EndToEndStream>(async (message) => {
                consumedMessages.push(message);
                waitGroup.done();
            }),
            {queueNames: [reconnectQueue]},
        );
        void relay.start();

        // Dispatch a message before the connection is killed
        const dispatcher = new AMQPMessageDispatcher<EndToEndStream>(channelPool, {exchange: reconnectExchange});
        waitGroup.add(1);
        await dispatcher.send({
            type: 'something' as const,
            payload: {name: 'BeforeDisconnect'},
            headers: {event_id: 'before-1'},
        });

        // Wait for the first message to be consumed
        await waitGroup.wait(2000);
        expect(consumedMessages).toHaveLength(1);
        expect(consumedMessages[0].payload.name).toEqual('BeforeDisconnect');

        // Have the broker close the relay's connection, through the management API
        await broker.closeConnections();

        // Give the relay time to detect the disconnect and reconnect
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Dispatch another message after the connection was killed and recovered
        waitGroup.add(1);
        await dispatcher.send({
            type: 'something' as const,
            payload: {name: 'AfterReconnect'},
            headers: {event_id: 'after-1'},
        });

        try {
            await waitGroup.wait(5000);
        } finally {
            await relay.stop();
            await channelPool.close();
            await connectionProvider.close();
            await broker.remove();
        }

        expect(consumedMessages).toHaveLength(2);
        expect(consumedMessages[1].payload.name).toEqual('AfterReconnect');
    });

    /**
     * A broker restart drops the connection and takes every channel on it down with it. Closing
     * the connection the provider handed out reproduces that from the pool's side: the connection
     * and its channels are gone, and only the pool can notice.
     */
    test('a pooled channel that died with its connection is replaced instead of handed out', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);
        const channelBeforeTheDrop = await channelPool.channel();
        await channelPool.release(channelBeforeTheDrop);

        await (await connectionProvider.connection()).close();
        const channelAfterTheDrop = await channelPool.channel();

        try {
            expect(channelAfterTheDrop).not.toBe(channelBeforeTheDrop);
            await expect(channelAfterTheDrop.checkExchange('amq.fanout')).resolves.toBeDefined();
        } finally {
            await channelPool.release(channelAfterTheDrop);
            await channelPool.close(1000);
            await connectionProvider.close();
        }
    });

    test('a dispatcher keeps publishing across a connection drop', async () => {
        const exchange = 'deltic_e2e_healing_dispatch';
        const queue = 'deltic_e2e_healing_dispatch_queue';
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);
        await declareFanout(channelPool, exchange, queue);
        const dispatcher = new AMQPMessageDispatcher<EndToEndStream>(channelPool, {exchange, maxTries: 5});
        await dispatcher.send({type: 'something', payload: {name: 'Before'}, headers: {event_id: 'reconnect-1'}});

        await (await connectionProvider.connection()).close();
        await dispatcher.send({type: 'something', payload: {name: 'After'}, headers: {event_id: 'reconnect-2'}});

        const inspectionChannel = await channelPool.channel();

        try {
            expect((await inspectionChannel.checkQueue(queue)).messageCount).toBe(2);
        } finally {
            await inspectionChannel.purgeQueue(queue);
            await channelPool.release(inspectionChannel);
            await channelPool.close(1000);
            await connectionProvider.close();
        }
    });

    test('a relay resumes consuming after its connection drops', async () => {
        const exchange = 'deltic_e2e_healing_relay';
        const queue = 'deltic_e2e_healing_relay_queue';
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);
        await declareFanout(channelPool, exchange, queue);

        /**
         * The broker is asked over a second connection whether the relay is consuming, so dropping
         * the relay's connection does not take the observation down with it. Waiting for the
         * consumer rather than for a first message keeps the queue empty at the moment of the drop:
         * a message in flight would be redelivered, which is correct but says nothing about
         * whether the relay came back.
         */
        const observerProvider = new AMQPConnectionProvider(amqpUrl);
        const observerPool = new AMQPChannelPool(observerProvider);
        const observer = await observerPool.channel();
        const relayIsConsuming = async (): Promise<boolean> => (await observer.checkQueue(queue)).consumerCount === 1;

        const consumedNames: string[] = [];
        const consumed = new WaitGroup();
        const relay = new AMQPMessageRelay<EndToEndStream>(
            channelPool,
            createMessageConsumer<EndToEndStream>(async (message) => {
                consumedNames.push(message.payload.name);
                consumed.done();
            }),
            {queueNames: [queue]},
        );
        const dispatcher = new AMQPMessageDispatcher<EndToEndStream>(channelPool, {exchange});
        void relay.start();

        try {
            expect(await until(relayIsConsuming)).toBe(true);

            await (await connectionProvider.connection()).close();
            consumed.add(1);
            await dispatcher.send({type: 'something', payload: {name: 'After'}, headers: {event_id: 'relay-reconnect-1'}});
            await consumed.wait(5000);

            expect(consumedNames).toEqual(['After']);
        } finally {
            await relay.stop();
            /**
             * A reconnect that abandons the channel the relay leased leaves the pool waiting on a
             * lease that is never handed back, and this close times out rather than completing.
             */
            await channelPool.close(1000);
            await connectionProvider.close();
            await observerPool.release(observer);
            await observerPool.close(1000);
            await observerProvider.close();
        }
    });

    /**
     * The broker closes the channel over a queue that does not exist, which amqplib reports as an
     * 'error' event. Without a listener that ends the process; without pacing, the relay retries
     * as fast as the broker answers.
     */
    test('a relay starts consuming from a queue that is declared after it started', async () => {
        const exchange = 'deltic_e2e_healing_late_queue';
        const queue = 'deltic_e2e_healing_late_queue_queue';
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);
        const setupChannel = await channelPool.channel();
        await setupChannel.deleteQueue(queue);
        await channelPool.release(setupChannel);

        let channelRequests = 0;
        const countedPool = {
            channel: async (timeout?: number) => {
                channelRequests++;

                return await channelPool.channel(timeout);
            },
            release: async (channel: ConfirmChannel) => await channelPool.release(channel),
        } as unknown as AMQPChannelPool;
        const consumed = new WaitGroup();
        const relay = new AMQPMessageRelay<EndToEndStream>(
            countedPool,
            createMessageConsumer<EndToEndStream>(async () => {
                consumed.done();
            }),
            {queueNames: [queue]},
        );
        void relay.start();

        try {
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(channelRequests).toBe(1);

            await declareFanout(channelPool, exchange, queue);
            consumed.add(1);
            const dispatcher = new AMQPMessageDispatcher<EndToEndStream>(channelPool, {exchange});
            await dispatcher.send({type: 'something', payload: {name: 'Late'}, headers: {event_id: 'late-queue-1'}});
            await consumed.wait(5000);
        } finally {
            await relay.stop();
            await channelPool.close(1000);
            await connectionProvider.close();
        }
    });

    /**
     * Closing a channel whose connection already went down rejects with "Channel closed". A pool
     * that does not settle those rejections ends the process on an unhandled rejection at exactly
     * the moment it is being asked to shut down cleanly.
     */
    test('closing a pool whose connection already went down produces no unhandled rejection', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);
        const channelPool = new AMQPChannelPool(connectionProvider);
        const channel = await channelPool.channel();
        await channelPool.release(channel);
        await (await connectionProvider.connection()).close();

        const unhandledRejections: unknown[] = [];
        const recordRejection = (reason: unknown): void => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', recordRejection);

        try {
            await channelPool.close(1000);
            await connectionProvider.close();
            await tickUntilRejectionsSurface();
        } finally {
            process.off('unhandledRejection', recordRejection);
        }

        expect(unhandledRejections.map(String)).toEqual([]);
    });
});
