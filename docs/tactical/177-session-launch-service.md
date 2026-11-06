# Session launch service

Topic: core-service-api

Status: steps 1-4 landed 2026-11-06. Accepted by the maintainer as the top item
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

Landed 2026-11-06. `settleLaunch` in `routes/session-launch-results.ts`
reads a Supervisor start or resume result once for resume, restart handoff,
restart fork, the stale-session handoff, the fork-summary target and
`/clearloop`. A full queue is refused. A queued launch is either kept
(`whenQueued: "wait"`) or cancelled and refused with the caller's message
(`whenQueued: "cancel"`). `refusedLaunchResponse` answers a refusal with the
503 body each route already sent. `test/routes/session-launch-outcomes.test.ts`
pins every route's status, body, queue cancellation and usage records for a
full queue and a queued launch, and the usage records of a started restart,
stale-session handoff and resume. It passed against the old code before the
change.

The creation routes are not part of it. Durable creation acceptance answers
them with a 202 receipt before the launch settles, so they never read the
result. Launches outside the route layer each map the result to their own
shape: review delivery, native API commands, the Project Queue scheduler
(with its own copies of the two checks), wake delivery, and the debug start
route, which answers its own `queue_full` body. They can share the mapping
once step 5 moves it under `src/sessions/`.

Every difference between the copies was checked against its history:

| Difference | Finding | Resolution |
| --- | --- | --- |
| Restart (handoff and fork) and the fork-summary target cancel a queued launch; resume, the stale-session handoff and `/clearloop` keep it | Deliberate. Restart shuts the old process down only after its replacement is active (`274cc24a3`, `cad0679d7`), so it leaves the old process running rather than replace it later. Fork-summary cancelled a queued launch from the start, when it answered like restart (`80068d677`); since it became a background job (`5c14aaf16`), the job tracks the target's process so a cancel can stop it. A user's turn and a loop's send can wait for a worker, and the client tells the user a queued stale-session handoff will appear when it starts | `whenQueued: "cancel"` or `"wait"` |
| Each cancelling path names its own error | Deliberate: the message says what did not start | The caller's `notStartedError` |
| The restart fork's 503s also name the new session and project | Deliberate (`e86b1caa9`): the fork already exists when its resume is refused | Extra fields passed to `refusedLaunchResponse` |
| `/clearloop` and the fork-summary target throw instead of answering | They run outside the request, in the loop runner and a background job, which report the error | The same outcome; the caller throws it |
| Usage is recorded per route: resume the turn, the stale-session handoff the session and turn, restart and the fork-summary target the session | Deliberate (`18ae0a87f`): a record is written when the server accepts the action, so a full queue records nothing for resume, restart or the stale-session handoff; the fork-summary job counts its target when the fork is created (next row). Resume recorded the turn in two branches | Unchanged; resume now records it once |
| A refused restart fork leaves its fork uncounted, while the fork-summary job counts its target once the fork exists, even if its launch is then refused | Unclear: `18ae0a87f` counts fork-summary "once its fork exists" and restart only on success, and the restart fork's refusal began naming its kept fork later (`e86b1caa9`). It changes the per-user session count in Settings, so it goes to the maintainer | Unchanged; [a gap](../../gaps/refused-restart-fork-uncounted-in-usage.md) |

A queued stale-session handoff never gets its handoff title, because the
title is written only when the launch starts at once. That is recorded as
[a gap](../../gaps/stale-handoff-queued-launch-loses-title.md).

### 4 — one transcript-child creation flow

Fork, clone and the two helper forks share one sequence: claim a fork number
and title, call the Supervisor, release the claim on failure, record the
creator and usage, write the lineage metadata and emit
`session-metadata-changed`. Fold the sequence into one function and keep each
caller's title and error-response choices as parameters.

Landed 2026-11-06, as three shared pieces rather than one function. Mapping
the copies showed they agree on the pieces but not on the sequence: each
path writes in its own order (fork records its launch metadata before its
title, the helpers their title first, and the fork-summary target counts
usage before either), and each records a different subset. One function
would need a switch for every difference, so each path keeps its short
sequence and calls:

- `recordNewSessionMetadata` in `routes/session-launch-metadata.ts`: writes a
  new session's title and lineage and announces them with
  `session-metadata-changed`. Fork, restart fork, restart handoff, the
  stale-session handoff and the retitle and fork-summary helpers each wrote
  and announced by hand, or through a helper-only closure.
- `releaseFailedForkNumber`, beside it: a failed fork gives back the fork
  number it claimed for its title, unless it was kept without its settings.
  Fork, restart fork and the fork-summary target each wrote that rule.
