---
"@deltic/event-sourcing": patch
---

The README now gives the PostgreSQL events table, with a plain index over aggregate root id and version, and says what two concurrent writers to one aggregate do: both events are kept, at the same version.
