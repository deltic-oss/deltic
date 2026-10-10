---
"@deltic/stack": major
---

The Postgres provider built its outbox repository without notifications, so the relays that listen for them only ever relayed on their poll interval. Every outbox write now notifies both the per-table channel of `setupOutboxRelay` and the central channel of `setupMultiOutboxRelay`; the new `outboxNotification` option changes that, and `{style: 'none'}` relies on polling alone.
