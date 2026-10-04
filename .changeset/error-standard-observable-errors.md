---
"@deltic/error-standard": patch
---

Give every StandardError its subclass name, and a JSON payload worth logging.

**Fixed:**

- `error.name` was `'Error'` for every subclass, so traces read `Error: …` and error-tracking
  dashboards collapsed every domain failure into one group. The name now comes from the actual
  subclass (`new.target.name`), defined non-enumerably to match Error semantics — `Object.keys`
  and object spreads are unchanged — and assigned before the stack is materialised, so the stack
  header carries it too.
- `JSON.stringify` of a StandardError produced `{"code":…,"context":…}` and nothing else:
  `message`, `stack` and `cause` are non-enumerable per the Error specification, so a JSON log
  line looked complete while omitting the human-readable message and the entire cause chain — the
  package's headline feature. `StandardError` now carries a `toJSON()` returning `name`,
  `message`, `code`, `context` and a described `cause` chain. Wrapped errors keep their `name`,
  `message` and the `code` that identifies system and driver failures (previously a wrapped pg
  error serialised to `{}`); wrapped StandardErrors keep their `code` and `context` as well.
  Aggregates describe their first few failures and count the rest, chains are cut after a few
  layers — a cyclic cause graph serialises instead of making `JSON.stringify` throw from inside a
  logging pipeline — and the stack is deliberately left out to keep payloads small: reporters that
  want it read `error.stack` directly.
