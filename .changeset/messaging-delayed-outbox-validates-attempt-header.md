---
"@deltic/messaging": patch
---

`DelayedOutboxRepositoryUsingPg.persist()` turned an `attempt` header that is not a number, such as another producer's header of the same name, into a `NaN` delay, and Postgres rejected the whole batch over the invalid `delay_until`. Such a header now counts as a first write.
