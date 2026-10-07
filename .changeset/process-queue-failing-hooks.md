---
"@deltic/process-queue": patch
---

A hook that fails no longer stalls a queue or leaves an unhandled rejection behind: a failing `onError` counts as not skipping the task, a failing `onFinish` rejects that task's `push()` promise, and a failure of `onDrained` is ignored.
