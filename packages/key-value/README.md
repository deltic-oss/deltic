# @deltic/key-value

A key-value store abstraction with in-memory and PostgreSQL implementations.

## Installation

```bash
npm install @deltic/key-value
```

For the PostgreSQL implementation, also install:

```bash
npm install @deltic/async-pg-pool pg
```

## Usage

### Interface

All implementations share the `KeyValueStore` interface:

```typescript
interface KeyValueStore<Key, Value> {
    persist(key: Key, value: Value): Promise<void>;
    retrieve(key: Key): Promise<Value | undefined>;
    remove(key: Key): Promise<void>;
    clear(): Promise<void>;
}
```

### In-Memory Store

```typescript
import {KeyValueStoreUsingMemory} from '@deltic/key-value/memory';

const store = new KeyValueStoreUsingMemory<string, {name: string}>();

await store.persist('user-1', {name: 'Alice'});
const value = await store.retrieve('user-1'); // {name: 'Alice'}
await store.remove('user-1');
await store.clear();
```

### PostgreSQL Store

```typescript
import {KeyValueStoreUsingPg, createKeyValueSchemaQuery} from '@deltic/key-value/pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';

// Create the table
await connection.query(createKeyValueSchemaQuery('user_settings'));

// Use the store
const store = new KeyValueStoreUsingPg<string, {theme: string}>(asyncPool, {
    tableName: 'user_settings',
});

await store.persist('user-1', {theme: 'dark'});
const settings = await store.retrieve('user-1'); // {theme: 'dark'}
```

#### Multi-Tenancy

The PostgreSQL implementation supports tenant-scoped storage:

```typescript
const store = new KeyValueStoreUsingPg<string, Settings, string, TenantId>(asyncPool, {
    tableName: 'tenant_settings',
    tenantContext: tenantIdReader,
    tenantIdConversion: tenantIdConversion,
});
```

#### Custom Key Conversion

Transform keys before storage:

```typescript
const store = new KeyValueStoreUsingPg<UserId, Profile, string>(asyncPool, {
    tableName: 'profiles',
    keyConversion: (userId) => userId.toString(),
});
```

### PostgreSQL with Columns

For cases where you want specific object properties stored as separate database columns (enabling queries and indexes) while preserving the full object as a JSON payload:

```typescript
import {KeyValueStoreWithColumnsUsingPg} from '@deltic/key-value/pg-with-columns';

type UserKey = {username: string; email: string};
type User = {username: string; email: string; age: number; verified: boolean};

const store = new KeyValueStoreWithColumnsUsingPg<UserKey, User>(
    asyncPool,
    'users',
    ['username', 'email'],   // identity columns (form the unique key)
    ['verified'],            // additional columns to extract from the value
);

await store.persist(
    {username: 'alice', email: 'alice@example.com'},
    {username: 'alice', email: 'alice@example.com', age: 30, verified: true},
);
```

## API Reference

### `KeyValueStore<Key, Value>` (interface)

| Method | Description |
|--------|-------------|
| `persist(key, value)` | Stores a key-value pair (upserts on conflict) |
| `retrieve(key)` | Returns the value or `undefined` if not found |
| `remove(key)` | Deletes a key-value pair |
| `clear()` | Removes all entries |

### `createKeyValueSchemaQuery(tableName, ifNotExists?)`

Returns a `CREATE TABLE` SQL string for the standard key-value schema with `tenant_id`, `key`, and `value` columns.

## License

ISC
