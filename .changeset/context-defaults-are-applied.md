---
"@deltic/context": patch
---

Apply the defaults passed to the `Context` constructor.

The third constructor argument, `defaults`, was accepted, stored and never read: every value
declared that way was silently dropped, so `get()` returned `undefined` and the key was absent from
`context()` — which also meant `ContextMessageDecorator` omitted headers it was configured to
forward. The defaults now seed each scope.

Precedence: values provided to `run()` win, and so do values inherited from a surrounding scope, so
a nested run keeps what its parent decided on instead of falling back to the default. That mirrors
how slot defaults behave in `composeContextSlots`. Because `defaults` is a fixed object shared by
every scope, context slots remain the mechanism for defaults that must be created per scope
(`defaultValue: () => createTx()`).

This changes behaviour only for code whose defaults were being ignored, which is code that was
already not getting what it asked for. The argument is now documented in the README.
