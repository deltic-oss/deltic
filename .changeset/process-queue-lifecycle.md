---
"@deltic/process-queue": patch
---

Give the sequential and concurrent queues one lifecycle that cannot wedge: a processor that throws or a rejecting `onError`/`onFinish` no longer crashes the process or stalls the queue, `stop()` waits for every task in flight including its hooks (without deadlocking when called from inside the queue), `start()` resumes after `stop()` and `purge()`, a task is never processed twice, and `onStop` is called once each time a queue comes to a stop. `SequentialProcessQueue` now honours `stopOnError` (default `true`), so a failed task that `onError` does not skip stops the queue instead of being retried in a tight loop; a failing `onError` counts as not skipping the task, and a failing `onFinish` rejects that task's `push()` promise.
