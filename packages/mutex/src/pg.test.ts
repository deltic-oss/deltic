import {setTimeout} from 'node:timers/promises';
import {Pool, type PoolConfig} from 'pg';
import {AsyncPgPool, type AsyncPgPoolOptions} from '@deltic/async-pg-pool';
import {UnableToAcquireLock, UnableToReleaseLock} from './index.js';
import {
    AsyncConnectionStorageProvider,
    type ConnectionStorageProvider,
    type LockIdConverter,
    makePostgresMutex,
    MutexUsingPostgres,
    type PostgresMutexMode,
    StaticConnectionStorageProvider,
} from './pg.js';
import {Crc32LockIdConverter} from './crc32-lock-id-converter.js';
import {pgTestCredentials} from '../../pg-credentials.js';

/**
 * Advisory locks are global to the database, so every lock id used here lives in
 * a randomised window that no other test suite in the repository uses.
 */
const advisoryLockBase = 700_000_000 + Math.floor(Math.random() * 1_000) * 20_000;
const converter = new Crc32LockIdConverter({base: advisoryLockBase, range: 10_000});
const lockId = 'pg-lock-id';
const otherLockId = 'pg-other-lock-id';

describe('MutexUsingPostgres', () => {
    let pools: Pool[] = [];
    let asyncPools: AsyncPgPool[] = [];

    const createPool = (config: PoolConfig = {}, options: AsyncPgPoolOptions = {}): AsyncPgPool => {
        const pool = new Pool({...pgTestCredentials, ...config});
        const asyncPool = new AsyncPgPool(pool, options);
        pools.push(pool);
        asyncPools.push(asyncPool);

        return asyncPool;
    };

    const createMutex = (
        asyncPool: AsyncPgPool,
        mode: PostgresMutexMode = 'fresh',
        storage: ConnectionStorageProvider = new StaticConnectionStorageProvider(),
    ) => new MutexUsingPostgres<string>(asyncPool, converter, mode, storage);

    afterEach(async () => {
        for (const asyncPool of asyncPools) {
            await asyncPool.flush().catch(() => undefined);
        }

        for (const pool of pools) {
            // guarded: a leaked connection would keep end() pending forever
            await Promise.race([pool.end().catch(() => undefined), setTimeout(2_000)]);
        }

        pools = [];
        asyncPools = [];
    });

    test('a lock is granted to exactly one of two acquirers using separate pools', async () => {
        const one = createMutex(createPool());
        const other = createMutex(createPool());

        const attempts = await Promise.all([one.tryLock(lockId), other.tryLock(lockId)]);

        expect(attempts.filter(acquired => acquired)).toHaveLength(1);

        if (attempts[0]) {
            await one.unlock(lockId);
        }

        if (attempts[1]) {
            await other.unlock(lockId);
        }
    });

    test('a blocking acquirer takes over once the holder releases the lock', async () => {
        const asyncPool = createPool();
        const holder = createMutex(asyncPool);
        const waiter = createMutex(asyncPool);
        const events: string[] = [];
        await holder.lock(lockId, 100);

        const waiting = waiter.lock(lockId, 2_000).then(() => {
            events.push('acquired');
        });

        // there is no deterministic signal for "the request is queued in postgres"
        await setTimeout(25);
        events.push('released');
        await holder.unlock(lockId);
        await waiting;

        expect(events).toEqual(['released', 'acquired']);

        await waiter.unlock(lockId);
    });

    test('a try-lock that cannot acquire the lock returns its connection to the pool', async () => {
        const asyncPool = createPool({max: 2, connectionTimeoutMillis: 1_000});
        const holder = createMutex(asyncPool);
        const other = createMutex(asyncPool);
        await holder.lock(lockId, 100);

        for (let attempt = 0; attempt < 6; attempt++) {
            expect(await other.tryLock(lockId)).toEqual(false);
        }

        // a leaked connection per failed attempt would have exhausted the pool by now
        expect(await other.tryLock(otherLockId)).toEqual(true);

        await other.unlock(otherLockId);
        await holder.unlock(lockId);
    });

    test('an acquisition that ran out of time returns its connection to the pool', async () => {
        const asyncPool = createPool({max: 2, connectionTimeoutMillis: 1_000});
        const holder = createMutex(asyncPool);
        const other = createMutex(asyncPool);
        await holder.lock(lockId, 100);

        for (let attempt = 0; attempt < 6; attempt++) {
            await expect(other.lock(lockId, 5)).rejects.toThrow(UnableToAcquireLock);
        }

        expect(await other.tryLock(otherLockId)).toEqual(true);

        await other.unlock(otherLockId);
        await holder.unlock(lockId);
    });

    test('an unknown mode is refused', async () => {
        const mutex = createMutex(createPool(), 'shared' as PostgresMutexMode);

        await expect(mutex.lock(lockId, 100)).rejects.toThrow('Unknown postgres mutex mode provided: shared');
        await expect(mutex.tryLock(lockId)).rejects.toThrow('Unknown postgres mutex mode provided: shared');
    });

    test('numeric lock ids are supported', async () => {
        const numericConverter: LockIdConverter<number> = {convert: id => advisoryLockBase + id};
        const asyncPool = createPool();
        const mutex = new MutexUsingPostgres<number>(asyncPool, numericConverter, 'fresh');
        const other = new MutexUsingPostgres<number>(asyncPool, numericConverter, 'fresh');

        await mutex.lock(9_001, 100);

        expect(await other.tryLock(9_001)).toEqual(false);
        expect(await other.tryLock(9_002)).toEqual(true);

        await other.unlock(9_002);
        await mutex.unlock(9_001);
    });

    test('advisory ids beyond the signed 32 bit range are supported', async () => {
        const wideConverter: LockIdConverter<string> = {convert: () => 4_000_000_000 + advisoryLockBase};
        const asyncPool = createPool();
        const mutex = new MutexUsingPostgres<string>(asyncPool, wideConverter, 'fresh');
        const other = new MutexUsingPostgres<string>(asyncPool, wideConverter, 'fresh');

        await mutex.lock(lockId, 100);

        expect(await other.tryLock(lockId)).toEqual(false);

        await mutex.unlock(lockId);
    });

    test('the primary mode composition refuses a re-entrant acquisition', async () => {
        const mutex = makePostgresMutex({pool: createPool(), converter, mode: 'primary'});

        await mutex.lock(lockId, 50);

        await expect(mutex.lock(lockId, 50)).rejects.toThrow(UnableToAcquireLock);

        await mutex.unlock(lockId);
    });

    test('a lock that was released outside the mutex is reported when it is released', async () => {
        const storage = new StaticConnectionStorageProvider();
        const mutex = createMutex(createPool(), 'primary', storage);
        await mutex.lock(lockId, 100);
        const connection = storage.resolve().connections.get(lockId)!;

        // this is what a lost session looks like to the mutex: the lock is simply gone
        await connection.query('select pg_advisory_unlock($1)', [converter.convert(lockId)]);

        await expect(mutex.unlock(lockId)).rejects.toThrow(UnableToReleaseLock);
    });

    it('reports a typed failure when the database refuses to release the lock', async () => {
        const storage = new StaticConnectionStorageProvider();
        const mutex = createMutex(createPool(), 'fresh', storage);
        await mutex.lock(lockId, 100);
        const connection = storage.resolve().connections.get(lockId)!;
        await connection.query('select pg_advisory_unlock($1)', [converter.convert(lockId)]);

        const outcome = await mutex.unlock(lockId).then(
            () => 'released',
            error => error,
        );

        expect(outcome).toBeInstanceOf(UnableToReleaseLock);
    });

    describe('when the pool cannot take a connection back', () => {
        // the release hook runs every time a healthy connection goes back to the pool
        const refusingHandBack: AsyncPgPoolOptions = {
            onRelease: async () => {
                throw new Error('the connection could not be reset');
            },
        };

        it('reports the release of a lock as a typed failure, after releasing the lock', async () => {
            const mutex = createMutex(createPool({}, refusingHandBack));
            const bystander = createMutex(createPool());
            await mutex.lock(lockId, 100);

            const outcome = await mutex.unlock(lockId).then(
                () => 'released',
                error => error,
            );

            // the connection is handed back exactly once, so the failure is not replaced by the
            // pool complaining about a second release
            expect(outcome).toBeInstanceOf(UnableToReleaseLock);
            expect(await bystander.tryLock(lockId)).toEqual(true);

            await bystander.unlock(lockId);
        });

        it('reports a try-lock that could not acquire the lock as a typed failure', async () => {
            const holder = createMutex(createPool());
            const other = createMutex(createPool({}, refusingHandBack));
            await holder.lock(lockId, 100);

            const outcome = await other.tryLock(lockId).then(
                acquired => acquired,
                error => error,
            );

            await holder.unlock(lockId);

            expect(outcome).toBeInstanceOf(UnableToAcquireLock);
        });
    });

    it('forgets the connection of a lock that was released', async () => {
        const storage = new StaticConnectionStorageProvider();
        const mutex = createMutex(createPool(), 'fresh', storage);
        await mutex.lock(lockId, 100);
        await mutex.unlock(lockId);

        expect(storage.resolve().connections.has(converter.convert(lockId))).toEqual(false);
    });

    it('does not release a lock that is held by another acquirer', async () => {
        const asyncPool = createPool({max: 3});
        const previousHolder = createMutex(asyncPool);
        const holder = createMutex(asyncPool);
        const bystander = createMutex(asyncPool);

        await previousHolder.lock(lockId, 100);
        await previousHolder.unlock(lockId);
        // claims the connection that was just handed back to the pool
        await holder.lock(lockId, 100);

        await previousHolder.unlock(lockId).catch(() => undefined);
        const stolen = await bystander.tryLock(lockId);

        if (stolen) {
            await bystander.unlock(lockId).catch(() => undefined);
        }

        await holder.unlock(lockId).catch(() => undefined);

        expect(stolen).toEqual(false);
    });

    it.fails('does not grant the same lock twice on the primary connection', async () => {
        const mutex = createMutex(createPool(), 'primary');
        await mutex.lock(lockId, 100);

        const secondAcquisition = await mutex.lock(lockId, 100).then(
            () => 'acquired',
            error => error,
        );

        // postgres counts advisory locks per session, so every acquisition needs its own release
        await mutex.unlock(lockId).catch(() => undefined);

        if (secondAcquisition === 'acquired') {
            await mutex.unlock(lockId).catch(() => undefined);
        }

        expect(secondAcquisition).toBeInstanceOf(UnableToAcquireLock);
    });

    // see .claude-work/issues/mutex-crc32-collisions-alias-unrelated-locks.md
    it('refuses to release a lock name that was never acquired', async () => {
        const asyncPool = createPool();
        const mutex = createMutex(asyncPool);
        const bystander = createMutex(asyncPool);
        // both names convert to the same advisory id
        expect(converter.convert('order-27')).toEqual(converter.convert('order-103'));

        await mutex.lock('order-27', 100);
        const outcome = await mutex.unlock('order-103').then(
            () => 'released',
            error => error,
        );

        const stolen = await bystander.tryLock('order-27');

        if (stolen) {
            await bystander.unlock('order-27');
        } else {
            await mutex.unlock('order-27').catch(() => undefined);
        }

        expect(outcome).toBeInstanceOf(UnableToReleaseLock);
    });

    describe('using a connection context per unit of work', () => {
        test('locks are acquired and released inside a connection context', async () => {
            const storage = new AsyncConnectionStorageProvider();
            const mutex = createMutex(createPool(), 'fresh', storage);

            await storage.run(async () => {
                await mutex.lock(lockId, 100);
                await mutex.unlock(lockId);
            });
        });

        test('acquiring a lock outside a connection context fails', async () => {
            const storage = new AsyncConnectionStorageProvider();
            const mutex = createMutex(createPool(), 'fresh', storage);

            await expect(mutex.lock(lockId, 100)).rejects.toThrow(
                'No connection context set, did you forget a .run call?',
            );
            await expect(mutex.unlock(lockId)).rejects.toThrow(
                'No connection context set, did you forget a .run call?',
            );
        });

        test('a lock cannot be released from another connection context', async () => {
            const storage = new AsyncConnectionStorageProvider();
            const mutex = createMutex(createPool(), 'fresh', storage);

            await storage.run(async () => {
                await mutex.lock(lockId, 100);

                // every run() starts a new connection context, including a nested one
                await storage.run(async () => {
                    await expect(mutex.unlock(lockId)).rejects.toThrow(UnableToReleaseLock);
                });

                await mutex.unlock(lockId);
            });
        });

        test('concurrent connection contexts hold their own locks', async () => {
            const storage = new AsyncConnectionStorageProvider();
            const mutex = createMutex(createPool(), 'fresh', storage);

            await Promise.all([
                storage.run(async () => {
                    await mutex.lock(lockId, 500);
                    await setTimeout(5);
                    await mutex.unlock(lockId);
                }),
                storage.run(async () => {
                    await mutex.lock(otherLockId, 500);
                    await setTimeout(5);
                    await mutex.unlock(otherLockId);
                }),
            ]);
        });
    });
});
