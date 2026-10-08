---
"@deltic/key-value": patch
---

Quote column names in every statement of `KeyValueStoreWithColumnsUsingPg`. They were quoted in the `INSERT` and `SET` lists but not in the `ON CONFLICT` target or the lookups of `retrieve` and `remove`, so a mixed-case column such as the default for a `camelCase` property failed with `column "userid" does not exist`; column names are now used exactly as configured everywhere.
