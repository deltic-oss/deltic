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
const supervision = Symbol.for('@deltic/async-pg-pool/supervision');

/**
 * One checkout of a client from the driver's pool, from the moment it is taken until it is handed
 * back. Holds the only reference to the driver's release function.
 *
 * `handedBack` is deliberately separate from `releasing`: the release hook still has to be able to
 * query the connection it is resetting, while a connection that has gone back to the pool must
 * refuse every further query, because the driver may already have handed it to another caller.
 */
class ConnectionLease {
    releasing = false;
    handedBack = false;
    /**
     * The handle that currently stands for this checkout. Replaced when the connection is parked as
     * idle, so that whoever released it cannot keep using it once the next claim receives it.
     */
    checkout!: Connection;

    constructor(
        readonly client: PoolClient,
        readonly handBack: PoolClient['release'],
    ) {}
}

/**
 * What a handle the pool gave out knows about itself.
 *
 * The pool never gives out the driver's client itself, because the driver hands that same object to
 * the next caller once it is back in its pool, and a reference kept past that point would query on
 * the next caller's behalf — in its transaction, under its tenant settings. Every claim, and every
 * transaction, gets a handle of its own instead, and a handle stops working when what it stood for
 * has ended.
 */
interface ConnectionSupervision {
    readonly lease: ConnectionLease;
    /**
     * `claimed` stands for a checkout; `transaction` stands for one transaction on a checkout, and
     * stops working when that transaction is committed or rolled back — even when the connection
     * itself stays with the context, as the primary connection does.
     */
    readonly role: 'claimed' | 'transaction';
    revoked: boolean;
    /**
     * How the transaction ended. What it exists for: the manual
     * `try { commit } catch (e) { rollback(trx, e) }` pattern. When the commit itself failed, the
     * transaction is already finalised by the time the compensating rollback arrives — the rollback
     * asks for something that is already true, and must not replace the commit's error with a
     * bookkeeping complaint. Only that case is forgiven: a rollback after a successful commit wants
     * to undo work that is already committed, and a second rollback usually means two owners think
     * the transaction is theirs — both must stay loud.
     */
    transactionOutcome?: 'committed' | 'rolled-back' | 'commit-failed';
}

type QueryArguments = unknown[];

interface Submittable {
    submit: (...args: unknown[]) => void;
    handleError?: (error: Error) => void;
}

function isSubmittable(value: unknown): value is Submittable {
    return typeof value === 'object' && value !== null && typeof (value as Partial<Submittable>).submit === 'function';
}

/**
 * Report a refused query the way the driver reports a query it cannot run, for each of the shapes
 * `query` accepts: a submittable (a cursor, a stream) learns through its own error handling, a
 * callback is called, and otherwise the returned promise rejects. Never synchronously, so a refused
 * query is caught wherever a failing one would be.
 */
function refuseQuery([config, values, callback]: QueryArguments, error: Error): unknown {
    if (isSubmittable(config)) {
        process.nextTick(() => config.handleError?.(error));

        return config;
    }

    const configuredCallback = typeof config === 'object' && config !== null
        ? (config as {callback?: unknown}).callback
        : undefined;
    const done = [callback, values, configuredCallback].find(candidate => typeof candidate === 'function');

    if (done !== undefined) {
        process.nextTick(() => (done as (error: Error) => void)(error));

        return undefined;
    }

    return Promise.reject(error);
}

export interface Connection extends Omit<PoolClient, 'release'> {
    [Symbol.asyncDispose](): Promise<void>;
}

export interface AsyncPoolContext {
    flushed?: true,
    exclusiveAccess: StaticMutex;
    transactionAccess: StaticMutex,
    sharedTransaction?: Connection | undefined;
    primaryConnection?: Connection | undefined;
    free: Array<[Connection, undefined | ReturnType<typeof setTimeout>]>;
    /**
     * Every connection this context has taken from the pool and not yet handed back, so that a
     * flush can account for all of them instead of only the ones it happens to have a name for.
     */
    claimed: Set<Connection>;
}

