---
"@deltic/async-pg-pool": patch
---

`release()` leaves the connection of the active transaction alone, as it already did the primary connection, and the pool hands it back once the transaction is committed or rolled back. Code that releases what `primary()` handed out no longer has to check whether a transaction is active first.
