---
"@deltic/async-pg-pool": patch
---

Take ownership of a connection's whole life, so it can always be handed back.

Handing a connection back to `pg` used to depend on a function stashed on the connection under a
symbol, which was attached only after the claim hooks had run, was never idempotent, and was applied
without touching the context bookkeeping that still pointed at the connection. Everything below is
one consequence or another of that.

**Fixed:**

- A failing `onClaim` hook leaked its connection permanently. The release path ran before the release
  function existed, so it threw a `TypeError` instead of releasing, and the reported error was that
  `TypeError` rather than `UnableToClaimConnection`. Connections are now supervised from the moment
  they are taken from the driver's pool, before any hook runs. The documented tenant-scoping
  `onClaim` example was enough to trigger this.
- `claimFresh()` threw without releasing when `freshResetQuery` failed, leaking one connection per
  failed reset.
- Evicting an idle connection removed it from the idle list but never handed it back, leaking one
  connection per idle period whenever `keepConnections` was above zero. The eviction timer also
  called into the context, so it could throw from a timer after a flush; it no longer does.
- `flush()` did not await the releases of idle connections — the callback it mapped over them
  returned nothing, so `Promise.all` awaited an array of `undefined` and reported the flush as done
  while releases were still in flight, turning a failing release hook into an unhandled rejection.
  Releases are now awaited one at a time, so a failure cannot skip the connections behind it, and
  failures are collected and reported instead of stopping the flush at the first one.
- `flush()` only knew about the primary connection and the idle list, so connections handed out by
  `claim()`, or by `primary()` under `keepPrimaryConnection: false`, were never released by it. The
  context now tracks every connection it has taken and not yet handed back, which is what `flush()`
  works from. This makes the README's "all connections are released on flush" true.
- A connection released while it was still recorded as the primary connection, or as the shared
  transaction, left the context pointing at a connection that belonged to the driver's pool again —
  after which it could be handed out as the primary a second time. Releasing a connection now drops
  every reference the context holds to it.
- Releasing a connection twice from inside the pool no longer happens: `finalizeTransaction` released
  and then released again from its own error path, which replaced the caller's error with the
  driver's double-release complaint. Releasing twice from *outside* the pool still reports the
  driver's error, because that remains a caller mistake worth hearing about.

Behaviour worth knowing about: `flush()` now rejects when a release hook fails, where it previously
resolved and let the failure escape as an unhandled rejection.
