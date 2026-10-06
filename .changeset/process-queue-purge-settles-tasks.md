---
"@deltic/process-queue": patch
---

Reject the tasks that `purge()` drops instead of abandoning them. `await queue.push(task)` hung for ever for a purged task; its promise now rejects with the new, exported `TaskWasPurged` error, while a caller that discarded the promise does not get an unhandled rejection.
