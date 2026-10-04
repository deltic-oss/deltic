---
"@deltic/messaging": patch
---

Run the members of a consumer or dispatcher chain one after the other, and settle only when they are done.

**Fixed:**

- `MessageConsumerChain` and `MessageDispatcherChain` handed the message to every member at once with
  `Promise.all`, which rejects as soon as one member fails while the others are still running. Whatever
  is scoped around the chain ended at that moment: `LockingMessageConsumer` released the aggregate's
  lock while a sibling consumer was still working on it, and the aggregate repository rolled back its
  transaction while the outbox write next to a failing synchronous consumer could still be in flight,
  leaving that write to run after the rollback, outside the transaction it belonged to. Both chains now run their
  members in the order they were given and stop at the first failure, so they settle only once nothing
  they started is still running.
- Order in the constructor now means order of execution. The `@deltic/stack` wiring that chains the
  outbox dispatcher before the synchronous consumers ("first outbox, then sync consumers") relied on
  an order the chain did not keep; it now does. Running members in order also stops a chain from
  issuing concurrent queries on the one connection its flow shares, which `pg` only tolerates by
  queueing them, a behaviour it has deprecated.

Behaviour worth knowing about: members after a failing one no longer receive the message. A relay
redelivers it to the whole chain, so the members before the failure see it again, as before.

Ported from duna-application `7e7d07f8ed` ("Make the default chains operate in sequence.").
