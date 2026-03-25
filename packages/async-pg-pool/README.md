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
| `maxIdleMs` | `number` | `1000` | Milliseconds before idle connections are closed |
| `onClaim` | `(client) => any` | — | Hook called when a connection is claimed |
| `onRelease` | `string \| function` | — | Hook called on release (string = SQL query) |
| `releaseHookOnError` | `boolean` | `false` | Run `onRelease` even when releasing due to error |
| `freshResetQuery` | `string` | — | SQL to reset connection state for `claimFresh()` |
| `beginQuery` | `string` | `'BEGIN'` | SQL to begin transactions |

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
| `flushSharedContext()` | Releases all connections in the current context |

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
