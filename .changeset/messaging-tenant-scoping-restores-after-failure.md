---
"@deltic/messaging": patch
---

When the consumer wrapped in `TenantScopingMessageConsumer` threw, the failed message's tenant stayed in the context, so work done between deliveries ran under that tenant. The previous tenant is now restored whether consumption succeeds or fails.
