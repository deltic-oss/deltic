import {type ConfirmChannel, type Message as AMQPMessage} from 'amqplib';
import crc32 from 'crc/crc32';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {StandardError, isUnrecoverableError} from '@deltic/error-standard';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import {type ProcessQueue, SequentialProcessQueue, PartitionedProcessQueue} from '@deltic/process-queue';
import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from '../index.js';
import {messageWithHeaders} from '../helpers.js';
import {type AMQPChannelPool} from './channel-pool.js';
import {
    type MessageDeliveryCounter,
    MessageDeliveryCounterUsingMemory,
} from '../message-delivery-counter.js';

export type AMQPMessageRelayOptions = {
    queueNames: string[];
    maxDeliveryAttempts?: number;
    maxConcurrency?: number;
};

/**
 * Acquiring a channel already waits out the connection provider's healing window, so this only
 * paces retries of failures that are local to starting up, such as a queue that is not there yet.
 */
const restartInterval = 1000;

/**
 * Only ever thrown into the relay's own restart handling, which retries it like any other
 * failure to start consuming.
 */
class ChannelClosedWhileAttaching extends StandardError {
    static forQueues = (queueNames: string[]) =>
        new ChannelClosedWhileAttaching(
            `The AMQP channel closed while consumers were being attached to ${queueNames.join(', ')}`,
            'amqp.relay_channel_closed_while_attaching',
            {queueNames: queueNames.join(', ')},
        );
}

/**
 * Reads the message a delivery carries, or nothing when its body is not one: not JSON at all, or
 * JSON that is not an object with a `type`. Missing headers are fine, the relay adds its own.
 */
function readMessage<Stream extends StreamDefinition>(amqp: AMQPMessage): AnyMessageFrom<Stream> | undefined {
    let body: unknown;

    try {
        body = JSON.parse(amqp.content.toString());
    } catch {
        return undefined;
    }

    if (typeof body !== 'object' || body === null) {
        return undefined;
    }

    const {type, headers} = body as {type?: unknown; headers?: unknown};

    if (typeof type !== 'string') {
        return undefined;
    }

    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
        return undefined;
    }

    return body as AnyMessageFrom<Stream>;
}

function rejectWithoutRequeue(channel: ConfirmChannel, amqp: AMQPMessage): void {
    try {
        channel.nack(amqp, false, false);
    } catch {
        // A channel that is closing already; the broker requeues what it leaves unsettled.
    }
}

/**
 * Tells one message from another across its redeliveries: by `event_id` when the producer set one,
 * by its body otherwise, which every redelivery carries unchanged.
 */
function deliveryKeyOf<Stream extends StreamDefinition>(task: MessageToProcess<Stream>): string {
    const eventId = task.message.headers['event_id'];

    if ((typeof eventId === 'string' && eventId !== '') || typeof eventId === 'number') {
        return String(eventId);
    }

    return `body:${createHash('sha256').update(task.amqp.content).digest('base64')}`;
}

type MessageToProcess<Stream extends StreamDefinition> = {
    amqp: AMQPMessage;
    /**
     * Delivery tags number the deliveries of one channel, so the tag on `amqp` only means anything
     * to the channel that delivered it. A reconnect can complete while a message is still being
     * processed; settling it on the channel that replaced it would settle whichever delivery that
     * number happens to name there, which is some other message.
     */
    channel: ConfirmChannel;
    message: AnyMessageFrom<Stream>;
};

export class AMQPMessageRelay<Stream extends StreamDefinition> {
    private shuttingDown: boolean = false;
    private readonly startupIsolation = new StaticMutexUsingMemory();
    private channel: undefined | ConfirmChannel = undefined;
    private restartOnChannelClose: undefined | (() => void) = undefined;
    private restartTimer: undefined | ReturnType<typeof setTimeout> = undefined;
    private processQueue: ProcessQueue<MessageToProcess<Stream>>;
    private consumerTags: string[] = [];
    private waiter: PromiseWithResolvers<void> | undefined = undefined;
    private startupTriggers = new EventEmitter<{start: []}>();

