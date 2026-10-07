---
"@deltic/messaging": patch
---

`paginateIds()` ignored the tenant context, so a job running for one tenant walked every tenant's streams and received their messages. Both repositories now paginate only over the tenant in context, and the Postgres one requires a tenant like its other reads; a walk over every tenant uses a repository without a tenant context.
