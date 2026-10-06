---
"@deltic/dependency-injection": patch
---

After a factory threw, every later `resolve()` of that service returned a proxy instead of running the factory again or reporting its error, so a caller's retry or fallback never ran and the failure resurfaced wherever the proxy was first used. A failed construction now leaves nothing behind: the next resolution runs the factory again, in `resolve()`, `createInstance()` and when a proxy constructs its service.
