# Project Queue launches drop the selected router pool and run on the direct login

A new-session Project Queue item never carries an Agent Auth Router pool,
account or policy, so it launches on the owner's direct provider login. With a
remembered pool restored on the New Session form, Queue accepts the item
without any notice while the form still shows the pool as selected. The
resulting session can spend a personal, rate-limited account the user meant to
keep out of the work.

Where:

- `packages/server/src/services/ProjectQueueService.ts` `normalizeTarget`
  keeps provider, mode, model, tier, executor, thinking and sandbox fields;
  `routerPoolId`, `routerAccountId`, `routerPolicy` and
  `routerClaudeAiConnectors` are never stored on `ProjectQueueTarget`.
- `packages/server/src/services/ProjectQueueScheduler.ts` `toModelSettings`
  passes none of them to `Supervisor.startSession`, which treats their absence
  as Direct.
- `packages/client/src/lib/newSessionStartDecisions.ts`
  `projectQueueRefusalBeforeDefer` refuses (`routerQueueUnsupported`) only when
  `routerSelectionCustomized`; `buildProjectQueueNewSessionTarget` documents
  that "a restored pool preference is ignored".

The session page composer's New session → Project Queue action has the same
server-side limitation and does not refuse for routed sessions; see
[composer-new-session-drops-source-sandbox-and-routing](composer-new-session-drops-source-sandbox-and-routing.md).

This was a deliberate interim choice in
[plan 147 § 6](../docs/tactical/147-router-pool-new-session-defaults.md)
("A restored pool must not make queueing fail") from when queue launches were
hard to route. The queue and launch paths have since been refactored, and the
choice was not revisited.

Fix: add router fields to `ProjectQueueTarget` (validated as in
`Supervisor`'s router checks), forward them from `toModelSettings`, send them
from `buildProjectQueueNewSessionTarget`, and remove the client refusal. Gate
the client on a server capability so an older server cannot silently drop the
fields. Apply the limited-user launch policy at enqueue and dispatch. A
dispatch-time router refusal (pool exhausted, login required, revoked grant)
must pause or retry the item, never fall back to Direct. Until then, a
restored pool should at least refuse or warn rather than queue silently.

Found 2026-11-08 while investigating a queued session that ran on the
maintainer's rate-limited personal Claude account despite a selected pool.
