---
"@deltic/dependency-injection": patch
---

Run every shutdown hook once when `cleanup()` is triggered from more than one place at a time.

**Fixed:**

- `cleanup()` had no notion of a cleanup already running. A second call that started before the
  first one finished computed the same shutdown levels from the same, not yet cleared, bookkeeping
  and invoked every hook a second time, concurrently with the first. Shutdown is commonly triggered
  twice — `SIGTERM` and `SIGINT` both arrive in a container runtime, a supervisor fires its deadline
  while a slow hook is still running — and hooks are rarely safe to repeat: `pg.Pool.end()` rejects
  with `Called end on pool more than once`, a closed AMQP channel rejects on `close()`, and a lock
  released twice can free a lock another process has since taken. A call made while a cleanup is
  running now joins that cleanup and settles when it has finished. Sequential calls are unchanged:
  once a cleanup has finished, the next call starts a new one.

Ported from duna-application's `ShutdownHandler` (`src/tools/shutdown/exports.ts`: the `shuttingDown`
guard in `shutdown()` from `0f3243a6aa`, and the per-signal guard from `e5ecc6fbd4` "Fix shutdown
routine for a clean exit"), which runs its shutdown routine once however many signals arrive. Adapted: the application returns early from a
repeated call, here the repeated call waits for the running cleanup, so a caller that awaits it
before exiting does not exit while hooks are still shutting things down.
