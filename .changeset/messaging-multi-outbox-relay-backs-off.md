---
"@deltic/messaging": major
---

`MultiOutboxRelayRunner` retries an outbox whose batch failed instead of ending the run. The first retry waits `pollIntervalMs`, and the wait doubles with every failure in a row, up to `failureBackoffCeilingMs` (60 seconds by default). The other outboxes keep relaying in the meantime, and a notification does not cut the wait short. Only a failure marked unrecoverable (`isUnrecoverableError` from `@deltic/error-standard`) still ends the run and rejects `start()`. The new `onRelayFailure` option reports every failure that will be retried.

Ported from duna-application `81cbb66adf` ("Prevent eternally re-trying on a closed AMQP channel."), which gave its multi outbox relay the per-table backoff and ends the run only for an unrecoverable failure.
