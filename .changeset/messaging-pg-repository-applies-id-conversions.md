---
"@deltic/messaging": patch
---

Apply the configured id conversions to every id `MessageRepositoryUsingPg` sends to the database.

**Fixed:**

- The `tenantIdConversion` option was accepted and never stored, so tenant ids reached the
  `tenant_id` column unconverted on every write and read. With prefixed tenant ids in a UUID column
  every `persist()` failed with `invalid input syntax for type uuid`; with a column that accepts the
  raw form, rows were stored under an id the rest of the system does not use. The option is now
  applied. Ported from duna-application `38cba86ea7` ("Fixed ID serialization with prefixes."), where
  the tenant id conversion has been applied since the repository gained it.
- `paginateIds({afterId})` compared the cursor against `aggregate_root_id` without passing it through
  `idConversion`, while every other read and write converts the aggregate root id. With prefixed ids
  in a UUID column, continuing a pagination failed with `invalid input syntax for type uuid` — every
  page after the first was unreachable. The cursor is now converted. Ported from duna-application
  `8739785a51` ("Account for concurrently running processes in aggregegate ID listing."), which
  introduced the cursor with the conversion.