export type AsyncPgPoolContextSlot = {async_pg_pool: AsyncPoolContext};

/**
 * BC EXPORT
 */
export type AsyncPgPoolContextData = AsyncPgPoolContextSlot;

export function asyncPoolContext(): AsyncPoolContext {
    return {
        exclusiveAccess: new StaticMutexUsingMemory(),
        transactionAccess: new StaticMutexUsingMemory(),
        sharedTransaction: undefined,
        primaryConnection: undefined,
        free: [],
        claimed: new Set(),
    };
}

function supervisionIfAny(connection: Connection): ConnectionSupervision | undefined {
    return (connection as unknown as Record<symbol, ConnectionSupervision | undefined>)[supervision];
}

/**
 * The lease's current handle when the connection is one this pool gave out, so that bookkeeping
 * always compares checkouts — a transaction's handle stands for the checkout it runs on.
 */
function checkoutOf(connection: Connection | undefined): Connection | undefined {
    return connection === undefined ? undefined : supervisionIfAny(connection)?.lease.checkout ?? connection;
}

function supervisionOf(connection: Connection): ConnectionSupervision {
    const state = supervisionIfAny(connection);

    if (state === undefined) {
        throw UnableToReleaseConnection.becauseItIsNotSupervised();
    }

    return state;
}

export const asyncPgPoolContextSlot = defineContextSlot({
    key: 'async_pg_pool',
    defaultValue: (): AsyncPoolContext => asyncPoolContext(),
});

/**
 * BC EXPORT
 */
export const transactionContextSlot = asyncPgPoolContextSlot;

function createDefaultTransactionContext(): Context<AsyncPgPoolContextSlot> {
    const store = new ContextStoreUsingMemory<AsyncPgPoolContextSlot>({
        async_pg_pool: asyncPgPoolContextSlot.defaultValue!(),
    });

    return composeContextSlots([asyncPgPoolContextSlot], store);
}

export type OnReleaseCallback = (client: Connection, err?: unknown) => Promise<any> | any;

/**
 * What ending a scope had to clean up. Reported rather than thrown, so it can be logged and counted
 * from a place that cannot handle a rejection.
 */
export interface AbandonedScope {
    /**
     * What was found of an open transaction:
     * - `'none'` — there was none;
     * - `'left-open'` — there was one and it was left for the owner that will finalise it, because
     *   forcing it would roll back work the owner may still intend to commit (the default);
     * - `'rolled-back'` — there was one and it was rolled back, because the caller asked to reclaim
     *   the connection rather than wait for an owner that may never finish.
     *
     * Anything other than `'none'` means a transaction outlived the code that opened it, which is
     * worth counting: `'left-open'` that never clears is a leak, and `'rolled-back'` discarded work.
     */
    openTransaction: 'none' | 'left-open' | 'rolled-back';
    releasedConnections: number;
    failures: unknown[];
}

/**
 * How to treat a transaction that is still open when a scope is abandoned.
 */
export interface AbandonOptions {
    /**
     * Roll the transaction back and reclaim its connection, rather than leaving it for its owner.
     * Off by default: a client disconnecting mid-request does not stop the handler, so the work it
     * is about to commit must not be thrown away. Turn it on where reclaiming the connection matters
     * more than the in-flight work — typically a hard deadline, after a grace period has passed.
     */
    rollbackOpenTransaction?: boolean;
}

export interface AsyncPgPoolOptions {
    keepConnections?: number;
    keepPrimaryConnection?: false,
    lockAfterFlush?: false,
    maxIdleMs?: number;
    onClaim?: (client: Connection) => Promise<any> | any;
    onRelease?: OnReleaseCallback | string;
    releaseHookOnError?: boolean;
    freshResetQuery?: string;
    beginQuery?: string;
    /**
     * How long `begin` may queue behind a transaction that is already active in the same context.
     *
     * Left unset it waits indefinitely, which is right for a caller that queues legitimately, but
     * turns a self-deadlock into a hang with no diagnostic: awaiting a second `begin` in the flow
     * that holds the transaction can never be satisfied, because that flow is the one that would
     * have to finalise it. Setting this converts that mistake into an error.
     */
    transactionWaitTimeoutMs?: number;
}

