import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {OutboxRepositoryUsingPg} from './outbox-repository.js';
import {NotifyingOutboxDecoratorUsingPg} from './notifying-outbox-decorator.js';
import {OutboxRelay} from '@deltic/messaging/outbox';
import {
    DuplicateOutboxLockId,
    MultiOutboxRelayRunner,
    type ClaimFailure,
    type RelayFailure,
} from './multi-outbox-relay-runner.js';
import {createMessageConsumer, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import {ConsumingMessageDispatcher} from '@deltic/messaging/consuming-message-dispatcher';
import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from '@deltic/messaging';
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

const lockA = 940_001;
const lockB = 940_002;

function relayInto<Stream extends StreamDefinition>(pool: AsyncPgPool, tableName: string, consumer: MessageConsumer<Stream>): OutboxRelay<Stream> {
    return new OutboxRelay(new OutboxRepositoryUsingPg<Stream>(pool, tableName), new ConsumingMessageDispatcher([consumer]));
}

/**
 * The backend process holding each of the given advisory locks, in the order of the lock ids.
 */
async function holdersOf(...lockIds: number[]): Promise<(number | undefined)[]> {
    const {rows} = await pgPool.query<{objid: number; pid: number}>(
        `SELECT objid::int AS objid, pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = ANY($1::int[])`,
        [lockIds],
    );

    return lockIds.map(lockId => rows.find(row => row.objid === lockId)?.pid);
}

async function eventually(condition: () => Promise<boolean>, timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error('The condition did not hold in time');
        }

        await wait(25);
    }
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
/**
 * The connections of another process: a runner on it cannot reuse a connection the first runner
 * handed back.
 */
