# @deltic/uid

A rich UID layer with branded IDs, prefixed generators, and database conversion utilities.

## Installation

```bash
npm install @deltic/uid @deltic/branded
```

For UUID v7 support:

```bash
npm install uuid
```

For ULID support:

```bash
npm install ulid
```

## Usage

### Prefixed Branded IDs

Generate type-safe, prefixed identifiers:

```typescript
import {PrefixedBrandedIdGenerator} from '@deltic/uid';
import {v7 as uuid} from 'uuid';

const userIdGenerator = new PrefixedBrandedIdGenerator('user', uuid);

const userId = userIdGenerator.generateId();
// 'user_0193a5f8-...' (branded as PrefixedId<'user'>)
```

Or use the built-in UUID v7 helper:

```typescript
import {uuidV7PrefixedBrandedIdGenerator} from '@deltic/uid/uuid';

const userIdGenerator = uuidV7PrefixedBrandedIdGenerator('user');
const userId = userIdGenerator.generateId(); // 'user_0193a5f8-...'
```

### ULID Support

```typescript
import {ulidPrefixedBrandedIdGenerator} from '@deltic/uid/ulid';

const orderIdGenerator = ulidPrefixedBrandedIdGenerator('order');
const orderId = orderIdGenerator.generateId(); // 'order_01ARZ3NDEKTSV4RRFFQ69G5FAV'
```

### ID Validation

```typescript
import {prefixedIdValidator} from '@deltic/uid';
import {validate as isValidUuid} from 'uuid';

const isUserId = prefixedIdValidator('user', isValidUuid);

isUserId('user_0193a5f8-...');  // true
isUserId('order_0193a5f8-...'); // false
isUserId(42);                   // false
```

### Database Conversion

Convert between prefixed branded IDs and database representations:

```typescript
import {PrefixedBrandedIdConversion, NoIdConversion} from '@deltic/uid';

// Strip prefix for database storage, add prefix when reading
const conversion = new PrefixedBrandedIdConversion('user', new NoIdConversion());

conversion.toDatabase(userId);         // '0193a5f8-...' (prefix stripped)
conversion.fromDatabase('0193a5f8-...'); // 'user_0193a5f8-...' (prefix added)
```

### ULID to UUID Conversion

```typescript
import {UlidToUuidIdConversion} from '@deltic/uid/ulid';

const conversion = new UlidToUuidIdConversion();
conversion.toDatabase(ulid);    // UUID string
conversion.fromDatabase(uuid);  // ULID string
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `PrefixedId<Prefix>` | Branded string type: `{prefix}_{id}` |
| `IdFactory<Type>` | Function that generates an ID |
| `IdValidator<Type>` | Type guard for ID validation |
| `IdGenerator<Type>` | Interface with `generateId()` method |
| `IdConversion<From, To>` | Interface with `toDatabase()` and `fromDatabase()` |

### Classes

| Class | Description |
|-------|-------------|
| `PrefixedBrandedIdGenerator<Prefix>` | Generates prefixed branded IDs using a factory function |
| `PrefixedBrandedIdConversion<Prefix, DatabaseType>` | Converts between prefixed IDs and database representation |
| `NoIdConversion<Type>` | Pass-through conversion (no transformation) |

## License

ISC
