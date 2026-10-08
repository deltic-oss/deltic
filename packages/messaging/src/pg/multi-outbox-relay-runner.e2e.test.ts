import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {OutboxRepositoryUsingPg} from './outbox-repository.js';
import {NotifyingOutboxDecoratorUsingPg} from './notifying-outbox-decorator.js';
import {OutboxRelay} from '@deltic/messaging/outbox';
import {MultiOutboxRelayRunner, type RelayFailure} from './multi-outbox-relay-runner.js';
import {createMessageConsumer, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import {ConsumingMessageDispatcher} from '@deltic/messaging/consuming-message-dispatcher';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import {MutexUsingPostgres, type LockIdConverter} from '@deltic/mutex/pg';
import type {StaticMutex, DynamicMutex, LockValue} from '@deltic/mutex';
import type {AnyMessageFrom} from '@deltic/messaging';
import {WaitGroup} from '@deltic/wait-group';
import {setTimeout as wait} from 'node:timers/promises';

interface StreamA {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

interface StreamB {
    aggregateRootId: string | number;
    messages: {
        foo: string;
        bar: string;
    };
}

const tableA = 'test_multi_outbox_a';
const tableB = 'test_multi_outbox_b';
const channelName = 'outbox_publish';
const createMessageA = messageFactory<StreamA>();
const createMessageB = messageFactory<StreamB>();

function staticMutexFrom<LockID extends LockValue>(mutex: DynamicMutex<LockID>, id: LockID): StaticMutex {
    return {
        tryLock: () => mutex.tryLock(id),
        lock: (timeout?: number) => mutex.lock(id, timeout),
        unlock: () => mutex.unlock(id),
    };
}

function createNotifyingOutbox<Stream extends {aggregateRootId: string | number; messages: Record<string, any>}>(
    pool: AsyncPgPool,
    tableName: string,
): NotifyingOutboxDecoratorUsingPg<Stream> {
    return new NotifyingOutboxDecoratorUsingPg<Stream>(
        pool,
        new OutboxRepositoryUsingPg<Stream>(pool, tableName),
        tableName,
        {style: 'central', channelName},
    );
}

function createOutboxTable(tableName: string): string {
    return `
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id BIGSERIAL PRIMARY KEY,
            consumed BOOLEAN NOT NULL,
            payload JSON NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_${tableName}_not_consumed
            ON ${tableName} (id)
            WHERE consumed = FALSE;
    `;
}

let pgPool: Pool;
let testPool: AsyncPgPool;
let runner: MultiOutboxRelayRunner | undefined;
let runner2: MultiOutboxRelayRunner | undefined;
let runnerPool: AsyncPgPool | undefined;
let runnerPool2: AsyncPgPool | undefined;

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);
    await pgPool.query(createOutboxTable(tableA));
    await pgPool.query(createOutboxTable(tableB));
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

    const outboxA = new OutboxRepositoryUsingPg<StreamA>(testPool, tableA);
    const outboxB = new OutboxRepositoryUsingPg<StreamB>(testPool, tableB);
    await outboxA.truncate();
    await outboxB.truncate();
    await testPool.flush();
});

afterAll(async () => {
    await pgPool.end();
});

