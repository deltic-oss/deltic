---
"@deltic/messaging": patch
---

`MessageRepositoryUsingMemory.paginateIds()` yielded every stream for a limit of zero, while Postgres returns nothing, so a paging loop that ends in production could run for ever in tests. A limit of zero now yields an empty page.
