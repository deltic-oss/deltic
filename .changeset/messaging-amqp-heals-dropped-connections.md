---
"@deltic/messaging": patch
"@deltic/stack": patch
---

Recover from a dropped AMQP connection instead of retrying on dead channels for ever, and give up on
a broker that does not come back.

Ported from duna-application `81cbb66adf` ("Prevent eternally re-trying on a closed AMQP channel."),
`a9434376df` ("Track timer.") and `bff99ae365` ("Wake caller when a channel dies to start new
claim.").

**Fixed in `AMQPChannelPool`:**

- Channels that died with their connection were handed out again. The pool served idle channels
  without consulting the connection, and a failed publish put its dead channel straight back, so
  after a single connection drop every `AMQPMessageDispatcher.send()` failed with `Channel closed`
  until the process restarted — retries included, since they drew the same dead channels. The pool
  now resolves the connection before it serves a channel (a new connection empties the pool),
  tracks which channels are still open, skips the ones that closed while idle, and does not pool a
  channel that died while leased.
- A caller parked on a full pool was only woken when a channel went back into the pool, so a lease
  freed by a dead channel left it waiting out its timeout and reporting an exhausted pool. Every
  freed lease now wakes a waiter, which opens a channel on the current connection.
- `close()` emptied nothing, so `channel()` kept handing out the channels it had just closed; it now
  empties the pool and `channel()` throws `ChannelPoolClosed`.
- A channel the broker closed over a failed operation — consuming from a queue that does not exist,
  acking an unknown delivery tag — emitted an `error` event nobody listened to, which Node turns into
  an uncaught exception that ends the process. The pool now absorbs it; the failed operation already
  rejects and the `close` event takes the channel out of circulation.

**Fixed in `AMQPConnectionProvider`:**

- An unreachable broker was retried for ever, and a bounded `backoff` strategy that gave up left
  `connection()` and `close()` pending for ever with an unhandled rejection. Retrying now stops after
  `healingTimeout` milliseconds of continuous failure (new option, 60 seconds by default) or when the
  backoff strategy gives up, with `UnableToHealAMQPConnection`. A broker that rejects every configured
  credential fails at once with `UnableToAuthenticateWithAMQP`. Both are unrecoverable errors
  (`isUnrecoverableError` from `@deltic/error-standard`); a caller's own `timeout` still fails with
  the ordinary `UnableToEstablishConnection`. A failed connect never leaves a settled waiter behind.
- A socket failure or a missed heartbeat emitted an unheard `error` event on the connection, ending
  the process; it is now absorbed and the connection is replaced on the next request.
- `close()` no longer rejects when a connection already went down.

**Fixed in `AMQPMessageDispatcher`:**

- When a try failed and the next try could not get a channel, the earlier channel was released a
  second time, and the pool's `ChannelNotLeased` replaced the failure the caller needed to see.
- An unrecoverable failure is passed on as it is, without spending the remaining tries.

**Fixed in `AMQPMessageRelay`:**

- A failure to start consuming was swallowed, leaving the relay running without consumers and
  `start()` pending for ever. It is now retried once a second; an unrecoverable failure ends the run
  and `start()` rejects with it. A channel that closes while the consumers are still being attached
  is retried at the same pace rather than at once, so a queue that does not exist yet is not retried
  as fast as the broker can answer (the duna-application original does that).
- Each reconnect leaked the previous channel's lease, so the pool's `close()` timed out after any
  reconnect; the replaced channel is now closed and handed back.
- Deliveries were acked or nacked on the relay's current channel. After a reconnect that settled
  them with delivery tags belonging to the old channel, acking or nacking an unrelated message. A
  delivery is now only settled on the channel that delivered it, while that channel is still the
  relay's; otherwise it is left for the broker to redeliver.
- `stop()` rejected when a reconnect held the start-up lock while waiting for the broker, and when
  cancelling a consumer on a dead channel failed; it now completes, clears a pending restart, and a
  reconnect that finishes afterwards hands its channel back instead of consuming on a stopped relay.
- A reconnect that purged the queue while a failed delivery was being counted produced an unhandled
  rejection.
