---
"@deltic/async-pg-pool": patch
---

The README's introduction and "How It Works" promised `AsyncLocalStorage` scoping by default, and the constructor reference left out the `context` parameter, while the default context is one process-wide scope for a single flow. The README now says everywhere that scoping follows the context the pool is given; no code changed.
