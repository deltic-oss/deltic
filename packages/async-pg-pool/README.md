# @deltic/async-pg-pool

An opinionated async interface for managing PostgreSQL connections from a `pg` pool, designed for multi-tenancy, shared transactions, and predictable connection reuse.

## Why?

The standard `pg.Pool` gives you connections and releases them. It doesn't help with:

- **Shared transactions** - Multiple independent modules (event store, projections, outbox) participating in the same transaction without passing connection objects around
- **Connection lifecycle hooks** - Running setup/teardown queries on every connection claim and release (e.g., setting `app.tenant_id` for row-level security)
- **Primary connections** - Reusing a single connection across an HTTP request for advisory locks or sequential operations
- **Context-based isolation** - Preventing tenant context leakage in multi-tenant applications

`AsyncPgPool` wraps a `pg.Pool` and adds context-aware connection management. Connections are tracked per async context via `AsyncLocalStorage`, so transactions, primary connections, and tenant state are automatically scoped:

```typescript
const asyncPool = new AsyncPgPool(pgPool, {
    onClaim: client => client.query(`SET app.tenant_id = '${tenantId}'`),
    onRelease: 'RESET app.tenant_id',
});

// Shared transaction across independent modules
await asyncPool.runInTransaction(async () => {
    await eventStore.persist(aggregate);   // uses the transaction
    await outbox.dispatch(events);         // same transaction
    await projection.update(aggregate);    // same transaction
});
```

## Installation

```bash
npm install @deltic/async-pg-pool pg
```

## Quick Start

```typescript
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';

const pgPool = new Pool({connectionString: 'postgresql://...'});
const asyncPool = new AsyncPgPool(pgPool);

// Claim and release connections
const connection = await asyncPool.claim();
const result = await connection.query('SELECT * FROM users');
await asyncPool.release(connection);

// Or use async disposal
{
    await using connection = await asyncPool.claim();
    await connection.query('SELECT * FROM users');
} // auto-released
```

## Usage

### Primary Connections

A primary connection is a cached connection scoped to the current async context. Multiple calls to `primary()` return the same connection, making it useful for advisory locks or sequential operations that must share state:

```typescript
const conn = await asyncPool.primary();
await conn.query('SELECT pg_advisory_lock(12345)');
// ... later, same connection
const conn2 = await asyncPool.primary(); // same connection as conn
await conn2.query('SELECT pg_advisory_unlock(12345)');
```

Because one connection serves the whole flow, queries a flow issues *concurrently* — a
`Promise.all` over repository calls, say — all land on the same client and run one after the
other, in issue order. There is no parallelism to gain from fanning out inside a flow. This
currently rides on the `pg` driver queueing concurrent queries per client, which `pg` has
deprecated and pg@9 will remove; with `keepPrimaryConnection: false` every `primary()` call claims
its own connection and neither the serialisation nor the driver dependency applies.

### Transactions

Transactions acquire a dedicated connection and track it in the async context:

```typescript
const trx = await asyncPool.begin();

try {
    await trx.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
    await trx.query('INSERT INTO audit_log (action) VALUES ($1)', ['user_created']);
    await asyncPool.commit(trx);
} catch (error) {
    await asyncPool.rollback(trx);
    throw error;
}
```

#### Using `runInTransaction`

For automatic commit/rollback:

```typescript
await asyncPool.runInTransaction(async () => {
    const conn = await asyncPool.primary();
    await conn.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
    await conn.query('INSERT INTO audit_log (action) VALUES ($1)', ['user_created']);
});
```

Nested calls to `runInTransaction` reuse the existing transaction.

Inside a transaction, `primary()` hands out the transaction's connection. Code that releases what it got from `primary()` needs no special case for that: `release()` leaves the active transaction's connection alone, as it does the primary connection, and the pool hands it back once the transaction is committed or rolled back.

#### Transaction outcomes are verified

`commit()` believes the server, not the query. When a statement inside a transaction failed and its
error was handled by the caller — an upsert conflict caught by hand, for instance — PostgreSQL has
already aborted the transaction, and a `COMMIT` sent to it is answered with a `ROLLBACK` command
tag: every statement in it is discarded, while the COMMIT query itself succeeds. `commit()` inspects
that tag and rejects with `UnableToCommitTransaction`, so lost work is reported instead of being
mistaken for success.

Errors keep their identity through the transaction helpers. A failing `COMMIT` — a deferred
constraint, a serialization failure — reaches the caller as itself, with its SQLSTATE `code` intact,
so retry-on-`40001` loops work. A failing `ROLLBACK` never replaces the error that made the unit of
work fail. And the manual pattern above is safe: a compensating `rollback()` after a commit that
failed is a no-op, because the transaction already ended without committing. A rollback after a
*successful* commit, or a second rollback, still throws — both mean the caller wants something that
can no longer be true.

