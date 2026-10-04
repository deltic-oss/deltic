import {Pool, type PoolClient} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {collect, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import type {StreamDefinition} from '../index.js';
import type {OutboxRepository} from '../outbox.js';
import {OutboxRepositoryUsingPg} from './outbox-repository.js';
import {NotifyingOutboxDecoratorUsingPg, type NotificationConfiguration} from './notifying-outbox-decorator.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

const tableName = 'test_notifying_outbox';
const injectionWitnessTable = 'test_notifying_outbox_injection';
const channelName = 'test_notifying_outbox_channel';
const createMessage = messageFactory<ExampleStream>();

let pgPool: Pool;
let asyncPool: AsyncPgPool;

function createOutbox(config: NotificationConfiguration): NotifyingOutboxDecoratorUsingPg<ExampleStream> {
    return new NotifyingOutboxDecoratorUsingPg<ExampleStream>(
        asyncPool,
        new OutboxRepositoryUsingPg<ExampleStream>(asyncPool, tableName),
        tableName,
        config,
    );
}

/**
 * Listens on a channel with a connection of its own, so notifications can be observed
 * the way a relay runner observes them.
 */
async function listenOn(channel: string): Promise<{
    received: (timeoutMs: number) => Promise<string | undefined>;
    stop: () => Promise<void>;
}> {
    const client: PoolClient = await pgPool.connect();
    const payloads: string[] = [];
    let waiter: ((payload: string) => void) | undefined;

    client.on('notification', notification => {
        if (notification.channel !== channel) {
            return;
        }

        payloads.push(notification.payload ?? '');
        waiter?.(notification.payload ?? '');
    });
    await client.query(`LISTEN ${channel}`);

    return {
        received: async (timeoutMs: number) => {
            if (payloads.length > 0) {
                return payloads[0];
            }

            return new Promise<string | undefined>(resolve => {
                const timer = setTimeout(() => resolve(undefined), timeoutMs);
                waiter = payload => {
                    clearTimeout(timer);
                    resolve(payload);
                };
            });
        },
        stop: async () => {
            client.removeAllListeners('notification');
            await client.query(`UNLISTEN ${channel}`);
            client.release();
        },
    };
}

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id BIGSERIAL PRIMARY KEY,
            consumed BOOLEAN NOT NULL,
            payload JSON NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${injectionWitnessTable} (
            id BIGSERIAL PRIMARY KEY
        );
    `);
});

beforeEach(() => {
    asyncPool = new AsyncPgPool(pgPool);
});

afterEach(async () => {
    await asyncPool.flush();
    await pgPool.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY`);
    await pgPool.query(`TRUNCATE TABLE ${injectionWitnessTable} RESTART IDENTITY`);
});

afterAll(async () => {
    await pgPool.end();
});

