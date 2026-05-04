# @deltic/async-pg-knex

## 0.1.6

### Patch Changes

- Source the active transaction from the underlying pool instead of instance state.

  `AsyncKnexConnectionProvider`, `AsyncDrizzleConnectionProvider`, and
  `AsyncKyselyConnectionProvider` all stored the current transaction wrapper on
  the instance, but the underlying `AsyncPgPool` tracks transactions in async
  context. Sharing one provider across concurrent async flows could therefore
  return a wrapper from the wrong context (or none at all). `withTransaction()`
  now consults the pool and returns a fresh wrapper bound to the connection
  active in the caller's async context.

## 0.1.5

### Patch Changes

- Source the active transaction from the underlying pool instead of instance state.

  `AsyncKnexConnectionProvider` previously stored the current transaction wrapper
  on the instance, but the underlying `AsyncPgPool` tracks transactions in async
  context. Sharing one provider across concurrent async flows could therefore
  return a wrapper from the wrong context (or none at all). `withTransaction()`
  now consults the pool and returns a fresh wrapper bound to the connection
  active in the caller's async context.

- Rely on async pg pool to track transactions instead of storing them locally.

## 0.1.4

### Patch Changes

- Materialise to query builder when the proxy is used as a sub-query.

## 0.1.3

### Patch Changes

- Support more knex query methods by flipping method detection.

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
