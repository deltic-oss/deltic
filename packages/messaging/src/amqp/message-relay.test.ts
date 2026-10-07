import {EventEmitter} from 'node:events';
import type {Message as AMQPMessage, ConfirmChannel} from 'amqplib';
import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from '../index.js';
import {createMessage} from '../helpers.js';
import type {MessageDeliveryCounter} from '../message-delivery-counter.js';
import {AMQPMessageRelay} from './message-relay.js';
import type {AMQPChannelPool} from './channel-pool.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        example: {value: string};
    };
}

type DeliveryHandler = (message: AMQPMessage | null) => void;

let deliveryTag = 0;

function amqpDeliveryOf(content: string, redelivered: boolean = false): AMQPMessage {
    return {
        content: Buffer.from(content),
        fields: {deliveryTag: ++deliveryTag, redelivered, exchange: '', routingKey: '', consumerTag: 'tag'},
        properties: {contentType: 'application/json', headers: {}},
    } as unknown as AMQPMessage;
}

function amqpDeliveryFor(message: AnyMessageFrom<ExampleStream>, redelivered: boolean = false): AMQPMessage {
    return amqpDeliveryOf(JSON.stringify(message), redelivered);
}

/**
 * Stands in for a ConfirmChannel so deliveries, acks and nacks can be observed
 * without a broker. Every outcome is awaitable so tests never have to sleep.
 */
class ObservableChannel extends EventEmitter {
    readonly acked: AMQPMessage[] = [];
    readonly nacked: {message: AMQPMessage; requeue: boolean}[] = [];
    readonly cancelledTags: string[] = [];
    closed: boolean = false;
    failsToCancel: boolean = false;
    private readonly handlers = new Map<string, PromiseWithResolvers<DeliveryHandler>>();
    private readonly outcomeWaiters: {count: number; resolve: () => void}[] = [];

    constructor(private readonly missingQueues: Set<string> = new Set()) {
        super();
    }

    private handlerFor(queueName: string): PromiseWithResolvers<DeliveryHandler> {
        const existing = this.handlers.get(queueName);

        if (existing !== undefined) {
            return existing;
        }

        const created = Promise.withResolvers<DeliveryHandler>();
        this.handlers.set(queueName, created);

        return created;
    }

    async consume(queueName: string, handler: DeliveryHandler): Promise<{consumerTag: string}> {
        /**
         * The broker closes the channel over a queue that does not exist. amqplib emits the
         * channel's 'close' before the rejected consume reaches the code awaiting it.
         */
        if (this.missingQueues.has(queueName)) {
            this.closed = true;
            this.emit('close');

            throw new Error(`Channel closed by server: 404 (NOT-FOUND) with message "no queue '${queueName}'"`);
        }

        this.handlerFor(queueName).resolve(handler);

        return {consumerTag: `tag:${queueName}`};
    }

    async cancel(consumerTag: string): Promise<void> {
        if (this.failsToCancel) {
            throw new Error('Channel closed');
        }

        this.cancelledTags.push(consumerTag);
    }

    ack(message: AMQPMessage): void {
        this.acked.push(message);
        this.releaseOutcomeWaiters();
    }

    nack(message: AMQPMessage, _allUpTo: boolean, requeue: boolean): void {
        this.nacked.push({message, requeue});
        this.releaseOutcomeWaiters();
    }

    async waitForConfirms(): Promise<void> {}

    async prefetch(): Promise<void> {}

    async close(): Promise<void> {
        this.closed = true;
        this.emit('close');
    }

    deliveryTo(queueName: string): Promise<DeliveryHandler> {
        return this.handlerFor(queueName).promise;
    }

    /**
     * Resolves once the relay has acked or nacked the given number of deliveries.
     */
    outcomes(count: number): Promise<void> {
        if (this.acked.length + this.nacked.length >= count) {
            return Promise.resolve();
        }

        const {promise, resolve} = Promise.withResolvers<void>();
        this.outcomeWaiters.push({count, resolve});

        return promise;
    }

    private releaseOutcomeWaiters(): void {
        const settled = this.acked.length + this.nacked.length;

        for (const waiter of this.outcomeWaiters.filter(w => w.count <= settled)) {
            waiter.resolve();
        }
    }
}

