---
"@deltic/messaging": major
---

`TenantScopingMessageConsumer` runs every message in a context scope of its own, and takes a context instead of a tenant value: pass the `Context` that your `ValueReadWriterUsingContext` reads from, backed by `AsyncLocalStorage`.

It used to assign the message's tenant to one shared value. Messages consumed at the same time overwrote each other's tenant, so their reads and writes could land in another tenant's data. A message that failed also left its tenant in the context for the work that followed it.
