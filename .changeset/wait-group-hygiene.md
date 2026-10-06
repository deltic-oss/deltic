---
"@deltic/wait-group": patch
---

Refuse counts that can never drain, and leave nothing behind when a wait ends.

**Fixed:**

- `add()` refuses anything but a non-negative integer. A negative or `NaN` count made the counter
  unable to ever reach zero again, turning every later `wait()` into a silent, permanent hang —
  the worst failure mode for a primitive that guards shutdowns — while also disabling `done()`'s
  misuse reporting.
- A waiter whose wait timed out or was aborted is removed from the waiter list. It used to stay
  behind for ever, one entry per retried wait, on a group whose counter rarely reaches zero.
- The abort listener is removed once a wait resolves. On a long-lived `AbortSignal` it used to pile
  up, one listener per completed wait, without any warning from Node.
- Timeouts that cannot mean anything are translated instead of reaching the timer: negative, `NaN`
  and `Infinity` mean "no deadline" (previously `NaN` and `Infinity` rejected with Node's internal
  `RangeError` about a `delay` parameter the caller never wrote); a fractional timeout is rounded
  up (previously the same `RangeError`); a timeout beyond what a timer can express is clamped
  (previously it overflowed and fired after one millisecond). Zero stays what it was: an instant
  deadline.
