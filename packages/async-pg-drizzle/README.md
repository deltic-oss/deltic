# @deltic/async-pg-drizzle

Drizzle ORM integration with `@deltic/async-pg-pool`, giving you full control over connection and transaction management while keeping Drizzle's type-safe query building API.

## Why?

Drizzle ORM manages connections and transactions internally. When you call `db.transaction()`, Drizzle checks out a connection, issues `BEGIN`, runs your callback, and commits or rolls back. This works for simple applications, but you lose control over important aspects:

- **Shared transactions** - Multiple independent modules (event store, projections, outbox) can't participate in the same transaction without passing a `tx` object around
- **Connection lifecycle hooks** - No way to run setup/teardown queries on connections (e.g., setting `app.tenant_id` for row-level security)
- **Request-scoped connections** - No built-in way to reuse a connection across an HTTP request
- **Cross-ORM transactions** - Can't share a transaction between Drizzle and Knex queries

`@deltic/async-pg-drizzle` bridges Drizzle's query builder with `@deltic/async-pg-pool`. You get Drizzle's full type-safe API while `AsyncPgPool` handles all connection and transaction management:

```typescript
const db = new AsyncDrizzleConnectionProvider(asyncPool, {schema});

// Queries — connections managed by AsyncPgPool
const users = await db.connection().select().from(usersTable);

// Transactions — managed by the provider, not by Drizzle
await db.runInTransaction(async () => {
    await db.connection().insert(usersTable).values({name: 'Frank'});
    await db.connection().insert(auditTable).values({action: 'user_created'});
});
```

## Installation

```bash
npm install @deltic/async-pg-drizzle @deltic/async-pg-pool drizzle-orm pg
```

## Quick Start

```typescript
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {AsyncDrizzleConnectionProvider} from '@deltic/async-pg-drizzle';
import * as schema from './schema';

// Create the connection stack
const pgPool = new Pool({connectionString: 'postgresql://...'});
const asyncPool = new AsyncPgPool(pgPool);
const db = new AsyncDrizzleConnectionProvider(asyncPool, {schema});

// Query with lazy connection resolution
const users = await db.connection()
    .select()
    .from(schema.usersTable)
    .where(eq(schema.usersTable.active, true));
```

## Usage

### Basic Queries

```typescript
// SELECT
const users = await db.connection()
    .select()
    .from(usersTable)
    .where(eq(usersTable.active, true));

// SELECT specific columns
const names = await db.connection()
    .select({name: usersTable.name, email: usersTable.email})
    .from(usersTable);

// INSERT with returning
const [newUser] = await db.connection()
    .insert(usersTable)
    .values({name: 'Alice', email: 'alice@example.com'})
    .returning();

// UPDATE
await db.connection()
    .update(usersTable)
    .set({lastLogin: new Date()})
    .where(eq(usersTable.id, userId));

// DELETE
await db.connection()
    .delete(usersTable)
    .where(eq(usersTable.id, userId));
```

### Raw SQL

```typescript
const result = await db.connection().execute(
    sql`SELECT * FROM users WHERE age > ${21}`,
);
```

### Transactions

Transactions acquire a dedicated connection for their duration:

```typescript
const trx = await db.begin();

try {
    await trx
        .update(accountsTable)
        .set({balance: sql`balance - ${amount}`})
        .where(eq(accountsTable.id, fromAccountId));

    await trx
        .update(accountsTable)
        .set({balance: sql`balance + ${amount}`})
        .where(eq(accountsTable.id, toAccountId));

    await trx.insert(transfersTable).values({
        fromAccount: fromAccountId,
        toAccount: toAccountId,
        amount,
    });

    await db.commit(trx);
} catch (error) {
    await db.rollback(trx);
    throw error;
}
```

A second `begin()` waits for the active transaction to be finalised — that is what lets two
concurrent flows share a context. It also means a flow must never `await` a transaction it would
itself have to finalise, because nothing can break that deadlock. Compose with `runInTransaction`,
which joins the active transaction instead of opening a second one, and set the pool's
`transactionWaitTimeoutMs` to turn a mistaken wait into an error rather than a hang.

#### Using `runInTransaction`

For simpler transaction handling with automatic commit/rollback:

```typescript
const user = await db.runInTransaction(async () => {
    const [user] = await db.connection()
        .insert(usersTable)
        .values({name: 'Bob'})
        .returning();

    await db.connection()
        .insert(auditLogTable)
        .values({action: 'user_created', userId: user.id});

    return user;
});
```

If the function throws, the transaction is automatically rolled back. Nested calls to `runInTransaction` reuse the existing transaction.

#### Custom Isolation Levels