    constructor(
        private readonly channelPool: AMQPChannelPool,
        private readonly consumer: MessageConsumer<Stream>,
        private readonly options: AMQPMessageRelayOptions,
        private readonly deliveryAttempts: MessageDeliveryCounter<string> = new MessageDeliveryCounterUsingMemory(),
    ) {
        this.startupTriggers.on('start', () => {
            void this.startup();
        });
        const maxDeliveryAttempts = this.options.maxDeliveryAttempts ?? 10;

        this.processQueue = new PartitionedProcessQueue(
            () => new SequentialProcessQueue<MessageToProcess<Stream>>({
                autoStart: true,
                processor: async (task) => {
                    await this.consumer.consume(task.message);

                    // Only a redelivery can have failed before.
                    if (task.amqp.fields.redelivered) {
                        await this.forgetDeliveryAttempts(task);
                    }

                    if (task.channel !== this.channel) {
                        // The broker redelivers anything left unsettled on the channel that is gone.
                        return;
                    }

                    task.channel.ack(task.amqp, false);
                    await task.channel.waitForConfirms();
                },
                onError: async (context) => {
                    const numberOfAttempts = await this.deliveryAttempts.increment(deliveryKeyOf(context.task));
                    const shouldRedeliver = maxDeliveryAttempts > numberOfAttempts;

                    if (!shouldRedeliver) {
                        await this.forgetDeliveryAttempts(context.task);
                    }

                    context.skipCurrentTask();

                    if (context.task.channel !== this.channel) {
                        // The broker redelivers anything left unsettled on the channel that is gone.
                        return;
                    }

                    context.task.channel.nack(context.task.amqp, false, shouldRedeliver);
                },
            }),
            (message) => crc32(String(message.message.headers['aggregate_root_id'] ?? '-')),
            options.maxConcurrency ?? 20,
        );
    }

    async start(): Promise<void> {
        this.shuttingDown = false;

        if (this.waiter) {
            throw new Error('Already started');
        }

        this.waiter = Promise.withResolvers<void>();
        this.startupTriggers.emit('start');

        return this.waiter.promise;
    }

    /**
     * Nothing awaits this, because it also runs as the handler for the channel closing. A failure
     * that escapes it has nowhere to go but the unhandled-rejection handler, and swallowing it
     * leaves the relay running without consumers. Failures are therefore handled here rather than
     * thrown: an unrecoverable one ends the run, anything else is retried.
     */
    private async startup(): Promise<void> {
        try {
            await this.attachToQueues();
        } catch (error) {
            if (this.shuttingDown) {
                return;
            }

            /**
             * A broker that is merely restarting is worth waiting for. One the connection provider
             * has already given up on is not, so that failure ends the relay, and with it the
             * process, instead of being retried for as long as the deployment lives.
             */
            if (isUnrecoverableError(error)) {
                this.waiter?.reject(error);

                return;
            }

            clearTimeout(this.restartTimer);
            this.restartTimer = setTimeout(() => this.startupTriggers.emit('start'), restartInterval);
        }
    }

