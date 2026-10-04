---
"@deltic/backoff": patch
"@deltic/error-standard": patch
"@deltic/async-pg-knex": patch
"@deltic/async-pg-drizzle": patch
"@deltic/async-pg-pool": patch
"@deltic/dependency-injection": patch
"@deltic/uid": patch
"@deltic/process-queue": patch
---

Make the documentation match what the packages actually do.

- **backoff**: the README imported both strategies from the package root, which does not export
  them — the examples now import from `@deltic/backoff/exponential` and `/linear`. Every documented
  delay was one base-multiple too high (`backOff(1)` is `initialDelayMs * base^0`, not `^1`) — a
  retry budget sized from the old numbers was twice as slack as intended. The `BackOffStrategy`
  interface comment claimed exhaustion returns `undefined`; it documents the actual contract now:
  exhaustion throws `MaxAttemptsExceeded`, and a strategy without a maximum never throws.
- **error-standard**: the README claimed `errorToMessage` returns `'Unknown error'` for values
  without a message; it never has. It documents the actual behaviour — the value's string
  representation.
- **async-pg-knex**: the README documented `claimClient()`/`releaseClient()`, which do not exist.
  The raw-client section now goes through `asyncPool.claim()`/`release()`, with the caveat that a
  claimed connection does not participate in the ambient transaction.
- **async-pg-drizzle / async-pg-pool**: documented that, under the default
  `keepPrimaryConnection: true`, queries a flow issues concurrently all run serially on the flow's
  one connection, riding on driver queueing that `pg` has deprecated. Also documented that the
  pool's default context is single-flow only, with the `AsyncLocalStorage` wiring concurrent flows
  require.
- **dependency-injection**: the README's `lazy: true` example registered the collection under the
  wrong token and threw `Dependency something is already registered`; neither example type-checked.
  Both examples are corrected and now covered by a test.
- **uid**: documented the ordering guarantees of the two generators — UUID v7 is strictly monotonic
  within a millisecond (and across a backwards clock adjustment), ULID is not — and when to pick
  which.
- **process-queue**: `isProcessing()` reports whether the queue is started, not whether work is in
  flight; the README now says so.
