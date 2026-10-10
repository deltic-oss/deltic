---
"@deltic/key-value": major
---

Scope every operation of a tenant-scoped Postgres key-value store to the current tenant. `KeyValueStoreUsingPg` read and removed a key across all tenants, `clear()` truncated the table for every tenant (cascading to tables referencing it), and `KeyValueStoreWithColumnsUsingPg` dropped the tenant for an id such as `0`; now every operation addresses only the current tenant's rows, `clear()` is a `DELETE`, and a tenant-scoped store rejects any operation when no tenant can be resolved.
