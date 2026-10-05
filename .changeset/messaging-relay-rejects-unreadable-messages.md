---
"@deltic/messaging": patch
---

A delivery whose body was not JSON made `AMQPMessageRelay` lose its channel, and redeliver everything
the channel had prefetched, over and over as the broker sent the message again. A delivery that is
not a JSON object with a string `type` is now rejected without requeue: dead-lettered when the queue
has a dead-letter exchange, dropped otherwise.
