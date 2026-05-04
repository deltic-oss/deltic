import {drizzle} from 'drizzle-orm/node-postgres';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type {Logger} from 'drizzle-orm';
import type {AsyncPgPool, Connection as PgConnection} from '@deltic/async-pg-pool';
import {StandardError} from '@deltic/error-standard';
import type {QueryArrayConfig, QueryConfig, QueryResult} from 'pg';


/**
 * Symbol used to store the pg connection on transaction drizzle instances.
 */
export const pgConnectionSymbol = Symbol.for('@deltic/async-pg-drizzle/connection');

/**
 * Options for creating an AsyncDrizzleConnectionProvider.
 */
export interface AsyncDrizzleConnectionProviderOptions<
    TSchema extends Record<string, unknown> = Record<string, never>,
> {
    /**
     * Drizzle schema for typed relational queries.
     */
    schema?: TSchema;

    /**
     * Enable query logging.
     */
    logger?: boolean | Logger;

    /**
     * Column name casing strategy.
     */
    casing?: 'snake_case' | 'camelCase';
}

/**
 * Thrown when `db.transaction()` is called on a drizzle instance managed
 * by this provider. Drizzle's internal transaction management conflicts
 * with AsyncPgPool's transaction lifecycle — use the provider's own
 * transaction methods or TransactionManager instead.
 */
export class DrizzleTransactionsNotSupported extends StandardError {
    static because = () =>
        new DrizzleTransactionsNotSupported(
            'Drizzle transactions are not supported. Use the provider transaction methods or TransactionManager instead.',
            'async-pg-drizzle.transactions_not_supported',
        );
}

/**
 * Extracts the pg connection stored on a transaction drizzle instance.
 * Throws if the instance doesn't have a stored connection.
 */
export function extractPgConnection<TSchema extends Record<string, unknown>>(
    db: NodePgDatabase<TSchema>,
): PgConnection {
    const connection = (db as any)[pgConnectionSymbol] as PgConnection | undefined;

    if (!connection) {
        throw new Error('Invalid transaction drizzle instance — missing pg connection');
    }

    return connection;
}

/**
 * Provides Drizzle ORM database instances backed by AsyncPgPool for
 * connection management.
 *
 * The `connection()` method returns a drizzle instance where connections
 * are resolved lazily at query execution time. Transaction lifecycle
 * (begin/commit/rollback) is managed through the provider's own methods,
 * mirroring the AsyncKnexConnectionProvider API.
 *
 * Drizzle's built-in `db.transaction()` is blocked on all instances
 * created by this provider to prevent conflicts with AsyncPgPool.
 *
 * @example
 * ```typescript
 * import {Pool} from 'pg';
 * import {AsyncPgPool} from '@deltic/async-pg-pool';
 * import {AsyncDrizzleConnectionProvider} from '@deltic/async-pg-drizzle';
 * import * as schema from './schema';
 *
 * const pgPool = new Pool({connectionString: '...'});
 * const asyncPool = new AsyncPgPool(pgPool);
 * const provider = new AsyncDrizzleConnectionProvider(asyncPool, {schema});
 *
 * // Lazy query — connection acquired only on await
 * const users = await provider.connection().select().from(schema.users);
 *
 * // Transaction via provider
 * const trx = await provider.begin();
 * try {
 *     await trx.insert(schema.users).values({name: 'Frank'});
 *     await provider.commit(trx);
 * } catch (e) {
 *     await provider.rollback(trx);
 *     throw e;
 * }
 *
 * // Or using runInTransaction
 * await provider.runInTransaction(async () => {
 *     const db = provider.connection();
 *     await db.insert(schema.users).values({name: 'Frank'});
 *     await db.insert(schema.audit).values({action: 'user_created'});
 * });
 * ```
 */
export class AsyncDrizzleConnectionProvider<
    TSchema extends Record<string, unknown> = Record<string, never>,
