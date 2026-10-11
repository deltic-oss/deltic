---
"@deltic/async-pg-pool": patch
---

Document that `abandon()` only reaches a request's scope from a listener bound to it.

**Fixed:**

- The README's recipe for ending a request scope registered `res.on('close', () => void
  asyncPool.abandon())`. `abandon()` ends the scope of the flow it is called from, and a response's
  `close` event is emitted by the socket, which existed before the request's scope did. On a client
  disconnect — the case the recipe exists for — the listener runs with no scope at all, so
  `abandon()` found nothing to end, reported `openTransaction: 'none'`, and the request's
  connections stayed checked out. The recipe now binds the listener with `AsyncResource.bind`, and
  the README explains when binding is needed: for any listener that reaches the pool, including a
  pooled connection's own `error`, `end` and `notification` events, which run on the async chain
  the socket was created on.

No code changed.

Ported from duna-application `a9e3a018d8` ("Ensure res.on('close', ...) is bound to the async
callstack."), where the request-scope middleware binds its `close` listener for this reason, and
`d3f3085319` ("Retain async context in outbox relay error cases."), which does the same for a
connection's `error` and `end` listeners.
