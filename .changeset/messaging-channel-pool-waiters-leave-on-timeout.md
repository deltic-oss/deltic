---
"@deltic/messaging": patch
---

A caller that timed out waiting on a full `AMQPChannelPool` stayed in the queue of waiters, so the
next released channel woke that departed caller and the callers still waiting timed out with
`ChannelPoolExhausted` while a channel sat idle in the pool. A caller now leaves the queue when it
stops waiting, and a released channel goes to the next caller still waiting.
