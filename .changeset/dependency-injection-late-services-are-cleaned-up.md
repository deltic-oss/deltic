---
"@deltic/dependency-injection": patch
---

A service resolved or created while `cleanup()` was running, by work still in flight during a graceful shutdown, was never shut down, by that cleanup or a later one, so a pool or connection constructed then kept the process alive. The running cleanup now shuts it down too, before whatever it depends on that is still up.
