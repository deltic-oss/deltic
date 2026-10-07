---
"@deltic/async-pg-pool": patch
"@deltic/async-pg-drizzle": patch
"@deltic/async-pg-knex": patch
"@deltic/async-pg-kysely": patch
---

Document the tenant claim hook with a bound parameter instead of string interpolation.

The READMEs demonstrated interpolating the tenant id into the claim hook's statement:

```typescript
onClaim: client => client.query(`SET app.tenant_id = '${tenantId}'`),
```

which lets a hostile tenant id escape the string and run its own SQL — with row-level security,
that is a full tenant bypass. The documented pattern now binds the id as a parameter, keeping it
as data:

```typescript
onClaim: client => client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]),
```

No code changed; the hooks always ran whatever the consumer wrote.
