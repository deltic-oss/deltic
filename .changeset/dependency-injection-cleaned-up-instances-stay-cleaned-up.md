---
"@deltic/dependency-injection": patch
---

Resolving a registered instance after a cleanup returned the object that had just been shut down and registered its cleanup again, so the next cleanup closed it a second time. Resolving a registered instance whose cleanup ran now throws; one without a cleanup stays resolvable.
