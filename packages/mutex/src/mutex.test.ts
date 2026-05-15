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
let pool: Pool;
let asyncPool: AsyncPgPool;

describe.each([
    ['Memory', () => new MutexUsingMemory<string>()],
    ['MultiMutex', () => new MultiMutex<string>([new MutexUsingMemory<string>(), new MutexUsingMemory<string>()])],
    [
        'MutexUsingPostgres - primary',
        () =>
            makePostgresMutex({
                pool: asyncPool,
                converter: new Crc32LockIdConverter({base: 0, range: 10_000}),
                mode: 'primary',
            }),
    ],
    [
        'MutexUsingPostgres - fresh',
        () =>
            makePostgresMutex({
                pool: asyncPool,
                converter: new Crc32LockIdConverter({base: 0, range: 10_000}),
                mode: 'fresh',
            }),
    ],
] as const)('Mutex using %s', (_name, factory) => {
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
});
