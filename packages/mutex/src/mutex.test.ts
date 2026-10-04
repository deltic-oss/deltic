import {setTimeout} from 'node:timers/promises';
import {type DynamicMutex, UnableToAcquireLock, UnableToReleaseLock} from './index.js';
import {Pool} from 'pg';

import {makePostgresMutex, MutexUsingPostgres} from './pg.js';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {MutexUsingMemory} from './memory.js';
import {MultiMutex} from './multi.js';
import {Crc32LockIdConverter} from './crc32-lock-id-converter.js';
import {pgTestCredentials} from '../../pg-credentials.js';

const lockId1 = 'lock-id-1';
const lockId2 = 'lock-id-2';
let pool: Pool;
let asyncPool: AsyncPgPool;

/**
 * Behaviour where an implementation is known to deviate from the contract every
 * other implementation honours. Each flag turns the matching contract test into
 * an expected failure, so the suite documents the divergence and turns red again
 * as soon as the implementation is fixed. No implementation carries a flag right
 * now — the ones that existed have been fixed — but the mechanism stays, so a
 * future divergence is documented here instead of weakening the contract.
 */
interface KnownDivergences {
    wakesWaitersOfOtherLockIds?: true;
    requiresUsableTimeout?: true;
    zeroTimeoutNeverExpires?: true;
    forgetsReleasedLocks?: true;
}

type ImplementationUnderTest = [
    name: string,
    factory: () => DynamicMutex<string>,
    divergences: KnownDivergences,
];

/**
 * Releases every lock a test could still be holding, whichever implementation
 * ran it, so a failing assertion can never leak a held lock into the next test.
 */
const releaseEveryLock = async (mutex: DynamicMutex<string>, ids: string[]): Promise<void> => {
    for (const id of ids) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const released = await mutex.unlock(id).then(
                () => true,
                () => false,
            );

            if (!released) {
                break;
            }
        }
    }
};

const implementations: ImplementationUnderTest[] = [
    ['Memory', () => new MutexUsingMemory<string>(), {}],
    [
        'MultiMutex',
        () => new MultiMutex<string>([new MutexUsingMemory<string>(), new MutexUsingMemory<string>()]),
        {},
    ],
    [
        'MutexUsingPostgres - primary',
        () =>
            makePostgresMutex({
                pool: asyncPool,
                converter: new Crc32LockIdConverter({base: 0, range: 10_000}),
                mode: 'primary',
            }),
        {},
    ],
    [
        'MutexUsingPostgres - fresh',
        () =>
            makePostgresMutex({
                pool: asyncPool,
                converter: new Crc32LockIdConverter({base: 0, range: 10_000}),
                mode: 'fresh',
            }),
        {},
    ],
];

