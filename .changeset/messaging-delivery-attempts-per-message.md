---
"@deltic/messaging": patch
---

`AMQPMessageRelay` counted the delivery attempts of every message without an `event_id` under one
shared key, so once `maxDeliveryAttempts` failures had added up anywhere on the queue, every failing
message was dead-lettered on its first failure. Such messages are now counted by their body, and a
count is forgotten once its message is handled or dead-lettered, through the new optional
`MessageDeliveryCounter.forget()`.
