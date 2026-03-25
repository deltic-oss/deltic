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

Extracts a message string from any value. Returns `error.message` for `Error` instances, the string itself for strings, or `'Unknown error'` for anything else.

## License

ISC
