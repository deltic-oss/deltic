---
"@deltic/uid": patch
---

Bind `PrefixedBrandedIdConversion`'s `toDatabase` and `fromDatabase` to their instance. The constructor called `bind` without assigning the result, so passing a method on as a plain function, such as `ids.map(conversion.toDatabase)`, failed with a `TypeError` on the first id.
