# Keys typed while a session loads appear only when its transcript arrives

Arriving at a session from the bang-history page with `composerPrefill`
or `focusComposer` (navigation state) starts the early-typing hold, so keys
struck before the composer exists land in the draft in order. But the
composer is already visible while the session read is still pending, and
the held keys appear only when the transcript loads. No key is lost, but
AGENTS.md asks that each keystroke appear within 100 ms. How long the wait
is depends on how long the session read takes; the pins hold the read
until their typing ends, so their timings are not a real-world figure.

The hold is released by the navigation-action effect in
`packages/client/src/hooks/useSessionTranscriptJumps.ts` (moved from
`SessionPage.tsx` by plan 181 slice 5), which is gated on `!loading`. Its
comment says the gate makes sure the jump target row and the footer
composer are mounted; the composer, at least, is mounted earlier. The
composer-ready handler's `flushEarlyComposerTyping` call does not help,
because it does nothing until that effect sets
`pendingEarlyComposerPrefillRef`.

Fix: handle prefill and focus outside the loading gate (with their own
consumed-navigation marker and history clear), when the composer's draft
controls are ready, and keep only the scroll action gated on loading.

`e2e/session-page-navigation-paths.spec.ts` pins today's behavior: it
bounds the delay from the transcript load, not from the composer
appearing. A fix should tighten that bound to the composer appearing.

Found 2026-11-08 while pinning the session page before plan 181.
