---
"@deltic/context": patch
---

`attach()` assigned every key it was given, so an own `__proto__` key, as `JSON.parse` produces, replaced the prototype of the context and made the values under it readable through `get()` while staying invisible to enumeration. Keys are now defined as own properties, so `__proto__` is an ordinary key like any other.