describe('MultiOutboxRelayRunner', () => {
    test('messages from multiple outboxes are routed to their respective consumers', async () => {
        // arrange
        const consumedA: AnyMessageFrom<StreamA>[] = [];
        const consumedB: AnyMessageFrom<StreamB>[] = [];
        const waitGroup = new WaitGroup();

        const consumerA = createMessageConsumer<StreamA>(async (message) => {
            consumedA.push(message);
            waitGroup.done();
        });
        const consumerB = createMessageConsumer<StreamB>(async (message) => {
            consumedB.push(message);
            waitGroup.done();
        });

        runnerPool = new AsyncPgPool(pgPool);
        const relayA = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA),
            new ConsumingMessageDispatcher([consumerA]),
        );
        const relayB = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamB>(runnerPool, tableB),
            new ConsumingMessageDispatcher([consumerB]),
        );

        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: relayA, [tableB]: relayB},
            {channelName, pollIntervalMs: 60_000},
        );

        void runner.start();
        await wait(500);

        // act
        waitGroup.add(4);
        const testOutboxA = createNotifyingOutbox<StreamA>(testPool, tableA);
        const testOutboxB = createNotifyingOutbox<StreamB>(testPool, tableB);
        await testOutboxA.persist([createMessageA('ping', 1), createMessageA('pong', 2)]);
        await testOutboxB.persist([createMessageB('foo', 'hello'), createMessageB('bar', 'world')]);

        // assert
        await waitGroup.wait(5000);
        expect(consumedA.map(withoutHeaders)).toEqual([
            createMessageA('ping', 1),
            createMessageA('pong', 2),
        ]);
        expect(consumedB.map(withoutHeaders)).toEqual([
            createMessageB('foo', 'hello'),
            createMessageB('bar', 'world'),
        ]);
    });

    test('pre-existing messages from all outboxes are relayed on start', async () => {
        // arrange
        const consumedA: AnyMessageFrom<StreamA>[] = [];
        const consumedB: AnyMessageFrom<StreamB>[] = [];
        const waitGroup = new WaitGroup();

        const consumerA = createMessageConsumer<StreamA>(async (message) => {
            consumedA.push(message);
            waitGroup.done();
        });
        const consumerB = createMessageConsumer<StreamB>(async (message) => {
            consumedB.push(message);
            waitGroup.done();
        });

        // persist BEFORE starting runner
        waitGroup.add(3);
        const testOutboxA = new OutboxRepositoryUsingPg<StreamA>(testPool, tableA);
        const testOutboxB = new OutboxRepositoryUsingPg<StreamB>(testPool, tableB);
        await testOutboxA.persist([createMessageA('ping', 10)]);
        await testOutboxB.persist([createMessageB('foo', 'existing'), createMessageB('bar', 'data')]);

        // act
        runnerPool = new AsyncPgPool(pgPool);
        const relayA = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA),
            new ConsumingMessageDispatcher([consumerA]),
        );
        const relayB = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamB>(runnerPool, tableB),
            new ConsumingMessageDispatcher([consumerB]),
        );

        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: relayA, [tableB]: relayB},
            {channelName, pollIntervalMs: 60_000},
        );

        void runner.start();

        // assert
        await waitGroup.wait(5000);
        expect(consumedA.map(withoutHeaders)).toEqual([
            createMessageA('ping', 10),
        ]);
        expect(consumedB.map(withoutHeaders)).toEqual([
            createMessageB('foo', 'existing'),
            createMessageB('bar', 'data'),
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
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            neverAcquiresMutex,
            {},
            {channelName, lockRetryMs: 50},
        );

        // act
        const startPromise = runner.start();
        await wait(200);
        await runner.stop();

        // assert — start() resolves without hanging
        await startPromise;
    });

    test('a failed batch is retried after a backoff while the other outboxes keep relaying', async () => {
        // arrange
        const consumedA: AnyMessageFrom<StreamA>[] = [];
        const consumedB: AnyMessageFrom<StreamB>[] = [];
        const failures: RelayFailure[] = [];
        const waitGroup = new WaitGroup();
        let attemptsA = 0;
        const consumerA = createMessageConsumer<StreamA>(async (message) => {
            attemptsA++;

            if (attemptsA === 1) {
                throw new Error('the broker is briefly unavailable');
            }

            consumedA.push(message);
            waitGroup.done();
        });
        const consumerB = createMessageConsumer<StreamB>(async (message) => {
            consumedB.push(message);
            waitGroup.done();
        });
        waitGroup.add(2);
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        await new OutboxRepositoryUsingPg<StreamB>(testPool, tableB).persist([createMessageB('foo', 'bar')]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {
                [tableA]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA), new ConsumingMessageDispatcher([consumerA])),
                [tableB]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamB>(runnerPool, tableB), new ConsumingMessageDispatcher([consumerB])),
            },
            {channelName, pollIntervalMs: 200, onRelayFailure: failure => failures.push(failure)},
        );

        // act
        const started = runner.start();

        // assert
        await waitGroup.wait(5000);
        expect(consumedA.map(withoutHeaders)).toEqual([createMessageA('ping', 1)]);
        expect(consumedB.map(withoutHeaders)).toEqual([createMessageB('foo', 'bar')]);
        expect(failures.map(({identifier, consecutiveFailures, retryInMs}) => ({identifier, consecutiveFailures, retryInMs}))).toEqual([
            {identifier: tableA, consecutiveFailures: 1, retryInMs: 200},
        ]);
        await runner.stop();
        await expect(started).resolves.toBeUndefined();
    });

    test('the wait doubles with every failure in a row, up to the ceiling, and starts over after a success', async () => {
        // arrange
        const failures: RelayFailure[] = [];
        const outcomes = ['fail', 'fail', 'fail', 'succeed', 'fail', 'succeed'];
        const handled = new WaitGroup();
        handled.add(2);
        const outbox = new OutboxRepositoryUsingPg<StreamA>(testPool, tableA);
        const consumer = createMessageConsumer<StreamA>(async (message) => {
            if (outcomes.shift() === 'fail') {
                throw new Error('the broker is briefly unavailable');
            }

            handled.done();

            if (message.type === 'ping') {
                // the next message only arrives once the first one got through
                void outbox.persist([createMessageA('pong', 2)]);
            }
        });
        await outbox.persist([createMessageA('ping', 1)]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA), new ConsumingMessageDispatcher([consumer]))},
            {channelName, pollIntervalMs: 50, failureBackoffCeilingMs: 150, onRelayFailure: failure => failures.push(failure)},
        );

        // act
        void runner.start();

        // assert
        await handled.wait(5000);
        expect(failures.map(({consecutiveFailures, retryInMs}) => ({consecutiveFailures, retryInMs}))).toEqual([
            {consecutiveFailures: 1, retryInMs: 50},
            {consecutiveFailures: 2, retryInMs: 100},
            {consecutiveFailures: 3, retryInMs: 150},
            {consecutiveFailures: 1, retryInMs: 50},
        ]);
    });

    test('a notification does not cut a backoff short', async () => {
        // arrange
        const attemptedAt: number[] = [];
        const consumed = new WaitGroup();
        consumed.add(2);
        const consumer = createMessageConsumer<StreamA>(async () => {
            attemptedAt.push(Date.now());

            if (attemptedAt.length === 1) {
                throw new Error('the broker is briefly unavailable');
            }

            consumed.done();
        });
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        const failed = Promise.withResolvers<void>();
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA), new ConsumingMessageDispatcher([consumer]))},
            {channelName, pollIntervalMs: 1000, onRelayFailure: () => failed.resolve()},
        );
        void runner.start();
        await failed.promise;

        // act
        await createNotifyingOutbox<StreamA>(testPool, tableA).persist([createMessageA('pong', 2)]);

        // assert
        await consumed.wait(5000);
        expect(attemptedAt[1] - attemptedAt[0]).toBeGreaterThanOrEqual(950);
    });

    test('a failure that cannot be recovered from ends the run, and start() rejects with it', async () => {
        // arrange
        const failures: RelayFailure[] = [];
        const brokerGone = Object.assign(new Error('the broker is not coming back'), {isUnrecoverable: true as const});
        const consumer = createMessageConsumer<StreamA>(async () => {
            throw brokerGone;
        });
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA), new ConsumingMessageDispatcher([consumer]))},
            {channelName, pollIntervalMs: 50, onRelayFailure: failure => failures.push(failure)},
        );

        // act
        const started = runner.start();

        // assert
        await expect(started).rejects.toBe(brokerGone);
        expect(failures).toEqual([]);
    });

    test('a failing report does not stop the retries', async () => {
        // arrange
        const consumed = Promise.withResolvers<void>();
        let attempts = 0;
        const consumer = createMessageConsumer<StreamA>(async () => {
            attempts++;

            if (attempts === 1) {
                throw new Error('the broker is briefly unavailable');
            }

            consumed.resolve();
        });
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: new OutboxRelay(new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA), new ConsumingMessageDispatcher([consumer]))},
            {
                channelName,
                pollIntervalMs: 50,
                onRelayFailure: () => {
                    throw new Error('the logger is down');
                },
            },
        );

        // act
        void runner.start();

        // assert
        await consumed.promise;
        expect(attempts).toEqual(2);
    });

    test('only one runner processes when lock is contended', async () => {
        // arrange
        const consumedA1: AnyMessageFrom<StreamA>[] = [];
        const consumedA2: AnyMessageFrom<StreamA>[] = [];
        const waitGroup = new WaitGroup();

        const consumer1 = createMessageConsumer<StreamA>(async (message) => {
            consumedA1.push(message);
            waitGroup.done();
        });
        const consumer2 = createMessageConsumer<StreamA>(async (message) => {
            consumedA2.push(message);
            waitGroup.done();
        });

        runnerPool = new AsyncPgPool(pgPool);
        runnerPool2 = new AsyncPgPool(pgPool);
        const relay1 = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA),
            new ConsumingMessageDispatcher([consumer1]),
        );
        const relay2 = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamA>(runnerPool2, tableA),
            new ConsumingMessageDispatcher([consumer2]),
        );

        const lockId = 999998;
        const converter: LockIdConverter<number> = {convert: () => lockId};
        const pgMutex1 = new MutexUsingPostgres(runnerPool, converter, 'fresh');
        const pgMutex2 = new MutexUsingPostgres(runnerPool2, converter, 'fresh');

        runner = new MultiOutboxRelayRunner(
            runnerPool,
            staticMutexFrom(pgMutex1, lockId),
            {[tableA]: relay1},
            {channelName, pollIntervalMs: 100, lockRetryMs: 100},
        );
        runner2 = new MultiOutboxRelayRunner(
            runnerPool2,
            staticMutexFrom(pgMutex2, lockId),
            {[tableA]: relay2},
            {channelName, pollIntervalMs: 100, lockRetryMs: 100},
        );

        void runner.start();
        void runner2.start();
        await wait(500);

        // act
        waitGroup.add(2);
        const testOutbox = createNotifyingOutbox<StreamA>(testPool, tableA);
        await testOutbox.persist([createMessageA('ping', 1), createMessageA('pong', 2)]);

        await waitGroup.wait(5000);

        // assert — only one consumer should have received messages
        const total = consumedA1.length + consumedA2.length;
        expect(total).toEqual(2);

        const winner = consumedA1.length > 0 ? consumedA1 : consumedA2;
        const loser = consumedA1.length > 0 ? consumedA2 : consumedA1;

        expect(winner.map(withoutHeaders)).toEqual([
            createMessageA('ping', 1),
            createMessageA('pong', 2),
        ]);
        expect(loser).toHaveLength(0);
    });

    test('notifications for unregistered identifiers are ignored', async () => {
        // arrange
        const consumedA: AnyMessageFrom<StreamA>[] = [];
        const waitGroup = new WaitGroup();

        const consumer = createMessageConsumer<StreamA>(async (message) => {
            consumedA.push(message);
            waitGroup.done();
        });

        runnerPool = new AsyncPgPool(pgPool);
        const relay = new OutboxRelay(
            new OutboxRepositoryUsingPg<StreamA>(runnerPool, tableA),
            new ConsumingMessageDispatcher([consumer]),
        );

        // Only register tableA — tableB is NOT registered
        runner = new MultiOutboxRelayRunner(
            runnerPool,
            new StaticMutexUsingMemory(),
            {[tableA]: relay},
            {channelName, pollIntervalMs: 60_000},
        );

        void runner.start();
        await wait(500);

        // act — send notification for unregistered table, then for registered table
        const testOutboxB = createNotifyingOutbox<StreamB>(testPool, tableB);
        await testOutboxB.persist([createMessageB('foo', 'ignored')]);
        await wait(200);

        waitGroup.add(1);
        const testOutboxA = createNotifyingOutbox<StreamA>(testPool, tableA);
        await testOutboxA.persist([createMessageA('ping', 42)]);

        // assert — only tableA messages consumed, no errors from tableB notification
        await waitGroup.wait(5000);
        expect(consumedA.map(withoutHeaders)).toEqual([
            createMessageA('ping', 42),
        ]);
    });
});
