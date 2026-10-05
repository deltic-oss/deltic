---
"@deltic/process-queue": patch
---

Route negative and fractional partition keys in `PartitionedProcessQueue`. `push()` threw a `TypeError` synchronously for a key such as a signed hash that happened to be negative, because `%` keeps the sign of the key; such keys are now mapped onto the partitions, and non-negative whole keys keep the partition they always had.
