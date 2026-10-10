---
"@deltic/transaction-manager": patch
---

`NoopTransactionManager` let a unit of work that threw before returning a promise escape as a synchronous throw, where the real managers reject. It now reports that failure as a rejected promise too.
