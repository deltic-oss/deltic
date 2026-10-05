---
"@deltic/error-standard": patch
---

`errorToMessage` threw for a value that cannot be converted to a string, such as an object without a prototype or one whose `toString` throws, so the failure being wrapped was lost. Such a value is now reported as `[unprintable object]`; every other value is reported as before.
