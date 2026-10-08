---
"@deltic/messaging": patch
---

`MessageRepositoryUsingPg.paginateIds()` stamped `stream_offset` from a column its query did not select, so every paginated message carried `stream_offset: undefined`. It now carries the offset the message was stored at, as every other read does.