    private async attachToQueues(): Promise<void> {
        await this.startupIsolation.lock(5000);

        try {
            if (this.shuttingDown) {
                return;
            }

            await this.releaseCurrentChannel();
            this.consumerTags = [];
            await this.processQueue.purge();
            this.processQueue.start();
            const channel = await this.channelPool.channel();

            /**
             * Acquiring a channel can wait out the connection provider's healing window, and a
             * stop that gave up on this lock has already wound the relay down in the meantime.
             * Consuming now would start a relay that was stopped, on a lease nothing returns.
             */
            if (this.shuttingDown) {
                await this.channelPool.release(channel);

                return;
            }

            this.channel = channel;
            let attached = false;
            let closedWhileAttaching = false;
            this.restartOnChannelClose = () => {
                /**
                 * A channel that closes while the consumers are still being attached fails that
                 * attempt, and the failure is retried at the restart interval. Restarting from here
                 * as well would retry at once: a failure that recurs on every attempt, such as a
                 * queue that is not there yet (the broker closes the channel over it), would then be
                 * retried as fast as the broker can answer.
                 */
                if (!attached) {
                    closedWhileAttaching = true;

                    return;
                }

                if (!this.shuttingDown) {
                    this.startupTriggers.emit('start');
                }
            };

            channel.on('close', this.restartOnChannelClose);

            await Promise.all(this.options.queueNames.map(async (queueName) => {
                const {consumerTag} = await channel.consume(queueName, (amqp: AMQPMessage | null) => {
                    if (!amqp) {
                        return;
                    }

                    const message = readMessage<Stream>(amqp);

                    /**
                     * amqplib closes the channel over anything this callback throws, and the broker
                     * redelivers the message to the next channel, which it closes in turn. It will
                     * never become readable, so it is rejected for good: dead-lettered when the
                     * queue has a dead-letter exchange, dropped otherwise.
                     */
                    if (message === undefined) {
                        rejectWithoutRequeue(channel, amqp);

                        return;
                    }

                    /**
                     * The processor and the error hook settle the delivery; the promise only
                     * reports the outcome again. A reconnect that purges the queue while a failure
                     * is being counted leaves that rejection without the handler the queue would
                     * otherwise attach, and an unhandled rejection ends the process.
                     */
                    this.processQueue.push({
                        amqp,
                        channel,
                        message: messageWithHeaders(message, {
                            amqp_queue_name: queueName,
                        }),
                    }).catch(() => undefined);
                }, {noAck: false});
                this.consumerTags.push(consumerTag);
            }));

            /**
             * The consumers can all be attached and the channel still be closed by the time this
             * runs: amqplib handles every frame that arrived together before the awaiting code
             * resumes. Nothing would restart a relay that went on to consider itself attached.
             */
            if (closedWhileAttaching) {
                throw ChannelClosedWhileAttaching.forQueues(this.options.queueNames);
            }

            attached = true;
        } finally {
            await this.startupIsolation.unlock();
        }
    }

    /**
     * A count is only needed while a message can still come back. Forgetting it once the message was
     * handled or dead-lettered bounds the counter, and gives a message that is put back on the queue
     * later a fresh budget. A count kept for longer than needed is harmless, so failing to forget it
     * does not fail the delivery.
     */
    private async forgetDeliveryAttempts(task: MessageToProcess<Stream>): Promise<void> {
        try {
            await this.deliveryAttempts.forget?.(deliveryKeyOf(task));
        } catch {
            // The count outlives the message, nothing more.
        }
    }

    /**
     * Reconnecting leaves the previous channel behind, and it has to be handed back or the relay
     * consumes the pool one lease per reconnect. It is closed rather than returned: the pool is
     * shared with every publisher in the process, and this channel carries consumers and whatever
     * they have prefetched. Closing cancels those consumers and returns their unsettled deliveries
     * to the broker; pooling it would hand a publisher a channel that is still being delivered to.
     */
    private async releaseCurrentChannel(): Promise<void> {
        const channel = this.channel;

        if (channel === undefined) {
            return;
        }

        this.channel = undefined;

        if (this.restartOnChannelClose !== undefined) {
            channel.off('close', this.restartOnChannelClose);
            this.restartOnChannelClose = undefined;
        }

        // A channel that went down with its connection is already closed, and says so when asked again.
        await Promise.allSettled([channel.close()]);

        try {
            await this.channelPool.release(channel);
        } catch {
            // The lease is gone either way; failing to hand it back must not stop the reconnect.
        }
    }

    async stop(): Promise<void> {
        /**
         * Shutting down is announced before the lock is attempted, and a lock that cannot be taken
         * does not stop it. A reconnect holds this lock for as long as it waits for the broker, and
         * shutdown handlers run in sequence: a stop that rejected on the lock would take every
         * handler queued behind it down with it.
         */
        this.shuttingDown = true;

        /**
         * A pending restart has nothing left to do, and it would otherwise keep the event loop
         * alive for the rest of its interval while the process is trying to exit.
         */
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;

        try {
            await this.startupIsolation.lock(5000);
            await this.startupIsolation.unlock();
        } catch {
            // A reconnect is still waiting for the broker; it notices the shutdown once it is done.
        }

        if (!this.waiter) {
            return;
        }

        /**
         * Instructs the AMQP server to stop sending messages. A channel that already went down
         * with its connection rejects every cancel, which must not stop the shutdown that is
         * winding the relay down anyway.
         */
        const channel = this.channel;

        if (channel !== undefined) {
            await Promise.allSettled(this.consumerTags.map(tag => channel.cancel(tag)));
        }

        await this.processQueue.stop();
        await this.releaseCurrentChannel();

        this.waiter.resolve();
    }
}