class ObservableChannelPool {
    readonly channels: ObservableChannel[] = [];
    readonly released: ObservableChannel[] = [];
    readonly missingQueues = new Set<string>();
    private readonly nextRequests: (() => Promise<ObservableChannel>)[] = [];
    requests: number = 0;

    async channel(): Promise<ObservableChannel> {
        this.requests++;
        const nextRequest = this.nextRequests.shift();

        if (nextRequest !== undefined) {
            return nextRequest();
        }

        return this.openChannel();
    }

    private openChannel(): ObservableChannel {
        const channel = new ObservableChannel(this.missingQueues);
        this.channels.push(channel);

        return channel;
    }

    failNextRequest(error: Error): void {
        this.nextRequests.push(async () => {
            throw error;
        });
    }

    /**
     * Keeps the next request waiting, the way acquiring a channel waits while the broker is
     * away, until the returned function hands it a channel.
     */
    holdNextRequest(): () => ObservableChannel {
        const held = Promise.withResolvers<ObservableChannel>();
        this.nextRequests.push(() => held.promise);

        return () => {
            const channel = this.openChannel();
            held.resolve(channel);

            return channel;
        };
    }

    async release(channel: ConfirmChannel): Promise<void> {
        this.released.push(channel as unknown as ObservableChannel);
    }

    get lastChannel(): ObservableChannel {
        return this.channels[this.channels.length - 1];
    }

    asChannelPool(): AMQPChannelPool {
        return this as unknown as AMQPChannelPool;
    }
}

function consumerThatCollects(collected: AnyMessageFrom<ExampleStream>[]): MessageConsumer<ExampleStream> {
    return {
        async consume(message) {
            collected.push(message);
        },
    };
}

const queueName = 'example_queue';

class BrokerIsGone extends Error {
    readonly isUnrecoverable = true as const;
}

