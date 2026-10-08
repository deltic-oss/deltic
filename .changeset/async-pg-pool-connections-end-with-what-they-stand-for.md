---
"@deltic/async-pg-pool": major
---

A connection kept past its release, or a transaction kept past its commit or rollback, kept running queries: outside the transaction it was meant for, or on a connection the driver had already handed to another flow. The pool now hands out a handle per claim and per transaction, and a query through one that has ended is refused with the new `UnableToUseConnection`; because a handle is not the `pg` client itself, compare `processID` rather than object identity with a raw client.