describe('NotifyingOutboxDecoratorUsingPg', () => {
    test('messages are persisted and can be read back through the decorator', async () => {
        const outbox = createOutbox({style: 'channel', channelName});

        await outbox.persist([createMessage('ping', 1), createMessage('pong', 2)]);

        expect((await collect(outbox.retrieveBatch(10))).map(withoutHeaders)).toEqual([
            createMessage('ping', 1),
            createMessage('pong', 2),
        ]);
        expect(await outbox.numberOfPendingMessages()).toEqual(2);
        expect(await outbox.numberOfConsumedMessages()).toEqual(0);
    });

    /**
     * This is the promise the outbox pattern makes: the message and the data the caller
     * wrote in the same transaction either both survive, or neither does.
     */
    test('a message written in a transaction that rolls back never reaches the outbox', async () => {
        const outbox = createOutbox({style: 'channel', channelName});

        await expect(asyncPool.runInTransaction(async () => {
            await outbox.persist([createMessage('ping', 1)]);

            throw new Error('the operation around the outbox write failed');
        })).rejects.toThrow('the operation around the outbox write failed');

        expect(await outbox.numberOfPendingMessages()).toEqual(0);
    });

    test('a message written in a transaction that commits ends up in the outbox', async () => {
        const outbox = createOutbox({style: 'channel', channelName});

        await asyncPool.runInTransaction(async () => {
            await outbox.persist([createMessage('ping', 1)]);
        });

        expect(await outbox.numberOfPendingMessages()).toEqual(1);
    });

    test('it notifies the channel of its own table', async () => {
        const listener = await listenOn(`${channelName}__${tableName}`);

        try {
            await createOutbox({style: 'channel', channelName}).persist([createMessage('ping', 1)]);

            expect(await listener.received(2000)).toEqual('');
        } finally {
            await listener.stop();
        }
    });

    test('it notifies the central channel with the table name as the payload', async () => {
        const listener = await listenOn(channelName);

        try {
            await createOutbox({style: 'central', channelName}).persist([createMessage('ping', 1)]);

            expect(await listener.received(2000)).toEqual(tableName);
        } finally {
            await listener.stop();
        }
    });

    /**
     * A relay must not be woken up for a message that was rolled back, otherwise it
     * polls for work that does not exist.
     */
    test('no notification is sent when the surrounding transaction rolls back', async () => {
        const listener = await listenOn(`${channelName}__${tableName}`);

        try {
            await expect(asyncPool.runInTransaction(async () => {
                await createOutbox({style: 'channel', channelName}).persist([createMessage('ping', 1)]);

                throw new Error('the operation around the outbox write failed');
            })).rejects.toThrow('the operation around the outbox write failed');

            expect(await listener.received(500)).toBeUndefined();
        } finally {
            await listener.stop();
        }
    });

    test('persisting no messages does not notify and does not open a transaction', async () => {
        const listener = await listenOn(`${channelName}__${tableName}`);

        try {
            await createOutbox({style: 'channel', channelName}).persist([]);

            expect(await listener.received(500)).toBeUndefined();
            expect(asyncPool.inTransaction()).toBe(false);
        } finally {
            await listener.stop();
        }
    });

    test('a failure in the wrapped repository leaves the caller transaction to the caller', async () => {
        const inner = new OutboxRepositoryUsingPg<ExampleStream>(asyncPool, tableName);
        const failingInner: OutboxRepository<ExampleStream> = {
            persist: async () => {
                throw new Error('writing to the outbox failed');
            },
            retrieveBatch: size => inner.retrieveBatch(size),
            markConsumed: messages => inner.markConsumed(messages),
            cleanupConsumedMessages: limit => inner.cleanupConsumedMessages(limit),
            truncate: () => inner.truncate(),
            numberOfPendingMessages: () => inner.numberOfPendingMessages(),
            numberOfConsumedMessages: () => inner.numberOfConsumedMessages(),
        };
        const failing = new NotifyingOutboxDecoratorUsingPg<ExampleStream>(
            asyncPool,
            failingInner,
            tableName,
            {style: 'channel', channelName},
        );

        await expect(asyncPool.runInTransaction(async () => {
            await failing.persist([createMessage('ping', 1)]);
        })).rejects.toThrow('writing to the outbox failed');

        expect(await createOutbox({style: 'channel', channelName}).numberOfPendingMessages()).toEqual(0);
    });

    /**
     * The channel name and the table name are pasted into the NOTIFY statement without
     * quoting, and the statement is sent without parameters, so Postgres accepts more
     * than one statement in it.
     *
     * see .claude-work/issues/messaging-notify-identifiers-interpolated-into-sql.md
     */
    it.fails('a channel name that is not an identifier is not executed as SQL', async () => {
        const hostile = `${channelName}; INSERT INTO ${injectionWitnessTable} (id) VALUES (DEFAULT); --`;

        await createOutbox({style: 'channel', channelName: hostile})
            .persist([createMessage('ping', 1)])
            .catch(() => undefined);

        const {rows} = await pgPool.query(`SELECT count(id) as count FROM ${injectionWitnessTable}`);

        expect(Number(rows[0].count)).toEqual(0);
    });
});
