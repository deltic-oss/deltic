import type {Pool, PoolClient} from 'pg';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import type {StaticMutex} from '@deltic/mutex';
import {errorToMessage, StandardError} from '@deltic/error-standard';
import type {TransactionManager} from '@deltic/transaction-manager';
import {
    Context,
    ContextStoreUsingMemory,
    composeContextSlots,
    defineContextSlot,
} from '@deltic/context';

const originalRelease = Symbol.for('@deltic/async-pg-pool/release');

export interface Connection extends Omit<PoolClient, 'release'> {
    [Symbol.asyncDispose](): Promise<void>;
}

export interface AsyncPoolContext {
    exclusiveAccess: StaticMutex;
    sharedTransaction?: Connection | undefined;
    primaryConnection?: Connection | undefined;
    free: Array<[Connection, undefined | ReturnType<typeof setTimeout>]>;
}

export type AsyncPgPoolContextData = {async_pg_pool: AsyncPoolContext};

export function asyncPoolContext(): AsyncPoolContext {
    return {
        exclusiveAccess: new StaticMutexUsingMemory(),
        sharedTransaction: undefined,
        primaryConnection: undefined,
        free: [],
    };
}

export const transactionContextSlot = defineContextSlot({
    key: 'async_pg_pool',
    defaultValue: (): AsyncPoolContext => asyncPoolContext(),
});

function createDefaultTransactionContext(): Context<AsyncPgPoolContextData> {
    const store = new ContextStoreUsingMemory<AsyncPgPoolContextData>({
        async_pg_pool: transactionContextSlot.defaultValue!(),
    });

    return composeContextSlots([transactionContextSlot], store);
}

export type OnReleaseCallback = (client: Connection, err?: unknown) => Promise<any> | any;

export interface AsyncPgPoolOptions {
    keepConnections?: number;
    maxIdleMs?: number;
    onClaim?: (client: Connection) => Promise<any> | any;
    onRelease?: OnReleaseCallback | string;
    releaseHookOnError?: boolean;
    freshResetQuery?: string;
    beginQuery?: string;
}

export class AsyncPgPool {
    private readonly keepConnections: number;
    private readonly maxIdleMs: number;
    private readonly freshResetQuery?: string;
    private readonly onRelease?: OnReleaseCallback;
    private readonly beginQuery: string;

    constructor(
        private readonly pool: Pool,
        private readonly options: AsyncPgPoolOptions = {},
        private readonly context: Context<AsyncPgPoolContextData> = createDefaultTransactionContext(),
    ) {
        this.keepConnections = options.keepConnections ?? 0;
        this.maxIdleMs = options.maxIdleMs ?? 1000;
        this.freshResetQuery = options.freshResetQuery;
        const onRelease = options.onRelease;
        this.onRelease = typeof onRelease === 'string' ? (client: Connection) => client.query(onRelease) : onRelease;
        this.beginQuery = options.beginQuery ?? 'BEGIN';
    }

    private resolveTransactionContext(): AsyncPoolContext {
        const ctx = this.context.get('async_pg_pool');

        if (ctx === undefined) {
            throw new Error('No transaction context available. Did you forget to call context.run()?');
        }

        return ctx;
    }

