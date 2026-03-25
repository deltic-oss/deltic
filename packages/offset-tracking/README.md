# @deltic/offset-tracking

A general-purpose offset tracking abstraction for stream processing and event consumers.

## Installation

```bash
npm install @deltic/offset-tracking
```

For the PostgreSQL implementation:

```bash
npm install @deltic/async-pg-pool pg
```

## Usage

### Interface

```typescript
import type {OffsetRepository} from '@deltic/offset-tracking';

// Default types: Offset = number, Id = string
const offsets: OffsetRepository = /* implementation */;

const lastOffset = await offsets.retrieve('my-consumer');
// process events after lastOffset...
await offsets.store('my-consumer', newOffset);
```

### In-Memory Implementation

```typescript
import {OffsetRepositoryUsingMemory} from '@deltic/offset-tracking/memory';

const offsets = new OffsetRepositoryUsingMemory<number, string>();
```

### PostgreSQL Implementation

```typescript
import {OffsetRepositoryUsingPg} from '@deltic/offset-tracking/pg';

const offsets = new OffsetRepositoryUsingPg(asyncPool, {
    tableName: 'consumer_offsets',
    consumerName: 'projection-users',
    selectForUpdate: true, // optional: lock row during read
});
```

## API Reference

### `OffsetRepository<Offset, Id>` (interface)

| Method | Description |
|--------|-------------|
| `retrieve(id)` | Returns the stored offset or `undefined` |
| `store(id, offset)` | Persists the offset for the given identifier |

## License

ISC
