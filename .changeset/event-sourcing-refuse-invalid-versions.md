---
"@deltic/event-sourcing": patch
---

`retrieveAtVersion()` with a negative version (or `NaN`) returned an empty aggregate from the in-memory event store but the current, fully replayed aggregate from Postgres. It now rejects a version that is not a whole number of zero or more with `InvalidAggregateRootVersion`; version `0` still gives the aggregate before its first event.
