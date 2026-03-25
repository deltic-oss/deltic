# @deltic/service-dispatcher

A contract-based service dispatch abstraction with type-safe request/response mapping and middleware support.

## Installation

```bash
npm install @deltic/service-dispatcher
```

## Usage

### Defining a Service

Define a service structure that maps command types to their payload and response:

```typescript
import type {ServiceStructure} from '@deltic/service-dispatcher';

type UserService = ServiceStructure<{
    createUser: {
        payload: {name: string; email: string};
        response: {id: string};
    };
    deleteUser: {
        payload: {id: string};
        response: void;
    };
}>;
```

### Dispatching Commands

```typescript
import {ServiceDispatcher} from '@deltic/service-dispatcher';

const service = new ServiceDispatcher<UserService>({
    createUser: async (payload) => {
        const user = await userRepo.create(payload);
        return {id: user.id};
    },
    deleteUser: async (payload) => {
        await userRepo.delete(payload.id);
    },
});

const result = await service.handle({
    type: 'createUser',
    payload: {name: 'Alice', email: 'alice@example.com'},
});
// result: {id: '...'}
```

### Middleware

Add cross-cutting concerns via middleware:

```typescript
import type {ServiceMiddleware} from '@deltic/service-dispatcher';

const loggingMiddleware: ServiceMiddleware<UserService> = async (input, next) => {
    console.log(`Handling ${String(input.type)}`);
    const result = await next(input);
    console.log(`Completed ${String(input.type)}`);
    return result;
};

const service = new ServiceDispatcher<UserService>(handlers, [loggingMiddleware]);
```

### Locking Middleware

Prevent concurrent execution of commands for the same resource:

```typescript
import {createServiceLockingMiddleware} from '@deltic/service-dispatcher/locking-middleware';

const lockingMiddleware = createServiceLockingMiddleware<UserService, string>({
    mutex,
    lockResolver: (input) => input.payload.id,
    timeoutMs: 5000,
});

const service = new ServiceDispatcher<UserService>(handlers, [lockingMiddleware]);
```

### Locking Decorator

Alternatively, wrap an entire service with locking:

```typescript
import {ServiceLocking} from '@deltic/service-dispatcher/locking-decorator';

const lockedService = new ServiceLocking<UserService, string>(service, {
    mutex,
    lockResolver: (input) => input.payload.id,
    shouldSkip: (input) => input.type === 'listUsers', // optional
});
```

### Aggregate Service

For event-sourced aggregates, use the aggregate service dispatcher that auto-persists aggregates with unreleased events:

```typescript
import {AggregateServiceDispatcher} from '@deltic/service-dispatcher/aggregate-service-dispatcher';

const service = new AggregateServiceDispatcher<UserService, UserStream>(
    {
        createUser: async (payload, aggregate) => {
            aggregate.create(payload.name, payload.email);
        },
    },
    aggregateRepository,
    (input) => input.payload.id,
);
```

## API Reference

### `Service<S>` (interface)

```typescript
interface Service<S> {
    handle<T extends keyof S>(input: {type: T; payload: S[T]['payload']}): Promise<S[T]['response']>;
}
```

### `ServiceDispatcher<S>`

Dispatches inputs to type-specific handlers through an optional middleware chain.

```typescript
new ServiceDispatcher(handlers: ServiceHandlers<S>, middlewares?: ServiceMiddleware<S>[])
```

### `ServiceMiddleware<S>` (interface)

```typescript
interface ServiceMiddleware<S> {
    (input, next): Promise<response>;
}
```

### `InputNotSupported`

Thrown when no handler is registered for the input type.

## License

ISC
