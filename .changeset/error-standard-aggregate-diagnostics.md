---
"@deltic/error-standard": patch
---

Report what an AggregateError aggregates, instead of its empty message.

`errorToMessage` returned `error.message` for every `Error`, and an `AggregateError`'s message is
empty by default — its diagnostics live in `errors`. Node reports a refused connection on a
dual-stack host exactly that way, so the most common infrastructure failure was logged as nothing
at all: `Unable to establish AMQP connection "main": `.

`errorToMessage` now describes the aggregated failures, joined with `; `. The first three are
described and the rest are counted (`and 47 more`), so an aggregate over a large fan-out cannot
amplify one log line into thousands of joined messages, and nesting is depth-limited so a cyclic
aggregate cannot recurse for ever. An `Error` whose message is empty now reports its `name`, plus
its `code` when it carries one (`Error (ECONNREFUSED)`), instead of an empty string.
