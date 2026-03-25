# @deltic/async-pg-drizzle

## 0.1.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.
- Updated dependencies [0ed7f15]
  - @deltic/error-standard@0.1.3
  - @deltic/async-pg-pool@0.2.2

## 0.1.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/error-standard@0.1.2
  - @deltic/async-pg-pool@0.2.1

## 0.1.0

### Minor Changes

- 64a4b38: Initial release. Provides a Drizzzle query builder integration with `AsyncPgPool` for connection management:

  - `AsyncDrizzleConnectionProvider` with lazy connections that only acquire a database connection when a query is awaited.
  - Transaction support with `begin()`, `commit()`, `rollback()`, and `runInTransaction()`.

### Patch Changes

- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
  - @deltic/async-pg-pool@0.1.0
  - @deltic/error-standard@0.1.1
