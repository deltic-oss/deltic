---
"@deltic/event-sourcing": patch
---

Make the test tooling assert on the action under test, and honour an expected error type.

**Fixed:**

- `then()`, `expectNoEvents()`, `emittedEvents()` and `emittedEventsWithHeaders()` reported the
  events of an earlier `when()`/`whenAggregate()` when the latest one recorded nothing. A command
  that records no events never reaches the message repository — the repository returns early and
  `AggregateServiceDispatcher` skips the persist — so the repository's last commit still held the
  previous action's events, and `then()` after a no-op command failed (or, worse, a `then(...)`
  expecting the earlier events passed). `when()` and `whenAggregate()` now clear the last commit
  before they run. Ported from duna-application `f97d92c0eb` / `733c62d3b8`.
- `expectError(SomeErrorClass)` followed by `whenAggregate()` failed every test with "The
  instanceof assertion needs a constructor but String was given": the check passed
  `typeof expectedError` (the string `'function'`) to `toBeInstanceOf` instead of the class. It
  now matches the thrown error against the class, as `when()` already did. Ported from
  duna-application `733c62d3b8`, which carries the corrected check.
