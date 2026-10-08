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

### Key Normalisation

Both stores normalise a key before they use it, so keys that are equal as values address the same
entry. The default, `SortingKeyNormalisation`, sorts the properties of an object key and of every
object nested in it: `{first: 1, second: 2}` and `{second: 2, first: 1}` are the same key. Arrays keep
their order, and anything other than a plain object is used as it is.

Pass a `KeyNormalisation` of your own as the `keyNormalisation` option to decide which keys are the
same:

```typescript
const store = new KeyValueStoreUsingMemory<string, {name: string}>({
    keyNormalisation: {normalise: key => key.toLowerCase()},
});
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

A store with a `tenantContext` scopes every operation (`persist`, `retrieve`, `remove` and `clear`) to the
tenant the context resolves to, and rejects the operation when no tenant can be resolved. The same key can
therefore hold a different value for every tenant. A store without a `tenantContext` is not tenant scoped.

#### Custom Key Conversion

Transform keys before storage:

```typescript
const store = new KeyValueStoreUsingPg<UserId, Profile, string>(asyncPool, {
    tableName: 'profiles',
    keyConversion: (userId) => userId.toString(),
});
```

The conversion receives the normalised key. Without one, the store hands the key to `pg` as it is,
which stores an object key as its JSON; that has to fit the `key` column's 255 characters.
Interpolating an object key (`` key => `prefix:${key}` ``) turns every one of them into
`prefix:[object Object]`.

#### Hashed Keys

`objectHashKeyConversion` stores an object or array key as a SHA3-512 hash of its contents, and any
other key as its string form. A hash fits the `key` column whatever the size of the key, but it cannot
be read back into the key. It needs `object-hash`:

```bash
npm install object-hash
```

```typescript
import {objectHashKeyConversion} from '@deltic/key-value/object-hash';

const store = new KeyValueStoreUsingPg<{tenant: string; day: string}, Report>(asyncPool, {
    tableName: 'reports',
    keyConversion: objectHashKeyConversion,
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

The constructor optionally takes a tenant context and a tenant id conversion as its fifth and sixth
arguments. Tenant scoping then works as for `KeyValueStoreUsingPg`, using a `tenant_id` column that must be
part of the table's unique key.

## API Reference

### `KeyValueStore<Key, Value>` (interface)

| Method | Description |
|--------|-------------|
| `persist(key, value)` | Stores a key-value pair (upserts on conflict) |
| `retrieve(key)` | Returns the value or `undefined` if not found |
| `remove(key)` | Deletes a key-value pair |
| `clear()` | Removes all entries; for a tenant-scoped store, those of the current tenant |

### `KeyNormalisation<Key>` (interface)

| Method | Description |
|--------|-------------|
| `normalise(key)` | Returns the form the store addresses the key by |

`SortingKeyNormalisation` is the default: it sorts the properties of plain objects, recursively.

### `createKeyValueSchemaQuery(tableName, ifNotExists?)`

Returns a `CREATE TABLE` SQL string for the standard key-value schema with `tenant_id`, `key`, and `value` columns.

## License

ISC
