---
"@deltic/async-pg-knex": patch
---

`ref()` and `queryBuilder()` on a connection or a transaction, and `connection().destroy()`, threw `TypeError: this.context[m] is not a function` because the adapter handed out knex's methods unbound. They are bound to the knex instance now, and `queryBuilder()` returns a builder that runs on the ambient connection or in the transaction, like every other query from there.
