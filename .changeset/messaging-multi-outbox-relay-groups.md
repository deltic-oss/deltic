---
"@deltic/messaging": major
"@deltic/stack": major
---

`MultiOutboxRelayRunner` takes an advisory lock per outbox instead of one global lock, so the outboxes are spread over the processes that run it. Every outbox is declared with the lock that guards it, `{relay, lockId, group?}`, and taking the lock is what starts relaying it. The outboxes of a group share one connection for their locks and their notifications. A connection that drops gives up its outboxes, which are claimed again on the next round.

- `holdGroups` limits a process to some of the groups.
- `maxConcurrentRelays` (10 by default) caps how many outboxes are relayed at the same time.
- `onClaimFailure` reports a group whose locks could not be taken.

The constructor no longer takes a `StaticMutex`, `lockRetryMs` is now `lockAcquisitionIntervalMs`, and two outboxes with the same lock id are refused with `DuplicateOutboxLockId`. `setupMultiOutboxRelay` follows: `mutex` is gone, every entry takes a `lockId` and an optional `group`, and the new options pass through, along with `failureBackoffCeilingMs` and `onRelayFailure`.

Ported from duna-application `27ad8cb24f` ("Consolidate outbox routing on staging.") and `d5b9a1084c` ("Remove global outbox relay lock."), with the bound connection listeners of `d3f3085319` ("Retain async context in outbox relay error cases.").
