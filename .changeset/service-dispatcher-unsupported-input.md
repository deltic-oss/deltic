---
"@deltic/service-dispatcher": patch
---

`AggregateServiceDispatcher` answered an unknown input type with `TypeError: handler is not a function`, after retrieving the aggregate, and both dispatchers accepted input types such as `toString` or `constructor` that resolve to members of `Object.prototype`. Both now reject such input with `InputNotSupported`, the aggregate dispatcher before it retrieves the aggregate.
