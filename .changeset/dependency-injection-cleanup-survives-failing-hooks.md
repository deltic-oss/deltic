---
"@deltic/dependency-injection": patch
---

One failing cleanup hook aborted `cleanup()`: the services beneath it (pools, connections, locks) were never shut down, a hook that threw synchronously kept its siblings from running, and only the first error was reported. Every hook now runs, and `cleanup()` then rejects with a `CleanupFailed` (an `AggregateError`) that names each failing service.
