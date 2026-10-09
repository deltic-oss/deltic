---
"@deltic/event-sourcing": patch
---

Tell the transaction manager why a rollback happened.

**Fixed in `@deltic/event-sourcing`:**

- All three rollback sites — the aggregate repository, the aggregate projection and the
  snapshotting repository — now forward the caught failure to
  `TransactionManager.rollback(error)`. The transaction manager is the one component that sees
  every rollback in the system, and it was never told why any of them happened; a manager that
  counts rollbacks by cause, tags a trace span or logs the failing operation now receives the
  cause the interface always advertised.
- With `TransactionManagerUsingPg`, a failed persist now reaches the pool as the rollback's
  cause, and the pool gives up the connection for it, as it already did for a failing
  `AsyncPgPool.runInTransaction` and as pg's own pool does after a failed query.