```typescript
const trx = await db.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');
// ... your queries
await db.commit(trx);
```

### Using `connection()` Inside Transactions

The `connection()` method is transaction-aware. When a transaction is active, queries executed through `connection()` automatically use the transaction connection:

```typescript
await db.runInTransaction(async () => {
    // Both queries run on the same transaction connection
    await db.connection().insert(usersTable).values({name: 'Frank'});
    await db.connection().insert(auditTable).values({action: 'user_created'});
});
```

This means modules that use `db.connection()` internally don't need to know whether they're running inside a transaction or not.

### Side-by-Side with Knex

Because both `@deltic/async-pg-drizzle` and `@deltic/async-pg-knex` delegate connection management to the same `AsyncPgPool`, they can share transactions:

```typescript
const drizzleDb = new AsyncDrizzleConnectionProvider(asyncPool, {schema});
const knexDb = new AsyncKnexConnectionProvider(asyncPool);

await asyncPool.runInTransaction(async () => {
    // Drizzle query — uses the shared transaction connection
    await drizzleDb.connection()
        .insert(usersTable)
        .values({name: 'Frank'});

    // Knex query — same transaction, same connection
    await knexDb.connection()('audit_log')
        .insert({action: 'user_created'});
});
```

## API Reference

### `AsyncDrizzleConnectionProvider`

#### Constructor

```typescript
new AsyncDrizzleConnectionProvider(pool: AsyncPgPool, options?: {
    schema?: TSchema;
    logger?: boolean | Logger;
    casing?: 'snake_case' | 'camelCase';
})
```

The `schema` option enables Drizzle's typed relational queries. The `logger` and `casing` options are passed through to Drizzle's configuration.

#### Methods

| Method | Description |
|--------|-------------|
| `connection()` | Returns a `NodePgDatabase` instance for building queries |
| `begin(query?)` | Begins a transaction, returns a `NodePgDatabase` bound to it |
| `commit(trx)` | Commits a transaction |
| `rollback(trx, error?)` | Rolls back a transaction |
| `withTransaction()` | Returns the current transaction instance (throws if none) |
| `inTransaction()` | Returns `true` if currently in a transaction |
| `runInTransaction(fn)` | Runs a function in a transaction with auto commit/rollback |

### Drizzle's `db.transaction()` Is Blocked

All `NodePgDatabase` instances created by this provider have Drizzle's built-in `db.transaction()` overridden to throw `DrizzleTransactionsNotSupported`. This prevents accidentally using Drizzle's internal transaction management, which would issue `BEGIN`/`COMMIT`/`ROLLBACK` on the pool-managed connection and corrupt the transaction state.

Use the provider's `begin()`/`commit()`/`rollback()` or `runInTransaction()` instead.

## How It Works

Under the hood, the provider creates a lightweight wrapper object with a single `query()` method. This object is passed to Drizzle as if it were a pg client. Drizzle only calls `client.query()` during normal operations, so the wrapper intercepts every query and routes it through `AsyncPgPool`:

1. **`connection()`** returns a Drizzle instance backed by the lazy wrapper
2. **When a query executes**, the wrapper calls `pool.primary()` to get the current connection (respecting transaction context)
3. **The query runs** on the resolved connection via `connection.query()`
4. **The connection is released** back to the pool (unless in a transaction)

**Transactions** work differently: `begin()` creates a new Drizzle instance bound directly to the transaction's pg connection. All queries on that instance execute on the dedicated transaction connection until commit or rollback.

### Integration with AsyncPgPool Features

Because connections flow through `AsyncPgPool`, you get all its features:

```typescript
const asyncPool = new AsyncPgPool(pgPool, {
    // Run on every connection claim
    onClaim: client => client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]),
    // Run on every connection release
    onRelease: 'RESET app.tenant_id',
    // Keep connections warm
    keepConnections: 2,
    maxIdleMs: 5000,
});

const db = new AsyncDrizzleConnectionProvider(asyncPool, {schema});

// Queries automatically get tenant_id set
const users = await db.connection().select().from(usersTable);
```

### Concurrency Within One Flow

Under the pool's default `keepPrimaryConnection: true`, every lazy query in a flow runs on the
flow's one shared connection. Queries issued concurrently — `Promise.all` over repository calls —
therefore run one after the other in issue order, not in parallel; there is nothing to gain from
fanning out inside a flow. This currently relies on the `pg` driver queueing concurrent queries per
client, which `pg` has deprecated. With `keepPrimaryConnection: false`, each lazy query outside a
transaction claims its own connection and runs genuinely in parallel; inside a transaction queries
share the transaction's connection by definition.

## License

ISC