- `recordCopyCreator` in the sessions route: a limited user's fork or clone
  is recorded as theirs, and counts as one session of their usage.

`test/routes/session-copy-records.test.ts` pins, per new session, the title
and lineage writes and announcements in order, a limited user's fork's
creator and usage records, and every fork-number claim and release,
including failed forks, forks kept without their settings and restart fork
and fork-summary targets whose launch is refused. It passed against the old code before
the change. The Supervisor's own recap generator fork is not a route path and
is unchanged.

Every difference between the copies was checked against its history:

| Difference | Finding | Resolution |
| --- | --- | --- |
| The order of the launch-metadata, creator, usage and title writes differs per path | Harmless: each write sets its own fields. Step 1's tests pin the order of the launch-metadata and title writes, and this step's tests pin fork's creator and usage records before its title | Each path keeps its order |
| Each path re-records a different subset after the copy exists: fork its title, `forkedFromSessionId` and lineage root; restart fork its title and root; the helpers their title, `archived` and `forkedFromSessionId`, and the fork-summary target also the root; clone its title, `forkedFromSessionId` and `/btw` link; the handoffs a title | Mostly the stored result already agrees: `SessionCreationStore.admit` records every transcript copy's title and `forkedFromSessionId`, a clone's `/btw` link to its source, and the helper generators' archiving before the copy exists (`1824356f0`, `e86b1caa9`), and the route writes repeat it. Only the lineage root, the handoffs' title, the fork-summary target's archiving (when made, on failure, and its later unarchiving, per [fork from turn](../../topics/fork-from-turn.md)) and a clone's `/btw` link to a parent other than its source are the route's alone | The caller's record; whether the routes should repeat admission's fields is step 5's one-owner decision |
| What each path announces: fork its title and `forkedFromSessionId`, restart fork only its title, clone nothing | Unclear: restart fork never re-recorded `forkedFromSessionId` (`cad0679d7`, `ea9c936df`), and clone predates the announcements (`bbaab48c3`; the `/btw` link `73e1ce003` added the parent fields to the event without emitting it from clone). No visible effect was found, since admission records those fields before a list can show the copy, but the client does read `forkedFromSessionId` from the event | Unchanged; raised with the maintainer with step 5 |
| Only fork and clone record a limited user as the creator | A leftover duplicate: fork and clone gained the write in `0d04f2211` (2026-09), and when admission took the creator over, `e86b1caa9` removed the start routes' write but left these two. Admission records the creator of every limited user's copy and stale-session handoff | Kept in `recordCopyCreator`; step 5's one-owner decision |
| Fork claims a number only when the source has a title, restart fork always, the fork-summary target only for a fallback title | Deliberate: an untitled fork has no number to show, restart always derives a title, and fork-summary does not spend a number its generated title will not use ([fork from turn](../../topics/fork-from-turn.md)) | Each caller decides when to claim; the release rule is shared |
| Fork takes its lineage root from the claim or `forkLineageRoot`, restart fork from the claim or the source id, fork-summary from `forkLineageRoot` | The same value: a claim's root is `forkLineageRoot` of the source, and restart claims whenever there is metadata to write | Unchanged |
| The helper closure announced even without a metadata service | Unreachable: both helper routes require one | The shared writer skips both |

### 5 — lift the service out of the route layer

Once steps 2-4 exist, move them and the step 1 writer behind a
`SessionLaunchService` under `packages/server/src/sessions/` that the routes
call with their already-parsed request. This is the seam the
[headless route host](../../topics/core-service-api.md#step-1--headless-route-host-d4)
needs. Decide here which owner writes each launch-metadata field. Today
`SessionCreationStore.admit`, the route, `Supervisor.forkSession` and
`SessionActivationCoordinator` write overlapping fields; leave one owner per field, and record the decision in the
core-service-api topic.

Steps 3 and 4 found these duplicates: admission records a transcript copy's
title and `forkedFromSessionId`, a clone's `/btw` link to its source, the
helper generators' archiving and a limited user as creator, which fork,
clone, restart fork and the helpers write again after the copy exists; and the Supervisor saves a project-write sandbox on start,
which the routes write again. The Supervisor's recap generator fork also
writes its own copy's title, archiving and launch metadata by hand.

## Not in scope

- Changing what any path inherits or persists. Known differences are
  recorded as gaps; aligning one is its own change.
- The Supervisor's internal start/resume/reactivate flow and queue admission.
  Plan 171 and the session-liveness topics own those.
- Routed-account inheritance for helper and successor launches, tracked in
  [routed auxiliary launch inheritance](../../gaps/routed-auxiliary-launch-inheritance.md).
