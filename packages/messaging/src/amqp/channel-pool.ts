import {type ChannelModel, type ConfirmChannel} from 'amqplib';
import {WaitGroup} from '@deltic/wait-group';
import {StandardError} from '@deltic/error-standard';
import {type AMQPConnectionProvider} from './connection-provider.js';

export class ChannelPoolExhausted extends StandardError {
    static becauseOfTimeout = () =>
        new ChannelPoolExhausted(
            'Timed out waiting for an available AMQP channel',
            'amqp.channel_pool_exhausted',
        );

    static becausePoolIsEmpty = () =>
        new ChannelPoolExhausted(
            'Unexpectedly could not resolve a channel from the pool',
            'amqp.channel_pool_exhausted',
        );
}

export class ChannelPoolClosed extends StandardError {
    static whileRetrievingConnection = () =>
        new ChannelPoolClosed(
            'Could not retrieve a connection when the pool is closing or closed',
            'amqp.channel_pool_closed',
        );
}

export class ChannelNotLeased extends StandardError {
    static onRelease = () =>
        new ChannelNotLeased(
            'Tried releasing a channel that was not leased',
            'amqp.channel_not_leased',
        );
}

export type AMQPChannelPoolOptions = {
    min?: number;
    max?: number;
    connectionName?: string;
    connectionTimeout?: number;
    prefetchCount?: number;
};

/**
 * Channels are relatively lightweight constructs that talk over connections. They require
 * asynchronous life-cycle management, which makes them a little difficult to deal with
 * when depending on a pool. Having to resolve a channel and managing its lifecycle in every
 * part that requires it is tedious. By using a channel pool, we can reduce this burden and
 * manage their lifecycle centrally.
 */
export class AMQPChannelPool {
    private closing: boolean = false;
    private blockers: PromiseWithResolvers<void>[] = [];
    private shutdownWaiter = new WaitGroup();
    private activeConnection: ChannelModel | undefined = undefined;
    private pool: ConfirmChannel[] = [];
    private leased = new Set<ConfirmChannel>();
    private usable = new Set<ConfirmChannel>();

    constructor(
        private readonly connectionProvider: AMQPConnectionProvider,
        private readonly options: AMQPChannelPoolOptions = {},
    ) {
        const min = this.options.min ?? 10;
        const max = this.options.max ?? 100;

        if (min < 0 || max < min) {
            throw new Error('Min needs to be positive and less than max.');
        }
    }

    async channel(timeout: number = 5000): Promise<ConfirmChannel> {
        /**
         * The connection is resolved before the pool is consulted, because a pooled channel does
         * not outlive the connection it was opened on. Asking first is what lets a dropped
         * connection empty the pool, and what gets a new one established at all: a pool served
         * without asking never reports that its channels have nothing left to talk over.
         */
        let connection = await this.connection();
        const pooled = this.takeFromPool();

        if (pooled !== undefined) {
            this.shutdownWaiter.add();
            this.leased.add(pooled);

            return pooled;
        }

        const max = this.options.max ?? 100;

        if (this.leased.size >= max) {
            const blocker = Promise.withResolvers<void>();
            this.blockers.push(blocker);
            const timer = setTimeout(
                () => blocker.reject(ChannelPoolExhausted.becauseOfTimeout()),
                timeout,
            );

            try {
                await blocker.promise;
            } finally {
                clearTimeout(timer);

                /**
                 * A caller leaves the queue however its wait ends. A freed lease that wakes a caller
                 * who already gave up is lost to the callers still waiting behind it.
                 */
                const position = this.blockers.indexOf(blocker);

                if (position !== -1) {
                    this.blockers.splice(position, 1);
                }
            }

            /**
             * Being woken means a lease was freed, which is not the same as a channel waiting in
             * the pool: the lease may have been freed by a channel that died with its connection.
             * A pooled one is taken when there is one, and otherwise the acquire carries on below
             * and opens a channel on the slot that just came free — on whatever connection is
             * current now, since the one resolved before waiting may be the one that died.
             */
            connection = await this.connection();
            const waited = this.takeFromPool();

            if (waited !== undefined) {
                this.shutdownWaiter.add();
                this.leased.add(waited);

                return waited;
            }
        }

        try {
            this.shutdownWaiter.add();
            const channel = await connection.createConfirmChannel();
            const prefetchCount = this.options.prefetchCount ?? 10;
            this.usable.add(channel);

            channel.on('close', () => {
                this.usable.delete(channel);
                this.discardFromPool(channel);
            });

            /**
             * The broker closes a channel when an operation on it fails (a missing queue or
             * exchange, an unknown delivery tag), and amqplib reports that as an 'error' event.
             * Without a listener, an EventEmitter turns it into an uncaught exception that ends
             * the process. The failed operation already rejects with the same error, and the
             * 'close' event that follows takes the channel out of circulation.
             */
            channel.on('error', () => undefined);

            this.leased.add(channel);
            await channel.prefetch(prefetchCount);

            return channel;
        } catch (e) {
            this.shutdownWaiter.done();
            throw e;
        }
    }

