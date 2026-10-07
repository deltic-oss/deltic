# @deltic/async-pg-kysely

Kysely query builder integration with `@deltic/async-pg-pool`, decoupling transaction management from Kysely so it can be shared across query builders and infrastructure.

## Why?

Kysely has solid transaction support, including `AsyncLocalStorage`-based implicit transactions via plugins. However, Kysely's transactions are Kysely-scoped — everything that participates must go through Kysely's `db.transaction()` callback.

In systems where multiple components need to share a transaction — an event store writing through one query builder, a projection updating through another, an outbox persisting through a third — tying the transaction lifecycle to any single tool becomes a bottleneck. You'd need to pass Kysely's transaction object into code that may not use Kysely at all.

`@deltic/async-pg-kysely` solves this by externalizing connection and transaction management to `AsyncPgPool`. Kysely becomes a query building layer only, while the pool owns the connection lifecycle. This means:

- **Decoupled transactions** — The transaction is managed at the pool level, not by Kysely. Any code using the same `AsyncPgPool` participates in the same transaction, regardless of which query builder it uses.
- **Cross-ORM consistency** — Kysely, Knex, and Drizzle queries can share a single transaction through the same pool, without any of them knowing about each other.
- **Connection lifecycle hooks** — `AsyncPgPool` provides hooks for connection setup/teardown (e.g., setting `app.tenant_id` for row-level security), applied uniformly to all query builders.

You keep Kysely's full type-safe API — the only thing that changes is who manages connections and transactions:

```typescript
const provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);

// Queries — connections managed by AsyncPgPool
const users = await provider.connection()
    .selectFrom('users')
    .selectAll()
    .execute();

// Transactions — managed by the provider, not by Kysely
await provider.runInTransaction(async () => {
    await provider.connection()
        .insertInto('users')
        .values({name: 'Frank'})
        .execute();
    await provider.connection()
        .insertInto('audit')
        .values({action: 'user_created'})
        .execute();
});
```

## Installation

```bash
npm install @deltic/async-pg-kysely @deltic/async-pg-pool kysely pg
```

For streaming query support, also install `pg-cursor`:

```bash
npm install pg-cursor
```

## Quick Start

```typescript
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {AsyncKyselyConnectionProvider} from '@deltic/async-pg-kysely';

interface DB {
    users: {
        id: Generated<number>;
        name: string;
        email: string | null;
        active: Generated<boolean>;
    };
}

// Create the connection stack
const pgPool = new Pool({connectionString: 'postgresql://...'});
const asyncPool = new AsyncPgPool(pgPool);
const provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);

// Query with lazy connection resolution
const users = await provider.connection()
    .selectFrom('users')
    .selectAll()
    .where('active', '=', true)
    .execute();
```

## Usage

### Basic Queries

```typescript
// SELECT
const users = await provider.connection()
    .selectFrom('users')
    .selectAll()
    .where('active', '=', true)
    .execute();

// SELECT specific columns
const names = await provider.connection()
    .selectFrom('users')
    .select(['name', 'email'])
    .execute();

// INSERT with returning
const newUser = await provider.connection()
    .insertInto('users')
    .values({name: 'Alice', email: 'alice@example.com'})
    .returningAll()
    .executeTakeFirstOrThrow();

// UPDATE
await provider.connection()
    .updateTable('users')
    .set({lastLogin: new Date()})
    .where('id', '=', userId)
    .execute();

// DELETE
await provider.connection()
    .deleteFrom('users')
    .where('id', '=', userId)
    .execute();
```

### Raw SQL

```typescript
import {sql} from 'kysely';

const result = await sql<{name: string; age: number}>`
    SELECT name, age FROM users WHERE age > ${21}
`.execute(provider.connection());
```

### Streaming Queries

For large result sets, you can stream rows instead of loading everything into memory. This requires `pg-cursor`:

```typescript
import Cursor from 'pg-cursor';

const provider = new AsyncKyselyConnectionProvider<DB>(asyncPool, {
    cursor: Cursor,
});

for await (const row of provider.connection()
    .selectFrom('events')
    .selectAll()
    .where('created_at', '>', cutoffDate)
    .stream(100)) {
    processEvent(row);
}
```

The `chunkSize` argument (100 above) controls how many rows are fetched from the database at a time via PostgreSQL cursors. Kysely's `.stream()` yields individual rows regardless of chunk size.

If `cursor` is not configured and `.stream()` is called, a clear error is thrown.

### Transactions

Transactions acquire a dedicated connection for their duration:

```typescript
const trx = await provider.begin();

try {
    await trx
        .updateTable('accounts')
        .set((eb) => ({balance: eb('balance', '-', amount)}))
        .where('id', '=', fromAccountId)
        .execute();

    await trx
        .updateTable('accounts')
        .set((eb) => ({balance: eb('balance', '+', amount)}))
        .where('id', '=', toAccountId)
        .execute();

    await trx
        .insertInto('transfers')
        .values({fromAccount: fromAccountId, toAccount: toAccountId, amount})
        .execute();

    await provider.commit(trx);
} catch (error) {
    await provider.rollback(trx);
    throw error;
}
```

#### Using `runInTransaction`

For simpler transaction handling with automatic commit/rollback:

```typescript
const user = await provider.runInTransaction(async () => {
    const user = await provider.connection()
        .insertInto('users')
        .values({name: 'Bob'})
        .returningAll()
        .executeTakeFirstOrThrow();

    await provider.connection()
        .insertInto('audit_log')
        .values({action: 'user_created', userId: user.id})
        .execute();

    return user;
});
```

