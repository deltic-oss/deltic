---
"@deltic/uid": patch
---

Refuse to convert an id that does not carry the conversion's prefix. `PrefixedBrandedIdConversion.toDatabase` cut `prefix.length + 1` characters off whatever it was given, so an id cast to the wrong type was silently stored under a mangled key; it now throws the new `UnexpectedIdPrefix` error.
