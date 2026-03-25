# @deltic/async-pg-pool

## 0.2.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.
- Updated dependencies [0ed7f15]
  - @deltic/transaction-manager@0.1.2
  - @deltic/context@0.1.2
  - @deltic/mutex@0.1.3

## 0.2.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/transaction-manager@0.1.1
  - @deltic/context@0.1.1
  - @deltic/mutex@0.1.2

## 0.2.0

### Minor Changes

- e0b32f8: Add transaction lifecycle helpers and remove HTTP middleware.

  **Breaking:**

  - Removed `httpMiddleware()` method. HTTP middleware should be implemented externally.

  **Added:**

  - `inTransaction()` to check if currently inside a transaction.
  - `withTransaction()` to retrieve the active transaction connection (throws if none active).
  - `runInTransaction(fn)` to run a function inside a transaction with automatic commit/rollback.
  - `TransactionManagerUsingPg` class implementing the `TransactionManager` interface.
  - `UnableToProvideActiveTransaction` error class.

### Patch Changes

- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
  - @deltic/transaction-manager@0.1.0
  - @deltic/mutex@0.1.1

## 0.1.0

### Minor Changes

- Initial release.

### Patch Changes

- Updated dependencies
  - @deltic/error-standard@0.1.0
  - @deltic/mutex@0.1.0