describe('AMQPMessageRelay', () => {
    let pool: ObservableChannelPool;
    let relay: AMQPMessageRelay<ExampleStream> | undefined;

    beforeEach(() => {
        pool = new ObservableChannelPool();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await relay?.stop();
        relay = undefined;
    });

    test('a message the consumer handled is acked', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'})));
        await channel.outcomes(1);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'one'}]);
        expect(channel.acked).toHaveLength(1);
        expect(channel.nacked).toHaveLength(0);
    });

    test('the queue a message came from is added to its headers', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        const secondQueue = 'other_example_queue';
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName, secondQueue]},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        (await channel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'}, {aggregate_root_id: 'a'})),
        );
        (await channel.deliveryTo(secondQueue))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'two'}, {aggregate_root_id: 'b'})),
        );
        await channel.outcomes(2);

        expect(consumed.map(m => m.headers['amqp_queue_name']).toSorted()).toEqual([queueName, secondQueue]);
    });

    test('a message the consumer rejected is nacked for redelivery', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 3},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'}, {event_id: 'event-1'})));
        await channel.outcomes(1);

        expect(channel.acked).toHaveLength(0);
        expect(channel.nacked.map(n => n.requeue)).toEqual([true]);
    });

    test('a message is dead-lettered once its delivery attempts are exhausted', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 3},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        const message = createMessage<ExampleStream>('example', {value: 'one'}, {event_id: 'event-1'});

        for (let attempt = 1; attempt <= 3; attempt++) {
            deliver(amqpDeliveryFor(message));
            await channel.outcomes(attempt);
        }

        expect(channel.nacked.map(n => n.requeue)).toEqual([true, true, false]);
    });

    test('messages for the same aggregate are handled one after the other', async () => {
        const order: string[] = [];
        const started: PromiseWithResolvers<void> = Promise.withResolvers();
        let releaseFirst: (() => void) | undefined;
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume(message) {
                    order.push(`start:${message.payload.value}`);

                    if (message.payload.value === 'one') {
                        started.resolve();
                        await new Promise<void>(resolve => {
                            releaseFirst = resolve;
                        });
                    }

                    order.push(`end:${message.payload.value}`);
                },
            },
            {queueNames: [queueName]},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        const headers = {aggregate_root_id: 'aggregate-1'};
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'}, headers)));
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'two'}, headers)));

        await started.promise;
        expect(order).toEqual(['start:one']);

        releaseFirst!();
        await channel.outcomes(2);

        expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    });

    test('stopping cancels the consumers and returns the channel to the pool', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        const running = relay.start();

        const channel = await waitForChannel(pool);
        await channel.deliveryTo(queueName);
        await relay.stop();
        await running;

        expect(channel.cancelledTags).toEqual([`tag:${queueName}`]);
        expect(pool.released).toEqual([channel]);
    });

    /**
     * A channel loss is how a broker-side disconnect surfaces. The relay has to
     * re-establish its consumers, otherwise it stays silently idle.
     */
    test('a channel that closes while running is replaced by a new one', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();

        const firstChannel = await waitForChannel(pool);
        await firstChannel.deliveryTo(queueName);

        await firstChannel.close();

        const secondChannel = await waitForChannel(pool, 2);
        const deliver = await secondChannel.deliveryTo(queueName);
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'after-reconnect'})));
        await secondChannel.outcomes(1);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'after-reconnect'}]);
    });

    test('the channel that is replaced on a reconnect is closed and handed back to the pool', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        void relay.start();
        const firstChannel = await waitForChannel(pool);
        await firstChannel.deliveryTo(queueName);

        firstChannel.emit('close');
        await (await waitForChannel(pool, 2)).deliveryTo(queueName);

        expect(pool.released).toEqual([firstChannel]);
    });

    /**
     * Delivery tags only mean something to the channel that delivered them. A message whose
     * channel is gone is redelivered by the broker; acking it on a closed channel throws.
     */
    test('a message that finishes after its channel closed is left for the broker to redeliver', async () => {
        const consumerStarted = Promise.withResolvers<void>();
        const finishConsuming = Promise.withResolvers<void>();
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    consumerStarted.resolve();
                    await finishConsuming.promise;
                },
            },
            {queueNames: [queueName]},
        );
        void relay.start();
        const firstChannel = await waitForChannel(pool);
        (await firstChannel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'})),
        );
        await consumerStarted.promise;

        firstChannel.emit('close');
        finishConsuming.resolve();
        const secondChannel = await waitForChannel(pool, 2);
        await secondChannel.deliveryTo(queueName);

        expect(firstChannel.acked).toHaveLength(0);
        expect(secondChannel.acked).toHaveLength(0);
    });

    /**
     * Counting a failed delivery can take a while when the count is shared through a store, and
     * the channel that delivered the message can close in the meantime. Settling the failure on
     * its replacement would nack whichever of its deliveries carries the same tag: a different message.
     */
    test('a failure is never settled on the channel that replaced the one that delivered it', async () => {
        const countingStarted = Promise.withResolvers<void>();
        const finishCounting = Promise.withResolvers<void>();
        const slowCounter: MessageDeliveryCounter<string> = {
            async increment() {
                countingStarted.resolve();
                await finishCounting.promise;

                return 1;
            },
        };
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName]},
            slowCounter,
        );
        void relay.start();
        const firstChannel = await waitForChannel(pool);
        (await firstChannel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'}, {event_id: 'event-1'})),
        );
        await countingStarted.promise;

        firstChannel.emit('close');
        // The reconnect waits for the task in flight, failure hook included, before it takes a new channel
        await yieldToMacrotask();
        finishCounting.resolve();
        const secondChannel = await waitForChannel(pool, 2);
        await secondChannel.deliveryTo(queueName);
        await yieldToMacrotask();

        expect(secondChannel.nacked).toHaveLength(0);
        expect(firstChannel.nacked).toHaveLength(0);
    });

    test('a failure to get a channel is retried at the restart interval', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        pool.failNextRequest(new Error('Channel unavailable'));
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();
        await yieldToMacrotask();
        expect(pool.requests).toEqual(1);

        vi.advanceTimersByTime(1000);
        const channel = await waitForChannel(pool);
        (await channel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'})),
        );
        await channel.outcomes(1);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'one'}]);
    });

    /**
     * The broker closes the channel over a queue that is not there yet, on every attempt.
     * Restarting on that close as well as on the failed attempt would retry as fast as the
     * broker can answer instead of at the restart interval.
     */
    test('a queue that is not there yet is retried at the restart interval, not at once', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        pool.missingQueues.add(queueName);
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();
        await waitForChannel(pool);

        for (let turn = 0; turn < 10; turn++) {
            await yieldToMacrotask();
        }

        expect(pool.requests).toEqual(1);

        pool.missingQueues.delete(queueName);
        vi.advanceTimersByTime(1000);
        const channel = await waitForChannel(pool, 2);
        (await channel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'})),
        );
        await channel.outcomes(1);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'one'}]);
        expect(pool.released).toEqual([pool.channels[0]]);
    });

    /**
     * A reconnect holds the start-up lock for as long as acquiring a channel waits for the
     * broker. Stopping must not fail on that lock, and the reconnect must not start consuming
     * on the stopped relay once the broker answers.
     */
    test('stopping does not wait for a reconnect that is still waiting for the broker', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const answerRequest = pool.holdNextRequest();
        const runningRelay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        const running = runningRelay.start();
        await yieldToMacrotask();

        const stopping = runningRelay.stop();
        await yieldToMacrotask();
        vi.advanceTimersByTime(5000);
        await stopping;
        await running;

        const lateChannel = answerRequest();
        await yieldToMacrotask();

        expect(pool.released).toEqual([lateChannel]);
        expect(await Promise.race([
            lateChannel.deliveryTo(queueName).then(() => 'consuming'),
            yieldToMacrotask().then(() => 'not consuming'),
        ])).toEqual('not consuming');
    });

    test('stopping completes when the consumers cannot be cancelled', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        const running = relay.start();
        const channel = await waitForChannel(pool);
        await channel.deliveryTo(queueName);
        channel.failsToCancel = true;

        await relay.stop();
        await running;

        expect(pool.released).toEqual([channel]);
    });

    /**
     * A queue can contain a message that this relay cannot deserialise, for instance
     * because a producer published something that is not JSON. That message must be
     * rejected so it can be dead-lettered, and must not take the delivery callback
     * (and with it the channel) down.
     */
    test('a payload that is not valid JSON is rejected instead of breaking delivery', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName], maxDeliveryAttempts: 3},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);

        expect(() => deliver(amqpDeliveryOf('<html>not json</html>'))).not.toThrow();

        await channel.outcomes(1);

        expect(consumed).toEqual([]);
        expect(channel.acked).toHaveLength(0);
        expect(channel.nacked.map(n => n.requeue)).toEqual([false]);
    });

    test('a message without headers is consumed with the headers the relay adds', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();
        const channel = await waitForChannel(pool);

        (await channel.deliveryTo(queueName))(amqpDeliveryOf('{"type": "example", "payload": {"value": "bare"}}'));
        await channel.outcomes(1);

        expect(consumed).toEqual([{type: 'example', payload: {value: 'bare'}, headers: {amqp_queue_name: queueName}}]);
        expect(channel.acked).toHaveLength(1);
    });

    test.each([
        ['an empty body', ''],
        ['a JSON string', '"example"'],
        ['JSON null', 'null'],
        ['an object without a type', '{"payload": {}, "headers": {}}'],
        ['headers that are not an object', '{"type": "example", "payload": {}, "headers": "none"}'],
    ])('a delivery carrying %s is rejected without reaching the consumer', async (_description, body) => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        void relay.start();
        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);

        deliver(amqpDeliveryOf(body));
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'readable'})));
        await channel.outcomes(2);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'readable'}]);
        expect(channel.nacked.map(n => n.requeue)).toEqual([false]);
        expect(channel.acked).toHaveLength(1);
    });

    /**
     * Nothing guarantees an event_id: the stack's default wiring publishes none, and other
     * producers may not either. Unrelated messages must not use up each other's attempts.
     */
    test('every message has its own delivery attempts when no event id is present', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 2},
        );
        void relay.start();

        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);

        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'}, {
            aggregate_root_id: 'aggregate-1',
        })));
        await channel.outcomes(1);
        deliver(amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'two'}, {
            aggregate_root_id: 'aggregate-2',
        })));
        await channel.outcomes(2);

        expect(channel.nacked.map(n => n.requeue)).toEqual([true, true]);
    });

    test('a message without an event id is dead-lettered once its own attempts are exhausted', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 3},
        );
        void relay.start();
        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        const message = createMessage<ExampleStream>('example', {value: 'one'}, {aggregate_root_id: 'aggregate-1'});

        for (let attempt = 1; attempt <= 3; attempt++) {
            deliver(amqpDeliveryFor(message, attempt > 1));
            await channel.outcomes(attempt);
        }

        expect(channel.nacked.map(n => n.requeue)).toEqual([true, true, false]);
    });

    test('a dead-lettered message that is put back on the queue starts its attempts over', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    throw new Error('handler is unhappy');
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 2},
        );
        void relay.start();
        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        const message = createMessage<ExampleStream>('example', {value: 'one'}, {event_id: 'event-1'});

        deliver(amqpDeliveryFor(message));
        await channel.outcomes(1);
        deliver(amqpDeliveryFor(message, true));
        await channel.outcomes(2);
        // moved back from the dead-letter queue, which makes it a first delivery again
        deliver(amqpDeliveryFor(message));
        await channel.outcomes(3);

        expect(channel.nacked.map(n => n.requeue)).toEqual([true, false, true]);
    });

    /**
     * Attempts count towards giving up on one stay of a message on the queue. Once it was handled,
     * a later failure of the same message (put back on the queue, replayed) starts over.
     */
    test('a message that was handled starts its delivery attempts over', async () => {
        const outcomes = ['fail', 'succeed', 'fail'];
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            {
                async consume() {
                    if (outcomes.shift() === 'fail') {
                        throw new Error('handler is unhappy');
                    }
                },
            },
            {queueNames: [queueName], maxDeliveryAttempts: 2},
        );
        void relay.start();
        const channel = await waitForChannel(pool);
        const deliver = await channel.deliveryTo(queueName);
        const message = createMessage<ExampleStream>('example', {value: 'one'}, {event_id: 'event-1'});

        deliver(amqpDeliveryFor(message));
        await channel.outcomes(1);
        deliver(amqpDeliveryFor(message, true));
        await channel.outcomes(2);
        deliver(amqpDeliveryFor(message, true));
        await channel.outcomes(3);

        expect(channel.acked).toHaveLength(1);
        expect(channel.nacked.map(n => n.requeue)).toEqual([true, true]);
    });

    /**
     * Relays are stopped and started again around deployments and when a supervising
     * process decides to pause consumption.
     */
    test('it can be started again after it was stopped', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        void relay.start();
        await (await waitForChannel(pool)).deliveryTo(queueName);
        await relay.stop();

        const outcome = await Promise.race([
            relay.start().then(() => 'stopped again', error => `rejected: ${(error as Error).message}`),
            new Promise<string>(resolve => setImmediate(() => resolve('running'))),
        ]);

        expect(outcome).toEqual('running');
    });

    test('a relay that gave up on the broker can be started again', async () => {
        const consumed: AnyMessageFrom<ExampleStream>[] = [];
        pool.failNextRequest(new BrokerIsGone('the broker is not coming back'));
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects(consumed),
            {queueNames: [queueName]},
        );
        await expect(relay.start()).rejects.toThrow(BrokerIsGone);

        void relay.start();
        const channel = await waitForChannel(pool);
        (await channel.deliveryTo(queueName))(
            amqpDeliveryFor(createMessage<ExampleStream>('example', {value: 'one'})),
        );
        await channel.outcomes(1);

        expect(consumed.map(m => m.payload)).toEqual([{value: 'one'}]);
    });

    test('starting a relay that is running is refused', async () => {
        relay = new AMQPMessageRelay<ExampleStream>(
            pool.asChannelPool(),
            consumerThatCollects([]),
            {queueNames: [queueName]},
        );
        void relay.start();
        await (await waitForChannel(pool)).deliveryTo(queueName);

        await expect(relay.start()).rejects.toThrow('AMQP message relay was already started');
    });
});

/**
 * The relay creates its channel asynchronously after start() is called. Waiting for
 * the channel to appear keeps the tests free of arbitrary delays.
 */
async function waitForChannel(pool: ObservableChannelPool, count: number = 1): Promise<ObservableChannel> {
    while (pool.channels.length < count) {
        await yieldToMacrotask();
    }

    return pool.channels[count - 1];
}

function yieldToMacrotask(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}
