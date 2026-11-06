# Session launch service

Topic: core-service-api

Status: steps 1 and 2 landed 2026-11-06. Accepted by the maintainer as the top item
of the module-boundary [priority queue](058-typescript-module-boundary-refactor.md#priority-queue).

Starting a session is one operation that today has about a dozen hand-written
copies. New sessions, resume, reactivate, restart (handoff and fork), the
stale-session handoff, fork, clone, the retitle and fork-summary helpers,
recap revival, `/clearloop`, queued-message launches and recovered-queue
reactivation each assemble the same launch settings, call the Supervisor, map
its queued or queue-full outcome, and record the new session's launch
metadata. They do it in slightly different ways. This plan folds those copies
into one launch service the routes call. It is also the first concrete step of
the [core service API](../../topics/core-service-api.md): a headless host or
script needs "launch a session" as one call, not as a REST handler body.

This is not a move-only refactor. Each step replaces several copies with one
implementation, so it sits outside the
[module-boundary contract](../../topics/typescript-module-boundary-refactor.md)'s
move-only rule and follows these rules instead:

- Every step is behavior-preserving and lands on its own.
- Before a step changes code, tests pin what each affected path does today,
  at the route level where the existing coverage is thin.
- Where copies already disagree, the step keeps each path's current behavior
  and records the disagreement as a gap, such as
  [clone working directory](../../gaps/clone-working-directory-ignores-sandbox-level.md).
  Aligning them is separate, named work with its own tests.
- Response shapes, provider selection, YA session ids, executor and sandbox
  persistence, queue-full and queued behavior, and durable creation recovery
  do not change.

## Launch paths today

| Path | Supervisor entry | Settings assembled by | Launch metadata written by |
| --- | --- | --- | --- |
| New session (project or detached) | `startSession` | `session-creation-routes.ts`, inline | creation admission and Supervisor |
| Resume | `resumeSession` | `buildResumeLaunch` | Supervisor activation |
| Reactivate | `reactivateSession` | `session-resume-routes.ts`, inline | `SessionActivationCoordinator` overrides |
| Restart handoff | `startSession` | `buildSuccessorLaunch` | route |
| Restart fork | `forkSession`, then `resumeSession` | `buildSuccessorLaunch` | route |
| Stale-session handoff | `startSession` | `buildSuccessorLaunch` | route, title only |
| Fork | `forkSession` | none (cold child) | route |
| Clone | `cloneSession`, or `forkSession` for Codex | Supervisor `resolveForkLaunchSettings` (Claude); none (Codex) | route adds a Codex sandbox |
| Retitle helper | `reactivateSession` if cold, then `forkSession` | `sessions.ts`, inline | route |
| Fork-summary helper and target | `forkSession` twice, then `resumeSession` | `sessions.ts`, inline (a resume of the forked target) | route, three times |
| Recap revival | `reactivateSession` | `sessions.ts`, inline | Supervisor activation |
| `/clearloop` | `resumeSession` | `buildResumeLaunch` | Supervisor activation |
| Queued message launch | queue, later `startSession`/`resumeSession` | message route, inline | queue owner |
| Recovered-queue reactivation | `reactivateSession` | `session-recovered-queue.ts`, inline | route |

Before any of these writers, `SessionCreationStore.admit` records the
provider, requested model, prompt-suggestion and recap preferences, and
sandbox of every durable new session and transcript copy. The last column
lists who writes after that; several paths write the same fields again.

The shared ingredients are the global instructions, the compact-threshold
settings, the sandbox fields, the inherited prompt-suggestion and recap
preferences, the successor model/thinking/effort/permission inheritance
(`inheritSuccessorLaunchSettings`), and the working directory of a
project-write sandboxed source.

## Steps

### 1 — one launch-metadata writer and one sandbox working-directory rule

Landed 2026-11-06. `routes/session-launch-metadata.ts` now owns:

- `persistLaunchMetadata(service, sessionId, record)`, the writer every route
  that records launch metadata itself uses, taking a named record instead of
  eight positional arguments. Its unused initial-prompt argument is gone; no
  caller passed one. The executor field stays for now even though
  `parseOptionalExecutor` always yields no executor; it goes when the
  leftover SSH-executor plumbing is removed.
- `inheritedChildLaunchMetadata` and `inheritedSandboxRecord`, the metadata a
  cold transcript child inherits from its source. Fork, the retitle helper,
  and the fork-summary helper and target each built it by hand. The Codex
  clone's sandbox record uses the same builder.

`sandboxWorkingProjectPath` in `routes/session-sandbox-settings.ts`, beside
the other sandbox inheritance rules, replaces the eight copies of the
project-write working-directory rule in `sessions.ts`.

The recovered-queue module calls the writer directly instead of receiving it
as a dependency. `test/routes/session-successor-launch-metadata.test.ts`
records every metadata write, in order, for fork (sandboxed and not), retitle,
fork-summary, restart fork, restart handoff and recovered-queue reactivation.
It passes against both the old and the new code. The Codex clone's sandbox
record is covered by `test/routes/sessions-clone-codex.test.ts`, except for
the working-project precedence.

### 2 — one successor launch-settings assembly

Landed 2026-11-06. `buildSuccessorLaunch` in `routes/session-launch-settings.ts`,
beside the resume assembly `buildResumeLaunch`, builds the Supervisor
`ModelSettings` of a successor session: restart handoff, restart fork and the
stale-session handoff. It applies the request's choices over the source's
inherited model, thinking, effort, service tier and permission mode
(`inheritSuccessorLaunchSettings`), adds the global instructions, the
source's recap delay and prompt-suggestion preference unless the request
overrides them, the sandbox fields, and the compact settings, and returns the
inherited values the restart fork also needs for its `forkSession` call.
`test/routes/session-successor-launch-settings.test.ts` pins the exact
settings and permission mode each path passes. It passed against the old
code before the change.

The fork-summary target is not part of it. It resumes a child whose launch
settings `forkSession` already recorded, so the Supervisor fills its thinking,
effort, service tier and permission mode from that record, as on any resume.

Every difference between the three copies was checked against its history:

| Difference | Finding | Resolution |
| --- | --- | --- |
| Restart listed the request's model ahead of the resolved model as a compact-window fallback | Redundant: the launch `model` equals the request's model whenever it names one, and the window lookup skips `default` and empty ids | Dropped; no behavior change |
| A cross-provider restart drops the source's models from the compact-window fallbacks | Deliberate: provider-local settings since `cfe0ecc62` (2026-08) | The shared rule |
| The stale-session handoff keeps the source's transcript model as a fallback across providers, and skips the live process's resolved model | Accidental: added in `6acb17549` (2026-09) without the provider-local rule, which [restart handoff template](../../topics/restart-handoff-template.md#launch-settings-inheritance) states for every cross-provider handoff | Fixed in its own commit after the refactor: the stale-session handoff now follows the restart rule |
| Only the restart handoff names the client `yep-anywhere` | Deliberate (`ef3c2470c`); the name equals the Codex default, so it has no effect today | Kept at the handoff call site |
| Only the stale-session handoff passes `instructionUsername` | Deliberate: limited users can reach it but cannot restart ([limited users](../../topics/limited-users.md)) | Named option |
| The restart fork adds its own sandbox state | Deliberate: the fork copied the source's sandbox state | Added by the caller |
| The stale-session handoff passes no permission rules, recap mode, helper model or service-tier override | Its request names none; the limited-user lock supplies what it fixes | Absent inputs to the same assembly |

The settings are now built once, before the handoff text or the fork is
created, instead of at the Supervisor call. The global instructions and
compact settings are read a moment earlier as a result.

The compact-window fallback models are unreachable in practice: a stored
compact percent needs a named model, that model is always the first
candidate, and the window lookup falls back to a heuristic that is never
zero. That is recorded as
[a gap](../../gaps/compact-window-fallback-models-unreachable.md) covering
every launch path's fallback list.

### 3 — one launch-outcome mapping

Map a Supervisor launch result (started, queued, queue full) to the route
response in one place. Today restart, the stale-session handoff, fork-summary,
`/clearloop` and the creation routes each do this differently: some cancel a
queued request, some return 202, and the error bodies differ. Pin each
current response before replacing them. The differences are deliberate per
route, so the shared mapping takes them as options.

### 4 — one transcript-child creation flow

Fork, clone and the two helper forks share one sequence: claim a fork number
and title, call the Supervisor, release the claim on failure, record the
creator and usage, write the lineage metadata and emit
`session-metadata-changed`. Fold the sequence into one function and keep each
caller's title and error-response choices as parameters.

### 5 — lift the service out of the route layer

Once steps 2-4 exist, move them and the step 1 writer behind a
`SessionLaunchService` under `packages/server/src/sessions/` that the routes
call with their already-parsed request. This is the seam the
[headless route host](../../topics/core-service-api.md#step-1--headless-route-host-d4)
needs. Decide here which owner writes each launch-metadata field. Today
`SessionCreationStore.admit`, the route, `Supervisor.forkSession` and
`SessionActivationCoordinator` write overlapping fields; leave one owner per field, and record the decision in the
core-service-api topic.

## Not in scope

- Changing what any path inherits or persists. Known differences are
  recorded as gaps; aligning one is its own change.
- The Supervisor's internal start/resume/reactivate flow and queue admission.
  Plan 171 and the session-liveness topics own those.
- Routed-account inheritance for helper and successor launches, tracked in
  [routed auxiliary launch inheritance](../../gaps/routed-auxiliary-launch-inheritance.md).
