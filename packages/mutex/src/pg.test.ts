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
        expect(storage.resolve().connections.has(lockId)).toEqual(true);
        await mutex.unlock(lockId);

        expect(storage.resolve().connections.has(lockId)).toEqual(false);
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

    });
});
