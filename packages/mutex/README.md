# @deltic/mutex

Contract-based mutex with support for key-based and global locks, backed by memory or PostgreSQL advisory locks.

## Installation

```bash
npm install @deltic/mutex
```

For the PostgreSQL implementation:

```bash
npm install @deltic/async-pg-pool pg
```

## Usage

### Key-Based Locks

```typescript
import {MutexUsingMemory} from '@deltic/mutex/memory';

const mutex = new MutexUsingMemory<string>();

// Blocking lock with timeout
await mutex.lock('order-123', 5000);
try {
    // critical section
} finally {
    await mutex.unlock('order-123');
}

// Non-blocking try
const acquired = await mutex.tryLock('order-123');
if (acquired) {
    try {
        // critical section
    } finally {
        await mutex.unlock('order-123');
    }
}
```

### Global Locks

```typescript
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';

const mutex = new StaticMutexUsingMemory();

await mutex.lock();
try {
    // critical section
} finally {
    await mutex.unlock();
}
```

### PostgreSQL Advisory Locks

```typescript
import {makePostgresMutex} from '@deltic/mutex/pg';

const mutex = makePostgresMutex({
    pool: asyncPool,
    idConverter: crc32Converter,
    mode: 'primary', // 'primary' or 'fresh'
});

await mutex.lock('resource-key');
// ... critical section
await mutex.unlock('resource-key');
```

The `mode` option controls connection behavior:
- `'primary'` — uses the primary connection (locks survive across queries on the same connection)
- `'fresh'` — claims a fresh connection per lock (isolated from other operations)

### Multi-Mutex

Coordinate locking across multiple mutex instances:

```typescript
import {MultiMutex} from '@deltic/mutex/multi';

const multi = new MultiMutex([mutexA, mutexB]);

// Locks both in order, unlocks in reverse order
await multi.lock('resource-key');
try {
    // both locks held
} finally {
    await multi.unlock('resource-key');
}
```

### CRC32 Lock ID Converter

Convert string lock IDs to numeric IDs for PostgreSQL advisory locks:

```typescript
import {Crc32LockIdConverter} from '@deltic/mutex/crc32-lock-id-converter';

const converter = new Crc32LockIdConverter({base: 1000000, range: 999999});
```

## API Reference

### `DynamicMutex<LockID>` (interface)

| Method | Description |
|--------|-------------|
| `tryLock(id)` | Attempts to acquire the lock, returns `true` if successful |
| `lock(id, timeout?)` | Acquires the lock, waiting up to `timeout` ms |
| `unlock(id)` | Releases the lock |

### `StaticMutex` (interface)

| Method | Description |
|--------|-------------|
| `tryLock()` | Attempts to acquire the global lock |
| `lock(timeout?)` | Acquires the global lock with optional timeout |
| `unlock()` | Releases the global lock |

### Error Classes

- `UnableToAcquireLock` — thrown when a lock cannot be acquired within the timeout
- `UnableToReleaseLock` — thrown when a lock release fails

## License

ISC
