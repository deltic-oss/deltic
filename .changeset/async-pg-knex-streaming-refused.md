---
"@deltic/async-pg-knex": patch
---

`stream()` and `pipe()` on a lazy query were buffered like builder methods, so no query ran, an export completed empty, and awaiting the result left an unhandled rejection; `asCallback()` never called back. Streaming from a lazy connection now throws the new `KnexStreamingNotSupported` (stream from a transaction or a claimed connection instead), and `asCallback()` runs the query and reports to the callback.