> {
    private readonly lazyDb: NodePgDatabase<TSchema>;
    private readonly drizzleConfig: {schema?: TSchema; logger?: boolean | Logger; casing?: 'snake_case' | 'camelCase'};

    constructor(
        private readonly pool: AsyncPgPool,
        options: AsyncDrizzleConnectionProviderOptions<TSchema> = {},
    ) {
        this.drizzleConfig = {
            schema: options.schema,
            logger: options.logger,
            casing: options.casing,
        };

        const lazyClient = createLazyClient(pool);
        this.lazyDb = this.blockTransactions(
            drizzle(lazyClient as any, this.drizzleConfig),
        );
    }

    /**
     * Get a drizzle database instance for building queries.
     *
     * The returned instance resolves connections lazily — no actual database
     * connection is acquired until a query is awaited. If currently in a
     * transaction, queries will use the transaction connection.
     *
     * @example
     * ```typescript
     * const users = await provider.connection()
     *     .select()
     *     .from(usersTable)
     *     .where(eq(usersTable.active, true));
     * ```
     */
    connection(): NodePgDatabase<TSchema> {
        return this.lazyDb;
    }

    /**
     * Begin a transaction and return a drizzle instance bound to it.
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
     *     await trx.insert(usersTable).values({name: 'Frank'});
     *     await provider.commit(trx);
     * } catch (e) {
     *     await provider.rollback(trx);
     *     throw e;
     * }
     * ```
     */
    async begin(beginQuery?: string): Promise<NodePgDatabase<TSchema>> {
        const pgConnection = await this.pool.begin(beginQuery);

        return this.createBoundInstance(pgConnection);
    }

    /**
     * Get the current transaction drizzle instance.
     *
     * The active transaction is sourced from the underlying pool, which tracks
     * it in the async context. Each call returns a fresh drizzle instance
     * bound to that connection, so callers in different async flows get an
     * instance scoped to their own context.
     *
     * @throws Error if not currently in a transaction
     */
    withTransaction(): NodePgDatabase<TSchema> {
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
     * @param trx The transaction drizzle instance to commit (must be the active transaction)
     */
    async commit(trx: NodePgDatabase<TSchema>): Promise<void> {
        const pgConnection = extractPgConnection(trx);
        await this.pool.commit(pgConnection);
    }

    /**
     * Rollback a transaction.
     *
     * This rolls back the transaction and releases the connection back to the pool.
     *
     * @param trx The transaction drizzle instance to rollback (must be the active transaction)
     * @param error Optional error that caused the rollback (for logging/cleanup)
     */
    async rollback(trx: NodePgDatabase<TSchema>, error?: unknown): Promise<void> {
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
     * const result = await provider.runInTransaction(async () => {
     *     const db = provider.connection();
     *     const [user] = await db.insert(usersTable).values({name: 'Frank'}).returning();
     *     await db.insert(auditTable).values({action: 'user_created', userId: user.id});
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
     * Builds a drizzle instance bound to a specific pg connection and tags
     * it with the connection symbol so commit/rollback can recover it.
     */
    private createBoundInstance(pgConnection: PgConnection): NodePgDatabase<TSchema> {
        const trx = this.blockTransactions(
            drizzle(pgConnection as any, this.drizzleConfig),
        );

        (trx as any)[pgConnectionSymbol] = pgConnection;

        return trx;
    }

    /**
     * Blocks drizzle's built-in `db.transaction()` on the given instance
     * to prevent conflicts with AsyncPgPool's transaction lifecycle.
     */
    private blockTransactions(db: NodePgDatabase<TSchema>): NodePgDatabase<TSchema> {
        (db as any).transaction = (): never => {
            throw DrizzleTransactionsNotSupported.because();
        };

        return db;
    }
}

/**
 * Creates a lazy pg client that resolves connections from the pool at query
 * execution time. When in a transaction, the shared transaction connection
 * is used. Otherwise, the primary connection is used and released after
 * the query completes.
 *
 * This object satisfies drizzle-orm's `NodePgClient` interface at runtime
 * (which only requires a `query()` method for normal operations).
 */
export function createLazyClient(pool: AsyncPgPool): {query: (config: QueryConfig | QueryArrayConfig, params?: unknown[]) => Promise<QueryResult>} {
    return {
        async query(config: QueryConfig | QueryArrayConfig, params?: unknown[]): Promise<QueryResult> {
            const connection = await pool.primary();
            const inTransaction = pool.inTransaction();

            try {
                return await connection.query(config as any, params as any);
            } finally {
                if (!inTransaction) {
                    await pool.release(connection);
                }
            }
        },
    };
}
