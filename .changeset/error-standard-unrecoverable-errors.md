---
"@deltic/error-standard": patch
---

Let an error say that retrying cannot resolve it.

**Added:**

- `UnrecoverableError`, a marker interface (`readonly isUnrecoverable: true`), and
  `isUnrecoverableError(error)`, which recognises it by the marker rather than by class, so the
  check holds across package boundaries and duplicated installs. Loops that swallow failures and
  retry must rethrow these, so they reach the top of the process and end it instead of keeping a
  worker alive against a dependency that is not coming back. The `@deltic/messaging` AMQP connection
  provider reports its give-ups this way. Ported from duna-application `81cbb66adf`.
