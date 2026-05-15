import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {OutboxRepositoryUsingPg} from './outbox-repository.js';
import {NotifyingOutboxDecoratorUsingPg} from './notifying-outbox-decorator.js';
import {OutboxRelay} from '@deltic/messaging/outbox';
import {OutboxRelayRunner} from './outbox-relay-runner.js';
import {createMessageConsumer, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import {ConsumingMessageDispatcher} from '@deltic/messaging/consuming-message-dispatcher';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import {MutexUsingPostgres, type LockIdConverter} from '@deltic/mutex/pg';
import type {StaticMutex, DynamicMutex, LockValue} from '@deltic/mutex';
import type {AnyMessageFrom} from '@deltic/messaging';
import {WaitGroup} from '@deltic/wait-group';
import {setTimeout as wait} from 'node:timers/promises';

interface ExampleStream {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

const tableName = 'test_outbox_relay_runner';
const channelName = `outbox_publish__${tableName}`;
const createMessage = messageFactory<ExampleStream>();

function createNotifyingOutbox(pool: AsyncPgPool): NotifyingOutboxDecoratorUsingPg<ExampleStream> {
    return new NotifyingOutboxDecoratorUsingPg<ExampleStream>(
        pool,
        new OutboxRepositoryUsingPg<ExampleStream>(pool, tableName),
        tableName,
        {style: 'channel'},
    );
}

function staticMutexFrom<LockID extends LockValue>(mutex: DynamicMutex<LockID>, id: LockID): StaticMutex {
    return {
        tryLock: () => mutex.tryLock(id),
        lock: (timeout?: number) => mutex.lock(id, timeout),
        unlock: () => mutex.unlock(id),
    };
}

let pgPool: Pool;
let runner: OutboxRelayRunner<ExampleStream> | undefined;
let runner2: OutboxRelayRunner<ExampleStream> | undefined;
let testPool: AsyncPgPool;
let runnerPool: AsyncPgPool | undefined;
let runnerPool2: AsyncPgPool | undefined;

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id BIGSERIAL PRIMARY KEY,
            consumed BOOLEAN NOT NULL,
            payload JSON NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_${tableName}_not_consumed
            ON ${tableName} (id)
            WHERE consumed = FALSE;
    `);
});

beforeEach(() => {
    testPool = new AsyncPgPool(pgPool);
});

afterEach(async () => {
    await runner?.stop();
    await runner2?.stop();
    await runnerPool?.flush();
    await runnerPool2?.flush();
    runner = undefined;
    runner2 = undefined;
    runnerPool = undefined;
    runnerPool2 = undefined;
    const testOutbox = new OutboxRepositoryUsingPg<ExampleStream>(testPool, tableName);
    await testOutbox.truncate();
    await testPool.flush();
});

afterAll(async () => {
    await pgPool.end();
});

describe('OutboxRelayRunner', () => {
    test('messages are relayed reactively via LISTEN/NOTIFY', async () => {
        // arrange
        const consumedMessages: AnyMessageFrom<ExampleStream>[] = [];
        const waitGroup = new WaitGroup();
        const consumer = createMessageConsumer<ExampleStream>(async (message) => {
            consumedMessages.push(message);
            waitGroup.done();
        });
        runnerPool = new AsyncPgPool(pgPool);
        const runnerOutbox = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool, tableName);
        const relay = new OutboxRelay(runnerOutbox, new ConsumingMessageDispatcher([consumer]));
        runner = new OutboxRelayRunner(runnerPool, new StaticMutexUsingMemory(), relay, {
            channelName,
            pollIntervalMs: 60_000, // high interval so only NOTIFY triggers processing
        });

        void runner.start();
        await wait(500); // let runner start and LISTEN

        // act
        waitGroup.add(2);
        const testOutbox = createNotifyingOutbox(testPool);
        await testOutbox.persist([
            createMessage('ping', 1),
            createMessage('pong', 2),
        ]);

        // assert
        await waitGroup.wait(5000);
        expect(consumedMessages.map(withoutHeaders)).toEqual([
            createMessage('ping', 1),
            createMessage('pong', 2),
        ]);
    });

    test('pre-existing messages are relayed on start', async () => {
        // arrange
        const consumedMessages: AnyMessageFrom<ExampleStream>[] = [];
        const waitGroup = new WaitGroup();
        const consumer = createMessageConsumer<ExampleStream>(async (message) => {
            consumedMessages.push(message);
            waitGroup.done();
        });

        // persist messages BEFORE starting runner
        waitGroup.add(2);
        const testOutbox = new OutboxRepositoryUsingPg<ExampleStream>(testPool, tableName);
        await testOutbox.persist([
            createMessage('ping', 10),
            createMessage('pong', 20),
        ]);

        // act
        runnerPool = new AsyncPgPool(pgPool);
        const runnerOutbox = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool, tableName);
        const relay = new OutboxRelay(runnerOutbox, new ConsumingMessageDispatcher([consumer]));
        runner = new OutboxRelayRunner(runnerPool, new StaticMutexUsingMemory(), relay, {
            channelName,
            pollIntervalMs: 60_000,
        });

        void runner.start();

        // assert
        await waitGroup.wait(5000);
        expect(consumedMessages.map(withoutHeaders)).toEqual([
            createMessage('ping', 10),
            createMessage('pong', 20),
        ]);
    });

    test('runner can be stopped while waiting for lock acquisition', async () => {
        // arrange
        const neverAcquiresMutex: StaticMutex = {
            tryLock: async () => false,
            lock: async () => {},
            unlock: async () => {},
        };
        runnerPool = new AsyncPgPool(pgPool);
        const runnerOutbox = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool, tableName);
        const relay = new OutboxRelay(runnerOutbox, new ConsumingMessageDispatcher([]));
        runner = new OutboxRelayRunner(runnerPool, neverAcquiresMutex, relay, {
            channelName,
            lockRetryMs: 50,
        });

        // act
        const startPromise = runner.start();
        await wait(200);
        await runner.stop();

        // assert — start() resolves without hanging
        await startPromise;
    });

    test('relay errors reject the start promise', async () => {
        // arrange
        const relayError = new Error('consumer exploded');
        const consumer = createMessageConsumer<ExampleStream>(async () => {
            throw relayError;
        });
        runnerPool = new AsyncPgPool(pgPool);
        const runnerOutbox = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool, tableName);
        const relay = new OutboxRelay(runnerOutbox, new ConsumingMessageDispatcher([consumer]));
        runner = new OutboxRelayRunner(runnerPool, new StaticMutexUsingMemory(), relay, {
            channelName,
            pollIntervalMs: 60_000,
        });

        const startPromise = runner.start();
        await wait(500);

        // act
        const testOutbox = createNotifyingOutbox(testPool);
        await testOutbox.persist([createMessage('ping', 1)]);

        // assert
        await expect(startPromise).rejects.toThrow('consumer exploded');
    });

    test('only one runner processes when lock is contended', async () => {
        // arrange
        const consumed1: AnyMessageFrom<ExampleStream>[] = [];
        const consumed2: AnyMessageFrom<ExampleStream>[] = [];
        const waitGroup = new WaitGroup();

        const consumer1 = createMessageConsumer<ExampleStream>(async (message) => {
            consumed1.push(message);
            waitGroup.done();
        });
        const consumer2 = createMessageConsumer<ExampleStream>(async (message) => {
            consumed2.push(message);
            waitGroup.done();
        });

        runnerPool = new AsyncPgPool(pgPool);
        runnerPool2 = new AsyncPgPool(pgPool);
        const runnerOutbox1 = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool, tableName);
        const runnerOutbox2 = new OutboxRepositoryUsingPg<ExampleStream>(runnerPool2, tableName);
        const relay1 = new OutboxRelay(runnerOutbox1, new ConsumingMessageDispatcher([consumer1]));
        const relay2 = new OutboxRelay(runnerOutbox2, new ConsumingMessageDispatcher([consumer2]));

        const lockId = 999999;
        const converter: LockIdConverter<number> = {convert: () => lockId};
        const pgMutex1 = new MutexUsingPostgres(runnerPool, converter, 'fresh');
        const pgMutex2 = new MutexUsingPostgres(runnerPool2, converter, 'fresh');

        runner = new OutboxRelayRunner(runnerPool, staticMutexFrom(pgMutex1, lockId), relay1, {
            channelName,
            pollIntervalMs: 100,
            lockRetryMs: 100,
        });
        runner2 = new OutboxRelayRunner(runnerPool2, staticMutexFrom(pgMutex2, lockId), relay2, {
            channelName,
            pollIntervalMs: 100,
            lockRetryMs: 100,
        });

        void runner.start();
        void runner2.start();
        await wait(500);

        // act
        waitGroup.add(2);
        const testOutbox = createNotifyingOutbox(testPool);
        await testOutbox.persist([
            createMessage('ping', 1),
            createMessage('pong', 2),
        ]);

        await waitGroup.wait(5000);

        // assert — only one consumer should have received messages
        const total = consumed1.length + consumed2.length;
        expect(total).toEqual(2);

        const winner = consumed1.length > 0 ? consumed1 : consumed2;
        const loser = consumed1.length > 0 ? consumed2 : consumed1;

        expect(winner.map(withoutHeaders)).toEqual([
            createMessage('ping', 1),
            createMessage('pong', 2),
        ]);
        expect(loser).toHaveLength(0);
    });
});
