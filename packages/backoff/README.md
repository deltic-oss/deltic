# @deltic/backoff

Strategy-based backoff calculation for retry logic.

## Installation

```bash
npm install @deltic/backoff
```

## Usage

The strategies live behind sub-path exports; the package root exports the
`BackOffStrategy` contract and the `MaxAttemptsExceeded` error.

### Exponential Backoff

```typescript
import {ExponentialBackoffStrategy} from '@deltic/backoff/exponential';

const strategy = new ExponentialBackoffStrategy(
    100,   // initial delay (ms)
    5,     // max attempts
    10000, // max delay (ms)
);

strategy.backOff(1); // 100ms  (100 * 2^0)
strategy.backOff(2); // 200ms  (100 * 2^1)
strategy.backOff(3); // 400ms  (100 * 2^2)
strategy.backOff(6); // throws MaxAttemptsExceeded
```

### Linear Backoff

```typescript
import {LinearBackoffStrategy} from '@deltic/backoff/linear';

const strategy = new LinearBackoffStrategy(500); // 500ms increment

strategy.backOff(1); // 500ms
strategy.backOff(2); // 1000ms
strategy.backOff(3); // 1500ms
```

The linear strategy never signals exhaustion — it grows without an upper bound —
so a retry loop using it has to bound itself, with a maximum attempt count or a
deadline of its own.

### Custom Base

The exponential strategy supports a custom base (default is 2.0):

```typescript
const strategy = new ExponentialBackoffStrategy(100, 10, 30000, 3.0);

strategy.backOff(1); // 100ms  (100 * 3^0)
strategy.backOff(2); // 300ms  (100 * 3^1)
strategy.backOff(3); // 900ms  (100 * 3^2)
```

## API Reference

### `BackOffStrategy` (interface)

```typescript
import type {BackOffStrategy} from '@deltic/backoff';

interface BackOffStrategy {
    backOff(attempt: number): number;
}
```

Returns the delay in milliseconds to apply before the given attempt. A strategy
signals exhaustion by throwing `MaxAttemptsExceeded`; a strategy without a
maximum (like the linear one) never throws, so callers must bound their own
retry loops.

### `ExponentialBackoffStrategy`

```typescript
import {ExponentialBackoffStrategy} from '@deltic/backoff/exponential';

new ExponentialBackoffStrategy(
    initialDelayMs: number,
    maxAttempts: number, // -1 for unlimited
    maxDelay?: number,
    base?: number, // default: 2.0
)
```

Calculates `initialDelayMs * base^(attempt - 1)`, clamped to `maxDelay` — the
first attempt is retried after `initialDelayMs`, and every attempt after that
multiplies the delay by `base`. Throws `MaxAttemptsExceeded` when
`attempt > maxAttempts`.

### `LinearBackoffStrategy`

```typescript
import {LinearBackoffStrategy} from '@deltic/backoff/linear';

new LinearBackoffStrategy(increment: number)
```

Calculates `increment * attempt`. Never throws.

### `MaxAttemptsExceeded`

```typescript
import {MaxAttemptsExceeded} from '@deltic/backoff';
```

Thrown when an exponential backoff exceeds its configured maximum attempts. The
refused attempt is available as `error.context.attempt`.

## License

ISC
