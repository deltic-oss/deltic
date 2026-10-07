---
"@deltic/process-queue": patch
---

Give the sequential and concurrent queues one lifecycle that cannot wedge: a processor that throws is reported to `onError` like one that rejects, `stop()` waits for every task in flight including its hooks (a hook that calls it on the `queue` it receives, now a handle to the queue, does not wait for itself), `start()` resumes after `stop()` and `purge()`, and a task is never processed twice. The `onStop` option, and the `onStop` argument of `PartitionedProcessQueue`, are removed; `await queue.stop()` resolves once the queue has stopped. `SequentialProcessQueue` now honours `stopOnError` (default `true`), so a failed task that `onError` does not skip stops the queue instead of being retried in a tight loop.
