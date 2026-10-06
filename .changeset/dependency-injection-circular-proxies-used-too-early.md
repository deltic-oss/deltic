---
"@deltic/dependency-injection": patch
---

A circular proxy that was used while its service was still being constructed ran the factory a second time, so a shared service existed twice and only one of them was ever cleaned up; when both sides of a cycle did this, resolution overflowed the stack. Both now throw a circular dependency error that names the path; storing the proxy during construction and using it afterwards keeps working.
