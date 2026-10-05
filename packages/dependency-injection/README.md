# `@deltic/dependency-injection`

A lightweight dependency injection container with intelligent cleanup orchestration.

## Why this container?

Most DI containers force you to manually manage cleanup order or clean up everything registered (including unused
services). This container:

1. **Tracks actual usage** - only cleans up services that were resolved
2. **Respects dependencies** - a service is cleaned up before the services it depends on
3. **Maximizes concurrency** - independent services cleanup in parallel
4. **No magic** - dependencies resolved via simple factory functions

## What it gives you:

1. Factory function based dependency construction.
2. Smart dependency cleanup orchestration
3. Proxy-based lazy services
4. Instance registration
5. Created instances, built outside the registry, cleaned up inside the dependency chain

## Installation

```sh
npm i -S @deltic/dependency-injection
# or
pnpm add @deltic/dependency-injection
```

## Usage

```typescript
import {DependencyContainer, container} from '@deltic/dependency-injection';

const myContainer = new DependencyContainer(); // or use the default container

class MyNameService {
    constructor(
        private readonly firstName: string,
        private readonly dependency: MyLastNameService,
    ) {
    }

    fullName(): string {
        return `${this.firstName} ${this.dependency.lastName}`;
    }
}

class MyLastNameService {
    constructor(
        public readonly lastName: string,
    ) {
    }
}

const myLastNameService = container.registerInstance<MyLastNameService>('my.last_name_service', {
    instance: new MyLastNameService('de Jonge'),
});

const myNameService = container.register<MyNameService>('my.name_service', {
    factory: container => {
        return new MyNameService(
            'Frank',
            container.resolve(myLastNameService),
        )
    }
});

const service = container.resolve(myNameService);

expect(service.fullName()).toEqual('Frank de Jonge');
```

## Cleanup ordering

`container.cleanup()` shuts down what was actually used, in an order derived from how it was
constructed. Everything that needs ordering takes part in a graph: services with a `cleanup`
callback, services constructed behind a proxy, and created instances. While a factory runs, whatever
it resolves is recorded as a dependency of it.

Services without a cleanup callback are transparent: they have nothing to shut down, so the
dependencies they resolve are attributed to whoever consumes them, including consumers that are
served the same instance from cache later on.

The graph is then walked from consumers to dependencies. Everything that nothing else depends on is
cleaned up first, concurrently; each following step waits for its consumers to finish. A dependency
therefore stays usable for as long as anything that may need it is still shutting down.

Calling `cleanup()` while a cleanup is already running joins the running one: every hook runs once,
and every caller settles when that shutdown has finished. Shutdown is usually triggered from more
than one place, so the triggers can share one handler without guarding it themselves:

```typescript
const shutdown = () => container.cleanup().then(() => process.exit(0));

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Once a cleanup has finished, a later call starts a new one for whatever was resolved since.

A cycle that cannot be resolved this way throws, and nothing is cleaned up:

```
Circular dependency detected in cleanup routine, could not shut down: something, collection.
```

## Common Problems &amp; Solutions

### Problem: A stateful service needs to be shut down

A common problem for stateful services, like database pools or redis connections. These services
need to be cleaned up so our applications can gracefully shut down.

#### Solution: Service cleanups

```typescript
import {container} from '@deltic/dependency-injection';
import {Pool} from 'pg';

const poolToken = container.register<Pool>('pg.pool', {
    factory: () => new Pool({
        host: 'localhost',
        user: 'database-user',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        maxLifetimeSeconds: 60
    }),
    cleanup: async pool => {
        await pool.end();
    },
});

const pool = container.resolve(poolToken);

// use the pool

await container.cleanup();
```

### Problem: Something needs to be constructed without being a registered service

Not everything belongs in the registry. A worker started for a single job, a subscription set up by
a test, a consumer created per tenant: these need dependencies from the container and need to be shut
down, but there is no sensible key to register them under. Constructing them by hand leaves them out
of the cleanup, which means their dependencies may shut down while they are still using them.

#### Solution: Created instances

`createInstance` runs a factory that resolves from the container, and registers the cleanup along
with it. The instance takes part in the same cleanup graph as registered services, so it is cleaned
up before the services it depends on.

```typescript
import {container} from '@deltic/dependency-injection';

const worker = container.createInstance({
    factory: container => new Worker(container.resolve(poolToken)),
    cleanup: async worker => {
        await worker.stop();
    },
});

await worker.run();

// `worker` is stopped first, the pool it depends on is ended after
await container.cleanup();
```

Created instances are not registered, cannot be resolved, and are never shared: each call constructs
a new instance. They nest like services do, so an instance created while a service is being
constructed is cleaned up after that service.

### Problem: Circular dependencies between services

Never a nice problem to have, but Proxy's to the rescue! Deltic uses proxies, which break cyclical
dependency resolution. This is a standard approach used by almost all DI containers.

#### Solution: No solution needed!

Deltic Dependency Injection automatically detects circular references and resolves dependencies
using proxies, which defer the instantiation, which breaks the looop. Problem solved!

At shutdown, a service that resolves itself, or a cycle in which only one service has a cleanup, is
cleaned up like anything else. A cycle between two services that both have a cleanup cannot be
ordered, each would have to outlive the other, so `cleanup()` refuses it before running any hook.
Give the cleanup to one side of the cycle only.

### Problem: Constructing heavy dependencies that are not always used

Some dependencies are expensive to construct. When they're not always needed, you may want to prevent
these dependencies from always being constructed.

#### Solution: Make your dependencies lazy

Dependencies can explicitly be lazy, which delays construction until they are actually used.

Either use the `lazy: true` setting, which makes the *definition* lazy — resolving hands out a
proxy, and construction happens on first use:

```typescript
import {container, type ServiceKey} from '@deltic/dependency-injection';

// The explicit token types break the type-level inference cycle that the
// value-level laziness allows.
const collectionToken: ServiceKey<SomeCollection> = container.register('collection', {
    lazy: true,
    factory: container => {
        return new SomeCollection(
            'collection-name',
            [container.resolve(somethingToken)],
        );
    },
});

const somethingToken: ServiceKey<Something> = container.register('something', {
    factory: container => {
        return new Something(
            'something-name',
            container.resolve(collectionToken),
        );
    },
});
```

Or keep the definition eager and make one *consumer* lazy with `resolveLazy`, which breaks the
cycle at the call site instead:

```typescript
const somethingToken: ServiceKey<Something> = container.register('something', {
    factory: container => {
        return new Something(
            'something-name',
            container.resolveLazy(collectionToken),
            // ------------- ^ a proxy; the collection is built on first use
        );
    },
});

const collectionToken: ServiceKey<SomeCollection> = container.register('collection', {
    factory: container => {
        return new SomeCollection(
            'collection-name',
            [container.resolve(somethingToken)],
        );
    },
});
```

## Type Safety

Service keys are strings, which means typos won't be caught at compile time. To mitigate this:

1. **Use constants** for service keys to enable autocomplete and refactoring
2. **Colocate registration** with service definitions
3. **Add integration tests** to verify expected services are registered

Missing service resolution throws a descriptive error with the attempted key.

## How It Compares

| Feature                        | @deltic/dependency-injection | tsyringe | inversify |
|--------------------------------|------------------------------|----------|-----------|
| Only cleanup used services     | ✅                            | ❌        | ❌         |
| Dependency-aware cleanup order | ✅                            | ❌        | ❌         |
| Concurrent cleanup             | ✅                            | ❌        | ❌         |
| Decorators required            | ❌                            | ✅        | ✅         |
| Reflection metadata            | ❌                            | ✅        | ✅         |

