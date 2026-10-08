---
"@deltic/service-dispatcher": major
---

The locking middleware had no default lock timeout, so one command that never finished made every later dispatch for its lock id wait forever, and `DELTIC_LOCK_TIMEOUT_MS` had no effect on it. Like the decorator, it now defaults to `defaultLockTimeoutMs` and rejects with `UnableToAcquireLock` once that passes.
