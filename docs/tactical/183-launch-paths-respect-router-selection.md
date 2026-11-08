# Launch paths respect the router selection

Topic: agent-auth-router

Status: implemented 2026-11-08. Switching an existing session's account
followed in [plan 185](185-switch-session-router-account.md).

## Goal

Every launch path either runs on the pool or account the user selected, or
refuses visibly. None may silently launch on the owner's direct login. This
replaces [plan 147 § 6](147-router-pool-new-session-defaults.md)'s interim
choice ("a restored pool must not make queueing fail", implemented by
ignoring it).

Invariant for the owning topic: a launch whose selection, saved default or
source session names a router pool or account produces a routed session or a
visible refusal. Direct is chosen only explicitly.

## Current state

- `Supervisor.startSession` already allocates a pin from `routerPoolId`,
  `routerAccountId`, `routerPolicy` and `routerClaudeAiConnectors`, and fails
  closed on router refusal. Resumes reuse the stored `routerBinding`, so
  existing-session queue items are already routed. The gaps are all in
  callers that never pass those fields.
- Gaps covered (deleted as fixed): project-queue-drops-router-pool,
  composer-new-session-drops-source-sandbox-and-routing, template launch (N9
  in [new-session-start-and-queue-differences](../../gaps/new-session-start-and-queue-differences.md)),
  agent-api-create-session-ignores-caller-router-binding, and the router,
  sandbox, tier, instructions and compaction parts of
  [source-review-launch-drops-session-settings](../../gaps/source-review-launch-drops-session-settings.md).

## Steps

### 1 — Project Queue carries the router selection

Server:

- Add optional `routerPoolId`, `routerAccountId`, `routerPolicy` and
  `routerClaudeAiConnectors` to the new-session `ProjectQueueTarget`
  (`packages/shared/src/project-queue.ts`), validated in
  `ProjectQueueService.normalizeTarget` with the same shape rules as
  `Supervisor`'s router checks (policy only with a pool; connectors only with
  a pool or account and only for Claude).
- Apply the limited-user launch policy at enqueue (`limitedLaunchPolicy`
  already refuses router fields for limited users) and again at dispatch.
- Forward the fields in `ProjectQueueScheduler.toModelSettings` for
  new-session items only. Existing-session items keep refusing router fields;
  their session's pin applies.
- Allocate at dispatch, not enqueue: a pool picks its account when the item
  runs, so quota at that moment decides.
- Router refusal at dispatch (no usable pool account, login required, revoked
  grant, router offline) uses the existing retryable startup-failure path:
  retry with backoff, then pause the item with the router's message. Never
  re-dispatch without the router fields.
- Advertise a new capability bit (for example
  `projectQueueRouterSelection`) and record it in
  `scripts/capability-releases.json`.

Client:

- `buildProjectQueueNewSessionTarget` sends the pool/account/policy/connectors
  and resolves model, thinking and tier against the routed catalog (as direct
  start does) when a pool is selected, restored or explicit.
- With the capability: remove the `routerQueueUnsupported` refusal.
- Without it (older server): refuse Queue whenever a pool is shown, restored
  or customized, with the existing toast. This alone fixes the silent case on
  old servers.
- Project Queue item rows show the pool/account the item will use.

Tests: a server test that a queued pool item dispatches with the router fields
and a stored binding, and that a router refusal pauses rather than launches
direct (reuse the router fixtures in `packages/server/test/agent-auth-router.test.ts`);
client decision tests in `newSessionStartDecisions.test.ts`; update the
`routerQueueUnsupported` cases in `NewSessionForm.test.tsx` and
`newSessionStartDecisions.test.ts`.

### 2 — composer New session inherits the source session's routing and sandbox

`lib/sessionComposerSend.ts` builds start-now and Queue new-session requests
from mode, model, thinking, provider and executor only.

- Routing: when the source session has a `routerBinding`, send its pool and
  policy if it came from a pool, else its account (see decision 1). Queue
  uses step 1's fields. Without the capability, refuse for routed sources the
  way restart and fork already do.
- Sandbox: send the source session's `sandboxLevel` and
  `sandboxNetworkFirewall`, and its service tier. This is the security half of
  the same gap and touches the same builders; land it as its own commit.

### 3 — templates send the router selection

`NewSessionForm.tsx`'s template `sessionSettings` add the router fields and the
routed model; `routes/project-templates.ts` already forwards them to session
creation. Folds into the N9 fix.

### 4 — Agent API and Source Review inherit or refuse for routed callers

- Agent API `createSession` from a routed session: the caller's selection per
  decision 1, with the caller's model when the request names none. Another
  provider is refused with a message. Never Direct.
- Source Review new session: the client sends the opening session's id
  (`newSession.sourceSessionId`); the server applies decision 1 and the
  opening session's sandbox and tier, plus global instructions and compact
  settings (decision 3).

### 5 — contracts and retirement

Update `topics/agent-auth-router.md` (supported slice: queue, composer,
template, API and review launches) and `topics/project-queue.md` (router
fields, dispatch-time allocation, pause on refusal). Mark plan 147 § 6
resolved. Delete each gap in the commit that fixes it.

## Decisions (maintainer, 2026-11-08)

1. A new session derived from a routed session (composer New session, Agent
   API createSession, Source Review) gets a fresh policy pick from the source
   binding's pool, with the source's policy, when the binding came from a
   pool; when the source was pinned to an explicit account, it gets that
   account through a new pin. It never shares the source's allocation or token.
   Forks and clones keep the existing same-account inheritance, since a copied
   transcript may be tied to its account.
2. A queued pool item whose pool has no usable account at dispatch retries,
   then pauses, like other startup failures.
3. All steps are in scope now. Source Review also carries the source
   session's sandbox level/firewall and service tier, and receives global
   instructions and compact settings as ordinary creation does.

## As implemented

- The composer's New session needed the source session's YA sandbox, which
  the client could not see: session payloads now carry `sandboxLevel` and
  `sandboxNetworkFirewall`. The sandbox follows the new session even to
  another provider that can run sandboxed, and is refused for one that
  cannot; router selection and tier apply only on the same provider.
  Routing and sandbox landed together, since one builder carries both.
- A pool refusal cancels the fresh allocation, which made every retry of the
  same admitted creation fail with "this failed launch was cancelled". AAR
  allocations refused before commit are now marked so a retried creation that
  names its selection again allocates afresh.
- Template preparation also sends the routed tier; its other N9 differences
  (sandbox field rule, lock overrides) remain in
  [the gap](../../gaps/new-session-start-and-queue-differences.md).

## Out of scope

Switching a session's account, automatic failover, and the non-router drops
(compact/helper settings, resume provider fallback, permission rules), which
stay in their gaps.
