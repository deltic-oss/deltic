---
"@deltic/offset-tracking": patch
---

Make `selectForUpdate` work, and refuse table names that are not identifiers.

**Fixed:**

- `selectForUpdate: true` emitted `SELECT FOR UPDATE "offset" FROM …` — a syntax error, so the one
  concurrency control the package offers failed on every `retrieve()`. The lock clause now sits at
  the end of the statement where it belongs. The option is also typed `boolean` instead of `true`,
  so it can carry a runtime flag.
- The offsets table name is part of the statement text, so it is now refused at construction unless
  it is a plain, optionally schema-qualified identifier. It used to be interpolated unchecked, which
  let a table *expression* replace the offsets table entirely.
