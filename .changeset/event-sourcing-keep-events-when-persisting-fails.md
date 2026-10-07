---
"@deltic/event-sourcing": patch
---

A failed `persist()` took the recorded events off the aggregate anyway, so retrying with the same aggregate resolved without writing anything. The events now stay on the aggregate until they are stored and the repository's transaction has committed, in the snapshotting repository too.
