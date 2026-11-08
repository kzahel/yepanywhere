# Client console.warn budget exceeded by the review-session list

`pnpm console:scan` fails with `method.warn is 61, exceeding the limit of 60`
(`scripts/console-chatter-baseline.json`). The extra ungated site is the
`console.warn("[review-sessions] retained session list failed", cause)` added
to `packages/client/src/hooks/useProjectReviewSessions.ts` by 5e86a07b3
("Offer existing sessions promptly as review destinations").

Not fixed in place: it was noticed while landing unrelated settings work, and
the review-session hook is another lane's fresh code; whether the failure
belongs in `lib/diagnostics`, behind a developer flag, or justifies a baseline
raise is that owner's call (topics/console-chatter.md, "When a limit trips").

Cheap fix: route the failure through `lib/diagnostics` (or gate it on
`import.meta.env.DEV`) so the count returns to 60.

Found 2026-11-08 while landing connection-safe settings.
