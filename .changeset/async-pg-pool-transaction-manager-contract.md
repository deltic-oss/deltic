---
"@deltic/async-pg-pool": patch
---

`TransactionManagerUsingPg.commit()` and `.rollback()` reject instead of throwing synchronously when
no transaction is active, as their `Promise<void>` signatures promise.

`TransactionManagerUsingPg` now passes the full `TransactionManager` contract suite of
`@deltic/transaction-manager`, run against real Postgres.
