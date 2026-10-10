---
"@deltic/key-value": patch
---

Hand back every connection the Postgres key-value stores claim. `clear()` and every method of `KeyValueStoreWithColumnsUsingPg` kept theirs.
