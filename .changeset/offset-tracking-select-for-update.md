---
"@deltic/offset-tracking": patch
---

Make `selectForUpdate` work.

**Fixed:**

- `selectForUpdate: true` emitted `SELECT FOR UPDATE "offset" FROM …` — a syntax error, so the one
  concurrency control the package offers failed on every `retrieve()`. The lock clause now sits at
  the end of the statement where it belongs. The option is also typed `boolean` instead of `true`,
  so it can carry a runtime flag.
