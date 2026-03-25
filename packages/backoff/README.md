# @deltic/backoff

Strategy-based backoff calculation for retry logic.

## Installation

```bash
npm install @deltic/backoff
```

## Usage

### Exponential Backoff

```typescript
import {ExponentialBackoffStrategy} from '@deltic/backoff';

const strategy = new ExponentialBackoffStrategy(
    100,   // initial delay (ms)
    5,     // max attempts
    10000, // max delay (ms)
);

strategy.backOff(1); // 200ms  (100 * 2^1)
strategy.backOff(2); // 400ms  (100 * 2^2)
strategy.backOff(3); // 800ms  (100 * 2^3)
strategy.backOff(6); // throws MaxAttemptsExceeded
```

### Linear Backoff

```typescript
import {LinearBackoffStrategy} from '@deltic/backoff';

const strategy = new LinearBackoffStrategy(500); // 500ms increment

strategy.backOff(1); // 500ms
strategy.backOff(2); // 1000ms
strategy.backOff(3); // 1500ms
```

### Custom Base

The exponential strategy supports a custom base (default is 2.0):

```typescript
const strategy = new ExponentialBackoffStrategy(100, 10, 30000, 3.0);

strategy.backOff(1); // 300ms  (100 * 3^1)
strategy.backOff(2); // 900ms  (100 * 3^2)
```

## API Reference

### `BackOffStrategy` (interface)

```typescript
interface BackOffStrategy {
    backOff(attempt: number): number;
}
```

### `ExponentialBackoffStrategy`

```typescript
new ExponentialBackoffStrategy(
    initialDelayMs: number,
    maxAttempts: number,
    maxDelay?: number,
    base?: number, // default: 2.0
)
```

Calculates `initialDelayMs * base^attempt`, clamped to `maxDelay`. Throws `MaxAttemptsExceeded` when `attempt > maxAttempts`.

### `LinearBackoffStrategy`

```typescript
new LinearBackoffStrategy(increment: number)
```

Calculates `increment * attempt`.

### `MaxAttemptsExceeded`

Thrown when an exponential backoff exceeds its configured maximum attempts.

## License

ISC
