# New Session start, Project Queue and template launches differ in ways a user can see

Plan 180 split `NewSessionForm.tsx` without changing behavior, so these
differences between its three launch paths stayed as they were. The
maintainer had no opinion on them (2026-11-08), so they wait here as
possible follow-ups rather than plan 180's slice 6. Each is small; the
plan's "Decisions for the maintainer" section has the evidence.

- **Turn-effort commands in Project Queue** (plan N4, Q1). Starting turns
  `/fast …` into `{ deliveryIntent: "direct", turnEffort }` metadata or
  refuses it; Project Queue from New Session queues the command as literal
  prompt text (`queueNewSessionForProject` in
  `packages/client/src/lib/newSessionStart.ts`). The server already carries
  queued message metadata to the first turn, and the session composer's
  Project Queue already sends `deliveryIntent: "deferred"` with the effort
  (`lib/sessionComposerSendDecisions.ts`). Cheap fix: plan the command in
  `planNewSessionProjectQueue` the same way, with start's refusals.
- **Composer history** (N5, Q2). A started prompt is saved to New Session's
  prompt history (`rememberComposerPrompt`); a queued one is not.
- **Template launch settings** (N9, Q3). `TemplateProjectForm`'s
  `sessionSettings` (in `NewSessionForm.tsx`) send raw thinking and effort
  even under a restored pool, omit the tier and the lock overrides, and send
  sandbox fields to servers without sandboxing (and the firewall when the
  level is `none`). Cheap fix: reuse `buildProjectQueueNewSessionTarget`'s
  direct-catalog resolution and start's sandbox field rule; machine control
  stays out, as for Queue.

Two related remainders, larger than the above:

- **Queued sessions lose recap, suggestion and helper settings** (N2). The
  Project Queue new-session target type
  (`packages/shared/src/project-queue.ts`) and the scheduler have no fields
  for them, so a queued session starts with defaults.
- **A start can stay "starting"** (N8). When the form's source or account
  changes before durable acceptance, `startNewSession` returns without
  clearing `isStarting`/`acceptingText`, so the form shows "starting"
  until it remounts.

Found 2026-11-07 while splitting the New Session form (plan 180).
