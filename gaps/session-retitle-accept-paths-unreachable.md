# The session title editor's retitle review paths cannot be reached

`useSessionTitleEditing` (moved from `SessionPage.tsx` by plan 181 slice 3)
supports a retitle mode in which a generated suggestion is shown "ready"
and the user accepts it with Enter or the Accept button, keeping any text
around the caret (`captureGeneratedRetitleInsertion`, the ready branch of
`handleAcceptGeneratedRetitle`, the `deferredInsertion` stored while a
suggestion is still generating). But `handleStartRetitleTitle` is only
ever called by `handleGenerateAndApplyTitle`, which passes
`applyWhenReady: true`. That mode disables the field and the Accept button
while generating and saves the suggestion as soon as it arrives, so the
"ready" state, accepting a ready suggestion and the caret insertion cannot
be reached from the UI and have no test.

One retitle path is reachable: when the proposal fails, the field becomes
editable in retitle mode. Ctrl+Enter then saves the typed title, but plain
Enter silently does nothing (the accept handler finds no suggestion). The
pins in `e2e/session-page-title-attachment-paths.spec.ts` record both.

Either restore an entry point that opens the editor with a suggestion to
review (if the feature is wanted), or remove the unreachable branches and
their markup and make Enter save after a failed proposal. Not done in plan
181, which moves code without changing it.

Found 2026-11-08 while pinning the session page before plan 181.