export class AsyncPgPool {
    private readonly keepConnections: number;
    private readonly maxIdleMs: number;
    private readonly freshResetQuery?: string;
    private readonly onClaim?: (client: Connection) => Promise<any> | any;
    private readonly onRelease?: OnReleaseCallback;
    private readonly releaseHookOnError: boolean;
    private readonly beginQuery: string;
    private readonly keepPrimaryConnection: boolean;
    private readonly lockAfterFlush: boolean;
    private readonly transactionWaitTimeoutMs?: number;

    constructor(
        private readonly pool: Pool,
        options: AsyncPgPoolOptions = {},
        private readonly context: Context<AsyncPgPoolContextSlot> = createDefaultTransactionContext(),
    ) {
        this.keepConnections = options.keepConnections ?? 0;
        this.maxIdleMs = options.maxIdleMs ?? 1000;
        this.freshResetQuery = options.freshResetQuery;
        const onRelease = options.onRelease;
        this.onClaim = options.onClaim;
        this.releaseHookOnError = options.releaseHookOnError ?? false;
        this.keepPrimaryConnection = options.keepPrimaryConnection ?? true;
        this.lockAfterFlush = options.lockAfterFlush ?? true;
        this.transactionWaitTimeoutMs = options.transactionWaitTimeoutMs;
        this.onRelease = typeof onRelease === 'string' ? (client: Connection) => client.query(onRelease) : onRelease;
        this.beginQuery = options.beginQuery ?? 'BEGIN';
    }

    /**
     * The context if the current flow has one, whatever state it is in. For the paths that must
     * keep working during or after a flush — abandoning, forgetting a released connection.
     */
    private currentContext(): AsyncPoolContext | undefined {
        return this.context.get('async_pg_pool');
    }

    private resolveContext(): AsyncPoolContext {
        const context = this.currentContext();

        if (context === undefined) {
            throw new Error('No transaction context available. Did you forget to call context.run()?');
        }

        if (context.flushed && this.lockAfterFlush) {
            throw new Error('The pool context is already flushed, no more database operations allowed!');
        }

        return context;
    }