#### When the server ends a session

A session can end while its connection is checked out: a failover, `pg_terminate_backend`, or a
server timeout such as `idle_in_transaction_session_timeout`. The pool listens for that on every
connection it hands out. The driver's pool does not while a connection is checked out, and an
unheard `error` event takes the process down.

The connection goes back to the driver, which discards it, and a kept primary or idle connection is
replaced on its next use. A transaction on it was rolled back by the server along with the session.
It stays the flow's transaction until its owner finalises it, so the rest of the flow fails on it
instead of writing outside of it, where each write would commit on its own. Its `commit()` rejects
with `UnableToCommitTransaction`, and its `rollback()` succeeds.

#### Custom Isolation Levels

```typescript
const trx = await asyncPool.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');
// ... your queries
await asyncPool.commit(trx);
```

### Context Isolation

Run operations in a completely isolated connection context:

```typescript
await asyncPool.runInIsolation(async () => {
    // Connections here are independent of the outer context
    const conn = await asyncPool.claim();
    await conn.query('...');
    await asyncPool.release(conn);
}); // all connections auto-released
```

Combine isolation with transactions:

```typescript
await asyncPool.runInIsolatedTransaction(async () => {
    const conn = await asyncPool.primary();
    await conn.query('...');
}); // auto-committed and connections released
```

#### The default context is for a single flow

`new AsyncPgPool(pool)` without a context argument stores its state in one process-wide,
memory-backed context. That is convenient for a script, a test, or any other single logical flow —
but it is **not safe for concurrent flows**: two overlapping requests would share one transaction
slot and one primary connection, and can observe — or roll back — each other's work.

Anything that serves concurrent flows must pass a context backed by `AsyncLocalStorage`, and run
each flow inside a scope of its own:

```typescript
import {AsyncLocalStorage} from 'node:async_hooks';
import {composeContextSlots} from '@deltic/context';
import {AsyncPgPool, asyncPgPoolContextSlot, asyncPoolContext} from '@deltic/async-pg-pool';

const context = composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage());
const asyncPool = new AsyncPgPool(pgPool, {}, context);

// per request / message:
await context.run(async () => {
    // ... handle the request
}, {async_pg_pool: asyncPoolContext()});
```

### Connection Lifecycle Hooks

Hooks run on every connection claim/release, making them ideal for multi-tenant setups:

```typescript
const asyncPool = new AsyncPgPool(pgPool, {
    onClaim: async (client) => {
        await client.query(`SET app.tenant_id = '${tenantId}'`);
    },
    onRelease: 'RESET app.tenant_id',
    keepConnections: 2,
    maxIdleMs: 5000,
});
```

## API Reference

### `AsyncPgPool`

#### Constructor

```typescript
new AsyncPgPool(pool: Pool, options?: AsyncPgPoolOptions)
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keepConnections` | `number` | `0` | Number of idle connections to retain |
| `keepPrimaryConnection` | `boolean` | `true` | Cache one connection per context for `primary()` |
| `lockAfterFlush` | `boolean` | `true` | Refuse database operations once the context is flushed |
| `maxIdleMs` | `number` | `1000` | Milliseconds before idle connections are closed |
| `onClaim` | `(client) => any` | — | Hook called when a connection is claimed |
| `onRelease` | `string \| function` | — | Hook called on release (string = SQL query) |
| `releaseHookOnError` | `boolean` | `false` | Run `onRelease` even when releasing due to error |
| `freshResetQuery` | `string` | — | SQL to reset connection state for `claimFresh()` |
| `beginQuery` | `string` | `'BEGIN'` | SQL to begin transactions |
| `transactionWaitTimeoutMs` | `number` | — | How long `begin()` may queue behind an active transaction. Unset waits indefinitely; setting it turns a self-deadlock — awaiting a second `begin()` in the flow that holds the transaction — into an error |

#### Methods

| Method | Description |
|--------|-------------|
| `claim()` | Claims a connection from the pool |
| `claimFresh()` | Claims a connection and runs `freshResetQuery` |
| `release(connection, err?)` | Releases a connection back to the pool |
| `primary()` | Returns the cached primary connection (creates one if needed) |
| `begin(query?)` | Begins a transaction, returns the transaction connection |
| `commit(client)` | Commits the active transaction |
| `rollback(client, error?)` | Rolls back the active transaction |
| `inTransaction()` | Returns `true` if currently in a transaction |
| `withTransaction()` | Returns the active transaction connection (throws if none) |
| `runInTransaction(fn)` | Runs a function in a transaction with auto commit/rollback |
| `runInIsolation(fn)` | Runs a function in an isolated connection context |
| `runInIsolatedTransaction(fn)` | Combines isolation and transaction management |
| `flush()` | Ends the context, expecting nothing outstanding. Rejects if a transaction was left open |
| `abandon()` | Ends the context whatever state it is in. Never waits, never rejects |
| `flushSharedContext()` | Deprecated alias for `flush()` |

