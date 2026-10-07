---
"@deltic/async-pg-knex": patch
---

Let code typed against `ConnectionProvider` say why it rolls back.

**Fixed:**

- `ConnectionProvider.rollback(trx)` declared no cause parameter, while
  `AsyncKnexConnectionProvider.rollback(trx, error?)` accepted one and forwarded it to the pool. Code
  that depends on the interface — the point of having one — could not pass the cause without a type
  error, so its rollbacks reached the pool, and anything observing rollbacks through it, as
  unexplained. The interface now declares `rollback(trx, error?)`. Existing implementations keep
  satisfying it, since the parameter is optional.

Ported from duna-application `d7563711e4` ("Propagate errors for rollbacks."), which made the same
change to the application's own connection provider interface.
