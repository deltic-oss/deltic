---
"@deltic/dependency-injection": patch
---

`register()` replaced the factory of a `lazy: true` definition on the caller's own object, so one definition registered in two containers made them share, and clean up twice, a single instance, and `{lazy: true, cache: false}` handed every resolution the same instance. The container now stores a copy of the definition and gives each resolution of a lazy service its own proxy, so a transient lazy service constructs an instance per resolution; `resolveLazy()` of a `lazy: true` service no longer overflows the stack when its proxy is first used.
