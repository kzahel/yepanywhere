# Session launch service

Topic: core-service-api

Status: steps 1-4 and the first part of step 5 landed 2026-11-06, the
rest of step 5 on 2026-11-07, the sandbox record's single owner checked on
the Linux testbed. Accepted by the maintainer as the top item of the module-boundary
[priority queue](058-typescript-module-boundary-refactor.md#priority-queue).

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
| Clone | `cloneSession`, or `forkSession` for Codex | Supervisor `resolveForkLaunchSettings` (Claude); none (Codex) | route added a Codex sandbox until step 5 |
| Retitle helper | `reactivateSession` if cold, then `forkSession` | `sessions.ts`, inline | route |
| Fork-summary helper and target | `forkSession` twice, then `resumeSession` | `sessions.ts`, inline (a resume of the forked target) | route, three times |
| Recap revival | `reactivateSession` | `sessions.ts`, inline | Supervisor activation |
| `/clearloop` | `resumeSession` | `buildResumeLaunch` | Supervisor activation |
| Queued message launch | queue, later `startSession`/`resumeSession` | message route, inline | queue owner |
| Recovered-queue reactivation | `reactivateSession` | `session-recovered-queue.ts`, inline | Supervisor activation; route, the saved preferences only since step 5 |

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
fork-summary, restart fork, restart handoff and recovered-queue reactivation
(the last replaced in step 5 part 2 by full-app cases in
`test/routes/session-launch-records.test.ts`).
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

#### Part 1: one owner per field

Landed 2026-11-06. The routes no longer write again what creation
admission already saved. The decision is recorded in
[core service API](../../topics/core-service-api.md#session-launch-metadata-owners).

| Field | Owner | Paths |
| --- | --- | --- |
| Provider, requested model, launch settings | Admission; the Supervisor records the settings a process runs with | Every new session and copy |
| Prompt-suggestion and recap preferences | Admission | Every new session and copy |
| The same preferences as a started process resolved them | Route, after the launch starts | Restart fork and fork-summary target; the recap delay only for restart handoff |
| A copy's title (cleaned up as a title edit is) and source, a clone's `/btw` link to its source, an internal helper's archiving, a limited user as creator | Admission | Fork, clone, restart fork, retitle and fork-summary helpers |
| An internal helper's prompt-suggestion preference | Admission, which turns it off | Retitle and fork-summary generators |
| A handoff's title | Route | Restart handoff, stale-session handoff |
| Fork lineage root | Route | Fork, restart fork, fork-summary target |
| The fork-summary target's archiving (hidden until it starts, hidden again on failure) | Route | Fork-summary target |
| A `/btw` link to a parent other than the source | Route | Clone |
| Sandbox record | Admission, the Supervisor on start and the route (not yet decided) | Every path; see below |

`recordNewSessionMetadata` now takes the fields only the route knows and,
separately, the fields admission already saved, which it announces to open
session lists without writing them again. The fork, clone and helper routes
no longer write the provider, model, preferences, title, source or creator,
and `inheritedChildLaunchMetadata` and `recordCopyCreator` are gone; a
copy's usage record stays in the route.
`test/routes/session-launch-records.test.ts` runs fork, clone, restart
handoff, restart fork and the retitle and fork-summary helpers through the
full app with a real Claude transcript, and pins each new session's whole
stored record and the settings a later plain resume starts with, for a
source with and without saved preferences, and the stored titles of clones
and the helper generators' preferences. It passed against the old code
before the change.

Every difference found while removing the writes was checked:

| Difference | Finding | Resolution |
| --- | --- | --- |
| A restart fork's request can change its prompt-suggestion and recap preferences; admission records the source's | Route-only: the fork's creation never sees the request's preferences, and a resume does not save preferences | The route keeps recording the started process's preferences |
| A restart handoff, restart fork or fork-summary target whose source saved no preferences stores the defaults its process started with; a plain fork stores none | Deliberate: a started session records what it runs with, since prompt suggestions (`2169541e5`, 2026-06-16) and recap delays (`9682c7687`, 2026-06-24) became durable. A later resume starts with the same defaults either way. Admission already resolves a restart handoff's prompt-suggestion preference the same way, so only its recap delay is recorded again | Unchanged; the three paths keep it |
| The route's title write cleaned a copy's title up (one line, no control characters, none when blank); admission stored it as sent. A `/btw` question aside's title keeps the question's line breaks | User-visible if dropped | Admission now stores a copy's title cleaned the same way. A copy the route never finished, because it failed after admission or was recovered later, also keeps a cleaned title now, as do lists that show a copy before the route ran |
| An internal retitle or fork-summary generator stored the source's prompt-suggestion preference over admission's "off" | Accidental: admission turns internal helpers' prompt suggestions off (`e86b1caa9`, 2026-11-03), and the route's write predates it. Harmless: a summary is generated through the provider, not by resuming the helper, so the stored value matters only if someone opens an archived helper | Dropped in its own commit; the full-app test pins "off" for a source that shows them |
| A session without a sandbox stored its project path as a sandbox path through the route's explicit "none" record | Harmless: every reader uses that path only for a project-write sandbox, or falls back to the working project, which names the same directory | Dropped in its own commit in part 3; a path-scope case shows the working project alone gives the same scope |
| The route's sandbox record names the source's working project, while a copy's admission and the Supervisor's save name the directory the copy runs in | They differ when the project is opened through a symlinked path; sandboxing runs only on Linux | Part 3: the routes pass the working project to the copy, checked on the Linux testbed |
| The fork route computed the copy's model itself when the fork returned no launch settings | Unreachable: `forkSession` always returns them | Removed |

#### Part 2: the shared launch code moves below the routes

Landed 2026-11-07. The launch pieces the routes share now live under
`packages/server/src/sessions/`, where a headless host or script can call
them without the REST layer:

| Module | What it owns |
| --- | --- |
| `session-launch-settings.ts` | The resume and successor launch settings (`createSessionLaunchSettings`), and `parseOptionalExecutor`, the one rule for what executor a launch may name, which checks a saved executor as well as a request's |
| `session-launch-outcome.ts` | `settleLaunch` and the queued and queue-full checks every launcher reads a Supervisor result with |
| `session-launch-metadata.ts` | The launch-metadata and new-session writers |
| `session-sandbox-inheritance.ts` | What a launch inherits from a saved sandbox: the firewall, a successor's project-write settings, the directory it runs in |
| `session-compact-thresholds.ts` | The compact settings each launch adds |
| `session-successor-titles.ts` | The title rules of a session made from another one: which source titles are kept, a fork's numbered prefix, a generated summary's or retitle's title (SRR-026) |

What stays in the routes is what reads a request or answers one:
`refusedLaunchResponse` (now `routes/session-launch-refusal.ts`), the
sandbox-level request parser and the request-body parsers. The restart
request's parser joined the other launch request parsers in
`routes/session-launch-request.ts`.

They stay plain modules rather than one `SessionLaunchService` class. Each
piece is stateless and already takes the few services it reads, and the
routes call different subsets of them, so a class would bundle unrelated
dependencies without removing any code. A headless host builds the
settings closures once from its own services, as the sessions route does.

Launchers outside the routes do not use `settleLaunch` itself. Review
delivery, native API commands, wake delivery and the debug start route
each turn the three outcomes straight into their own answer in a few lines,
and none cancels a queued launch; the debug route also answers the raw
`queue_full` error. Mapping through `settleLaunch` first would add a step
without removing a decision. The Project Queue scheduler had its own copies
of the queued and queue-full checks, and now uses the shared ones.

Recovered-queue reactivation no longer records the provider, executor or
requested model in the route. Step 1 assumed a reactivation saves only the
settings its request names, but without explicit overrides the Supervisor
treats every setting it was given as requested: it saves the provider,
executor, recap delay and prompt-suggestion preference of the process it
started, and its launch settings record carries the requested model, which
it also mirrors into the legacy requested-model field. The route still
writes the session's saved preferences back afterwards: the process's
prompt-suggestion preference is resolved, so a saved "native" becomes "off"
on a provider without native suggestions, and the session keeps the saved
one, as a plain reactivation does.
`test/routes/session-launch-records.test.ts` pins the stored record and a
later resume for a queued turn that names a model, one on the default
model, and a session with no saved provider or preferences, and the
stored preference of a saved "native" on a provider without native
suggestions. Its snapshots were captured on the old code. No caller passes
a provider, executor or requested model to `persistLaunchMetadata` any
more, so those fields are gone.

#### Part 3: one owner for a copy's sandbox record

Landed 2026-11-07 as SRR-025 in the
[sessions route ledger](053-sessions-route-refactor-ledger.md). Fork, the
retitle and fork-summary helpers and a sandboxed source's Codex clone pass
the source's working project to `forkSession` as `workingProjectId`, which
creation admission and the Supervisor's sandbox save record, and the
routes' sandbox writes are removed. The restarts, the Claude clone and the
fork-summary continuation already recorded what the Supervisor saves. The
Supervisor still records a copy's transcript project when the transcript
lies outside the folder the copy runs in, so a fork of a symlinked source
keeps it.

A Linux-only full-app test,
`test/routes/session-launch-records-sandboxed.test.ts`, starts a real
sandboxed session in a symlinked folder and pins what each copy stores, the
project list that shows it and where a later resume runs. It was captured
on the old code on the Linux testbed reached through Machine Control and
passes unchanged. For an unsandboxed source the routes' record only added
a sandbox folder equal to the project; that difference is dropped in its
own commit, as part 1's table records.

The same cases show that a resume, a clone, a restart and a fork-summary
continuation of such a source record the folder's real path as the working
project, so those sessions leave the list of the project the user opened.
That is left as it was and recorded in
[gaps/symlinked-sandboxed-session-leaves-its-project-list.md](../../gaps/symlinked-sandboxed-session-leaves-its-project-list.md).

## Not in scope

- Changing what any path inherits or persists. Known differences are
  recorded as gaps; aligning one is its own change.
- The Supervisor's internal start/resume/reactivate flow and queue admission.
  Plan 171 and the session-liveness topics own those.
- Routed-account inheritance for helper and successor launches, tracked in
  [routed auxiliary launch inheritance](../../gaps/routed-auxiliary-launch-inheritance.md).
