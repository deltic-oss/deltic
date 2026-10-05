---
"@deltic/clock": patch
---

Refuse a point in time a test clock cannot represent, instead of silently becoming unusable.

**Fixed:**

- `createTestClock(start)` and `TestClock.travelTo(time)` interpret a string with `Date.parse`, which
  reports `NaN` for anything it cannot parse. `NaN` is a valid `number`, so it was stored without
  complaint and the clock reported `NaN` from `now()` and an `Invalid Date` from `date()` from then
  on. `reset()` did not recover a clock broken through `travelTo`. Both now throw when the value
  cannot be interpreted, naming the offending value. The same guard covers a number that is not
  finite, and `TestClock.advance(increment)`.

  This surfaced far from the mistake: a clock built from `'1670167845'` (a unix timestamp in seconds,
  which is not a parseable date string) made `AggregateRoot.recordThat` throw
  `RangeError: Invalid time value` from `toISOString()`, and made the Postgres outbox repositories
  fail with a driver error on an `Invalid Date` query parameter. A clock that refuses the value
  reports the problem at the call site that built it.

  A caller that was unknowingly running on a `NaN` clock now gets an error where it previously got
  silently wrong behaviour.
