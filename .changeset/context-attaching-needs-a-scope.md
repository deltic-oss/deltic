---
"@deltic/context": patch
---

Refuse to attach context values when there is no scope to attach them to.

`Context.attach` wrote into whatever `context()` returned, and outside a `run()` scope that is a
fresh throwaway `{}` — the values were filled into an object that was discarded the moment the call
returned. Nothing was stored and nothing was reported. `ValueReadWriterUsingContext.use()` and
`.forget()` reach the same path, so a tenant scoped outside a scope became a no-op that surfaced
later as `UnableToResolveValue` — an error that blames the caller for forgetting to set a value
that was, in fact, set.

`attach` now throws `UnableToAttachContext` (`context.no_active_scope`) when the store has no active
scope. There is no honest alternative for `AsyncLocalStorage`: there is no store to write into and
no way to create one the surrounding flow would observe.

Reading outside a scope is unchanged and still legal — `context()` answers `{}`, `get()` answers
`undefined`, `mustResolve()` throws `UnableToResolveValue`. Only the write path fails.
`composeContextSlotsForTesting` is unaffected, since its store always holds an object; it remains
the way to prepare context without entering a scope.

Code that attaches outside a scope and never reads the value back will now throw where it used to
appear to work. That code was already not doing what it looked like it was doing.
