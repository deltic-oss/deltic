# @deltic/context

Async context tracking for scoping state to HTTP requests, message processing, or any async operation. Compatible with `AsyncLocalStorage`.

## Installation

```bash
npm install @deltic/context
```

## Usage

### Basic Context

```typescript
import {Context, ContextStoreUsingMemory} from '@deltic/context';

type RequestContext = {
    requestId: string;
    tenantId: string;
};

const store = new ContextStoreUsingMemory<RequestContext>();
const context = new Context<RequestContext>(store);

await context.run(async () => {
    context.get('requestId'); // 'req-123'
    context.get('tenantId');  // 'acme'
}, {requestId: 'req-123', tenantId: 'acme'});
```

### With AsyncLocalStorage

For production use, pass an `AsyncLocalStorage` instance as the store to scope context per async execution:

```typescript
import {AsyncLocalStorage} from 'node:async_hooks';
import {Context} from '@deltic/context';

const store = new AsyncLocalStorage<Partial<RequestContext>>();
const context = new Context<RequestContext>(store);
```

### Context Slots

For composable, typed context with default values:

```typescript
import {defineContextSlot, composeContextSlots} from '@deltic/context';

const tenantSlot = defineContextSlot<'tenant_id', string>({key: 'tenant_id'});
const userSlot = defineContextSlot({
    key: 'user_id',
    defaultValue: () => 'anonymous',
});
const txSlot = defineContextSlot({
    key: 'tx',
    defaultValue: () => createTx(),
    inherited: false, // not inherited from parent context
});

const requestContext = composeContextSlots([tenantSlot, userSlot, txSlot]);

await requestContext.run(async () => {
    requestContext.get('tenant_id'); // 'acme'
    requestContext.get('user_id');   // 'anonymous' (default)
}, {tenant_id: 'acme'});
```

### Value Readers

For resolving individual context values with type safety:

```typescript
import {ValueReadWriterUsingContext} from '@deltic/context';

const tenantId = new ValueReadWriterUsingContext(context, 'tenantId');

tenantId.resolve();      // string | undefined
tenantId.mustResolve();  // string (throws if undefined)
tenantId.preventMismatch('acme'); // throws if current value !== 'acme'
```

### Testing

Use `composeContextSlotsForTesting` to create a context pre-initialized with defaults:

```typescript
import {composeContextSlotsForTesting} from '@deltic/context';

const context = composeContextSlotsForTesting([tenantSlot, userSlot]);
```

## API Reference

### `Context<C>`

| Method | Description |
|--------|-------------|
| `run(fn, context?)` | Runs a function within a context scope. Values merge with inherited context |
| `attach(context)` | Merges values into the current context (mutates) |
| `get(key)` | Returns a context value or `undefined` |
| `context()` | Returns the full context object |

### `ContextStore<C>` (interface)

Compatible with `AsyncLocalStorage`. Implementations must provide:
- `getStore()` — returns the current context
- `run(store, callback)` — runs a callback within a context scope

### `defineContextSlot(options)`

Creates a typed context slot with optional default value and inheritance control.

### `composeContextSlots(slots, store?)`

Composes multiple slots into a single `Context`. Slots with `defaultValue` are auto-initialized. Slots with `inherited: false` are not carried into nested `run()` calls.

### `ValueReadWriter<Value>` (interface)

| Method | Description |
|--------|-------------|
| `resolve()` | Returns the value or `undefined` |
| `mustResolve()` | Returns the value or throws `UnableToResolveValue` |
| `use(value)` | Sets the value |
| `forget()` | Clears the value |
| `preventMismatch(value)` | Throws `ContextMismatchDetected` if the current value differs |

## License

ISC
