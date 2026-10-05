---
"@deltic/key-value": patch
---

Hand the connections the Postgres key-value stores claim back to the pool, except the connection of an open transaction. `clear()` and every method of `KeyValueStoreWithColumnsUsingPg` never released theirs, and `KeyValueStoreUsingPg` released an isolated transaction's connection in the middle of it, after which the pool refused to finalise the transaction.
