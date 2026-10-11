---
"@deltic/event-sourcing": patch
---

`AggregateRootRepositoryWithSnapshotting.persist()` stored the snapshot before the events, so without a shared transaction a failed event write left a snapshot ahead of its stream, carrying a decision that was never recorded. The events are now written first; a failed snapshot write leaves a snapshot behind its stream, which loading already catches up on.
