---
"@deltic/dependency-injection": patch
---

Keep service names off the object prototype.

The definition and cache registries were plain objects, so every lookup walked
`Object.prototype`. Registering a service named `toString`, `valueOf` or any other prototype
member threw `Dependency … is already registered` on an empty container, and resolving such a
name that was never registered returned a native function — `Object.prototype.toString`, the
`Object` constructor — instead of the documented `No definition found` error, deferring the
failure to wherever the impostor was first used.

Both registries are `Map`s now, like the rest of the container's state. Cache hits also check
presence rather than truthiness, so an intentionally falsy instance would be cached instead of
being rebuilt on every resolution.
