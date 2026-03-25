# @deltic/wait-group

A Go-like WaitGroup for coordinating async operations in TypeScript.

## Installation

```bash
npm install @deltic/wait-group
```

## Usage

```typescript
import {WaitGroup} from '@deltic/wait-group';

const wg = new WaitGroup();

// Track concurrent work
for (const item of items) {
    wg.add();
    processItem(item).finally(() => wg.done());
}

// Wait for all work to complete
await wg.wait();
```

### With Timeout

```typescript
await wg.wait({timeout: 5000}); // throws after 5 seconds
```

### With AbortSignal

```typescript
const controller = new AbortController();

await wg.wait({abortSignal: controller.signal});
```

### Combining Timeout and AbortSignal

```typescript
await wg.wait({timeout: 5000, abortSignal: controller.signal});
```

## API Reference

### `WaitGroup`

| Method | Description |
|--------|-------------|
| `add(i?: number)` | Increments the counter (default 1) |
| `done()` | Decrements the counter. Throws if already at zero |
| `wait(options?)` | Returns a promise that resolves when the counter reaches zero |

### `WaitOptions`

```typescript
type WaitOptions = {
    timeout?: number;       // Timeout in milliseconds
    abortSignal?: AbortSignal;
};
```

## License

ISC