    async release(channel: ConfirmChannel): Promise<void> {
        if (!this.leased.delete(channel)) {
            throw ChannelNotLeased.onRelease();
        }

        /**
         * A channel that died while it was leased has nothing left to offer the pool, and
         * closing it a second time only produces an error saying it is already closed.
         */
        if (!this.usable.has(channel)) {
            this.shutdownWaiter.done();
            this.wakeCallerWaitingForLease();

            return;
        }

        if (this.closing) {
            await Promise.allSettled([channel.close()]);
            this.shutdownWaiter.done();
            this.wakeCallerWaitingForLease();

            return;
        }

        const min = this.options.min ?? 10;

        if (this.pool.length > min) {
            await Promise.allSettled([channel.close()]);
            this.shutdownWaiter.done();
            this.wakeCallerWaitingForLease();

            return;
        }

        this.pool.push(channel);
        this.shutdownWaiter.done();
        this.wakeCallerWaitingForLease();
    }

    /**
     * Callers park here when every lease is taken, so what they are waiting on is a lease coming
     * free rather than a channel arriving in the pool. Those differ whenever a channel is released
     * without being pooled, which is every release during a connection drop: without a wake, a
     * caller waits out its whole timeout and reports an exhausted pool that is in fact empty.
     */
    private wakeCallerWaitingForLease(): void {
        this.blockers.shift()?.resolve();
    }

    /**
     * A channel can close while it sits idle in the pool, and the close event that removes it
     * arrives on its own turn of the event loop. Skipping the dead ones here keeps a caller from
     * ever being handed one, whichever happens first.
     */
    private takeFromPool(): ConfirmChannel | undefined {
        while (this.pool.length > 0) {
            const channel = this.pool.shift();

            if (channel !== undefined && this.usable.has(channel)) {
                return channel;
            }
        }

        return undefined;
    }

    private discardFromPool(channel: ConfirmChannel): void {
        const position = this.pool.indexOf(channel);

        if (position !== -1) {
            this.pool.splice(position, 1);
        }
    }

    private async connection(): Promise<ChannelModel> {
        if (this.closing) {
            throw ChannelPoolClosed.whileRetrievingConnection();
        }

        const connection = await this.connectionProvider.connection(
            this.options.connectionName,
            this.options.connectionTimeout,
        );

        /**
         * When we have leased channels and there is a new connection resolved, the pool
         * is no longer useful. Any channel that was in use was connected to a closed connection.
         */
        if (this.activeConnection !== connection) {
            this.pool = [];
        }

        this.activeConnection = connection;

        return connection;
    }

    async close(timeout?: number): Promise<void> {
        this.closing = true;
        const pooled = this.pool;
        this.pool = [];

        /**
         * Closing a channel whose connection already went down rejects with "Channel closed".
         * Settling those rejections is what keeps a broker outage during shutdown from ending the
         * process on an unhandled rejection instead of closing the pool.
         */
        await Promise.allSettled(pooled.map(channel => channel.close()));
        await this.shutdownWaiter.wait(timeout);
    }
}
