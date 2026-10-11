---
"@deltic/event-sourcing": patch
---

`AggregateRootUsingHandlerMap` and `AggregateRootUsingReducerMap` looked handlers up through `Object.prototype`, so replaying an event typed `__proto__` threw and one typed `toString` replaced a reducer map's state. They now consider only the map's own keys, so such a type is skipped like any other type without a handler.
