import {
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    type KyselyConfig,
    type KyselyPlugin,
    type LogConfig,
    type PostgresCursorConstructor,
} from 'kysely';
import type {AsyncPgPool, Connection as PgConnection} from '@deltic/async-pg-pool';
import {AsyncPgDialect} from './dialect.js';
import {AsyncPgConnection, pgConnectionSymbol} from './connection.js';
import {KyselyTransactionsNotSupported} from './errors.js';

export {AsyncPgDialect} from './dialect.js';
export {AsyncPgDriver} from './driver.js';
export {AsyncPgConnection, pgConnectionSymbol} from './connection.js';
export type {AsyncPgConnectionOptions} from './connection.js';
export {KyselyTransactionsNotSupported} from './errors.js';

/**
 * Options for creating an AsyncKyselyConnectionProvider.
 */
export interface AsyncKyselyConnectionProviderOptions {
    /**
     * Kysely plugins to install.
     */
    plugins?: KyselyPlugin[];

    /**
     * Logging configuration.
     */
    log?: LogConfig;

    /**
     * A pg-cursor constructor for streaming query support.
     *
     * Install `pg-cursor` and pass the default export to enable
     * streaming queries via Kysely's `.stream()` API.
     *
     * @example
     * ```typescript
     * import Cursor from 'pg-cursor';
     *
     * const provider = new AsyncKyselyConnectionProvider<DB>(pool, {
     *     cursor: Cursor,
     * });
     * ```
     */
    cursor?: PostgresCursorConstructor;
}

/**
 * Extracts the pg connection from a transaction Kysely instance.
 * Throws if the instance doesn't have a stored connection.
 */
export function extractPgConnection<DB>(db: Kysely<DB>): PgConnection {
    const connection = (db as any)[pgConnectionSymbol] as PgConnection | undefined;

    if (!connection) {
        throw new Error('Invalid transaction Kysely instance — missing pg connection');
    }

    return connection;
}

/**
 * Provides Kysely query builder instances backed by AsyncPgPool for
 * connection management.
 *
 * The `connection()` method returns a Kysely instance where connections
 * are resolved lazily via the custom driver. Transaction lifecycle
 * (begin/commit/rollback) is managed through the provider's own methods,
 * mirroring the AsyncKnexConnectionProvider and AsyncDrizzleConnectionProvider API.
 *
 * Kysely's built-in `db.transaction()` is blocked on all instances
 * created by this provider to prevent conflicts with AsyncPgPool.
 *
 * @example
 * ```typescript
 * import {Pool} from 'pg';
 * import {AsyncPgPool} from '@deltic/async-pg-pool';
 * import {AsyncKyselyConnectionProvider} from '@deltic/async-pg-kysely';
 *
 * interface DB {
 *     users: { id: number; name: string; email: string | null };
 * }
 *
 * const pgPool = new Pool({connectionString: '...'});
 * const asyncPool = new AsyncPgPool(pgPool);
 * const provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);
 *
 * // Lazy query — connection acquired only on execute
 * const users = await provider.connection()
 *     .selectFrom('users')
 *     .selectAll()
 *     .execute();
 *
 * // Transaction via provider
 * const trx = await provider.begin();
 * try {
 *     await trx.insertInto('users').values({name: 'Frank'}).execute();
 *     await provider.commit(trx);
 * } catch (e) {
 *     await provider.rollback(trx);
 *     throw e;
 * }
 * ```
 */
