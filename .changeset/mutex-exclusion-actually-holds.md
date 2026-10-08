---
"@deltic/mutex": major
---

Make mutual exclusion hold, make timeouts mean what they say, and stop stale handles from
releasing other holders' locks.

**Fixed in `MutexUsingMemory`:**

- Waiters are queued per lock id. One shared queue served every id, so releasing lock `one` woke a
  waiter for lock `two` while `two`'s holder was still running — mutual exclusion broke as soon as
  two lock ids were contended at once, lock `one` was leaked for ever, and the wrongly woken command
  then failed on release. This also broke `makePostgresMutex({mode: 'primary'})`, which composes the
  memory mutex in front of the advisory lock, and with it the locking guarantee of
  `@deltic/service-dispatcher`.

**Fixed in `MutexUsingPostgres`:**

- `lock(id)` without a timeout used to emit `SET lock_timeout TO 'undefinedms'`, failing every
  acquisition; it now waits indefinitely, like the memory implementation. `lock(id, 0)` used to set
  `lock_timeout = 0`, which *disables* the timeout — "do not wait" became "wait for ever, holding a
  pooled connection"; a zero, negative or `NaN` timeout now translates to a try-lock that fails fast.
  A failed bounded acquisition also resets `lock_timeout` before the session is handed back, so a
  kept primary connection does not carry it into unrelated queries.
- The connection holding a lock is forgotten as soon as the lock is released. The stale entry used to
  let a second `unlock()` release a lock that a *later* acquirer held — reporting success to the one
  caller and silently unlocking the other — and leaked one map entry per lock id. Releasing a lock
  that is not held now reports a typed `UnableToReleaseLock`.
- Lock connections are stored under the lock id as the caller knows it, not under the converted
  advisory id. Converters map an unbounded name space onto a bounded number range, so two names can
  collide — `unlock('order-103')` could release `order-27`'s lock and report success. Colliding names
  still serialise against each other server-side (inherent to the mapping); they can no longer
  release each other. `ConnectionStorage.connections` is now keyed by `LockValue` instead of
  `number`, which is a type-level change for custom `ConnectionStorageProvider` implementations.
- A release the database refuses is reported as `UnableToReleaseLock` instead of being replaced by a
  double-release complaint from the pool.

**Fixed in `MultiMutex`:**

- `unlock()` releases every composed mutex even when one of them fails, instead of stopping at the
  first failure — a transient backend failure no longer leaves the in-memory guard of
  `makePostgresMutex({mode: 'primary'})` held for ever. Failures are collected; a single one is
  rethrown as-is, several are wrapped in `UnableToReleaseLock` with an `AggregateError` cause. The
  rollback of a partially acquired `lock()`/`tryLock()` keeps going the same way.
- The remaining time budget handed to later mutexes is clamped to at least one millisecond. An
  exhausted budget used to be passed as a negative number (refused outright) or exactly zero
  (interpreted as "wait for ever" by the Postgres implementation).

Still open, by design: the raw `MutexUsingPostgres` in `'primary'` mode is session-re-entrant —
Postgres grants the same advisory lock twice on one session. Use `makePostgresMutex`, whose composed
in-memory guard now genuinely serialises re-entrant acquisition.
