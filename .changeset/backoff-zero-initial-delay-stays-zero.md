---
"@deltic/backoff": patch
---

`ExponentialBackoffStrategy` with an initial delay of `0` returned `NaN` from attempt 1025 on, once the exponent overflowed. It now returns `0` for every attempt.
