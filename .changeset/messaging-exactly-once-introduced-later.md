---
"@deltic/messaging": patch
---

Allow `ExactlyOnceMessageConsumerDecorator` to be introduced for a consumer that already processed messages.

With `{introducedLater: true}`, a stream without a stored offset starts at the message that arrives instead of
replaying its history. By default a missing offset still counts as 0, so history is replayed as before. The
identifier and offset resolvers moved into the same options object, the transaction manager is required, and
the offset is stored after the message is consumed, in the same transaction.
