# @deltic/async-pg-knex

## 0.1.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.
- Updated dependencies [0ed7f15]
  - @deltic/async-pg-pool@0.2.2

## 0.1.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/async-pg-pool@0.2.1

## 0.1.0

### Minor Changes

- e0b32f8: Initial release. Provides Knex query builder integration with `AsyncPgPool` for connection management:

  - `AsyncKnexConnectionProvider` with lazy connections that only acquire a database connection when a query is awaited.
  - Transaction support with `begin()`, `commit()`, `rollback()`, and `runInTransaction()`.

### Patch Changes

- Updated dependencies [e0b32f8]
  - @deltic/async-pg-pool@0.1.0
