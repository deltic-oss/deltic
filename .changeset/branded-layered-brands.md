---
"@deltic/branded": patch
---

Let a brand be layered onto an already branded type. `Branded<UserId, 'Verified'>` collapsed to `never`, because both brands wrote the same property; each brand now adds a property of its own, so a layered type keeps both brands and stays out of unrelated ones.
