# @deltic/error-standard

A standard error base class with error codes, structured context, and cause chains.

## Installation

```bash
npm install @deltic/error-standard
```

## Usage

### Defining Errors

Extend `StandardError` to define domain-specific errors with codes and context:

```typescript
import {StandardError} from '@deltic/error-standard';

class UserNotFound extends StandardError {
    static forId(id: string) {
        return new UserNotFound(
            `User ${id} not found`,
            'USER_NOT_FOUND',
            {userId: id},
        );
    }
}

class PaymentFailed extends StandardError {
    static because(reason: string, cause: unknown) {
        return new PaymentFailed(
            `Payment failed: ${reason}`,
            'PAYMENT_FAILED',
            {reason},
            cause,
        );
    }
}
```

### Extracting Error Messages

Use `errorToMessage` to safely extract a message from any thrown value:

```typescript
import {errorToMessage} from '@deltic/error-standard';

try {
    await riskyOperation();
} catch (error) {
    console.log(errorToMessage(error)); // works with Error, string, or unknown
}
```

### Marking Errors as Unrecoverable

Some failures are not worth retrying: a broker that rejects every configured credential, or one
that stayed unreachable for longer than a dependency is allowed to be away. Implement
`UnrecoverableError` on such errors, and have loops that swallow failures and try again rethrow
them, so they reach the top of the process and end it instead of keeping a worker alive with
nothing to do:

```typescript
import {isUnrecoverableError, StandardError, type UnrecoverableError} from '@deltic/error-standard';

class UnableToReachBroker extends StandardError implements UnrecoverableError {
    readonly isUnrecoverable = true as const;

    static afterTryingFor(durationMs: number) {
        return new UnableToReachBroker(
            `Unable to reach the broker after retrying for ${durationMs}ms`,
            'broker.unreachable',
            {durationMs},
        );
    }
}

while (running) {
    try {
        await relayNextBatch();
    } catch (error) {
        if (isUnrecoverableError(error)) {
            throw error;
        }

        await backOff();
    }
}
```

The `@deltic/messaging` AMQP connection provider reports its give-ups this way, and its message
dispatcher and relay pass them on instead of retrying.

## API Reference

### `StandardError`

```typescript
abstract class StandardError extends Error {
    constructor(
        message: string,
        code: string,
        context?: ErrorContext,
        cause?: unknown,
    )

    readonly code: string;
    readonly context: ErrorContext;
}
```

An abstract base class extending `Error`. Subclass it to define specific error types with machine-readable codes and structured context.

### `ErrorContext`

```typescript
type ErrorContext = {[index: string]: string | number | null | boolean};
```

### `errorToMessage(error: unknown): string`

Extracts a message string from any value. Returns `error.message` for `Error` instances, and the
value's string representation for anything else — `'a reason'` for a thrown string, `'42'` for a
number, `'undefined'` for `undefined`, and `'[object Object]'` for a plain object, which is a hint
to throw `Error`s instead.

It never throws, so it is safe to call while reporting a failure: a value that cannot be converted to
a string, such as an object without a prototype or one whose `toString` throws, is reported as
`'[unprintable object]'`.

### `UnrecoverableError`

```typescript
interface UnrecoverableError {
    readonly isUnrecoverable: true;
}
```

A marker for errors that retrying cannot resolve.

### `isUnrecoverableError(error: unknown): error is Error & UnrecoverableError`

Returns `true` for an `Error` whose `isUnrecoverable` property is exactly `true`. The check relies on
the marker rather than on `instanceof`, so it holds across package boundaries and duplicated
installs. It does not look through the `cause` chain: wrapping an unrecoverable error in another
error is a decision to handle it.

## License

ISC
