---
"@deltic/async-pg-kysely": patch
---

`runInTransaction()` only compensates a failure of the unit of work with a rollback. A failing COMMIT, such as a deferred constraint or a serialization failure, now reaches the caller as itself, with its `code` intact, instead of as the complaint of a rollback sent after it. A failing ROLLBACK no longer replaces the unit of work's error.
