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

### Defaults

A third constructor argument gives every scope a starting set of values:

```typescript
const context = new Context<RequestContext>(store, undefined, {tenantId: 'public'});

await context.run(async () => {
    context.get('tenantId'); // 'public'
});

await context.run(async () => {
    await context.run(async () => {
        context.get('tenantId'); // 'acme', a surrounding scope outranks the default
    });
}, {tenantId: 'acme'});
```

Values provided to `run()` win over the defaults, and so do values inherited from a surrounding
scope — the defaults only fill in what nothing else decided. They are a fixed object shared by
every scope, so use [context slots](#context-slots) when a default needs to be created per scope
(`defaultValue: () => createTx()`).

### With AsyncLocalStorage

For production use, pass an `AsyncLocalStorage` instance as the store to scope context per async execution:

```typescript
import {AsyncLocalStorage} from 'node:async_hooks';
import {Context} from '@deltic/context';

const store = new AsyncLocalStorage<Partial<RequestContext>>();
const context = new Context<RequestContext>(store);
```

`ContextStoreUsingMemory` keeps one context for the whole process, so it is only sound for one flow
at a time, such as a script or a test: flows that overlap read and overwrite the same context.

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

// backed by an AsyncLocalStorage of its own, unless a store is passed as the second argument
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

### Writing requires a scope

`attach()` — and `use()`/`forget()`, which build on it — write into the scope that is currently
active. Outside a `run()` there is nothing to write into, so they throw `UnableToAttachContext`
(`context.no_active_scope`) rather than accept the values and drop them:

```typescript
tenantId.use('acme');       // throws: there is no scope to write to

await context.run(async () => {
    tenantId.use('acme');   // fine
});
```

Reading outside a scope stays legal: `context()` answers `{}`, `get()` answers `undefined` and
`mustResolve()` throws `UnableToResolveValue`.

### Testing

Use `composeContextSlotsForTesting` to create a context pre-initialized with defaults. It is backed
by a memory store that always holds an object, so values can be prepared with `attach()` before
entering a scope — which is the way to set up context without wrapping the test in a `run()`:

```typescript
import {composeContextSlotsForTesting} from '@deltic/context';

const context = composeContextSlotsForTesting([tenantSlot, userSlot]);

context.attach({tenant_id: 'acme'});
```

## API Reference

### `Context<C>`

Constructed as `new Context(store, createContextValue?, defaults?)`.

| Constructor argument | Description |
|----------------------|-------------|
| `store` | The `ContextStore` backing the scope, typically an `AsyncLocalStorage` |
| `createContextValue` | Merge strategy for inherited and provided values, defaults to a shallow merge |
| `defaults` | Values every scope starts with, unless the run or a surrounding scope provides its own |

| Method | Description |
|--------|-------------|
| `run(fn, context?)` | Runs a function within a context scope. Values merge with inherited context |
| `attach(context)` | Merges values into the current context (mutates). Throws `UnableToAttachContext` outside a scope |
| `get(key)` | Returns a context value or `undefined` |
| `context()` | Returns the full context object, `{}` outside a scope |

### `ContextStore<C>` (interface)

Compatible with `AsyncLocalStorage`. Implementations must provide:
- `getStore()` — returns the current context
- `run(store, callback)` — runs a callback within a context scope

### `defineContextSlot(options)`

Creates a typed context slot with optional default value and inheritance control.

### `composeContextSlots(slots, store?)`

Composes multiple slots into a single `Context`. Slots with `defaultValue` are auto-initialized. Slots with `inherited: false` are not carried into nested `run()` calls. Without a `store`, the context is backed by an `AsyncLocalStorage` of its own, so concurrent flows are scoped separately.

### `ValueReadWriter<Value>` (interface)

| Method | Description |
|--------|-------------|
| `resolve()` | Returns the value or `undefined` |
| `mustResolve()` | Returns the value or throws `UnableToResolveValue` |
| `use(value)` | Sets the value. The context-backed implementation needs an active scope |
| `forget()` | Clears the value. The context-backed implementation needs an active scope |
| `preventMismatch(value)` | Throws `ContextMismatchDetected` if the current value differs |

## License

ISC