If the function throws, the transaction is automatically rolled back. Nested calls to `runInTransaction` reuse the existing transaction.

#### Custom Isolation Levels

```typescript
const trx = await provider.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');
// ... your queries
await provider.commit(trx);
```

### Using `connection()` Inside Transactions

The `connection()` method is transaction-aware. When a transaction is active, queries executed through `connection()` automatically use the transaction connection via `AsyncPgPool`:

```typescript
await provider.runInTransaction(async () => {
    // Both queries run on the same transaction connection
    await provider.connection()
        .insertInto('users')
        .values({name: 'Frank'})
        .execute();
    await provider.connection()
        .insertInto('audit')
        .values({action: 'user_created'})
        .execute();
});
```

This means modules that use `provider.connection()` internally don't need to know whether they're running inside a transaction or not.

### Cross-Query-Builder Transactions

This is the primary reason this package exists. Because `@deltic/async-pg-kysely`, `@deltic/async-pg-drizzle`, and `@deltic/async-pg-knex` all delegate connection management to the same `AsyncPgPool`, they participate in the same transaction without knowing about each other:

```typescript
const kyselyDb = new AsyncKyselyConnectionProvider<DB>(asyncPool);
const knexDb = new AsyncKnexConnectionProvider(asyncPool);

await asyncPool.runInTransaction(async () => {
    // Kysely query — uses the shared transaction connection
    await kyselyDb.connection()
        .insertInto('users')
        .values({name: 'Frank'})
        .execute();

    // Knex query — same transaction, same connection
    await knexDb.connection()('audit_log')
        .insert({action: 'user_created'});
});
```

## API Reference

### `AsyncKyselyConnectionProvider<DB>`

#### Constructor

```typescript
new AsyncKyselyConnectionProvider<DB>(pool: AsyncPgPool, options?: {
    plugins?: KyselyPlugin[];
    log?: LogConfig;
    cursor?: PostgresCursorConstructor;
})
```

- `plugins` — Kysely plugins to install (e.g., `CamelCasePlugin`)
- `log` — Kysely's query logging configuration
- `cursor` — A `pg-cursor` constructor to enable streaming queries via `.stream()`

#### Methods

| Method | Description |
|--------|-------------|
| `connection()` | Returns a `Kysely<DB>` instance for building queries |
| `begin(query?)` | Begins a transaction, returns a `Kysely<DB>` bound to it |
| `commit(trx)` | Commits a transaction |
| `rollback(trx, error?)` | Rolls back a transaction |
| `withTransaction()` | Returns the current transaction instance (throws if none) |
| `inTransaction()` | Returns `true` if currently in a transaction |
| `runInTransaction(fn)` | Runs a function in a transaction with auto commit/rollback |
| `destroy()` | Destroys the Kysely instance (call on shutdown) |

### Kysely's Transaction Methods Are Blocked

All `Kysely<DB>` instances created by this provider have Kysely's built-in `db.transaction()` and `db.startTransaction()` overridden to throw `KyselyTransactionsNotSupported`. The driver's `beginTransaction`, `commitTransaction`, and `rollbackTransaction` methods also throw. This prevents Kysely from issuing `BEGIN`/`COMMIT`/`ROLLBACK` on the pool-managed connection, which would corrupt `AsyncPgPool`'s transaction state.

Use the provider's `begin()`/`commit()`/`rollback()` or `runInTransaction()` instead.

## How It Works

Under the hood, the provider creates a custom Kysely `Dialect` with a custom `Driver` implementation backed by `AsyncPgPool`:

1. **`connection()`** returns a Kysely instance whose driver resolves connections via `pool.primary()`
2. **When a query executes**, the driver calls `pool.primary()` to get the current connection (respecting transaction context)
3. **The query runs** on the resolved connection via `connection.query()`
4. **The connection is released** back to the pool — unless the driver was handed the active transaction's connection, which only that transaction's commit or rollback hands back. That is decided when the connection is acquired, so a transaction that begins or ends while the query runs does not change what happens to the query's connection

**Transactions** work differently: `begin()` creates a new Kysely instance with an inline dialect that always returns the same dedicated connection. All queries on that instance execute on the transaction connection until commit or rollback.

### Architecture

The package provides three main building blocks:

- **`AsyncPgDialect`** — A Kysely `Dialect` that reuses Kysely's `PostgresQueryCompiler`, `PostgresAdapter`, and `PostgresIntrospector` while providing a custom driver
- **`AsyncPgDriver`** — A Kysely `Driver` that routes `acquireConnection`/`releaseConnection` through `AsyncPgPool`
- **`AsyncPgConnection`** — A Kysely `DatabaseConnection` that wraps a pg client and translates between pg's query result format and Kysely's `QueryResult`

### Integration with AsyncPgPool Features

Because connections flow through `AsyncPgPool`, you get all its features:

```typescript
const asyncPool = new AsyncPgPool(pgPool, {
    // Run on every connection claim
    onClaim: client => client.query(`SET app.tenant_id = '${tenantId}'`),
    // Run on every connection release
    onRelease: 'RESET app.tenant_id',
    // Keep connections warm
    keepConnections: 2,
    maxIdleMs: 5000,
});

const provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);

// Queries automatically get tenant_id set
const users = await provider.connection()
    .selectFrom('users')
    .selectAll()
    .execute();
```

## License

ISC
