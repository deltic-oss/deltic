import knex, {type Knex} from 'knex';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {Connection, ConnectionProvider, Transaction} from './types.js';
import {createLazyConnection} from './lazy-query-builder.js';
import {createTransactionWrapper, extractPgConnection} from './transaction-wrapper.js';

export type {Connection, ConnectionProvider, Transaction, BufferedCall} from './types.js';
export {createLazyConnection, createLazyQueryBuilder, createLazyRawBuilder} from './lazy-query-builder.js';
export {createTransactionWrapper, extractPgConnection, pgConnectionSymbol} from './transaction-wrapper.js';

/**
 * Options for creating an AsyncKnexConnectionProvider.
 */
export interface AsyncKnexConnectionProviderOptions {
    /**
     * Additional Knex configuration. The client is always 'pg' and
     * connection is managed externally, so those options are ignored.
     */
    knexConfig?: Omit<Knex.Config, 'client' | 'connection'>;
}

/**
 * Provides Knex-based database connections using AsyncPgPool for connection management.
 *
 * This class implements the ConnectionProvider interface, offering:
 * - Lazy connections that only acquire a database connection when a query is awaited
 * - Transaction support with proper connection lifecycle management
 * - Raw pg Client access when needed
 *
 * @example
 * ```typescript
 * import {Pool} from 'pg';
 * import {AsyncPgPool} from '@deltic/async-pg-pool';
 * import {AsyncKnexConnectionProvider} from '@deltic/async-pg-knex';
 *
 * const pgPool = new Pool({connectionString: '...'});
 * const asyncPool = new AsyncPgPool(pgPool);
 * const provider = new AsyncKnexConnectionProvider(asyncPool);
 *
 * // Lazy query - connection acquired only on await
 * const users = await provider.connection().select('*').from('users');
 *
 * // Transaction
 * const trx = await provider.begin();
 * try {
 *     await trx('users').insert({name: 'John'});
 *     await provider.commit(trx);
 * } catch (e) {
 *     await provider.rollback(trx);
 *     throw e;
 * }
 * ```
 */
export class AsyncKnexConnectionProvider implements ConnectionProvider {
    private readonly knex: Knex;

    constructor(
        private readonly pool: AsyncPgPool,
        options: AsyncKnexConnectionProviderOptions = {},
    ) {
        // Create a Knex instance without a connection pool - we manage connections ourselves
        this.knex = knex({
            ...options.knexConfig,
            client: 'pg',
            // Use a dummy connection config since we provide connections manually
            connection: {},
            // Disable pool since we manage connections through AsyncPgPool
            pool: {min: 0, max: 0},
        });
    }

    /**
     * Get a Connection for building queries.
     *
     * The returned Connection is lazy - no actual database connection is acquired
     * until the query is awaited. This allows building complex queries without
     * holding a connection.
     *
     * If currently in a transaction, queries will use the transaction connection.
     *
     * @example
     * ```typescript
     * // These don't acquire a connection yet
     * const query = provider.connection()
     *     .select('*')
     *     .from('users')
     *     .where('active', true);
     *
     * // Connection acquired here, query executed, connection released
     * const users = await query;
     * ```
     */
    connection(): Connection {
        return createLazyConnection(this.knex, this.pool);
    }

    /**
     * Begin a transaction and return a Transaction object.
     *
     * Unlike connection(), the Transaction immediately acquires a connection
     * since transactions require a dedicated connection for their duration.
     *
     * @param beginQuery Optional custom BEGIN query (e.g., 'BEGIN ISOLATION LEVEL SERIALIZABLE')
     *
     * @example
     * ```typescript
     * const trx = await provider.begin();
     * try {
     *     await trx('accounts').where('id', 1).decrement('balance', 100);
     *     await trx('accounts').where('id', 2).increment('balance', 100);
     *     await provider.commit(trx);
     * } catch (e) {
     *     await provider.rollback(trx);
     *     throw e;
     * }
     * ```
     */
    async begin(beginQuery?: string): Promise<Transaction> {
        const pgConnection = await this.pool.begin(beginQuery);

        return createTransactionWrapper(this.knex, pgConnection);
    }

    /**
     * Get the current transaction.
     *
     * The active transaction is sourced from the underlying pool, which tracks
     * it in the async context. Each call returns a fresh wrapper bound to that
     * connection, so callers in different async flows get a wrapper scoped to
     * their own context.
     *
     * @throws Error if not currently in a transaction
     */
    withTransaction(): Transaction {
        const pgConnection = this.pool.withTransaction();

        return createTransactionWrapper(this.knex, pgConnection);
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
     * @param trx The transaction to commit (must be the active transaction)
     */
    async commit(trx: Transaction): Promise<void> {
        const pgConnection = extractPgConnection(trx);
        await this.pool.commit(pgConnection);
    }

    /**
     * Rollback a transaction.
     *
     * This rolls back the transaction and releases the connection back to the pool.
     *
     * @param trx The transaction to rollback (must be the active transaction)
     * @param error Optional error that caused the rollback (for logging/cleanup)
     */
    async rollback(trx: Transaction, error?: unknown): Promise<void> {
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
     *     const [user] = await provider.connection()('users').insert({name: 'John'}).returning('*');
     *     await provider.connection()('audit').insert({action: 'user_created', userId: user.id});
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
     * Destroy the Knex instance.
     * Call this when shutting down to clean up resources.
     */
    async destroy(): Promise<void> {
        await this.knex.destroy();
    }
}