describe.each(implementations)('Mutex using %s', (_name, factory, divergences) => {
    let mutex: DynamicMutex<string>;

    beforeAll(() => {
        pool = new Pool(pgTestCredentials);
    });

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pool, {
            onRelease: async connection => {
                await connection.query('RESET ALL');
            },
        });
        mutex = factory();
    });

    afterEach(async () => {
        await asyncPool.flush();
    });

    afterAll(async () => {
        await pool.end();
    });

    test('sanity check the locking on postgres', async () => {
        const createPool = () =>
            new Pool({
                host: 'localhost',
                user: 'duna',
                password: 'duna',
                port: Number(process.env.POSTGRES_PORT ?? 35432),
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
                maxLifetimeSeconds: 60,
            });

        const p1 = createPool();
        const pool1 = new AsyncPgPool(p1);
        const m1 = new MutexUsingPostgres(pool1, new Crc32LockIdConverter({base: 1000, range: 1000}), 'fresh');
        const m2 = new MutexUsingPostgres(pool1, new Crc32LockIdConverter({base: 1000, range: 1000}), 'fresh');

        await m1.lock('something', 100);

        await expect(m2.lock('something', 10)).rejects.toThrow();

        await m1.unlock('something');

        await p1.end();
    });

    test('a lock can be acquired and released', async () => {
        expect.assertions(0);
        await mutex.lock(lockId1, 50);
        await mutex.unlock(lockId1);
    });

    test('a tried lock can be acquired and released', async () => {
        const locked = await mutex.tryLock(lockId1);
        await mutex.unlock(lockId1);

        // assert
        expect(locked).toEqual(true);
    });

    test('a lock guarantees exclusive access when asked concurrently', async () => {
        const result: number[][] = [];
        const promises: Promise<any>[] = [];

        for (let i = 0; i < 5; i++) {
            promises.push(
                (async (index: number) => {
                    await mutex.lock(lockId1, 200 + i);
                    result.push([index]);
                    await setTimeout(10 - i);
                    result.at(-1)!.push(index);
                    await mutex.unlock(lockId1);
                })(i),
            );
        }

        await Promise.all(promises);

        expect(result.toSorted((a, b) => a[0] - b[0])).toEqual([
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
            [4, 4],
        ]);
    });

    test('acquiring a lock after a timeout', async () => {
        await mutex.lock(lockId1, 50);

        await expect(mutex.lock(lockId1, 50)).rejects.toThrow(UnableToAcquireLock);

        await mutex.unlock(lockId1);

        await expect(mutex.lock(lockId1, 50)).resolves.toEqual(undefined);

        await mutex.unlock(lockId1);
    });

    test('a lock cannot be acquired twice', async () => {
        // arrange
        await mutex.lock(lockId1, 50);

        // act
        await expect(mutex.lock(lockId1, 1)).rejects.toThrow(UnableToAcquireLock);

        // cleanup
        await mutex.unlock(lockId1);
    });

    test('a locked mutex can try but will not acquire a lock', async () => {
        // arrange
        await mutex.lock(lockId1, 50);

        // act
        const locked = await mutex.tryLock(lockId1);

        // assert
        expect(locked).toBe(false);

        // cleanup
        await mutex.unlock(lockId1);
    });

    test('released locks can be acquired again', async () => {
        await mutex.lock(lockId1, 50);

        expect(await mutex.tryLock(lockId1)).toEqual(false);

        await mutex.unlock(lockId1);

        expect(await mutex.tryLock(lockId1)).toEqual(true);

        // cleanup
        await mutex.unlock(lockId1);
    });

    test('locks that are not acquired cannot be released', async () => {
        await expect(mutex.unlock(lockId1)).rejects.toThrow(UnableToReleaseLock);
    });

    test('a lock is released when the guarded work throws', async () => {
        const workFailure = new Error('the guarded work failed');
        const guardedWork = async () => {
            await mutex.lock(lockId1, 50);

            try {
                throw workFailure;
            } finally {
                await mutex.unlock(lockId1);
            }
        };

        await expect(guardedWork()).rejects.toBe(workFailure);

        // the lock id must be usable again, otherwise a single failure deadlocks it forever
        expect(await mutex.tryLock(lockId1)).toEqual(true);

        await mutex.unlock(lockId1);
    });

    test('distinct lock ids are held independently', async () => {
        await mutex.lock(lockId1, 50);
        await mutex.lock(lockId2, 50);

        expect(await mutex.tryLock(lockId1)).toEqual(false);
        expect(await mutex.tryLock(lockId2)).toEqual(false);

        await mutex.unlock(lockId1);

        expect(await mutex.tryLock(lockId1)).toEqual(true);
        expect(await mutex.tryLock(lockId2)).toEqual(false);

        await mutex.unlock(lockId1);
        await mutex.unlock(lockId2);
    });

    test('a lock is granted to exactly one of two concurrent try-lock callers', async () => {
        const attempts = await Promise.all([mutex.tryLock(lockId1), mutex.tryLock(lockId1)]);

        expect(attempts.filter(acquired => acquired)).toHaveLength(1);

        await mutex.unlock(lockId1);
    });

    test('releasing a lock id that was never acquired leaves other lock ids untouched', async () => {
        await mutex.lock(lockId1, 50);

        await expect(mutex.unlock(lockId2)).rejects.toThrow(UnableToReleaseLock);

        expect(await mutex.tryLock(lockId1)).toEqual(false);

        await mutex.unlock(lockId1);
    });

    test('lock ids that name object prototype members are ordinary lock ids', async () => {
        await mutex.lock('__proto__', 50);

        expect(await mutex.tryLock('constructor')).toEqual(true);
        expect(await mutex.tryLock('__proto__')).toEqual(false);

        await mutex.unlock('__proto__');
        await mutex.unlock('constructor');
    });

    // see .claude-work/issues/mutex-memory-waiter-queue-not-keyed-by-lock-id.md
    const handsLockToWaiterOfSameLockId = divergences.wakesWaitersOfOtherLockIds ? test.fails : test;
    handsLockToWaiterOfSameLockId('a released lock is only handed to a waiter for that same lock id', async () => {
        await mutex.lock(lockId1, 100);
        await mutex.lock(lockId2, 100);

        let lockId2GrantedWhileHeld = false;
        const waiterForLockId2 = mutex.lock(lockId2, 100).then(
            () => {
                lockId2GrantedWhileHeld = true;
            },
            () => {},
        );
        const waiterForLockId1 = mutex.lock(lockId1, 100).then(
            () => {},
            () => {},
        );

        // releasing lockId1 may only ever wake the waiter queued for lockId1
        await mutex.unlock(lockId1);
        await Promise.all([waiterForLockId1, waiterForLockId2]);
        const grantedToTheWrongWaiter = lockId2GrantedWhileHeld;

        await releaseEveryLock(mutex, [lockId1, lockId2]);

        expect(grantedToTheWrongWaiter).toEqual(false);
    });

    // see .claude-work/issues/mutex-pg-lock-requires-usable-timeout.md
    const acquiresWithoutTimeout = divergences.requiresUsableTimeout ? test.fails : test;
    acquiresWithoutTimeout('a free lock can be acquired without providing a timeout', async () => {
        const outcome = await mutex.lock(lockId1).then(
            () => 'acquired',
            error => error,
        );

        await releaseEveryLock(mutex, [lockId1]);

        expect(outcome).toEqual('acquired');
    });

    // see .claude-work/issues/mutex-pg-lock-requires-usable-timeout.md
    const acquiresWithUnusableTimeout = divergences.requiresUsableTimeout ? test.fails : test;
    acquiresWithUnusableTimeout('a free lock can be acquired when the timeout is not a number', async () => {
        // a misconfigured timeout such as DELTIC_LOCK_TIMEOUT_MS=5s arrives here as NaN
        const outcome = await mutex.lock(lockId1, Number.NaN).then(
            () => 'acquired',
            error => error,
        );

        await releaseEveryLock(mutex, [lockId1]);

        expect(outcome).toEqual('acquired');
    });

    // see .claude-work/issues/mutex-pg-zero-timeout-never-expires.md
    const zeroTimeoutDoesNotWait = divergences.zeroTimeoutNeverExpires ? test.fails : test;
    zeroTimeoutDoesNotWait('a lock request with a zero timeout does not wait for the holder', async () => {
        await mutex.lock(lockId1, 50);
        const attempt = mutex.lock(lockId1, 0).then(
            () => 'acquired',
            () => 'rejected',
        );
        const outcome = await Promise.race([attempt, setTimeout(250, 'still waiting')]);

        // release the holder first, so a still-blocked attempt cannot outlive the test
        await mutex.unlock(lockId1);
        await attempt;
        await releaseEveryLock(mutex, [lockId1]);

        expect(outcome).toEqual('rejected');
    });

    // see .claude-work/issues/mutex-pg-unlock-keeps-stale-connection.md
    const releasingTwiceIsTyped = divergences.forgetsReleasedLocks ? test.fails : test;
    releasingTwiceIsTyped('releasing an already released lock reports a typed failure', async () => {
        await mutex.lock(lockId1, 50);
        await mutex.unlock(lockId1);

        const outcome = await mutex.unlock(lockId1).then(
            () => 'released',
            error => error,
        );

        expect(outcome).toBeInstanceOf(UnableToReleaseLock);
    });
});
