# @deltic/event-sourcing

## 0.1.3

### Patch Changes

- Rename interface to be more human, kept BC alias.
- Updated dependencies
- Updated dependencies
  - @deltic/async-pg-pool@0.2.3
  - @deltic/service-dispatcher@0.2.3

## 0.1.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.
- Updated dependencies [0ed7f15]
  - @deltic/transaction-manager@0.1.2
  - @deltic/service-dispatcher@0.2.2
  - @deltic/async-pg-pool@0.2.2
  - @deltic/messaging@0.1.2
  - @deltic/context@0.1.2
  - @deltic/clock@0.1.3
  - @deltic/uid@0.1.2

## 0.1.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/transaction-manager@0.1.1
  - @deltic/service-dispatcher@0.2.1
  - @deltic/async-pg-pool@0.2.1
  - @deltic/messaging@0.1.1
  - @deltic/context@0.1.1
  - @deltic/clock@0.1.2
  - @deltic/uid@0.1.1

## 0.1.0

### Minor Changes

- e0b32f8: Initial release. Provides a full event sourcing framework including:

  - `AggregateRoot` base class with event recording and replay.
  - `EventSourcedAggregateRepository` for persisting and retrieving aggregates from event streams.
  - `AggregateRootUsingReflectMetadata` for decorator-based event handler registration.
  - Snapshotting support via `AggregateRootRepositoryWithSnapshotting` and `SnapshotRepository`.
  - Test tooling with `createTestTooling()` for given/when/then-style aggregate testing.

### Patch Changes

- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
- Updated dependencies [be70e50]
- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
  - @deltic/async-pg-pool@0.2.0
  - @deltic/clock@0.1.1
  - @deltic/service-dispatcher@0.1.0
  - @deltic/messaging@0.1.0
  - @deltic/transaction-manager@0.1.0
  - @deltic/uid@0.1.0
