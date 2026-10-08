---
"@deltic/messaging": major
---

Remove `SequentialMessageConsumer` and its `@deltic/messaging/sequential-message-consumer` entry point. After the first message that failed it stopped draining its queue, so every later `consume()` call returned a promise that never settled, and it could not be stopped or drained. To consume one message at a time, push messages onto a `SequentialProcessQueue` from `@deltic/process-queue` whose processor calls the consumer, and skip a failed message in `onError` to keep going; the messaging README shows how.
