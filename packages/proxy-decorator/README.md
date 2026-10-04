# @deltic/proxy-decorator

Decorate selected methods of an instance without writing a decorator class for the whole interface.

## Installation

```bash
npm install @deltic/proxy-decorator
```

## Usage

```typescript
import {decorateInstance} from '@deltic/proxy-decorator';

const repository = decorateInstance(new FrameworkRepositoryUsingPg(connection), {
    retrieve: async (inner, organizationId, version) => {
        const framework = structuredClone(await inner(organizationId, version));
        framework.policies.push(...(await policies.provideFor(organizationId)));

        return framework;
    },
});
```

Each decorator receives the original method, bound to the instance, followed by the arguments of the
call. The decorated instance keeps the type of the original, so it can be handed to anything that
expects it.

Every member that is not decorated is served by the original instance, and methods are bound to it.
The instance's own calls therefore stay undecorated: when `retrieveLatest()` calls `this.retrieve()`
internally, it calls the original `retrieve`, not the decorated one.

Methods named after a `Proxy` trap (`get`, `set`, `has`, `apply`, …) cannot be decorated.

## API

### `decorateInstance(instance, decorators)`

Returns a proxy of `instance` in which every method named in `decorators` is replaced by
`(...args) => decorator(inner, ...args)`.

### `DecoratorsForInstance<Instance>`

The type of the `decorators` argument: for every method of `Instance`, an optional
`(inner, ...args) => result` with the method's own parameters and return type.
