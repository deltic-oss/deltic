---
"@deltic/async-pg-pool": patch
"@deltic/async-pg-drizzle": patch
"@deltic/async-pg-knex": patch
"@deltic/async-pg-kysely": patch
---

Believe the server about what a COMMIT did, and stop cleanup from replacing the caller's error.

**Fixed in `@deltic/async-pg-pool`:**

- `commit()` now inspects the command tag the server answers with. A COMMIT sent to a transaction
  that failed earlier is answered with `ROLLBACK` — every statement in it was discarded — and the
  tag is the only place that distinction exists, because the query itself succeeds. The pool ignored
  it, so a unit of work that swallowed a statement error (an upsert conflict handled by hand, for
  instance) was told its transaction committed while the server had thrown all of it away. This now
  rejects with `UnableToCommitTransaction`. The work is still gone — Postgres discards the whole
  aborted transaction, that part is not fixable — but the caller is told, instead of the loss being
  reported as success.
- `runInTransaction()` only compensates a failure of the unit of work with a rollback. Catching wider
  than that meant a failing COMMIT — a deferred constraint, a serialization failure — was answered
  with a rollback of a transaction that was already finalised, and the caller received `Trying to
  ROLLBACK a transaction that is NOT the known transaction` instead of the error that mattered.
  SQLSTATE-driven retry loops never saw their `40001`. The commit's own failure now propagates
  untouched, with its `code` intact.
- A failing ROLLBACK no longer replaces the unit of work's error. The rollback's failure has already
  condemned the connection, which is all it can usefully do; the caller sees why their work failed.
- The manual `try { commit } catch (e) { rollback(trx, e) }` pattern is now safe: a compensating
  rollback after a *failed commit* is a no-op, because the transaction already ended without
  committing and refusing the call would bury the commit's error. Only that case is forgiven — a
  rollback after a successful commit, or a second rollback, still throws, since both mean the caller
  wants something that can no longer be true.
- `TransactionManagerUsingPg.commit()` and `.rollback()` reject instead of throwing synchronously
  when no transaction is active, as their `Promise<void>` signatures promise.
- `runInIsolation()` no longer lets the flush at the end of the isolated scope replace the unit of
  work's own failure — the two are usually correlated, since a unit of work that threw before
  committing leaves the very open transaction the flush would complain about. The flush still runs,
  so the scope leaks nothing; its complaint just steps aside.

`TransactionManagerUsingPg` now passes the full `TransactionManager` contract suite of
`@deltic/transaction-manager` (35 cases, run against real Postgres), including the four cases that
were impossible before these fixes.

**Fixed in the drizzle, knex and kysely providers:**

- Their `runInTransaction()` had the same shape and the same masking; the same separation is applied,
  so a commit failure reaches the caller as itself, and a failing rollback no longer replaces the
  unit of work's error.
