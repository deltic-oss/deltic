---
"@deltic/key-value": minor
---

Both stores normalise a key before they use it, through the new `KeyNormalisation` interface and `keyNormalisation` option. The default `SortingKeyNormalisation` sorts the properties of object keys recursively, so `{first, second}` and `{second, first}` address the same entry in Postgres as they already did in memory. An object key that was stored with its properties out of order is now looked up under its sorted JSON and needs a migration. `object-hash` is no longer a peer dependency.