let otherProcessPool: Pool | undefined;

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
    await otherProcessPool?.end();
    otherProcessPool = undefined;

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
            {[tableA]: {relay: relayA, lockId: lockA}, [tableB]: {relay: relayB, lockId: lockB}},
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
            {[tableA]: {relay: relayA, lockId: lockA}, [tableB]: {relay: relayB, lockId: lockB}},
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

    test('a runner that holds no outbox can be stopped', async () => {
        // arrange
        const idle = createMessageConsumer<StreamA>(async () => {});
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {[tableA]: {relay: relayInto(runnerPool, tableA, idle), lockId: lockA}}, {channelName, lockAcquisitionIntervalMs: 50});
        void runner.start();
        await eventually(async () => (await holdersOf(lockA))[0] !== undefined);
        runnerPool2 = new AsyncPgPool(pgPool);
        runner2 = new MultiOutboxRelayRunner(runnerPool2, {[tableA]: {relay: relayInto(runnerPool2, tableA, idle), lockId: lockA}}, {channelName, lockAcquisitionIntervalMs: 50});
        const started = runner2.start();
        await wait(200);

        // act
        await runner2.stop();

        // assert
        await expect(started).resolves.toBeUndefined();
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
            {
                [tableA]: {relay: relayInto(runnerPool, tableA, consumerA), lockId: lockA},
                [tableB]: {relay: relayInto(runnerPool, tableB, consumerB), lockId: lockB},
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
            {[tableA]: {relay: relayInto(runnerPool, tableA, consumer), lockId: lockA}},
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
            {[tableA]: {relay: relayInto(runnerPool, tableA, consumer), lockId: lockA}},
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
            {[tableA]: {relay: relayInto(runnerPool, tableA, consumer), lockId: lockA}},
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
            {[tableA]: {relay: relayInto(runnerPool, tableA, consumer), lockId: lockA}},
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

    test('an outbox is relayed by the runner holding its lock, and taken over once that runner stops', async () => {
        // arrange
        const consumedByFirst: number[] = [];
        const consumedBySecond: number[] = [];
        const first = new WaitGroup();
        const second = new WaitGroup();
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {
                relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(async message => {
                    consumedByFirst.push(message.payload);
                    first.done();
                })),
                lockId: lockA,
            },
        }, {channelName, pollIntervalMs: 60_000, lockAcquisitionIntervalMs: 50});
        void runner.start();
        await eventually(async () => (await holdersOf(lockA))[0] !== undefined);
        otherProcessPool = new Pool(pgTestCredentials);
        runnerPool2 = new AsyncPgPool(otherProcessPool);
        runner2 = new MultiOutboxRelayRunner(runnerPool2, {
            [tableA]: {
                relay: relayInto(runnerPool2, tableA, createMessageConsumer<StreamA>(async message => {
                    consumedBySecond.push(message.payload);
                    second.done();
                })),
                lockId: lockA,
            },
        }, {channelName, pollIntervalMs: 60_000, lockAcquisitionIntervalMs: 50});
        void runner2.start();
        await wait(200);

        // act
        first.add(1);
        await createNotifyingOutbox<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        await first.wait(5000);
        await runner.stop();
        second.add(1);
        await createNotifyingOutbox<StreamA>(testPool, tableA).persist([createMessageA('ping', 2)]);
        await second.wait(5000);

        // assert
        expect(consumedByFirst).toEqual([1]);
        expect(consumedBySecond).toEqual([2]);
    });

    test('the outboxes of a group share one connection, and every group has its own', async () => {
        // arrange
        const idleA = createMessageConsumer<StreamA>(async () => {});
        const idleB = createMessageConsumer<StreamB>(async () => {});
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {relay: relayInto(runnerPool, tableA, idleA), lockId: lockA, group: 'shared'},
            [tableB]: {relay: relayInto(runnerPool, tableB, idleB), lockId: lockB, group: 'shared'},
        }, {channelName, lockAcquisitionIntervalMs: 50});
        runnerPool2 = new AsyncPgPool(pgPool);
        runner2 = new MultiOutboxRelayRunner(runnerPool2, {
            [tableA]: {relay: relayInto(runnerPool2, tableA, idleA), lockId: lockA, group: 'first'},
            [tableB]: {relay: relayInto(runnerPool2, tableB, idleB), lockId: lockB, group: 'second'},
        }, {channelName, lockAcquisitionIntervalMs: 50});

        // act
        void runner.start();
        await eventually(async () => !(await holdersOf(lockA, lockB)).includes(undefined));
        const shared = await holdersOf(lockA, lockB);
        await runner.stop();
        void runner2.start();
        await eventually(async () => !(await holdersOf(lockA, lockB)).includes(undefined));
        const separate = await holdersOf(lockA, lockB);

        // assert
        expect(shared[0]).toEqual(shared[1]);
        expect(separate[0]).not.toEqual(separate[1]);
    });

    test('a runner relays only the groups it holds', async () => {
        // arrange
        const consumedA: AnyMessageFrom<StreamA>[] = [];
        const consumedB = Promise.withResolvers<void>();
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        await new OutboxRepositoryUsingPg<StreamB>(testPool, tableB).persist([createMessageB('foo', 'bar')]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(async message => {
                consumedA.push(message);
            })), lockId: lockA, group: 'first'},
            [tableB]: {relay: relayInto(runnerPool, tableB, createMessageConsumer<StreamB>(async () => {
                consumedB.resolve();
            })), lockId: lockB, group: 'second'},
        }, {channelName, holdGroups: ['second'], pollIntervalMs: 50, lockAcquisitionIntervalMs: 50});

        // act
        void runner.start();
        await consumedB.promise;
        await wait(200);

        // assert
        expect(consumedA).toEqual([]);
        expect(await holdersOf(lockA)).toEqual([undefined]);
    });

    test('a runner that lost the lock of an outbox stops relaying it', async () => {
        // arrange
        const consumed: number[] = [];
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(async message => {
                consumed.push(message.payload);
            })), lockId: lockA},
        }, {channelName, pollIntervalMs: 50, lockAcquisitionIntervalMs: 60_000});
        void runner.start();
        await eventually(async () => (await holdersOf(lockA))[0] !== undefined);
        const [lost] = await holdersOf(lockA);

        // act
        await pgPool.query('SELECT pg_terminate_backend($1)', [lost]);
        await eventually(async () => (await holdersOf(lockA))[0] === undefined);
        await wait(100);
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        await wait(300);

        // assert
        expect(consumed).toEqual([]);
    });

    test('an outbox whose connection dropped is claimed again on a new connection', async () => {
        // arrange
        const consumed = Promise.withResolvers<void>();
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(async () => {
                consumed.resolve();
            })), lockId: lockA},
        }, {channelName, pollIntervalMs: 60_000, lockAcquisitionIntervalMs: 50});
        void runner.start();
        await eventually(async () => (await holdersOf(lockA))[0] !== undefined);
        const [dropped] = await holdersOf(lockA);

        // act
        await pgPool.query('SELECT pg_terminate_backend($1)', [dropped]);
        await eventually(async () => ![undefined, dropped].includes((await holdersOf(lockA))[0]));
        await createNotifyingOutbox<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);

        // assert
        await consumed.promise;
    });

    test('never relays more outboxes at the same time than maxConcurrentRelays allows', async () => {
        // arrange
        const started: string[] = [];
        const gates: Record<string, PromiseWithResolvers<void>> = {[tableA]: Promise.withResolvers(), [tableB]: Promise.withResolvers()};
        const done = new WaitGroup();
        done.add(2);
        const gated = (tableName: string) => async () => {
            started.push(tableName);
            await gates[tableName].promise;
            done.done();
        };
        await new OutboxRepositoryUsingPg<StreamA>(testPool, tableA).persist([createMessageA('ping', 1)]);
        await new OutboxRepositoryUsingPg<StreamB>(testPool, tableB).persist([createMessageB('foo', 'bar')]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            [tableA]: {relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(gated(tableA))), lockId: lockA},
            [tableB]: {relay: relayInto(runnerPool, tableB, createMessageConsumer<StreamB>(gated(tableB))), lockId: lockB},
        }, {channelName, maxConcurrentRelays: 1, pollIntervalMs: 60_000, lockAcquisitionIntervalMs: 50});

        // act
        void runner.start();
        await eventually(async () => started.length > 0);
        await wait(300);
        const startedWhileTheFirstRan = [...started];
        gates[tableA].resolve();
        gates[tableB].resolve();

        // assert
        await done.wait(5000);
        expect(startedWhileTheFirstRan).toHaveLength(1);
        expect(started.toSorted()).toEqual([tableA, tableB]);
    });

    test('a group whose locks cannot be taken is reported without holding up the other groups', async () => {
        // arrange
        const failures: ClaimFailure[] = [];
        const consumedB = Promise.withResolvers<void>();
        await new OutboxRepositoryUsingPg<StreamB>(testPool, tableB).persist([createMessageB('foo', 'bar')]);
        runnerPool = new AsyncPgPool(pgPool);
        runner = new MultiOutboxRelayRunner(runnerPool, {
            // not a valid advisory lock key, so taking it fails
            [tableA]: {relay: relayInto(runnerPool, tableA, createMessageConsumer<StreamA>(async () => {})), lockId: 1.5, group: 'broken'},
            [tableB]: {relay: relayInto(runnerPool, tableB, createMessageConsumer<StreamB>(async () => {
                consumedB.resolve();
            })), lockId: lockB, group: 'working'},
        }, {
            channelName,
            lockAcquisitionIntervalMs: 50,
            onClaimFailure: failure => {
                failures.push(failure);

                throw new Error('the logger is down');
            },
        });

        // act
        void runner.start();

        // assert
        await consumedB.promise;
        expect(failures.length).toBeGreaterThan(0);
        expect(failures.every(failure => failure.group === 'broken')).toBe(true);
    });

    test('refuses two outboxes that share a lock id', () => {
        // arrange
        const pool = new AsyncPgPool(pgPool);
        const idleA = createMessageConsumer<StreamA>(async () => {});
        const idleB = createMessageConsumer<StreamB>(async () => {});

        // act
        const construct = () => new MultiOutboxRelayRunner(pool, {
            [tableA]: {relay: relayInto(pool, tableA, idleA), lockId: lockA, group: 'first'},
            [tableB]: {relay: relayInto(pool, tableB, idleB), lockId: lockA, group: 'second'},
        });

        // assert
        expect(construct).toThrow(DuplicateOutboxLockId);
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
            {[tableA]: {relay, lockId: lockA}},
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
