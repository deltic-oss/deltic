---
"@deltic/async-pg-kysely": patch
---

A Kysely transaction started on an instance derived from a transaction instance (`trx.withSchema(...).transaction()`, and likewise `withPlugin`, `withoutPlugins`, `withTables`) ran as part of the outer transaction, so its rollback discarded nothing. It is now refused with `KyselyTransactionsNotSupported`, as the README already promised.
