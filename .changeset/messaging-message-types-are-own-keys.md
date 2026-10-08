---
"@deltic/messaging": patch
---

A message type named after an `Object.prototype` member, such as `toString` or `constructor`, resolved to that inherited member: `routeSomeToReducer` replaced the state with `'[object Undefined]'`, upcasting threw a `TypeError` and `SchemaVersionMessageDecorator` stamped a wrong `schema_version`. Such a type is now treated like any other unregistered type.
