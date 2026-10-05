import {AMQPChannelPool, ChannelNotLeased, ChannelPoolClosed, ChannelPoolExhausted} from './channel-pool.js';
import {type AMQPConnectionProvider} from './connection-provider.js';
import {EventEmitter} from 'node:events';
import type {ConfirmChannel} from 'amqplib';

type FakeChannel = ConfirmChannel & {closed: boolean};

function createFakeChannel(): any {
    const channel = Object.assign(new EventEmitter(), {
        closed: false,
        prefetch: async () => {},
        close: async () => {
            channel.closed = true;
        },
        waitForConfirms: async () => {},
    });

    return channel;
}

function createFakeConnectionProvider(): AMQPConnectionProvider {
    const fakeConnection = {
        createConfirmChannel: async () => createFakeChannel(),
    };

    return {
        connection: async () => fakeConnection,
        close: async () => {},
    } as unknown as AMQPConnectionProvider;
}

/**
 * Hands out one connection at a time, like the real provider. Dropping it makes the next request
 * get a new connection and closes every channel that was opened on the old one, which is what a
 * broker restart or a network failure does.
 */
function createDroppableConnectionProvider(): {provider: AMQPConnectionProvider; drop: () => void} {
    let channels: FakeChannel[] = [];
    let connection = createConnection();

    function createConnection() {
        return {
            createConfirmChannel: async (): Promise<FakeChannel> => {
                const channel: FakeChannel = createFakeChannel();
                channels.push(channel);

                return channel;
            },
        };
    }

    return {
        provider: {
            connection: async () => connection,
            close: async () => {},
        } as unknown as AMQPConnectionProvider,
        drop: () => {
            const dying = channels;
            channels = [];
            connection = createConnection();

            for (const channel of dying) {
                channel.closed = true;
                channel.emit('close');
            }
        },
    };
}

describe('AMQPChannelPool', () => {
    test('constructor rejects invalid min/max configuration', () => {
        const provider = createFakeConnectionProvider();

        expect(() => new AMQPChannelPool(provider, {min: -1})).toThrow();
        expect(() => new AMQPChannelPool(provider, {min: 10, max: 5})).toThrow();
    });

    test('releasing a channel that was not leased throws ChannelNotLeased', async () => {
        const provider = createFakeConnectionProvider();
        const pool = new AMQPChannelPool(provider);
        const fakeChannel = createFakeChannel();

        await expect(pool.release(fakeChannel)).rejects.toThrow(ChannelNotLeased);
    });

    test('a leased channel can be released back to the pool', async () => {
        const provider = createFakeConnectionProvider();
        const pool = new AMQPChannelPool(provider);

        const channel = await pool.channel();
        await pool.release(channel);

        // Should not throw - the channel was properly returned
        await pool.close();
    });

    test('requesting a channel after close throws', async () => {
        const provider = createFakeConnectionProvider();
        const pool = new AMQPChannelPool(provider);

        await pool.close();

        await expect(pool.channel()).rejects.toThrow();
    });

    test('a released channel is handed out again instead of a fresh one', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider(), {min: 1});

        const first = await pool.channel();
        await pool.release(first);
        const second = await pool.channel();

        expect(second).toBe(first);

        await pool.release(second);
        await pool.close();
    });

    /**
     * close() closes the channels it has idling, so anything handed out afterwards would be
     * unusable: publishing on it fails with "channel closed" instead of with the error
     * that says the pool is done.
     *
     * see .claude-work/issues/messaging-channel-pool-hands-out-closed-channels.md
     */
    test('requesting a channel after close throws when the pool still holds idle channels', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider(), {min: 1});

        const channel = await pool.channel();
        await pool.release(channel);
        await pool.close();

        expect((channel as FakeChannel).closed).toBe(true);
        await expect(pool.channel()).rejects.toThrow(ChannelPoolClosed);
    });

    /**
     * Callers queue up when the pool is at its maximum. A caller that gave up must not
     * take the channel that is released next with it, because the callers behind it are
     * then left waiting while a channel sits idle in the pool.
     */
    test('a released channel goes to a caller that is still waiting', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider(), {min: 1, max: 1});

        const leased = await pool.channel();
        const givesUp = pool.channel(10);
        await expect(givesUp).rejects.toThrow(ChannelPoolExhausted);

        const stillWaiting = pool.channel(100);
        // let the caller resolve the connection and park behind the caller that gave up
        await new Promise<void>(resolve => setImmediate(resolve));
        await pool.release(leased);

        await expect(stillWaiting).resolves.toBe(leased);
    });

    test('a pooled channel that died with its connection is replaced instead of handed out', async () => {
        const {provider, drop} = createDroppableConnectionProvider();
        const pool = new AMQPChannelPool(provider);
        const channelBeforeTheDrop = await pool.channel();
        await pool.release(channelBeforeTheDrop);

        drop();
        const channelAfterTheDrop = await pool.channel();

        expect(channelAfterTheDrop).not.toBe(channelBeforeTheDrop);
        expect((channelAfterTheDrop as FakeChannel).closed).toBe(false);
    });

    test('a channel that closes while it sits in the pool is never handed out', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider());
        const idle = await pool.channel();
        await pool.release(idle);

        (idle as FakeChannel).emit('close');

        await expect(pool.channel()).resolves.not.toBe(idle);
    });

    test('a channel that died while it was leased is not returned to the pool', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider());
        const leased = await pool.channel();

        (leased as FakeChannel).emit('close');
        await pool.release(leased);

        await expect(pool.channel()).resolves.not.toBe(leased);
    });

    /**
     * A caller parked on a full pool is waiting for a lease to come free. Releasing a channel
     * that died with its connection frees the lease without putting anything in the pool, so
     * the caller has to open a new channel on the slot instead of timing out.
     */
    test('a caller waiting for a lease gets a new channel when a dead channel is released', async () => {
        const {provider, drop} = createDroppableConnectionProvider();
        const pool = new AMQPChannelPool(provider, {min: 1, max: 1});
        const leased = await pool.channel();
        const waiting = pool.channel(1000);
        await new Promise<void>(resolve => setImmediate(resolve));

        drop();
        await pool.release(leased);
        const replacement = await waiting;

        expect(replacement).not.toBe(leased);
        expect((replacement as FakeChannel).closed).toBe(false);
    });

    /**
     * The broker closes a channel over a failed operation, such as consuming from a queue that
     * does not exist, and amqplib reports it as an 'error' event. An EventEmitter without an
     * 'error' listener rethrows it, which ends the process on an uncaught exception.
     */
    test('an error the broker reports on a channel does not escape as an uncaught exception', async () => {
        const pool = new AMQPChannelPool(createFakeConnectionProvider());
        const channel = await pool.channel();

        expect(() => (channel as FakeChannel).emit('error', new Error('Channel closed by server: 404 (NOT-FOUND)')))
            .not.toThrow();
    });
});
