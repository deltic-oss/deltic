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

A factory that throws hands its error to whoever resolved the service and leaves nothing behind:
nothing is cached and nothing is registered for cleanup, so the next resolution runs the factory
again. A transient failure, such as a database that was briefly unreachable, can simply be retried.

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

A cleanup hook that throws or rejects does not stop the cleanup: its siblings still run, and so do
the hooks of everything beneath it. Once the whole graph was walked, `cleanup()` rejects with a
`CleanupFailed`, an `AggregateError` whose `errors` are what the hooks threw and whose `failures`
pair each of them with its service. Every hook ran once, so a later `cleanup()` only cleans up what
was resolved since.

Calling `cleanup()` while a cleanup is already running joins the running one: every hook runs once,
and every caller settles when that shutdown has finished. Shutdown is usually triggered from more
than one place, so the triggers can share one handler without guarding it themselves:

```typescript
const shutdown = () => container.cleanup().then(() => process.exit(0));

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Once a cleanup has finished, a later call starts a new one for whatever was resolved since.

A cleanup leaves the registrations in place and forgets the instances: resolving a service after a
cleanup constructs it again, and the next cleanup cleans that one up. A registered instance with a
`cleanup` is the exception: the container did not construct it, so it cannot construct a new one,
and resolving it after its cleanup ran throws instead of handing out an instance that was shut down.
A reference obtained before the cleanup, or a proxy that was already used, keeps pointing at the
instance that was cleaned up.

A service resolved while a cleanup is running, by a request that is still being handled for
example, is cleaned up by that same cleanup: each step is taken from the graph as it is at that
moment, so the late service is cleaned up before whatever it depends on that has not been cleaned up
yet. What has already been cleaned up cannot wait for it, so drain the work that still needs its
dependencies first, typically by cleaning up the component that accepts the work (a server, a
consumer).

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

A proxy can only defer what is not needed yet: it may be *stored* while the service it stands in for
is being constructed, but not *used*, because using it would need the very instance that is still
being built. The container refuses that instead of constructing the service a second time:

```
Circular dependency: "member" was used while it was still being constructed (member -> index -> member). …
```

Store the dependency in the constructor and use it in methods that run afterwards.

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

### Problem: A service must not be shared

Services are constructed once and shared by everything that resolves them. Some objects carry
state that belongs to one unit of work, a builder or a per-request scope, and must not be shared.

#### Solution: Transient services

Register them with `cache: false`, and every resolution constructs a new instance:

```typescript
const builderToken = container.register<ReportBuilder>('report.builder', {
    cache: false,
    factory: container => new ReportBuilder(container.resolve(poolToken)),
});
```

A transient service cannot have a `cleanup`: the container does not keep the instances it hands
out, so it has nothing to clean up. Combined with `lazy: true`, every resolution hands out a proxy
of its own, which constructs its own instance on first use.

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