    async runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return this.context.run(async () => {
            let result: R;

            try {
                result = await fn();
            } catch (e) {
                // The flush still runs — the isolated scope must not leak connections — but its
                // complaint must not replace the unit of work's own failure. The two are usually
                // correlated: a unit of work that threw before committing leaves the very open
                // transaction the flush would report.
                try {
                    await this.flush();
                } catch {
                    // reported through the unit of work's error below
                }

                throw e;
            }

            await this.flush();

            return result;
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
        const context = this.resolveContext();
        await context.exclusiveAccess.lock();

        try {
            const transaction = context.sharedTransaction;

            if (transaction) {
                return transaction;
            }

            if (this.keepPrimaryConnection === false) {
                return this.claim();
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
        const context = this.resolveContext();

        return context.sharedTransaction !== undefined;
    }

    withTransaction(): Connection {
        const {sharedTransaction} = this.resolveContext();

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
        let response: R;

        try {
            response = await fn();
        } catch (e) {
            // Only a failure of the unit of work is compensated with a rollback. Catching wider
            // than that meant a failing COMMIT — or a failing release hook after one — was answered
            // with a rollback of a transaction that was already finalised, and the caller received
            // that bookkeeping complaint instead of the error that mattered. SQLSTATE-driven retry
            // loops never saw their serialization failures because of it.
            try {
                await this.rollback(transaction, e);
            } catch {
                // The unit of work's own failure is what the caller must see. The rollback's
                // failure has already condemned the connection, which is all it can usefully do.
            }

            throw e;
        }

        await this.commit(transaction);

        return response;
    }

    wasFlushed(): boolean {
        return this.currentContext()?.flushed ?? false;
    }

    /**
     * @deprecated use `flush` instead.
     */
    async flushSharedContext(): Promise<void> {
        return this.flush();
    }

    /**
     * End the scope, expecting nothing to be outstanding.
     *
     * Releases every connection the context still holds and reports a transaction that was never
     * committed or rolled back. Use this where the scope has a deterministic owner: a unit of work,
     * a message consumer, a test. Where the end of the scope is not in the caller's hands — an HTTP
     * request that the client may abort — use `abandon` instead.
     *
     * Note that this deliberately does not wait for an open transaction to finish. Waiting was the
     * previous behaviour and it could not be satisfied: the transaction holding the access is the
     * very thing being reported on, so the wait never ended.
     */
    async flush(): Promise<void> {
        if (this.wasFlushed()) {
            return;
        }

        const context = this.resolveContext();
        await context.exclusiveAccess.lock();
        let outcome: AbandonedScope;

        try {
            // A deterministic owner calling flush has asserted it is done, so nothing is going to
            // commit a transaction that is still open. Rolling it back reclaims the connection; the
            // rejection below then tells the owner it forgot to finalise.
            outcome = await this.tearDown(context, {rollbackOpenTransaction: true});
        } finally {
            await context.exclusiveAccess.unlock();
        }

        if (outcome.openTransaction === 'rolled-back') {
            throw UnableToFlush.becauseATransactionWasStillOpen();
        }

        if (outcome.failures.length === 1) {
            throw outcome.failures[0];
        }

        if (outcome.failures.length > 1) {
            throw new AggregateError(outcome.failures, 'Unable to release every connection of the pool context');
        }
    }

    /**
     * End the scope whatever state it is in, and report what that took.
     *
     * Waits for nothing and rejects for nothing, so it is safe to call from the places where a scope
     * turns out to be over but no result can be handled: a socket close handler, a deadline timer, a
     * signal handler. Anything that went wrong is in the returned `failures` rather than thrown,
     * because a rejection in such a handler is an unhandled rejection.
     *
     * It ends the scope of the flow it is called from. An event listener does not necessarily run in
     * the flow that registered it — a response's `close` on a client disconnect runs with no scope
     * at all — so bind such a listener to its scope (`AsyncResource.bind`) or this finds nothing.
     *
     * By default an open transaction is *left alone*: a client disconnecting mid-request does not
     * stop the handler, so the transaction may still be committed by work that is still running, and
     * reclaiming it would discard that work. Pass `rollbackOpenTransaction` to force it back where
     * reclaiming the connection matters more — typically a hard deadline after a grace period.
     *
     * Calling it more than once is harmless, and it can be called after a flush.
     */
    async abandon(options: AbandonOptions = {}): Promise<AbandonedScope> {
        // Not `resolveContext`: abandoning has to work on a context that is already flushed or
        // locked, and it must never throw.
        const context = this.currentContext();

        if (context === undefined || context.flushed === true) {
            return {openTransaction: 'none', releasedConnections: 0, failures: []};
        }

        // Taken if it happens to be free, never waited for. It is only held while a connection is
        // being claimed or a transaction started, and waiting is the one thing this must not do.
        const exclusive = await context.exclusiveAccess.tryLock();

        try {
            return await this.tearDown(context, {
                rollbackOpenTransaction: options.rollbackOpenTransaction ?? false,
            });
        } catch (e) {
            return {openTransaction: 'none', releasedConnections: 0, failures: [e]};
        } finally {
            if (exclusive) {
                await context.exclusiveAccess.unlock();
            }
        }
    }

    /**
     * Return everything the context holds, reporting rather than throwing.
     */
    private async tearDown(
        context: AsyncPoolContext,
        {rollbackOpenTransaction}: {rollbackOpenTransaction: boolean},
    ): Promise<AbandonedScope> {
        const transaction = context.sharedTransaction;

        // An open transaction means the scope may still be doing work — the classic case being a
        // request whose client has gone but whose handler runs on to commit. Unless the caller
        // insists, leave the transaction and everything else to the owner that will finalise it, and
        // report that it was left. Touching it would discard work the owner still intends to keep.
        if (transaction !== undefined && !rollbackOpenTransaction) {
            return {openTransaction: 'left-open', releasedConnections: 0, failures: []};
        }

        const failures: unknown[] = [];
        let transactionError: unknown = undefined;
        const transactionCheckout = checkoutOf(transaction);

        if (transaction !== undefined) {
            context.sharedTransaction = undefined;
            // Whoever still holds the transaction — a handler that is still running, typically —
            // must not carry on outside of it once it is rolled back.
            supervisionOf(transaction).revoked = true;

            try {
                // Rolling back beats letting the driver do it on release: it ends the transaction
                // server-side now, rather than leaving its locks held until the connection is reaped.
                await transactionCheckout!.query('ROLLBACK');
            } catch (e) {
                transactionError = e;
                failures.push(e);
            }

            try {
                // The transaction reserved the transaction access, so ending it gives that back.
                await context.transactionAccess.unlock();
            } catch (e) {
                failures.push(e);
            }
        }

        for (const [, timeout] of context.free) {
            clearTimeout(timeout);
        }

        // One at a time, so a failure cannot skip the connections behind it, and collected rather
        // than thrown, because leaking a connection is worse than reporting late.
        // Snapshot, because releasing a connection removes it from the set being walked.
        const outstanding = Array.from(context.claimed);
        let releasedConnections = 0;

        for (const connection of outstanding) {
            try {
                // A connection whose rollback failed is handed back as broken, so it gets destroyed
                // instead of serving the next caller.
                await this.doRelease(connection, connection === transactionCheckout ? transactionError : undefined);
                releasedConnections += 1;
            } catch (e) {
                failures.push(e);
            }
        }

        context.free.length = 0;
        context.primaryConnection = undefined;
        context.flushed = true;

        return {
            openTransaction: transaction !== undefined ? 'rolled-back' : 'none',
            releasedConnections,
            failures,
        };
    }

    async claim(): Promise<Connection> {
        const context = this.resolveContext();

        const [freeClient, timeout] = context.free.shift() ?? [];

        if (freeClient) {
            clearTimeout(timeout);

            return freeClient;
        }

        return this.claimFromPool();
    }

    private async claimFromPool(): Promise<Connection> {
        const client = await this.pool.connect();
        // Supervise before anything else runs: a claim hook that fails needs a connection that can
        // already be handed back, which is what made a failing hook leak its connection outright.
        const connection = this.supervise(client);
        const onClaim = this.onClaim;

        if (onClaim) {
            try {
                await onClaim(connection);
            } catch (err) {
                await this.doRelease(connection, err);

                throw UnableToClaimConnection.because(err);
            }
        }

        return connection;
    }

    /**
     * Take ownership of a connection taken from the driver's pool.
     *
     * Everything about giving the connection back lives here: the driver's own release function is
     * captured where nobody else can reach it, and releasing is idempotent.
     */
    private supervise(client: PoolClient): Connection {
        // The driver hands out a fresh single-use release function per checkout, so it is captured
        // here rather than read off the client later.
        const lease = new ConnectionLease(client, client.release.bind(client));
        lease.checkout = this.handOut(lease, 'claimed');
        this.currentContext()?.claimed.add(lease.checkout);

        return lease.checkout;
    }

    /**
     * A handle on a checkout: the driver's client in every respect, except that it refuses to query
     * once what it stands for has ended, and cannot be released behind the pool's back.
     */
    private handOut(lease: ConnectionLease, role: ConnectionSupervision['role']): Connection {
        const state: ConnectionSupervision = {lease, role, revoked: false};
        const {client} = lease;
        const clientQuery = client.query as (...args: QueryArguments) => unknown;
        const query = (...args: QueryArguments): unknown => {
            if (state.revoked && role === 'transaction') {
                return refuseQuery(args, UnableToUseConnection.becauseItsTransactionEnded());
            }

            // A release hook still queries while the connection is `releasing`; only a connection
            // that has actually gone back to the driver is refused.
            if (state.revoked || lease.handedBack) {
                return refuseQuery(args, UnableToUseConnection.becauseItWasReleased());
            }

            return clientQuery.apply(client, args);
        };
        const dispose = async (): Promise<void> => {
            if (!state.revoked && !lease.handedBack) {
                await this.release(handle);
            }
        };
        const refuseManualRelease = (): never => {
            throw new Error('You should not release the client manually.');
        };
        // A hook that wraps the handle's query (instrumentation, fault injection) wraps the guard.
        let servedQuery: unknown = query;
        const handle = new Proxy(client, {
            set(target, property, value) {
                if (property === 'query') {
                    servedQuery = value;

                    return true;
                }

                return Reflect.set(target, property, value);
            },
            get(target, property) {
                switch (property) {
                    case 'query':
                        return servedQuery;
                    case 'release':
                        return refuseManualRelease;
                    case Symbol.asyncDispose:
                        return dispose;
                    case supervision:
                        return state;
                    case originalRelease:
                        // BC: the driver's release function has always been reachable here.
                        return lease.handBack;
                    default:
                        return Reflect.get(target, property);
                }
            },
        }) as unknown as Connection;

        return handle;
    }

    /**
     * Give a checkout a new handle and retire the old one, for a connection that stays with the
     * context while whoever released it must stop using it.
     */
    private reissue(context: AsyncPoolContext, connection: Connection): Connection {
        const state = supervisionOf(connection);
        const {lease} = state;
        state.revoked = true;
        lease.checkout = this.handOut(lease, 'claimed');

        if (context.claimed.delete(connection)) {
            context.claimed.add(lease.checkout);
        }

        return lease.checkout;
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
            // The connection is ours until it is handed back, so a failing reset must not strand it.
            await this.doRelease(connection, err);

            throw UnableToClaimConnection.because(err);
        }
    }

    async begin(query: string = this.beginQuery): Promise<Connection> {
        const context = this.resolveContext();
        // Reserving the transaction access is what serialises transactions within one context: a
        // second caller queues here until the active transaction is finalised. It stays reserved for
        // the life of the transaction, so every path out of this method that does *not* leave a
        // transaction open has to give it back — that is what the outer catch is for. Leaving it
        // reserved used to wedge the context permanently, including every later flush.
        await context.transactionAccess.lock(this.transactionWaitTimeoutMs);

        try {
            await context.exclusiveAccess.lock();

            try {
                if (context.sharedTransaction) {
                    throw new Error('Unexpectedly encountered a transaction after acquiring the transaction lock');
                }

                const client = context.primaryConnection ?? (await this.claim());

                try {
                    await client.query(query);

                    // A handle of its own, even on the primary connection: the transaction ends at
                    // commit or rollback while the connection may stay with the context, and
                    // whoever kept the transaction must not be able to write outside of it.
                    return (context.sharedTransaction = this.handOut(supervisionOf(client).lease, 'transaction'));
                } catch (e) {
                    await this.doRelease(client, e);
                    throw e;
                }
            } finally {
                await context.exclusiveAccess.unlock();
            }
        } catch (e) {
            await context.transactionAccess.unlock();

            throw e;
        }
    }

    commit(client: Connection): Promise<void> {
        return this.finalizeTransaction('COMMIT', client);
    }

    /**
     * The cause is for the layers above, such as a manager that logs rollbacks by cause. Whether the
     * connection survives is decided by whether the ROLLBACK succeeds.
     */
    rollback(client: Connection, _error?: unknown): Promise<void> {
        return this.finalizeTransaction('ROLLBACK', client);
    }

    private async finalizeTransaction(
        command: 'ROLLBACK' | 'COMMIT',
        client: Connection,
    ): Promise<void> {
        const context = this.resolveContext();

        if (context.sharedTransaction !== client) {
            // A failed commit already finalised the transaction without committing it. The
            // compensating rollback of the `try commit, catch rollback` pattern is then asking for
            // what is already the case, and refusing it would bury the error that made the commit
            // fail. Only that case is forgiven — see `transactionOutcome`.
            if (command === 'ROLLBACK' && supervisionIfAny(client)?.transactionOutcome === 'commit-failed') {
                return;
            }

            throw new Error(`Trying to ${command} a transaction that is NOT the known transaction.`);
        }

        // Whatever happens from here, this transaction is over, and until the command proves
        // otherwise it ended in failure. Nothing may run through its handle any more.
        context.sharedTransaction = undefined;
        const transaction = supervisionOf(client);
        transaction.revoked = true;
        transaction.transactionOutcome = command === 'ROLLBACK' ? 'rolled-back' : 'commit-failed';
        const {lease} = transaction;
        const checkout = lease.checkout;
        let discarded = false;

        try {
            // The command tag reports what the server actually did. A COMMIT sent to a transaction
            // that failed earlier is answered with `ROLLBACK`: every statement in it was discarded.
            // The tag is the only place that distinction exists — the query itself succeeds.
            const result = await checkout.query(command);
            discarded = command === 'COMMIT' && result.command !== 'COMMIT';

            if (command === 'COMMIT' && !discarded) {
                transaction.transactionOutcome = 'committed';
            }

            // A finalised transaction leaves a clean session, whatever the unit of work threw, and
            // so does a COMMIT the server discarded. An error that concerns the connection makes the
            // command itself fail, which destroys the connection below.
            await this.release(checkout);
        } catch (e) {
            // The release above may already have handed the connection back before failing; only
            // release what is still ours, so the caller keeps the error that actually matters
            // instead of a double-release complaint from the driver.
            if (!lease.handedBack) {
                await this.doRelease(lease.checkout, e);
            }

            throw e;
        } finally {
            await context.transactionAccess.unlock();
        }

        if (discarded) {
            throw UnableToCommitTransaction.becauseTheServerDiscardedIt();
        }
    }

    /**
     * Hands a connection back. A connection the context still needs stays with it, whatever the
     * caller reports: the kept primary connection, and the connection of the active transaction,
     * which goes back once the transaction is committed or rolled back. Whether a failure condemns
     * that connection is for the transaction's owner to decide when it finalises the transaction.
     */
    async release(connection: Connection, err: unknown = undefined): Promise<void> {
        const context = this.resolveContext();
        const state = supervisionIfAny(connection);

        if (connection === context.sharedTransaction) {
            return;
        }

        if (state?.revoked) {
            // Released before — parked as idle, or ended with its transaction — and since then
            // possibly handed to someone else in this context.
            throw UnableToReleaseConnection.becauseItWasAlreadyReleased();
        }

        // A transaction's handle stands for the checkout the transaction runs on.
        const checkout = state?.lease.checkout ?? connection;

        if (checkout === context.primaryConnection && this.keepPrimaryConnection) {
            return;
        }

        if (err === undefined && this.keepConnections > context.free.length) {
            // Parked under a new handle, so the caller that released it cannot use it alongside
            // the next caller in this context that claims it.
            const parked = this.reissue(context, checkout);
            const timeout =
                this.maxIdleMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          const index = context.free.findIndex(([c]) => c === parked);

                          if (index < 0) {
                              return;
                          }

                          context.free.splice(index, 1);
                          // Evicting the connection has to hand it back, otherwise the pool loses one
                          // connection per idle period. A timer has nobody to report to, so a failing
                          // release hook is swallowed here rather than becoming a fatal unhandled
                          // rejection; a caller-driven release still surfaces it.
                          void this.doRelease(parked).catch(() => {});
                      }, this.maxIdleMs);
            context.free.push([parked, timeout]);
        } else {
            return this.doRelease(checkout, err);
        }
    }

