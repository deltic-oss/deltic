---
"@deltic/async-pg-drizzle": patch
"@deltic/async-pg-knex": patch
---

Document how a second `begin()` behaves.

Both adapters forward `begin()` to `@deltic/async-pg-pool`, where a second `begin()` in the same
context waits for the active transaction to be finalised. That queueing is deliberate — it is what
lets two concurrent flows share a context — but it also means a flow must never `await` a transaction
it would itself have to finalise. The README now says so, and points at `runInTransaction` for
composition and the pool's `transactionWaitTimeoutMs` for turning a mistaken wait into an error.
