---
"@deltic/async-pg-knex": patch
---

`connection().schema` and `trx.schema` handed back knex's own schema builder, which failed every statement with "Unable to acquire a connection" because the adapter's knex instance has no pool. `trx.schema` now runs in the transaction, and `connection().schema` runs on the ambient connection like every other query, inside the active transaction when there is one.