    /**
     * Hand a connection back to the driver's pool, exactly once.
     */
    private async doRelease(connection: Connection, err: unknown = undefined): Promise<void> {
        const {lease} = supervisionOf(connection);

        if (lease.handedBack) {
            // Releasing a connection twice is a caller mistake worth hearing about, so let the
            // driver report it. Going through its single-use function keeps that signal without
            // running the release hook a second time.
            lease.handBack(undefined);

            return;
        }

        if (lease.releasing) {
            return;
        }

        lease.releasing = true;
        this.forget(lease);

        const onRelease = this.onRelease;
        let hookError: unknown = undefined;

        if (onRelease && (err === undefined || this.releaseHookOnError)) {
            try {
                // Still usable on purpose: a reset hook has to be able to query the connection.
                await onRelease(lease.checkout, err);
            } catch (e) {
                hookError = e;
            }
        }

        // From here on every handle on this checkout refuses to query.
        lease.handedBack = true;
        const reportedError = hookError ?? err;
        lease.handBack(
            reportedError === undefined
                ? undefined
                : reportedError instanceof Error
                  ? reportedError
                  : new Error(String(reportedError)),
        );

        if (hookError !== undefined) {
            throw UnableToReleaseConnection.because(hookError);
        }
    }

    /**
     * Drop every reference this context holds to a checkout, so nothing hands it out again once it
     * has gone back to the pool.
     */
    private forget(lease: ConnectionLease): void {
        // Not `resolveContext`: forgetting has to keep working while a context is being flushed.
        const context = this.currentContext();

        if (context === undefined) {
            return;
        }

        const isThisCheckout = (connection: Connection | undefined): boolean =>
            connection !== undefined && supervisionIfAny(connection)?.lease === lease;

        context.claimed.delete(lease.checkout);

        const index = context.free.findIndex(([c]) => isThisCheckout(c));

        if (index >= 0) {
            clearTimeout(context.free[index]![1]);
            context.free.splice(index, 1);
        }

        if (isThisCheckout(context.primaryConnection)) {
            context.primaryConnection = undefined;
        }

        if (isThisCheckout(context.sharedTransaction)) {
            context.sharedTransaction = undefined;
        }
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

    static becauseItIsNotSupervised = () =>
        new UnableToReleaseConnection(
            'Unable to release connection: it was not claimed through this pool',
            'async-pg-pool.connection_not_supervised',
        );

    static becauseItWasAlreadyReleased = () =>
        new UnableToReleaseConnection(
            'Unable to release connection: it was already released',
            'async-pg-pool.connection_already_released',
        );
}

/**
 * Reported, the way the driver reports a failing query, when a query is issued through a
 * connection that is no longer the caller's to use. Running it would land outside of the
 * transaction it was meant for, or on a connection the driver has since handed to someone else.
 */
export class UnableToUseConnection extends StandardError {
    static becauseItWasReleased = () =>
        new UnableToUseConnection(
            'Unable to use connection: it was released, and may already be serving another caller. '
                + 'Claim a connection for the work instead of keeping one around.',
            'async-pg-pool.connection_was_released',
        );

    static becauseItsTransactionEnded = () =>
        new UnableToUseConnection(
            'Unable to use connection: the transaction it belongs to was already committed or rolled back, '
                + 'so the query would run outside of it.',
            'async-pg-pool.transaction_has_ended',
        );
}

export class UnableToCommitTransaction extends StandardError {
    static becauseTheServerDiscardedIt = () =>
        new UnableToCommitTransaction(
            'Unable to commit: the transaction had already failed, so the server discarded it instead of committing. '
                + 'Every statement in it was rolled back. A statement failed earlier and its error was swallowed.',
            'async-pg-pool.transaction_discarded_on_commit',
        );
}

class UnableToFlush extends StandardError {
    static becauseATransactionWasStillOpen = () =>
        new UnableToFlush(
            'Unable to flush: a transaction was still open and has been rolled back. Forgot to call commit or rollback?',
            'async-pg-pool.transaction_was_still_open',
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
