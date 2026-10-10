---
"@deltic/async-pg-pool": patch
---

Survive a session the server ends while its connection is checked out.

**Fixed in `@deltic/async-pg-pool`:**

- The pool now listens for `error` and `end` on every connection it hands out. The driver's pool
  stops listening while a connection is checked out, so a session the server ended — a failover,
  `pg_terminate_backend`, `idle_in_transaction_session_timeout` — emitted an `error` nobody heard,
  and Node took the process down.
- The lost connection goes back to the driver, which discards it. A kept primary or idle connection
  is replaced on its next use, and releasing the lost connection afterwards is accepted quietly.
- A transaction on a lost connection was rolled back by the server. It stays the flow's transaction
  until its owner finalises it, so the rest of the flow fails on it rather than writing outside of
  it. Its `commit()` rejects with `UnableToCommitTransaction`
  (`async-pg-pool.transaction_session_ended`), and its `rollback()` succeeds.
