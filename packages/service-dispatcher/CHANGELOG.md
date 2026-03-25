# @deltic/service-dispatcher

## 0.2.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/event-sourcing@0.1.1
  - @deltic/mutex@0.1.2

## 0.2.0

### Minor Changes

- be70e50: BC break: Changed the main interface to be centered around an input object instead of separate parameters.

### Patch Changes

- e0b32f8: Add aggregate-aware service dispatching and mutex-based command locking.

  - `AggregateServiceDispatcher` for service dispatchers that auto-fetch an aggregate root, delegate to a handler, and persist when events are recorded.
  - `ServiceLocking` decorator to wrap any `Service` with mutex-based locking per command.
  - `createServiceLockingMiddleware()` for the middleware variant of the same locking behavior.
  - Shared locking types: `LockIDResolver`, `LockSkipDetector`, `ServiceLockingOptions`.

- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
  - @deltic/event-sourcing@0.1.0
  - @deltic/mutex@0.1.1

## 0.1.0

### Minor Changes

- ea0efe1: Initial release
