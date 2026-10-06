---
"@deltic/messaging": patch
---

`AMQPMessageRelay.start()` threw `Already started` for a relay that had been stopped, or whose run had
ended because the connection provider gave up on the broker. A relay whose run ended can now be
started again; starting one that is still running is refused with a `StandardError`
(`amqp.relay_already_started`).
