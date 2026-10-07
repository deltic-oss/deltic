---
"@deltic/event-sourcing": patch
"@deltic/async-pg-pool": patch
---

Report why a rollback happened, without punishing the connection for it.

**Fixed in `@deltic/event-sourcing`:**

- All three rollback sites — the aggregate repository, the aggregate projection and the
  snapshotting repository — now forward the caught failure to
  `TransactionManager.rollback(error)`. The transaction manager is the one component that sees
  every rollback in the system, and it was never told why any of them happened; a manager that
  counts rollbacks by cause, tags a trace span or logs the failing operation now receives the
  cause the interface always advertised.

**Changed in `@deltic/async-pg-pool`, as the prerequisite:**

- A transaction the server finalised — committed, rolled back, or discarded on commit — releases
  its connection as *healthy*, regardless of the rollback cause. Previously a cause handed to
  `rollback(client, error)` destroyed a provably clean connection and, worse, skipped the
  `onRelease` reset hook (under the default `releaseHookOnError: false`) for exactly the flows
  that had just failed — forwarding causes without this change would have leaked session state
  like `app.tenant_id` back into the pool. The cause is a diagnostic for the layers above, not a
  verdict on the connection: a connection that is actually broken fails the ROLLBACK itself and
  is still destroyed. The practical effect is less connection churn — a failed unit of work no
  longer costs a reconnect — and release hooks that reliably run.
