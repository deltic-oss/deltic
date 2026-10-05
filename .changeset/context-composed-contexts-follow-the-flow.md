---
"@deltic/context": patch
---

`composeContextSlots(slots)` without a store kept one context for the whole process, so flows that overlapped, such as two concurrent requests, read and overwrote each other's values, and a context outlived them both. Without a store, a composed context is now backed by an `AsyncLocalStorage` of its own; pass a `ContextStoreUsingMemory` to keep the old behaviour.
