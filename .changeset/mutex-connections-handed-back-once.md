---
"@deltic/mutex": patch
---

Hand a lock's connection back to the pool once, even when handing it back fails.

**Fixed in `MutexUsingPostgres`:**

- `unlock()` released the lock's connection inside its `try` and released it again from the `catch`
  when that first release failed — for example because the pool's `onRelease` hook could not reset
  the connection. The second release made `pg` throw `Release called on client which has already
  been released to the pool.`, which replaced the real failure: callers received a plain `Error`
  instead of `UnableToReleaseLock`, and lost the cause. The lock itself was released; only the report
  was wrong. A failing release is now reported as `UnableToReleaseLock`, with the pool's failure as
  its cause.
- `tryLock()` did the same for a lock it could not acquire: the connection handed back after a
  refused `pg_try_advisory_lock` was released a second time when that release failed. It now
  reports `UnableToAcquireLock`, with the pool's failure as its cause.

Ported from duna-application `85c6604627` ("Fix issues with connection release"), which stopped the
application's copy of the mutex from releasing a connection twice once `e6f2d47ca1` ("Prevent hanging
connections.") had added a release to the error path. The guard is set before the release is
attempted rather than after it succeeds, so it also covers the release itself failing — a case the
application's copy still releases twice.
