# @deltic/async-pg-knex

Knex query builder integration with `@deltic/async-pg-pool`, giving you full control over connection management while keeping Knex's excellent query building API.

## Why?

Knex manages its own internal connection pool, which works fine for simple applications. However, you lose control over important aspects of connection management:

- **Connection lifecycle hooks** - Run setup/teardown queries when connections are claimed or released (e.g., setting `app.tenant_id` for row-level security)
- **Request-scoped connections** - Reuse a single "primary" connection across an HTTP request
- **Transaction context** - Share transaction state via `AsyncLocalStorage` without passing transaction objects everywhere
- **Connection pooling strategy** - Fine-tune how connections are kept warm, when they're released, and how they're reset

`@deltic/async-pg-knex` bridges Knex's query builder with `@deltic/async-pg-pool`, letting you use Knex for query building while `AsyncPgPool` handles all connection management:

```typescript
const db = new AsyncKnexConnectionProvider(asyncPool);

// Build and execute queries - connections managed by AsyncPgPool
const users = await db.connection()
    .select('*')
    .from('users')
    .where('active', true);
```

## Installation

```bash
npm install @deltic/async-pg-knex @deltic/async-pg-pool knex pg
```

## Quick Start

```typescript
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {AsyncKnexConnectionProvider} from '@deltic/async-pg-knex';

// Create the connection stack
const pgPool = new Pool({connectionString: 'postgresql://...'});
const asyncPool = new AsyncPgPool(pgPool);
const db = new AsyncKnexConnectionProvider(asyncPool);

// Query with lazy connection
const users = await db.connection()
    .select('*')
    .from('users')
    .where('active', true);

// Callable syntax also works
const posts = await db.connection()('posts')
    .select('title', 'content')
    .where('published', true)
    .orderBy('created_at', 'desc')
    .limit(10);
```

## Usage

### Basic Queries

```typescript
// SELECT
const users = await db.connection()
    .select('id', 'name', 'email')
    .from('users')
    .where('active', true);

// INSERT with returning
const [newUser] = await db.connection()
    .table('users')
    .insert({name: 'Alice', email: 'alice@example.com'})
    .returning('*');

// UPDATE
await db.connection()
    .update('users')
    .where('id', userId)
    .update({last_login: new Date()});

// DELETE
await db.connection()
    .table('users')
    .where('id', userId)
    .delete();
```

### Raw Queries

```typescript
// With positional bindings
const result = await db.connection()
    .raw('SELECT * FROM users WHERE email = ?', ['alice@example.com']);

// With named bindings
const result = await db.connection()
    .raw('SELECT * FROM users WHERE age > :minAge', {minAge: 21});
```

### Transactions

Transactions acquire a dedicated connection for their duration:

```typescript
const trx = await db.begin();

try {
    await trx('accounts')
        .where('id', fromAccountId)
        .decrement('balance', amount);
    
    await trx('accounts')
        .where('id', toAccountId)
        .increment('balance', amount);
    
    await trx('transfers').insert({
        from_account: fromAccountId,
        to_account: toAccountId,
        amount,
    });
    
    await db.commit(trx);
} catch (error) {
    await db.rollback(trx);
    throw error;
}
```

#### Using `runInTransaction`

For simpler transaction handling with automatic commit/rollback:

```typescript
const result = await db.runInTransaction(async () => {
    const [user] = await db.connection()('users')
        .insert({name: 'Bob'})
        .returning('*');
    
    await db.connection()('audit_log').insert({
        action: 'user_created',
        user_id: user.id,
    });
    
    return user;
});
```

If the function throws, the transaction is automatically rolled back.

#### Custom Isolation Levels

```typescript
const trx = await db.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');
// ... your queries
await db.commit(trx);
```

### Inspecting Queries Without Execution

Use `toSQL()` or `toString()` to inspect queries without acquiring a connection:

```typescript
const query = db.connection()
    .select('*')
    .from('users')
    .where('id', 1);

// No connection acquired
console.log(query.toSQL());
// { sql: 'select * from "users" where "id" = ?', bindings: [1] }

console.log(query.toString());
// select * from "users" where "id" = 1
```

### Raw Client Access

When you need direct access to the underlying pg client:

```typescript
const client = await db.claimClient();

try {
    await client.query('LISTEN my_channel');
    // ... do something with notifications
} finally {
    await db.releaseClient(client);
}
```

## API Reference

### `AsyncKnexConnectionProvider`

#### Constructor

```typescript
new AsyncKnexConnectionProvider(pool: AsyncPgPool, options?: {
    knexConfig?: Omit<Knex.Config, 'client' | 'connection'>
})
```

#### Methods

| Method | Description |
|--------|-------------|
| `connection()` | Returns a lazy `Connection` for building queries |
| `begin(query?)` | Begins a transaction, returns a `Transaction` |
| `commit(trx)` | Commits a transaction |
| `rollback(trx, error?)` | Rolls back a transaction |
| `withTransaction()` | Returns the current transaction (throws if none) |
| `inTransaction()` | Returns `true` if currently in a transaction |
| `runInTransaction(fn)` | Runs a function in a transaction with auto commit/rollback |
| `claimClient()` | Claims a raw pg `Client` from the pool |
| `releaseClient(client)` | Releases a raw pg `Client` back to the pool |
| `destroy()` | Destroys the Knex instance |

### `Connection`

A Knex-like query builder that defers connection acquisition. Supports all standard Knex query methods:

- Query starters: `select`, `insert`, `update`, `delete`, `from`, `into`, `table`
- Aggregates: `count`, `sum`, `avg`, `min`, `max`, `first`, `pluck`
- Modifiers: `where`, `orWhere`, `whereIn`, `whereNull`, `orderBy`, `limit`, `offset`, `groupBy`, `having`, `join`, `distinct`
- Raw queries: `raw`
- Inspection: `toSQL`, `toString`

### `Transaction`

Similar to `Connection` but bound to a specific database connection for the transaction's duration. Queries execute immediately rather than lazily.

## How It Works

This package uses JavaScript Proxies to intercept Knex query builder method calls and route them through `AsyncPgPool`:

1. **`connection()`** returns a Proxy that buffers method calls
2. **Method calls** (`.select()`, `.where()`, etc.) are recorded
3. **On `await`** (when `.then()` is called):
   - A connection is acquired from `AsyncPgPool` (respecting transaction context)
   - Buffered calls are replayed on a real Knex query builder
   - The query executes using `.connection()` to bind it to the acquired connection
   - The connection is released back to the pool (unless in a transaction)

**Transactions** work differently - they immediately acquire a connection via `pool.begin()` and all queries on the transaction object are bound to that connection until commit/rollback.

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

const db = new AsyncKnexConnectionProvider(asyncPool);

// Queries automatically get tenant_id set
const users = await db.connection().select('*').from('users');
```

## License

ISC
