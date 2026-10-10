---
"@deltic/async-pg-pool": major
---

Add `abandon()`, and stop the transaction reservation from wedging a context.

`transactionAccess` was doing two jobs: serialising transactions within a context, and standing in
for "a transaction is open". Because it was given back in exactly one place — `finalizeTransaction` —
every other way out of a transaction leaked it, and everything that waited on it waited forever.

**Added:**

- `abandon()` ends a context once its open transaction has ended, and rejects for nothing.
  What it had to clean up is returned as an `AbandonedScope` (`openTransaction`,
  `releasedConnections`, `failures`) rather than thrown, so it is safe to call from the places where
  a scope turns out to be over but no result can be handled: a socket close handler, a deadline
  timer, a signal handler. Calling it twice, or after a flush, is harmless.

  This exists because an HTTP request has no reliable "handler finished" hook. `finish` does not fire
  when a client disconnects, `close` fires while the handler may still be running, and Express — v5
  included — gives no awaitable handler-completion signal, so `flush()` could never be placed
  correctly for a request scope.

  By default `abandon()` **waits for an open transaction**. A client disconnecting does not stop the
  handler — Node runs it to completion — so the transaction may still be committed by work that is
  still running, and rolling it back would discard that work. The scope ends once the handler
  commits or rolls the transaction back (`openTransaction: 'finished'`), or once the server ends the
  transaction's session (`'lost'`), before any transaction the handler would begin after it. The
  server's `idle_in_transaction_session_timeout`, and from PostgreSQL 17 `transaction_timeout`, bound
  the wait. Pass `{rollbackOpenTransaction: true}` to end the scope at once with a rollback, where
  reclaiming the connection matters more than the in-flight work, typically a hard deadline after a
  grace period.

- `transactionWaitTimeoutMs` bounds how long `begin()` queues behind a transaction that is already
  active in the same context. Unset it waits indefinitely, as before. Queueing itself is intended
  behaviour and is unchanged; the option exists so that awaiting a second transaction in the flow
  that holds the first — a self-deadlock, since that flow is the one that would have to finalise it —
  reports instead of hanging.

**Fixed:**

- A failing `BEGIN` never gave back the transaction reservation, so every later `begin()` **and every
  later `flush()`** in that context waited forever. Any path out of `begin()` that does not leave a
  transaction open now releases it.
- `flush()` waited for the transaction reservation before doing anything, which could not be
  satisfied when a transaction was open: the transaction holding the reservation was the very thing
  being reported on. As a result its own "forgot to call commit or rollback" error was unreachable
  dead code and a forgotten commit turned into a silent hang. `flush()` no longer waits; it rolls the
  transaction back, releases the connection, and then rejects with `UnableToFlush` — so a reported
  mistake is not also a leak.

**Changed:**

- `flush()` rejects where it previously hung, which is the point, but it is a behaviour change for
  anything that treated the hang as "in progress". `flushSharedContext()` is unchanged as an alias.
