---
"@deltic/async-pg-pool": patch
---

A transaction the server finalised, committed or rolled back, releases its connection as *healthy*,
regardless of the rollback cause. Previously a cause handed to `rollback(client, error)` destroyed a
connection the successful ROLLBACK had just shown to be clean. A connection that is actually broken
fails the ROLLBACK itself and is still destroyed. The practical effect is less connection churn: a
failed unit of work no longer costs a reconnect.
