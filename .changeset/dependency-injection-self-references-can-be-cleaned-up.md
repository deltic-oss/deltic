---
"@deltic/dependency-injection": patch
---

A service that resolved itself, lazily or through a cycle whose other members had no cleanup, was recorded as its own dependency, so `cleanup()` reported a circular dependency and shut nothing down. Such a service is now cleaned up like any other.