export class AsyncKyselyConnectionProvider<DB> {
    private readonly db: Kysely<DB>;

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly options: AsyncKyselyConnectionProviderOptions = {},
    ) {
        this.db = this.blockTransactions(
            new Kysely<DB>({
                dialect: new AsyncPgDialect(pool, {cursor: options.cursor}),
                plugins: options.plugins,
                log: options.log,
            }),
        );
    }

    /**
     * Get a Kysely instance for building and executing queries.
     *
     * The returned instance resolves connections lazily via the custom
     * driver — no connection is held between queries. If currently in a
     * transaction, queries will use the transaction connection.
     *
     * @example
     * ```typescript
     * const users = await provider.connection()
     *     .selectFrom('users')
     *     .selectAll()
     *     .where('active', '=', true)
     *     .execute();
     * ```
     */
    connection(): Kysely<DB> {
        return this.db;
    }

    /**
     * Begin a transaction and return a Kysely instance bound to it.
     *
     * The returned instance is directly bound to the transaction connection —
     * all queries executed on it run within the transaction.
     *
     * @param beginQuery Optional custom BEGIN query (e.g., 'BEGIN ISOLATION LEVEL SERIALIZABLE')
     *
     * @example
     * ```typescript
     * const trx = await provider.begin();
     * try {
     *     await trx.insertInto('users').values({name: 'Frank'}).execute();
     *     await provider.commit(trx);
     * } catch (e) {
     *     await provider.rollback(trx);
     *     throw e;
     * }
     * ```
     */
    async begin(beginQuery?: string): Promise<Kysely<DB>> {
        const pgConnection = await this.pool.begin(beginQuery);

        return this.createBoundInstance(pgConnection);
    }

    /**
     * Get the current transaction Kysely instance.
     *
     * The active transaction is sourced from the underlying pool, which tracks
     * it in the async context. Each call returns a fresh Kysely instance
     * bound to that connection, so callers in different async flows get an
     * instance scoped to their own context.
     *
     * @throws Error if not currently in a transaction
     */
    withTransaction(): Kysely<DB> {
        const pgConnection = this.pool.withTransaction();

        return this.createBoundInstance(pgConnection);
    }

    /**
     * Check if currently inside a transaction.
     */
    inTransaction(): boolean {
        return this.pool.inTransaction();
    }

    /**
     * Commit a transaction.
     *
     * This commits the transaction and releases the connection back to the pool.
     *
     * @param trx The transaction Kysely instance to commit
     */
    async commit(trx: Kysely<DB>): Promise<void> {
        const pgConnection = extractPgConnection(trx);
        await this.pool.commit(pgConnection);
    }

    /**
     * Rollback a transaction.
     *
     * This rolls back the transaction and releases the connection back to the pool.
     *
     * @param trx The transaction Kysely instance to rollback
     * @param error Optional error that caused the rollback
     */
    async rollback(trx: Kysely<DB>, error?: unknown): Promise<void> {
        const pgConnection = extractPgConnection(trx);
        await this.pool.rollback(pgConnection, error);
    }

    /**
     * Run a function within a transaction.
     *
     * If already in a transaction, the function runs in the existing transaction.
     * Otherwise, begins a new transaction, runs the function, and commits.
     * If the function throws, the transaction is rolled back.
     *
     * @param fn Function to run within the transaction
     * @returns The return value of the function
     *
     * @example
     * ```typescript
     * const user = await provider.runInTransaction(async () => {
     *     const db = provider.connection();
     *     const user = await db.insertInto('users')
     *         .values({name: 'Frank'})
     *         .returningAll()
     *         .executeTakeFirstOrThrow();
     *     await db.insertInto('audit')
     *         .values({action: 'user_created', user_id: user.id})
     *         .execute();
     *     return user;
     * });
     * ```
     */
    async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        if (this.inTransaction()) {
            return fn();
        }

        const trx = await this.begin();

        try {
            const result = await fn();
            await this.commit(trx);

            return result;
        } catch (e) {
            await this.rollback(trx, e);
            throw e;
        }
    }

    /**
     * Destroy the Kysely instance.
     * Call this when shutting down to clean up resources.
     */
    async destroy(): Promise<void> {
        await this.db.destroy();
    }

    /**
     * Creates a Kysely instance bound to a specific pg connection and tags
     * it with the connection symbol so commit/rollback can recover it.
     */
    private createBoundInstance(pgConnection: PgConnection): Kysely<DB> {
        const connectionWrapper = new AsyncPgConnection(pgConnection, {cursor: this.options.cursor});

        const dialect: KyselyConfig['dialect'] = {
            createDriver: () => ({
                async init(): Promise<void> {},
                async acquireConnection() { return connectionWrapper; },
                async beginTransaction(): Promise<void> {},
                async commitTransaction(): Promise<void> {},
                async rollbackTransaction(): Promise<void> {},
                async releaseConnection(): Promise<void> {},
                async destroy(): Promise<void> {},
            }),
            createQueryCompiler: () => new PostgresQueryCompiler(),
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db: Kysely<any>) => new PostgresIntrospector(db),
        };

        const trx = this.blockTransactions(
            new Kysely<DB>({
                dialect,
                plugins: this.options.plugins,
                log: this.options.log,
            }),
        );

        (trx as any)[pgConnectionSymbol] = pgConnection;

        return trx;
    }

    /**
     * Blocks Kysely's built-in transaction methods on the given instance.
     *
     * Both `db.transaction()` and `db.startTransaction()` are overridden
     * to throw, preventing Kysely from issuing BEGIN/COMMIT/ROLLBACK
     * that would conflict with AsyncPgPool's transaction state.
     */
    private blockTransactions(db: Kysely<DB>): Kysely<DB> {
        (db as any).transaction = (): never => {
            throw KyselyTransactionsNotSupported.because();
        };
        (db as any).startTransaction = (): never => {
            throw KyselyTransactionsNotSupported.because();
        };

        return db;
    }
}
