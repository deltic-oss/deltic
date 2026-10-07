import type {DatabaseConnection, Driver, TransactionSettings} from 'kysely';
import type {PostgresCursorConstructor} from 'kysely';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {AsyncPgConnection, pgConnectionSymbol} from './connection.js';
import {KyselyTransactionsNotSupported} from './errors.js';

/**
 * Options for creating an AsyncPgDriver.
 */
export interface AsyncPgDriverOptions {
    /**
     * A pg-cursor constructor, passed through to AsyncPgConnection
     * for streaming query support.
     */
    cursor?: PostgresCursorConstructor;
}

/**
 * A Kysely Driver backed by AsyncPgPool.
 *
 * This driver implements Kysely's Driver interface, routing all connection
 * management through AsyncPgPool. Connections are acquired via
 * `pool.primary()` and released after each query, except the active
 * transaction's connection, which its commit or rollback hands back.
 *
 * The `beginTransaction`, `commitTransaction`, and `rollbackTransaction`
 * methods throw to prevent Kysely from issuing transaction commands that
 * would conflict with AsyncPgPool's transaction state. All transaction
 * lifecycle management must go through AsyncPgPool or the provider.
 */
export class AsyncPgDriver implements Driver {
    /**
     * The connections handed out as the active transaction's connection. Whether a query's
     * connection is handed back is decided when it is acquired: a transaction that begins or ends
     * while the query runs says nothing about the connection the query was given.
     */
    readonly #transactionConnections = new WeakSet<DatabaseConnection>();

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly options: AsyncPgDriverOptions = {},
    ) {}

    async init(): Promise<void> {
        // No-op — AsyncPgPool is already initialized.
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        const pgConnection = await this.pool.primary();
        const connection = new AsyncPgConnection(pgConnection, {cursor: this.options.cursor});

        if (this.pool.inTransaction() && this.pool.withTransaction() === pgConnection) {
            this.#transactionConnections.add(connection);
        }

        return connection;
    }

    async beginTransaction(_connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
        throw KyselyTransactionsNotSupported.because();
    }

    async commitTransaction(_connection: DatabaseConnection): Promise<void> {
        throw KyselyTransactionsNotSupported.because();
    }

    async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {
        throw KyselyTransactionsNotSupported.because();
    }

    async releaseConnection(connection: DatabaseConnection): Promise<void> {
        // The transaction's connection is handed back by its commit or rollback, not per query.
        if (this.#transactionConnections.delete(connection)) {
            return;
        }

        await this.pool.release((connection as AsyncPgConnection)[pgConnectionSymbol]);
    }

    async destroy(): Promise<void> {
        // No-op — AsyncPgPool lifecycle is managed externally.
    }
}