### Ending a context

Which of the two you want depends on whether you control the end of the scope.

`flush()` is for a scope with a deterministic owner — a unit of work, a message consumer, a test.
It releases every connection the context still holds and **rejects** if a transaction was never
committed or rolled back, because in a scope you control that is a bug worth hearing about. It rolls
that transaction back first, so a reported mistake is not also a leak. `runInIsolation` calls it for
you in a `finally`.

`abandon()` is for a scope whose end is not in your hands. The motivating case is an HTTP request:
there is no reliable moment after the handler, because `finish` does not fire when a client
disconnects, `close` fires while the handler may still be running, and Express — including v5 —
gives you no awaitable handler-completion signal. So `abandon()` **waits for nothing and rejects for
nothing**, which makes it safe to call from a socket close handler, a deadline timer or a signal
handler. What it had to clean up comes back as a value instead of an exception:

```typescript
const outcome = await asyncPool.abandon();

if (outcome.openTransaction === 'left-open') {
    // A transaction outlived the code that opened it. Usually the handler is simply still running
    // and will commit; worth a metric so a persistent one shows up as the leak it is.
    logger.warn('abandoned a scope with an open transaction', outcome);
}
```

**A client disconnecting does not stop the handler.** Node runs it to completion, so a request that
was mid-transaction when the socket closed will still commit. `abandon()` therefore does **not** roll
an open transaction back by default — doing so would throw away work the handler is about to commit.
It leaves the transaction and its connection to the handler that owns them, and reports
`openTransaction: 'left-open'`. The connection is reclaimed when the handler finishes, the same as
for a request that was never interrupted.

When reclaiming the connection matters more than the in-flight work — a hard deadline, where a
handler has had its grace period and is presumed stuck — pass `rollbackOpenTransaction`:

```typescript
import {AsyncResource} from 'node:async_hooks';

// soft: the client is gone, but let a still-running handler finish and commit
res.on('close', AsyncResource.bind(() => void asyncPool.abandon()));

// hard: the handler has had long enough; take the connection back
const deadline = setTimeout(() => void asyncPool.abandon({rollbackOpenTransaction: true}), 30_000);
```

Register the listener from inside the request's scope and bind it with `AsyncResource.bind`.
`abandon()` ends the scope of the flow it is called from, and a response's `close` event is emitted
by the socket, which existed before the request's scope did. On a client disconnect — the case this
is for — an unbound listener runs with no scope at all, so `abandon()` finds nothing to end and
reports `openTransaction: 'none'` while the request's connections stay checked out. A timer keeps
the scope it was created in, so the deadline needs no binding as long as it is armed inside the
scope; armed from within the `close` listener, it inherits whatever that listener runs in.

The same holds for anything else that reaches the pool from an event listener. A pooled
connection's own `error`, `end` and `notification` events run on the async chain its socket was
created on — usually some other flow's — so a listener that releases the connection or queries the
pool has to be bound to the flow that claimed it.

Calling `abandon()` twice, or after a `flush()`, is harmless and reports nothing left to do.

A note on avoiding the problem rather than handling it: with `keepPrimaryConnection: false` and
`keepConnections: 0`, nothing is cached for the life of the context and every query releases its own
connection, so a scope that never opens a transaction has nothing to clean up at all. That is the
recommended configuration where scope teardown is not deterministic. The corollary is that under it
a transaction must always be opened through `runInTransaction` or `runInIsolatedTransaction`, never
a bare `begin()`, because only those have a `finally` of their own.

### `TransactionManagerUsingPg`

Implements `TransactionManager` from `@deltic/transaction-manager`, delegating to an `AsyncPgPool`:

```typescript
import {TransactionManagerUsingPg} from '@deltic/async-pg-pool';

const transactionManager = new TransactionManagerUsingPg(asyncPool);
```

### `Connection`

Extends pg's `PoolClient` (without `release`) and supports `Symbol.asyncDispose` for `await using` syntax.

## How It Works

`AsyncPgPool` uses `@deltic/context` (backed by `AsyncLocalStorage`) to track connection state per async execution context. Each context maintains:

- A **primary connection** for reuse across calls
- A **shared transaction** connection when a transaction is active
- A pool of **idle connections** with configurable TTL
- A **mutex** for thread-safe context transitions

When you call `primary()`, the pool checks the current context for an existing primary connection or active transaction. When you call `runInTransaction()`, the transaction connection is stored in context so that any code running within that async scope — even in different modules — automatically participates in the same transaction.

This is what enables cross-module, cross-ORM transactions: `@deltic/async-pg-drizzle`, `@deltic/async-pg-knex`, and `@deltic/async-pg-kysely` all delegate to the same `AsyncPgPool` and share the same context.

## License

ISC