    async runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return this.context.run(async () => {
            try {
                return await fn();
            } finally {
                await this.flushSharedContext();
            }
        }, {
            async_pg_pool: asyncPoolContext(),
        });
    }

    async runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return this.runInIsolation(async () => {
            return this.runInTransaction(fn);
        });
    }

    async primary(): Promise<Connection> {
        const context = this.resolveTransactionContext();
        await context.exclusiveAccess.lock();

        try {
            const transaction = context.sharedTransaction;

            if (transaction) {
                return transaction;
            }

            const primaryConnection = context.primaryConnection;

            if (primaryConnection) {
                return primaryConnection;
            }

            return (context.primaryConnection = await this.claim());
        } finally {
            await context.exclusiveAccess.unlock();
        }
    }

    inTransaction(): boolean {
        const context = this.resolveTransactionContext();

        return context.sharedTransaction !== undefined;
    }

    withTransaction(): Connection {
        const {sharedTransaction} = this.resolveTransactionContext();

        if (sharedTransaction === undefined) {
            throw UnableToProvideActiveTransaction.noTransactionWasActive();
        }

        return sharedTransaction;
    }

    async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        if (this.inTransaction()) {
            return fn();
        }

        const transaction = await this.begin();

        try {
            const response = await fn();
            await this.commit(transaction);

            return response;
        } catch (e) {
            await this.rollback(transaction, e);
            throw e;
        }
    }

    async flushSharedContext(): Promise<void> {
        const context = this.resolveTransactionContext();
        await context.exclusiveAccess.lock();

        try {
            await Promise.all(
                context.free.map(([connection, timeout]) => {
                    clearTimeout(timeout);
                    this.doRelease(connection);
                }),
            );
            context.free.length = 0;

            if (context.primaryConnection) {
                await this.doRelease(context.primaryConnection);
                context.primaryConnection = undefined;
            }

            if (context.sharedTransaction) {
                throw new Error(
                    'Expected not the have a transaction, but one was found. Forgot to call commit or rollback?',
                );
            }
        } finally {
            await context.exclusiveAccess.unlock();
        }
    }

    async claim(): Promise<Connection> {
        const context = this.resolveTransactionContext();
        const [freeClient, timeout] = context.free.shift() ?? [];

        if (freeClient) {
            clearTimeout(timeout);

            return freeClient;
        }

        return this.claimFromPool();
    }

    private async claimFromPool(): Promise<Connection> {
        const client = (await this.pool.connect()) as unknown as Connection;
        const onClaim = this.options.onClaim;

        if (onClaim) {
            try {
                await onClaim(client);
            } catch (err) {
                await this.doRelease(client, err);

                throw UnableToClaimConnection.because(err);
            }
        }

        const release = this.release.bind(this);
        const poolRelease = (client as unknown as PoolClient).release.bind(client);
        let released = false;

        return Object.defineProperties(client, {
            [originalRelease]: {
                writable: true,
                value: poolRelease,
            },
            [Symbol.asyncDispose]: {
                writable: true,
                value: async () => {
                    if (!released) {
                        released = true;
                        return release(client);
                    }
                },
            },
            release: {
                writable: true,
                value: () => {
                    throw new Error('You should not release the client manually.');
                },
            },
        });
    }

    async claimFresh(): Promise<Connection> {
        const connection = await this.claimFromPool();

        if (!this.freshResetQuery) {
            return connection;
        }

        try {
            await connection.query(this.freshResetQuery);

            return connection;
        } catch (err) {
            throw UnableToClaimConnection.because(err);
        }
    }

    async begin(query: string = this.beginQuery): Promise<Connection> {
        const context = this.resolveTransactionContext();
        await context.exclusiveAccess.lock();

        if (context.sharedTransaction) {
            await context.exclusiveAccess.unlock();
            throw new Error('Cannot begin transaction when already inside one');
        }

        let client: Connection;

        try {
            client = context.primaryConnection ?? (await this.claim());
        } catch (e) {
            await context.exclusiveAccess.unlock();
            throw e;
        }

        try {
            await client.query(query);

            return (context.sharedTransaction = client);
        } catch (e) {
            await this.doRelease(client, e);
            throw e;
        } finally {
            await context.exclusiveAccess.unlock();
        }
    }

    commit(client: Connection): Promise<void> {
        return this.finalizeTransaction('COMMIT', client);
    }

    rollback(client: Connection, error?: unknown): Promise<void> {
        return this.finalizeTransaction('ROLLBACK', client, error);
    }

    private async finalizeTransaction(
        command: 'ROLLBACK' | 'COMMIT',
        client: Connection,
        error?: unknown,
    ): Promise<void> {
        const context = this.resolveTransactionContext();

        if (context.sharedTransaction !== client) {
            throw new Error(`Trying to ${command} a transaction that is NOT the known transaction.`);
        }

        try {
            await client.query(command);
            await this.release(client, error);
        } catch (e) {
            await this.doRelease(client, e);
            throw e;
        } finally {
            this.resolveTransactionContext().sharedTransaction = undefined;
        }
    }

    async release(connection: Connection, err: unknown = undefined): Promise<void> {
        const context = this.resolveTransactionContext();

        if (connection === context.primaryConnection) {
            return;
        }

        if (err === undefined && this.keepConnections > context.free.length) {
            const timeout =
                this.maxIdleMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          const context = this.resolveTransactionContext();
                          const index = context.free.findIndex(([c]) => c === connection);

                          if (index >= 0) {
                              context.free.splice(index, 1);
                          }
                      }, this.maxIdleMs);
            context.free.push([connection, timeout]);
        } else {
            return this.doRelease(connection, err);
        }
    }

    private async doRelease(connection: Connection, err: unknown = undefined): Promise<void> {
        const onRelease = this.onRelease;

        if (onRelease && (err === undefined || this.options.releaseHookOnError)) {
            try {
                await onRelease(connection, err);
            } catch (onReleaseError) {
                ((connection as any)[originalRelease] as PoolClient['release'])(
                    onReleaseError instanceof Error ? onReleaseError : new Error(String(onReleaseError)),
                );

                throw UnableToReleaseConnection.because(onReleaseError);
            }
        }

        // Forward to the original release function.
        ((connection as any)[originalRelease] as PoolClient['release'])(
            err === undefined ? err : err instanceof Error ? err : new Error(String(err)),
        );
    }
}

class UnableToClaimConnection extends StandardError {
    static because = (err: unknown) =>
        new UnableToClaimConnection(
            `Unable to claim connection: ${errorToMessage(err)}`,
            'async-pg-pool.unable_to_claim_connection',
            {},
            err,
        );
}

class UnableToReleaseConnection extends StandardError {
    static because = (err: unknown) =>
        new UnableToReleaseConnection(
            `Unable to release connection: ${errorToMessage(err)}`,
            'async-pg-pool.unable_to_release_connection',
            {},
            err,
        );
}

class UnableToProvideActiveTransaction extends StandardError {
    static noTransactionWasActive = (err?: unknown) =>
        new UnableToProvideActiveTransaction(
            'Unable to provide active transaction: no transaction was active',
            'async-pg-pool.no_active_transaction_available',
            {},
            err,
        );
}

export class TransactionManagerUsingPg implements TransactionManager {
    constructor(private readonly pool: AsyncPgPool) {}

    rollback(error?: unknown): Promise<void> {
        return this.pool.rollback(this.pool.withTransaction(), error);
    }

    async begin(): Promise<void> {
        await this.pool.begin();
    }

    commit(): Promise<void> {
        return this.pool.commit(this.pool.withTransaction());
    }

    inTransaction(): boolean {
        return this.pool.inTransaction();
    }

    runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return this.pool.runInIsolation(fn);
    }

    runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return this.pool.runInTransaction(fn);
    }

    runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return this.pool.runInIsolatedTransaction(fn);
    }
}
