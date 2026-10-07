---
"@deltic/uid": patch
---

`prefixedIdValidator` takes any `(id: string) => boolean` for the part after the prefix, so the README's `prefixedIdValidator('user', validate)` with `uuid`'s plain `validate` compiles. `IdValidator` is declared once, as the type guard.
