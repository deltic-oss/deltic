---
"@deltic/async-pg-kysely": patch
---

With `keepPrimaryConnection: false`, a query that was still running when another part of the flow began a transaction kept its connection checked out until the scope ended, and a query on the transaction's connection that finished after the commit released it a second time. The driver now decides when it hands out a connection whether it is the active transaction's, and returns every other connection after its query.
