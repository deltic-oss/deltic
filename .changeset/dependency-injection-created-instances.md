---
"@deltic/dependency-injection": patch
---

Introduce created instances: instances built outside the service registry that still take part in the cleanup graph.

**Added:**

- `createInstance({factory, cleanup})` constructs an instance through a callback that resolves its
  dependencies from the container. The instance is cleaned up before the services it depends on, and
  after whatever created it, without being registered under a key.

**Fixed:**

- Services that have no cleanup of their own are transparent in the cleanup graph. Previously the
  dependencies discovered beneath them were only attributed on the resolution that constructed them,
  so a later consumer served from cache never learned about them and could be cleaned up
  concurrently with services it transitively depended on. Those dependencies are now inherited by
  every consumer.
- `resolveLazy()` on a service with a `cleanup` callback threw a `TypeError` as soon as the proxy was
  used, and never registered the cleanup. Proxied services now always take part in the cleanup graph,
  which also means the dependencies they resolve are attributed to them instead of to whatever
  happened to be resolving when the proxy was first used.
- A proxied service registered with `cache: false` is no longer cached.
