import {type DynamicMutex, type LockValue, UnableToAcquireLock, UnableToReleaseLock} from './index.js';
import {AsyncPgPool, type Connection} from '@deltic/async-pg-pool';
import {AsyncLocalStorage} from 'node:async_hooks';
import {MultiMutex} from './multi.js';
import {MutexUsingMemory} from './memory.js';

export type PostgresMutexMode = 'fresh' | 'primary';

export interface ConnectionStorage {
    /**
     * The connection holding each acquired lock, keyed by the lock id *as the caller knows it*.
     * Keying by the converted advisory id let two colliding names — converters map an unbounded
     * name space onto a bounded number range — release each other's locks through a stale entry.
     */
    connections: Map<LockValue, Connection>;
}

export interface ConnectionStorageProvider {
    resolve(): ConnectionStorage;
}

export class StaticConnectionStorageProvider implements ConnectionStorageProvider {
    private readonly context: ConnectionStorage = {
        connections: new Map(),
    };

    resolve(): ConnectionStorage {
        return this.context;
    }
}

export class AsyncConnectionStorageProvider implements ConnectionStorageProvider {
    constructor(private readonly store = new AsyncLocalStorage<ConnectionStorage>()) {}

    resolve(): ConnectionStorage {
        const context = this.store.getStore();

        if (!context) {
            throw new Error('No connection context set, did you forget a .run call?');
        }

        return context;
    }

    run<R>(callback: () => R): R {
        return this.store.run(
            {
                connections: new Map(),
            },
            callback,
        );
    }
}

export class MutexUsingPostgres<LockID extends LockValue> implements DynamicMutex<LockID> {
    constructor(
        private readonly pool: AsyncPgPool,
        private readonly idConverter: LockIdConverter<LockID>,
        private readonly mode: PostgresMutexMode,
        private readonly connectionStorage: ConnectionStorageProvider = new StaticConnectionStorageProvider(),
    ) {}

    private connection(): Promise<Connection> {
        if (this.mode === 'fresh') {
            return this.pool.claimFresh();
        } else if (this.mode === 'primary') {
            return this.pool.primary();
        }

        throw new Error(`Unknown postgres mutex mode provided: ${this.mode}`);
    }

    async lock(id: LockID, timeout?: number): Promise<void> {
        // `lock_timeout` cannot express every timeout a caller can: zero *disables* it, turning
        // "do not wait" into "wait for ever", a negative value is refused outright, and anything
        // non-numeric used to end up interpolated as '<NaN>ms', failing every acquisition. The
        // timeout is therefore translated first: wait for ever, wait this long, or do not wait.
        const wait = timeout === undefined || timeout === Number.POSITIVE_INFINITY
            ? 'indefinitely'
            : Number.isFinite(timeout) && timeout > 0
              ? 'bounded'
              : 'not-at-all';

        if (wait === 'not-at-all') {
            if (await this.tryLock(id)) {
                return;
            }

            throw UnableToAcquireLock.becauseOfError(id, 'Time ran out.');
        }

        const client = await this.connection();
        const lockId = this.idConverter.convert(id);

        try {
            if (wait === 'bounded') {
                // Validated as a finite positive number above, so this interpolates a number.
                await client.query(`SET SESSION lock_timeout TO '${Math.ceil(timeout!)}ms'`);
            }

            await client.query('SELECT pg_advisory_lock($1) as locked', [lockId]);
            this.connections.set(id, client);

            if (wait === 'bounded') {
                await client.query('RESET lock_timeout');
            }
        } catch (e) {
            // Best effort: in primary mode the session outlives this failure, and it must not keep
            // a lock timeout that would then apply to every unrelated query on it.
            await client.query('RESET lock_timeout').catch(() => undefined);
            await this.pool.release(client, e);
            throw UnableToAcquireLock.becauseOfError(id, e);
        }
    }

    async tryLock(id: LockID): Promise<boolean> {
        const client = await this.connection();
        const lockId = this.idConverter.convert(id);
        // A connection is handed back once. Once a release has been attempted the pool owns the
        // connection, even when that release failed; releasing it again from the error path made the
        // pool report a double release instead of the failure that actually happened.
        let handedBack = false;

        try {
            const response = await client.query<{locked: boolean}>('select pg_try_advisory_lock($1) as locked', [
                lockId,
            ]);
            const wasLocked = response.rows[0].locked;

            if (wasLocked) {
                this.connections.set(id, client);
            } else {
                handedBack = true;
                await this.pool.release(client);
            }

            return wasLocked;
        } catch (e) {
            if (!handedBack) {
                await this.pool.release(client, e);
            }

            throw UnableToAcquireLock.becauseOfError(id, e);
        }
    }

    private get connections(): Map<LockValue, Connection> {
        return this.connectionStorage.resolve().connections;
    }

    async unlock(id: LockID): Promise<void> {
        const lockId = this.idConverter.convert(id);
        const connection = this.connections.get(id);

        if (!connection) {
            throw UnableToReleaseLock.becauseOfError(
                id,
                new Error('The lock is not held here: it was never acquired, or it was already released.'),
            );
        }

        // Forgotten before anything else happens: advisory locks are per session and converted ids
        // can collide, so an entry that outlived its release let a stale unlock release a lock that
        // belonged to a later acquirer — while telling its caller everything went fine.
        this.connections.delete(id);

        let refused = false;
        // Handed back once, see tryLock: a failing release must not be followed by a second one.
        let handedBack = false;

        try {
            const response = await connection.query('select pg_advisory_unlock($1) as unlocked', [lockId]);
            refused = response.rows[0].unlocked === false;
            handedBack = true;
            await this.pool.release(connection);
        } catch (e) {
            if (!handedBack) {
                await this.pool.release(connection, e);
            }

            throw UnableToReleaseLock.becauseOfError(id, e);
        }

        if (refused) {
            throw UnableToReleaseLock.becauseOfError(
                id,
                new Error('Database told us it could not release the lock.'),
            );
        }
    }
}

export interface LockIdConverter<LockID> {
    convert(id: LockID): number;
}

export type LockRange = {
    base: number;
    range: number;
};

export function makePostgresMutex<const LockID extends string | number>(options: {
    pool: AsyncPgPool;
    converter: LockIdConverter<LockID>;
    mode?: PostgresMutexMode;
    connectionStorage?: ConnectionStorageProvider;
}): DynamicMutex<LockID> {
    const mode: PostgresMutexMode = options.mode ?? 'fresh';

    const primaryMutex = new MutexUsingPostgres(
        options.pool,
        options.converter,
        options.mode ?? 'fresh',
        options.connectionStorage,
    );

    if (mode === 'fresh') {
        return primaryMutex;
    }

    return new MultiMutex([new MutexUsingMemory(), primaryMutex]);
}
