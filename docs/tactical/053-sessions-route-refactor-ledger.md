# Sessions Route Refactor Ledger

Status: Dormant again, 2026-11-06: the maintainer revived the session-detail
read routes (doc 058 row 1.2) and they landed as SRR-014, which moved the
helpers those routes share with the rest of the file, and SRR-015, which moved
the routes. SRR-016 then moved the session project-routing closures those
routes receive out of the route factory. The maintainer then revived the
start/resume/reactivate routes (doc 058 row 1.3): SRR-017 moved the helpers
and closures they share with the rest of the file, and SRR-018 moved the
routes themselves into their own registrars. SRR-019 then folded the
successor routes' copied launch-metadata writes into one module as step 1 of
[plan 177](177-session-launch-service.md), which owns the session-launch
consolidation from here, SRR-020 gave the successor launches one
settings assembly as step 2, SRR-021 gave every route one reading of a
launch's started, queued or queue-full result as step 3, and SRR-022 gave
the routes that make a session from another one writer for its title and
lineage as step 4. SRR-023 then stopped those routes writing again what
creation admission already saved, as the first part of step 5. SRR-013
landed the
metadata/seen-state registrar (row 1.6) earlier the same day. SRR-012 landed
2026-10-27 as `06cff21d6` under
[plan 163](163-http-independent-restart-compaction.md); its separate
observer cleanup does not extend the move slice. The other route-registrar
extractions (doc 058 rows 1.4-1.5) remain deferred; revive each as its own
SRR item.

See also: `topics/core-service-api.md` — the sessions REST surface this
ledger refactors is the surface that topic proposes exposing as an
embeddable core API, so ownership-boundary moves here shape that
extraction.

See also: `topics/typescript-module-boundary-refactor.md` and
`docs/tactical/058-typescript-module-boundary-refactor.md` — the repo-wide
module-boundary campaign. This ledger owns the limited SRR-012 to SRR-024
revivals and future
`packages/server/src/routes/sessions.ts` refactors. Campaign slices touching
that file should reopen or supersede this ledger deliberately, be tracked here
as SRR items, and carry both topic trailers.

Scope: this document applies only to the server route file
`packages/server/src/routes/sessions.ts` and the narrow `routes/session-*.ts`
helpers split out of it. It does not gate client session work such as
`SessionPage.tsx`, `useSession.ts`, session-detail selectors, provider adapter
splits, or test-fixture organization in doc 058.

Sequencing: this ledger was the campaign's starting point and stayed active
for the helper-sized `sessions.ts` splits. On 2026-07-06 the remaining
route-registrar `sessions.ts` extractions were deferred so the broader
module-boundary campaign could move to more valuable/easier slices in doc 058.

Dormant-state criterion: when every SRR item is done, deferred, or dropped and
no active 058 Phase 1 slice touching `sessions.ts` remains, leave this ledger
in the dormant state. Doc 058 is the campaign worklog for all non-`sessions.ts`
slices; Phases 2-6 do not involve this document.

Pivot note, 2026-07-06: SRR-003 remains deferred, all other SRR items are
done, and doc 058 rows 1.2-1.6 are deferred for now (row 1.6 later landed
as SRR-013 on 2026-11-06, and rows 1.2 and 1.3 were revived the same day
as SRR-014/SRR-015 and SRR-017/SRR-018). Future `sessions.ts`
route-registrar extraction should reopen or supersede this ledger deliberately
rather than assuming the old narrow lane is still active.

## Purpose

`sessions.ts` is one of the largest maintained source files in the repo. It is
also load-bearing: it bridges persisted provider transcripts, live Supervisor
processes, metadata, notifications, recovered queues, restart/fork workflows,
and client-facing REST responses.

This ledger tracks simple refactors that can reduce file size or duplication
without changing the session API contract. Each item should be explicitly
accepted, deferred, or dropped before implementation.

Line deltas below are rough `sessions.ts` deltas. New-file extractions usually
add a similar number of lines elsewhere; the goal is smaller ownership
boundaries, not necessarily fewer total repository lines.

## Guardrails

- Prefer behavior-preserving extraction over redesign.
- Keep each implementation small enough to review in one pass.
- Do not create generic "helpers" buckets. A new file should have a narrow
  domain name and ownership boundary, such as `session-metadata-patch.ts` or
  `session-compact-thresholds.ts`; otherwise prefer a same-file helper or
  defer the refactor.
- Treat line-count reduction as supporting evidence, not the reason to move
  code. A move is worthwhile only when it removes duplication, improves a
  route/test boundary, or isolates provider-specific behavior.
- Do not reshape `Process`, `Supervisor`, WebSocket streaming, replay buffers,
  or provider protocol behavior as part of this ledger.
- Run focused sessions-route tests and server typecheck for code changes.
- If an item touches background loops, session liveness, reconnect behavior, or
  server catch-up paths, first read `topics/architecture-mandates.md`.

## Status Values

- `done`: implemented and verified.
- `proposed`: ready for user decision.
- `accepted`: user chose it; ready to implement.
- `deferred`: keep the note but do not implement now.
- `dropped`: no longer worth tracking.

## Refactor Items

### SRR-024: The Shared Launch Code Moves Below The Routes

Status: done, 2026-11-07. Second part of step 5 of
[plan 177](177-session-launch-service.md). Mostly move-only; the
recovered-queue change follows that plan's behavior-preserving rules.

Destination: `packages/server/src/sessions/`. Moved whole:
`session-launch-settings.ts`, `session-launch-metadata.ts` and
`session-compact-thresholds.ts` (with their two unit tests, now in
`test/sessions/`). Split: `settleLaunch` and its types move to
`session-launch-outcome.ts`, which also exports the queued and queue-full
checks, while `refusedLaunchResponse` stays in the routes as
`routes/session-launch-refusal.ts`; the sandbox inheritance rules move to
`session-sandbox-inheritance.ts`, while `parseSessionSandboxLevel` stays in
`routes/session-sandbox-settings.ts`; `parseOptionalExecutor` moves from
`routes/session-request-helpers.ts` to `session-launch-settings.ts`, which
uses it for a saved executor. `RestartSessionBody` and
`parseOptionalRestartSessionBody` move from `sessions.ts` to the existing
`routes/session-launch-request.ts`, beside the other launch request
parsers.

Line delta: `-62` lines from `sessions.ts` (5,435 -> 5,373).

Problem:

The launch settings, outcome mapping and metadata writers a headless host
needs sat in the REST layer, and the recovered-queue route recorded a
provider and requested model the Supervisor's reactivation had already
saved.

Implemented:

- the moves above, each unchanged apart from imports, `export` keywords,
  doc comments that no longer say "route" or that the moved code lacked,
  and the two queue checks, renamed `isQueuedLaunch` and
  `isQueueFullLaunch` and typed to accept any launcher's result;
- the Project Queue scheduler uses the shared queued and queue-full checks
  instead of its own copies; the other non-route launchers keep their
  short mappings, for the reasons in plan 177 part 2;
- recovered-queue reactivation no longer writes the provider, executor or
  requested model, which the Supervisor saves; it still writes the
  session's saved preferences back over the ones the process resolved.
  `persistLaunchMetadata` loses its provider, executor and requested-model
  fields, which no caller passes any more.

Verification: the full-app `test/routes/session-launch-records.test.ts`
gains four recovered-queue cases whose snapshots were captured on the old
code, including a saved "native" prompt-suggestion preference on a
provider without native suggestions; the mocked write-order case for that route, which could not see the
Supervisor's saves, is removed.

### SRR-023: One Owner For Each New Session's Launch Record

Status: done, 2026-11-06. First part of step 5 of
[plan 177](177-session-launch-service.md). Not a move-only slice; it follows
that plan's behavior-preserving rules.

Destination: no new module. `recordNewSessionMetadata` in
`packages/server/src/routes/session-launch-metadata.ts` gains a second
argument for fields admission already saved, which it announces without
writing; `inheritedChildLaunchMetadata` and the route's
`recordCopyCreator` are removed.

Line delta: `-40` lines from `sessions.ts` (5,475 -> 5,435);
`session-launch-metadata.ts` shrinks from 188 to 174 lines.

Problem:

Fork, clone, restart (handoff and fork) and the retitle and fork-summary
helpers wrote a new session's provider, model, preferences, title, source
and creator after it existed, although creation admission had saved each of
them before the session was made.

Implemented:

- each route writes only what admission does not know: a handoff's title,
  a fork's lineage root, the fork-summary target's archiving, a `/btw` link
  to a parent other than the source, the preferences a started process
  resolved, and the sandbox record;
- admission stores a copy's title cleaned up the way the route's title
  write did;
- a separate commit stops the retitle and fork-summary generators storing
  their source's prompt-suggestion preference over admission's "off" for
  internal helpers, an accidental leftover;
- the owner of each field and every difference found are in plan 177's
  step 5 tables; the sandbox record keeps its route write until it can be
  verified on Linux.

Verification: `test/routes/session-launch-records.test.ts` pins each new
session's whole stored record and the settings a later plain resume starts
with, through the full app and a real Claude transcript. It passed against
the old code before the change. The route write-order tests were updated to
the shorter write lists.

### SRR-022: One Record For Sessions Made From Another

Status: done, 2026-11-06. Step 4 of
[plan 177](177-session-launch-service.md). Not a move-only slice; it follows
that plan's behavior-preserving rules.

Destination: `recordNewSessionMetadata` and `releaseFailedForkNumber` join
the existing `packages/server/src/routes/session-launch-metadata.ts`;
`recordCopyCreator` replaces two copies inside the sessions route factory.

Line delta: `-49` lines from `sessions.ts` (5,524 -> 5,475);
`session-launch-metadata.ts` grows from 134 to 188 lines.

Problem:

Fork, restart fork, restart handoff, the stale-session handoff and the
retitle and fork-summary helpers each wrote a new session's title and
lineage and announced it by hand or through a helper-only closure; fork,
restart fork and the fork-summary target each wrote the rule that a failed
fork gives back its fork number; fork and clone each recorded a limited
user as the copy's creator.

Implemented:

- the three shared pieces above; each path keeps its own order of writes,
  which differs per path;
- each difference between the copies was classified in plan 177's step 4
  table. Admission already records most of what these routes write again,
  and clone and restart fork announce less than fork; both go to the
  maintainer with step 5's one-owner-per-field decision.

Verification: `test/routes/session-copy-records.test.ts` pins, per new
session, the title and lineage writes and announcements in order, a
limited user's fork's creator and usage records, and every fork-number claim
and release, including failed forks, forks kept without their settings and
restart fork and fork-summary targets whose launch is refused. It passed
against the old code before the change.

### SRR-021: One Launch-Outcome Mapping

Status: done, 2026-11-06. Step 3 of
[plan 177](177-session-launch-service.md). Not a move-only slice; it follows
that plan's behavior-preserving rules.

Destination: `settleLaunch` and `refusedLaunchResponse` replace the two type
guards in the existing `packages/server/src/routes/session-launch-results.ts`.

Line delta: `-15` lines from `sessions.ts` (5,539 -> 5,524);
`session-resume-routes.ts` 797 -> 788; `session-launch-results.ts` 21 -> 97.

Problem:

Resume, restart handoff, restart fork, the stale-session handoff, the
fork-summary target and `/clearloop` each read the Supervisor's started,
queued or queue-full result by hand: the same queue-full body four times,
and three hand-written cancellations of a queued launch that must start now.

Implemented:

- `settleLaunch(result, policy)` reads the result once. A full queue is
  refused; a queued launch is kept (`whenQueued: "wait"`) or cancelled and
  refused with the caller's message (`whenQueued: "cancel"`);
- `refusedLaunchResponse` answers a refusal with the 503 body every route
  already sent, plus what the request already made (the restart fork's new
  session); `/clearloop` and the fork-summary job throw the refusal instead;
- the resume route records the turn once for a started or kept launch
  instead of in two branches;
- each difference between the copies was classified in plan 177's step 3
  table. Two existing differences are recorded as gaps for the maintainer:
  a queued stale-session handoff loses its title
  (`gaps/stale-handoff-queued-launch-loses-title.md`), and a refused
  restart fork is left out of the usage count
  (`gaps/refused-restart-fork-uncounted-in-usage.md`).

Verification: `test/routes/session-launch-outcomes.test.ts` pins each
route's status, body, queue cancellation and usage records for a full queue
and a queued launch, plus usage for a started restart, stale-session
handoff and resume. It passed against the old code before the change.

### SRR-020: One Launch-Settings Assembly For Successor Sessions

Status: done, 2026-11-06. Step 2 of
[plan 177](177-session-launch-service.md). Not a move-only slice; it follows
that plan's behavior-preserving rules.

Destination: `buildSuccessorLaunch` joins `buildResumeLaunch` in the existing
`packages/server/src/routes/session-launch-settings.ts`.

Line delta: `-81` lines from `sessions.ts` (5,621 -> 5,540);
`session-launch-settings.ts` grows from 129 to 246 lines.

Problem:

Restart handoff, restart fork and the stale-session handoff each built the
Supervisor launch settings of their new session by hand: the same inherited
model, thinking, effort, service tier and permission mode, global
instructions, recap and prompt-suggestion preferences, sandbox fields and
compact settings, with small differences between the copies.

Implemented:

- `buildSuccessorLaunch` runs the successor inheritance and builds the
  settings object once. The restart fork adds its fork's sandbox state; the
  restart handoff adds its client name; the stale-session handoff names the
  acting user for limited-user instructions;
- each difference between the copies was traced to its commit and
  classified in plan 177's step 2 table. The one accidental difference, the
  stale-session handoff's compact-window fallbacks, stays behind a temporary
  option here and is fixed in its own follow-up commit; that
  commit takes `sessions.ts` to 5,539 lines and
  `session-launch-settings.ts` to 241.

Verification: `test/routes/session-successor-launch-settings.test.ts` pins
the exact settings object and permission mode each path passes to the
Supervisor: restart handoff with every request override, with inherited
settings in a sandbox, and across providers; restart fork; and the
stale-session handoff for a superuser and for a locked limited user. Two
restart handoff cases load a transcript whose model differs from the live
process's, pinning the order of the compact-window fallbacks. It passed
against the old code before the change. The follow-up fix adds a stale-session case
for the same order; it and the locked cross-provider case fail before the
fix, by design.

### SRR-019: One Launch-Metadata Writer For Successor Sessions

Status: done, 2026-11-06. Step 1 of
[plan 177](177-session-launch-service.md), the session launch service. Not a
move-only slice: it replaces copies with one implementation, under that
plan's behavior-preserving rules rather than the module-boundary move-only
contract.

Destinations: new `packages/server/src/routes/session-launch-metadata.ts`;
`sandboxWorkingProjectPath` joins the existing
`packages/server/src/routes/session-sandbox-settings.ts`.

Line delta: `-82` lines from `sessions.ts` (5,703 -> 5,621); new module of
134 lines; `session-sandbox-settings.ts` grows by 15.

Problem:

`persistLaunchMetadata` was a factory closure with eight positional
arguments. Fork, the retitle helper and the fork-summary helper and target
each called it with the same hand-built "inherit from the source" record. The
project-write working-directory rule was copied eight times. The
recovered-queue module received the closure as a dependency.

Implemented:

- `persistLaunchMetadata(service, sessionId, record)` takes a named record
  and writes the same fields in the same order. It no longer accepts the
  initial prompt, which no caller passed;
- `inheritedChildLaunchMetadata` and `inheritedSandboxRecord` build the
  record a cold transcript child inherits. Fork, retitle, both fork-summary
  forks and the Codex clone's sandbox record use them;
- `sandboxWorkingProjectPath` replaces the eight copies of the working-directory
  rule;
- restart fork, restart handoff, the fork-summary target's post-resume write
  and recovered-queue reactivation call the same writer with their own
  records. The recovered-queue module imports it instead of taking it as a
  dependency.

Verification: `test/routes/session-successor-launch-metadata.test.ts`
records every metadata write, in order, on each child for fork (sandboxed and
unsandboxed), retitle, fork-summary, restart fork, restart handoff and
recovered-queue reactivation. It passes against both the old and the new
code. The Codex clone's sandbox record is covered by
`test/routes/sessions-clone-codex.test.ts`. One real difference found while
mapping the paths is recorded in
[clone working directory](../../gaps/clone-working-directory-ignores-sandbox-level.md),
not fixed here.

### SRR-018: Register Start, Resume And Reactivate Routes From Their Own Modules

Status: done, 2026-11-06. Accepted with SRR-017, which moved the helpers
these routes share with the rest of the file; landed as campaign slice 1.3b
in doc 058, completing row 1.3.

Destinations:

- `POST /projects/:projectId/session-creations` (`startProjectSession`),
  `POST /session-creations` (`startDetachedSession`) and the factory closure
  `ensureDetachedProjectPath`, used only by the detached start -> new
  `packages/server/src/routes/session-creation-routes.ts`, as
  `registerSessionCreationRoutes(routes, deps, closures)`;
- `POST /projects/:projectId/sessions/:sessionId/resume`, the reactivate
  project-queue admission middleware and
  `POST /projects/:projectId/sessions/:sessionId/reactivate`, with the
  module-level `parseOptionalReactivateSessionBody`,
  `REACTIVATE_SHOW_THINKING_OPTIONS` and `isPermissionRules` that only
  reactivate uses -> new `packages/server/src/routes/session-resume-routes.ts`,
  as `registerSessionResumeRoutes(routes, deps, closures)`.

Line delta: `-1,010` lines from `sessions.ts` (6,713 -> 5,703); new modules
of 376 and 797 lines.

Problem:

The start, resume and reactivate handlers were 918 contiguous lines of
`createSessionsRoutes`, the largest remaining block in row 1.3's scope.
After SRR-017 they read no factory binding except `routes`, `deps`, three
stateless closures, and `ensureDetachedProjectPath`, which only they use,
so they can register from their own modules.

Implemented:

- moved the four route blocks, the admission middleware, the reactivate body
  parser and `ensureDetachedProjectPath` byte-identically. The module-level
  parser stays module-private in its new home; the routes and
  `ensureDetachedProjectPath` sit inside the registrar bodies;
- `createSessionsRoutes` calls the two registrars back to back at the old
  position, right after `registerSessionDetailRoute`, so the registration
  order of every route and middleware, including the reactivate admission
  middleware relative to the read-only-executor `routes.use(...)` in front
  of it, is unchanged;
- the closures `creationAcceptance`, `getGlobalInstructions` and
  `buildResumeLaunch` are still built once by the SRR-017 factories that
  `createSessionsRoutes` calls, because their siblings and the latter two
  themselves serve code that stays (restart, stale-handoff, fork,
  fork-summary, clone, recap, retitle, the message route, `/clearloop` and
  the recovered-queue deps). They are passed as the registrars'
  `closures` parameter and destructured at the top of each registrar under
  the same names. The registrars do not call the factories themselves, so
  each closure is still the single instance the route factory built;
- `deps` is typed as `SessionCreationRouteDeps` (`supervisor`, `scanner`,
  `userUsageService`, and the compact-settings services) and
  `SessionResumeRouteDeps` (provider resolution deps, those services,
  `readerFactory`, `sessionMetadataService` and
  `projectQueueScheduler.reserveUserSessionStart`), not `SessionsDeps`;
- `ensureDetachedProjectPath` is now created when the registrar runs rather
  than earlier in the factory; it is stateless and only called at request
  time.

Risk:

- medium. Route registration, project-queue admission and durable session
  creation pass through this code, though no body changed. Registration
  order, the admission middleware and the closures' identity are the
  tripwires; Tier 3 and `pnpm test:e2e:sdk` cover them.

Verification: see doc 058's slice 1.3b landing note.

### SRR-017: Move Session Start And Resume Helpers Shared With Other Routes

Status: done, 2026-11-06. Proposed and accepted the same day (the
maintainer asked for the next slice after SRR-016), landed as campaign
slice 1.3a in doc 058. It prepares SRR-018, which moves the start, resume
and reactivate routes (doc 058 row 1.3).

Destinations:

- `permissionModeError`, `StartSessionBody`, `hasSessionMessageContent`,
  `CreateSessionBody` and `parseOptionalJsonObjectBody` -> new
  `packages/server/src/routes/session-launch-request.ts`;
- `isQueuedResponse` and `isQueueFullResponse` -> new
  `packages/server/src/routes/session-launch-results.ts`;
- `parseSessionSandboxLevel`, `persistedSandboxNetworkFirewall` and
  `inheritedSandboxSettings` -> new
  `packages/server/src/routes/session-sandbox-settings.ts`;
- `resolveCompactModelSettings` -> existing
  `packages/server/src/routes/session-compact-thresholds.ts`, beside the
  `resolveCompactPercent`/`resolveCompactWindow` it calls;
- `ResumeLaunchRequest` and the factory closures `getGlobalInstructions` and
  `buildResumeLaunch` -> new
  `packages/server/src/routes/session-launch-settings.ts`, inside
  `createSessionLaunchSettings(deps)`;
- `requestCreationProvenance` and the factory closures `creationForRequest`
  and `creationAcceptance` -> new
  `packages/server/src/routes/session-creation-requests.ts`, inside
  `createSessionCreationRequests(deps)`.

Line delta: `-552` lines from `sessions.ts` (7,265 -> 6,713); `+55` in
`session-compact-thresholds.ts` (42 -> 97); new modules of 137, 21, 81, 129
and 227 lines.

Problem:

A preflight of the start, resume and reactivate routes (lines 2462-3379
before this item) found they share no factory state such as maps, timers
or queues with the rest of `createSessionsRoutes`, but they do reach three
factory closures that code staying behind also calls: `creationForRequest`
(through `creationAcceptance`; called directly by restart, stale-handoff,
fork, fork-summary and clone), `getGlobalInstructions` (also restart,
stale-handoff, fork-summary, recap, retitle, the message route and the
recovered-queue deps) and `buildResumeLaunch` (also `/clearloop`'s
`sendClearloopPrompt`). They also use ten module-level helpers and body
types that staying code uses (restart, stale-handoff, fork, fork-summary,
clone, retitle, `PUT /sessions/:sessionId/mode`, the message route and
`/clearloop`).
Moving the routes while those stay behind would make the new module import
`sessions.ts`, which the campaign forbids.

Implemented:

- moved the module-level helpers and types verbatim, each gaining `export`
  except `requestCreationProvenance`, which only its new module calls.
  `inheritedSandboxSettings` is used only by staying routes; it moved with
  its two sandbox siblings so the sandbox request settings have one owner;
- moved the contiguous `creationForRequest`/`creationAcceptance` block and
  the contiguous `getGlobalInstructions`/`buildResumeLaunch` block
  byte-identically into the bodies of the two factories, which return them.
  `createSessionsRoutes` calls each once at its block's old position and
  destructures the same names, so every call site is unchanged.
  `creationAcceptance` is used only by the two session-creation routes; it
  moved with `creationForRequest`, which it calls, as the durable-creation
  domain. `sessions/session-creation-acceptance.ts` keeps the receipt and
  submission-hash logic, which has no HTTP context;
- `deps` is typed as narrow interfaces rather than `SessionsDeps`:
  `resolveCompactModelSettings` takes `CompactModelSettingsDeps`
  (`serverSettingsService`, `modelInfoService`), the launch-settings factory
  `SessionLaunchSettingsDeps` (those plus `sessionMetadataService`), and the
  creation factory `SessionCreationRequestDeps` (`signal`,
  `getLimitedUserGrants`, `sessionMetadataService`). Every caller passes
  `SessionsDeps`, which satisfies them structurally;
- `sessions.ts` imports the moved names; imports used only by the moved code
  left its import list.

Risk:

- low. Pure helpers and stateless closures that read `deps` at request time;
  nothing in the route factory calls them during construction. No route
  registration, queue admission, timer or process code moved.

Verification: see doc 058's slice 1.3a landing note.

### SRR-016: Build Session Project Routing Outside The Route Factory

Status: done, 2026-11-06. Proposed and accepted the same day (the
maintainer asked for the next slice after SRR-015, whose follow-up named
it), landed as campaign slice 1.2c in doc 058.

Destination: the existing
`packages/server/src/routes/session-project-routing.ts`, which already owns
`resolveCanonicalProjectRedirect`, now also exporting
`createSessionProjectRouting(deps, storedIdentityFor)` and its
`SessionProjectRoutingDeps`.

Line delta: `-158` lines from `sessions.ts` (7,423 -> 7,265), `+208` in
`session-project-routing.ts` (41 -> 249).

Problem:

After SRR-015, the session project-routing closures sat in
`createSessionsRoutes` with no route of their own:
`resolveSessionProjectRouting` and `buildSessionProjectRedirectPath` serve
the two detail registrars and `POST .../refresh-preview`,
`getGrokNativeProjectId` (with its lazy `unscopedGrokReader`) and
`buildGrokNativeRedirectPath` serve only the registrars. They are one
domain, the project a session request is served under, and the module that
already decides that redirect is their natural owner.

Implemented:

- moved the contiguous block from `let unscopedGrokReader` through
  `resolveSessionProjectRouting` byte-identically into the body of
  `createSessionProjectRouting`, which returns the four closures.
  `createSessionsRoutes` calls it once at the block's old position and
  destructures the same four names, so every call site (`POST
  .../refresh-preview` and the `sessionDetailRouting` object) is unchanged.
  The lazy Grok reader is still one instance per `createSessionsRoutes`
  call, shared by both registrars;
- `deps` is typed as the narrow `SessionProjectRoutingDeps`
  (`SessionProviderResolutionDeps` plus `supervisor.getProcessForSession`,
  `scanner.getOrCreateProject`, and the full `sessionMetadataService`
  that `creationStatusForSession` takes and whose `getMetadata` the block
  reads; `grokSessionsDir` and `signal` are inherited), not `SessionsDeps`;
  the factory passes its own `deps` object;
- `storedIdentityFor` stays in `sessions.ts` because
  `GET /sessions/:sessionId/native-source`, `POST .../clone` and the routing
  object also use it; it becomes the second parameter, under the same
  name, so the moved body still calls it as before;
- `rewindRecordIdsFor` stays: it belongs to the rewind domain, not to
  project routing;
- `sessions.ts` no longer imports `resolveCanonicalProjectRedirect` or
  `encodeProjectId`, and imports `GrokSessionReader` as a type only (its
  remaining use is a type annotation);
- the two detail registrars keep receiving the `routing` object. Having
  each call `createSessionProjectRouting` itself would build a second lazy
  Grok reader, which is not a move.

Risk:

- low. Closures only, called at request time; nothing reads them during
  factory construction except the routing object literal, which still
  follows the call. No route registration, queue, timer or process code
  moved.

Verification: see doc 058's slice 1.2c landing note.

### SRR-015: Register Session-Detail Read Routes From Their Own Modules

Status: done, 2026-11-06. Proposed and accepted with SRR-014, landed as
campaign slice 1.2b in doc 058.

Destinations:

- `packages/server/src/routes/session-detail-routes.ts`, exporting
  `registerSessionDetailRoute(routes, deps, routing)` for
  `GET /projects/:projectId/sessions/:sessionId`;
- `packages/server/src/routes/session-detail-subresource-routes.ts`,
  exporting `registerSessionDetailSubresourceRoutes(routes, deps, routing)`
  for `GET .../agents`, `GET .../agents/:agentId` and `GET .../metadata`.

Line delta: `-1,520` lines from `sessions.ts` (8,943 -> 7,423), `+1,301` and
`+416` in the two registrar modules.

Problem:

The session-detail read is the file's largest handler (about 850 lines of
pagination, compact-tail, overlay, augment and unread shaping), and three
lighter reads of the same session sit beside it. They share response-field
helpers with each other and not with the rest of the file. The agents,
agent-content and metadata `GET`s are contiguous; the detail `GET` follows
`PUT .../project` and `POST .../refresh-preview`.

Implemented:

- moved both route blocks byte-identically, including their route comments.
  `createSessionsRoutes` calls each registrar at its block's old position,
  so all four routes register on the same Hono instance in the same order
  relative to every other route and to the
  `/projects/:projectId/sessions/:sessionId/*` middleware;
- helpers only these reads use moved with them: the detail constants,
  `roundedMs`, the durable-overlay cursor helpers,
  `completedPublicShareMessageCount`, and `getSessionSlashCommands` and
  `effectiveModelSettingsFromMetadata` (exported from the detail module for
  the subresource module), all verbatim;
- the factory-level `loadProviderSession` and the `boundSessionReads`
  instance it uses, both used only by the detail `GET`, moved into
  `registerSessionDetailRoute` verbatim. The instance is still built once
  per `createSessionsRoutes` call; its constructor only stores options, so
  building it a few statements later is not observable;
- factory closures both registrars use stay in `sessions.ts` (SRR-016
  later moved four of them into `session-project-routing.ts`, still built
  once per factory call):
  `resolveSessionProjectRouting` and `buildSessionProjectRedirectPath`
  (also called by `POST .../refresh-preview`), `storedIdentityFor` (also
  used by other routes), `getGrokNativeProjectId` (which owns the lazy Grok
  reader the two registrars must share), `buildGrokNativeRedirectPath` and
  `rewindRecordIdsFor`. The last three are now referenced in `sessions.ts`
  only by the routing object. They are passed as the
  `routing` parameter (`SessionDetailRouting`) and destructured at the top of
  each registrar, so the moved bodies keep calling them by name;
- `deps` is typed as the narrow `SessionDetailRouteDeps`
  (`SessionProviderResolutionDeps` plus the fields the reads use), not
  `SessionsDeps`. `SessionProjectRouting` names the routing result type that
  `resolveSessionProjectRouting` still declares inline.

Risk:

- medium. Largest route move of the series, but no queue, timer, liveness or
  provider-process code moved, and every body is byte-identical.

Verification: see doc 058's slice 1.2b landing note.

### SRR-014: Move Session-Detail Helpers Shared With The Rest Of The File

Status: done, 2026-11-06. Proposed and accepted the same day (the
maintainer asked for the next slice after SRR-013), landed as campaign
slice 1.2a in doc 058. It prepares SRR-015.

Destinations:

- `resolveSessionReader` -> existing
  `packages/server/src/routes/session-provider-resolution.ts`;
- `sdkMessagesToClientMessages`, `extractContextUsageFromSDKMessages` and
  their private `isCompactBoundaryMessage` -> new
  `packages/server/src/routes/session-sdk-history.ts`;
- `messageId` -> new `packages/server/src/routes/session-message-id.ts`.

Line delta: `-237` lines from `sessions.ts` (9,180 -> 8,943), `+82` in
`session-provider-resolution.ts`, `+167` and `+13` in the two new modules.

Problem:

A preflight of the session-detail read routes (doc 058 row 1.2) found three
module-level helpers they call that other `sessions.ts` code also calls:
`resolveSessionReader` (also the restart handoff), `sdkMessagesToClientMessages`
(also the restart source session) and `messageId` (also the fork, rewind and
restart-handoff helpers). Moving the routes while those stay behind would make
the new module import `sessions.ts`, which the campaign forbids.

Implemented:

- moved the five functions verbatim. Four gained `export` (the formatter
  rewrapped `sdkMessagesToClientMessages`'s signature as a result);
  `isCompactBoundaryMessage` stays module-private beside its only caller.
  `messageId` gained a one-line doc comment in its new module.
  `extractContextUsageFromSDKMessages` is called only by the detail `GET`;
  it moved with `sdkMessagesToClientMessages` as the same SDK-history
  domain;
- `resolveSessionReader`'s `deps` parameter changed type from `SessionsDeps`
  to the new `SessionReaderResolutionDeps`
  (`SessionProviderResolutionDeps` plus `sessionMetadataService.getMetadata`),
  the fields it reads. This avoids a back-import; every caller passes
  `SessionsDeps`, which satisfies it structurally;
- `sessions.ts` imports the moved functions; `ContextUsage`,
  `NativeSessionId` and `collapseMessageSnapshots` left its import list with
  their only users.

Risk:

- low. Helper functions only (`resolveSessionReader` reads provider
  sources; the rest are pure); no route, queue, timer or process code moved.

Verification: see doc 058's slice 1.2a landing note.

### SRR-013: Register Metadata And Seen-State Routes From Their Own Module

Status: done, 2026-11-06. Proposed and accepted the same day (the
maintainer asked for this revival), landed as campaign slice 1.6 in doc 058.

Destination: new file
`packages/server/src/routes/session-metadata-routes.ts`, exporting
`registerSessionMetadataRoutes(routes, deps)`.

Line delta: `-174` lines from `sessions.ts` (9,354 -> 9,180), `+199` lines
in the registrar module.

Problem:

Five handlers near the end of `createSessionsRoutes` own seen state and
metadata bookkeeping rather than transcripts or processes:
`POST`/`DELETE /sessions/:sessionId/mark-seen`,
`GET /notifications/last-seen`, `GET /debug/metadata` and
`PUT /sessions/:sessionId/metadata` (which also carries archive and star
updates and the archive stop boundary). They are one contiguous block and read
only `supervisor`, `notificationService`, `sessionMetadataService` and
`eventBus` from `deps`.

Implemented:

- moved the block byte-identically, including its route comments, into
  `registerSessionMetadataRoutes`, which `createSessionsRoutes` calls at the
  block's old position. The routes register on the same Hono instance in the
  same order, so matching, mounted paths and the auth middleware applied in
  `app.ts` are unchanged;
- the closure-captured `deps` became the `deps` parameter, typed as the narrow
  `SessionMetadataRoutesDeps` interface rather than importing `SessionsDeps`
  back from the route file. `SessionsDeps` satisfies it structurally;
- `SESSION_UNREAD_TIMESTAMP` and `parseSessionMetadataPatch` moved with
  their only callers; `nonHumanUserTurnField` stays imported in both files.

Left in place: `GET /projects/:projectId/sessions/:sessionId/metadata`. It is
a session-detail read with ownership, unread and recap shaping, and belongs to
the session-detail registrar (doc 058 row 1.2), not this group. The dedicated
`POST /api/sessions/:sessionId/archive` route already lives in
`session-archive.ts`.

Risk:

- low. No queue, timer, liveness or provider-process code moved; the archive
  path still awaits `abortSessionWithVerification` before emitting.

Verification: see doc 058's slice 1.6 landing note.

### SRR-012: Extract Restart Compaction Outside HTTP

Status: done, 2026-10-27, `06cff21d6`.

[Plan 163](163-http-independent-restart-compaction.md) moves the
restart-compaction attempt into a narrow supervisor module, preserving both
HTTP callers and existing policy. A separate behavior commit fixes observer
cleanup after dispatch refusal or throw. This does not select the archived
core assembly or revive the deferred route-registrar extractions.

Moved `RestartCompactAttempt`, `RESTART_COMPACT_WAIT_MS`,
`waitForRestartCompactBoundary` and `tryRestartCompact` into
`supervisor/restart-compaction.ts`. Kept the route's boundary predicate for
transcript handling and both production call sites unchanged. The module
imports `Process` only as a type; the helper text matches the baseline except
for exports. No dependency-parameter conversion or runtime changes.

Direct controlled-event tests cover synchronous completion during dispatch,
exact compact priority, boundary-only completion, timeout/error/termination
and normal cleanup. Existing route tests remain unchanged. Full validation
and runtimes are recorded in plan 163. Observer cleanup repair remains a
separate behavior commit, not an extension of this move slice.

The extraction carries `core-service-api` and
`typescript-module-boundary-refactor` topic trailers.

### SRR-001: Extract Request Parsing Helpers

Status: done.

Commit: `d7227af9` (`Extract session request helpers`).

Destination: new file
`packages/server/src/routes/session-request-helpers.ts`.

Line delta: about `-300` lines from `sessions.ts`, `+325` lines in the helper
file.

Moved pure request-boundary helpers from `sessions.ts` to
`packages/server/src/routes/session-request-helpers.ts`:

- executor parsing;
- optional service tier normalization;
- resume mode parsing;
- recap/prompt-suggestion/helper-side-model parsing;
- user-message metadata shaping.

Why it was safe:

- no `Hono`, `Supervisor`, reader, filesystem, or live process dependency;
- direct move of pure helpers plus imports;
- no route behavior changes.

Verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-request-helpers.ts
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts test/routes/sessions-clone-codex.test.ts
git diff --check
pnpm lint
```

### SRR-002: Deduplicate Provider-Resolution Dependencies

Status: done.

Destination: same file; all callers now use the existing top-level
`providerResolutionDeps(deps)` helper.

Line delta: `-65` lines from `sessions.ts`.

Problem:

`sessions.ts` has a `providerResolutionDeps(deps)` helper and also a local
`getProviderResolutionDeps()` closure with the same shape, while several
`findSessionSummaryAcrossProviders(...)` calls still build the object inline.
That duplication makes each provider-source addition easy to miss in one path.

Likely change:

- keep one helper for building `ProviderResolutionDeps`;
- replace inline object literals and the duplicate closure with that helper;
- keep provider lookup order and preferred-provider arguments unchanged.

Implemented:

- removed the duplicate `getProviderResolutionDeps()` closure inside
  `createSessionsRoutes`;
- replaced inline `ProviderResolutionDeps` literals with
  `providerResolutionDeps(deps)`;
- left every `project`, `projectId`, `sessionId`, and preferred-provider
  argument unchanged.

Value:

- reduces drift risk across Claude/Codex/Gemini/Grok/pi resolution paths;
- small line reduction;
- makes future provider changes less error-prone.

Risk:

- low, but every changed call site should be checked so the same `project`,
  `projectId`, `sessionId`, and preferred provider are still passed.

Verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts test/routes/sessions-clone-codex.test.ts test/routes/recents.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts
```

### SRR-003: Extract Session Ownership Response Shaping

Status: deferred.

Destination: likely same file, as a small helper near
`providerResolutionDeps(deps)`. A new file is not warranted unless more
ownership-response code accumulates.

Estimated line delta: about `-12` to `-18` lines from `sessions.ts`.

Problem:

Multiple read routes repeat the same ownership decision: live YA process wins,
then external tracker, then persisted/no-owner fallback. Each response also
repeats `processId`, `permissionMode`, `modeVersion`, and
`recapAfterSeconds`.

Likely change:

- add a small helper such as `buildSessionOwnership(process, isExternal,
  fallback?)`;
- use it in metadata/detail routes first;
- avoid changing process lookup timing or response fields.

Value:

- removes duplicated response-shaping logic;
- lowers the chance that a future ownership field is added to one route but not
  the other.

Risk:

- low to medium. The helper must preserve the persisted fallback used by the
  detail route when no process/external owner exists.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts
```

### SRR-004: Extract Launch Option Normalization

Status: done.

Destination: new file
`packages/server/src/routes/session-thinking-options.ts`.

Line delta: about `-20` net lines from `sessions.ts`, with a 23-line helper
module added.

Problem:

Start, create, detached start, detached create, resume, and reactivate repeat
similar launch-option setup: model/default handling, service tier, thinking,
executor, helper settings, provider, permissions, global instructions, and
recap/prompt-suggestion inheritance.

Likely change:

- extract narrow helpers for one repeated axis at a time, such as
  `normalizeRequestedModel(...)` or `buildThinkingOptions(...)`;
- avoid one large "launch options builder" until the smaller helpers prove
  useful.

Implemented:

- moved the repeated `body.thinking`/`body.showThinking` conversion into
  `buildThinkingOptions(...)`;
- replaced the identical conversion in project start/create, detached
  start/create, resume, reactivate, restart, and message queue paths;
- left model/default fallback, service tier, provider, executor, recap, and
  prompt-suggestion inheritance in the route handlers because those paths have
  different fallback rules.

Value:

- meaningful size reduction;
- fewer inconsistencies between start/resume/reactivate paths.

Risk:

- medium. These paths have subtle differences, especially metadata fallback and
  resume inheritance.

Verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-thinking-options.ts
git diff --check
pnpm lint
pnpm typecheck
pnpm test
```

Focused route tests passed with the preexisting sessions-metadata WARN/INFO
log chatter for negative-path Claude resume/compact cases. Root tests passed
with the baseline suite chatter recorded in doc 058.

### SRR-005: Move Recovered Queue Helpers

Status: done.

Destination: new file
`packages/server/src/routes/session-recovered-queue.ts`.

Line delta: about `-180` net lines from `sessions.ts`, with a 228-line helper
module added.

Problem:

Recovered patient-queue behavior is cohesive but takes a large block inside the
route file: listing paused entries, ensuring a process, resuming groups in
order, steering through a target, and preserving compose order against newer
live patient entries.

Likely change:

- move recovered-queue helper functions into a nearby module;
- keep the Hono route handlers in `sessions.ts`;
- pass explicit dependencies instead of importing global services.

Implemented:

- moved `ensureProcessForRecoveredItem`, `resumeRecoveredGroup`,
  `reportableProcessState`, and `resolveRecoveredGroupForDelivery` into
  `session-recovered-queue.ts`;
- passed explicit `RecoveredQueueDeps` for supervisor lookup/reactivation,
  metadata lookup, durable queue persistence, global instructions, and launch
  metadata persistence;
- kept recovered-queue HTTP handlers, response shapes, route paths, and
  `waitForPatientQueuePersistenceIdle()` waits in `sessions.ts`;
- left read-side recovered queue shaping in `session-queue-summaries.ts`
  rather than merging queue modules into a generic bucket.

Value:

- better isolation for restart-paused queue behavior;
- easier focused tests for recovered-queue edge cases later.

Risk:

- medium. The code touches live process reactivation and durable queue
  persistence, so it is less "pure extraction" than SRR-002 or SRR-003.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-recovered-queue.ts
git diff --check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e:sdk
```

`topics/architecture-mandates.md` was read before implementation. Focused
route tests passed with the preexisting sessions-metadata WARN/INFO log
chatter for negative-path Claude resume/compact cases.

### SRR-006: Move Claude Resume API-Error Guard

Status: done.

Destination: new file
`packages/server/src/routes/session-claude-resume-guard.ts`.

Line delta: `-76` lines from `sessions.ts`, `+82` lines in the Claude resume
guard module.

Problem:

Claude-specific resume blocking/recovery logic lives near the top of the
generic sessions route file. It walks the Claude transcript DAG to detect an
SDK API-error tail and either blocks resume or resumes at the last good
assistant message.

Likely change:

- move `ClaudeResumeApiErrorBlocker`,
  `getClaudeResumeApiErrorBlocker(...)`, and
  `getClaudeResumeBlockerFromReader(...)` into a small helper module;
- keep the route's existing log messages and response shape unchanged;
- import only `getClaudeResumeBlockerFromReader(...)` in `sessions.ts`.

Implemented:

- moved the Claude API-error tail detector and reader wrapper into
  `session-claude-resume-guard.ts`;
- removed the Claude transcript DAG dependency from `sessions.ts`;
- kept the resume route's logging, `resumeSessionAt` handling, and 409
  response shape in place.

Value:

- isolates a provider-specific resume quirk from the generic route;
- keeps a subtle safety check easier to test and review;
- removes top-of-file noise before the route dependency/interface section.

Risk:

- low. The logic is already pure except for reading a session through
  `ISessionReader`.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-claude-resume-guard.ts
```

### SRR-007: Move Worker Queue Routes

Status: done.

Destination: new file
`packages/server/src/routes/supervisor-queue.ts`; `app.ts` mounts it at
`/api` before the sessions route.

Line delta: `-42` lines from `sessions.ts`, `+59` lines in the supervisor
queue route module.

Problem:

`/status/workers` and `/queue` endpoints are Supervisor/worker-pool admin
routes, not session-detail routes. They currently live at the end of
`sessions.ts`.

Likely change:

- extract the four worker queue route registrations;
- pass only `deps.supervisor` to the new route factory;
- preserve the current public paths.

Implemented:

- moved the four Supervisor queue/status handlers to
  `createSupervisorQueueRoutes(supervisor)`;
- mounted that route factory at `/api` from `app.ts`, preserving the public
  `/api/status/workers`, `/api/queue`, and `/api/queue/:queueId` paths;
- added route tests that assert the preserved `/api` paths and 404 behavior.

Value:

- removes unrelated admin endpoints from the sessions route;
- clarifies that these endpoints are process/queue status, not per-session
  transcript behavior.

Risk:

- low to medium. The implementation is tiny, but route mounting must preserve
  exact paths.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/supervisor-queue.test.ts test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/supervisor-queue.ts packages/server/src/app.ts packages/server/test/routes/supervisor-queue.test.ts
```

### SRR-008: Move Compact Threshold Lookup Helpers

Status: done.

Destination: new file
`packages/server/src/routes/session-compact-thresholds.ts`.

Line delta: `-36` lines from `sessions.ts`, `+42` lines in the compact
threshold module.

Problem:

`resolveCompactPercent(...)` and `resolveCompactWindow(...)` are exported from
the large route file only so focused tests can cover threshold behavior. They
are pure compact-threshold helpers, not route handlers.

Likely change:

- move those two helpers and their comments to a compact-threshold module;
- update `sessions.ts` and the two focused tests to import from that module.

Implemented:

- moved both helpers to `session-compact-thresholds.ts`;
- updated `sessions.ts` to import them;
- updated the focused compact-threshold tests to import the small module
  instead of the large route module.

Value:

- removes exported utility code from the route surface;
- makes the threshold behavior easier to test without importing the whole
  route module.

Risk:

- low. This is pure helper extraction, but tests/imports must be updated.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/resolveCompactPercent.test.ts test/routes/resolveCompactWindow.test.ts test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-compact-thresholds.ts
```

### SRR-009: Extract Session Metadata Patch Parsing

Status: done.

Destination: new file
`packages/server/src/routes/session-metadata-patch.ts`.

Line delta: about `-166` net lines from `sessions.ts`, with a 198-line parser
module and focused parser test coverage added.

Problem:

`PUT /sessions/:sessionId/metadata` spends much of its route body validating
and normalizing heartbeat, parent-session, prompt-suggestion, and recap fields.
That parsing is mostly pure request-boundary logic.

Likely change:

- add a `parseSessionMetadataPatch(body)` helper returning either a normalized
  metadata patch or an API error message/status;
- keep metadata service updates and event emission in `sessions.ts`;
- preserve every existing validation range and error string.

Implemented:

- moved the `PUT /sessions/:sessionId/metadata` request-body validation and
  normalization into `session-metadata-patch.ts`;
- added focused parser coverage for empty patches, clear values, heartbeat
  interval bounds, parent-session normalization, prompt-suggestion validation,
  recap validation, and heartbeat text truncation;
- kept metadata service updates, SSE event emission, route path, and response
  shape in `sessions.ts`.

Value:

- leaves the route handler focused on read body -> update metadata -> emit
  event;
- makes validation rules easier to unit test later.

Risk:

- medium. The parser is pure, but the route has many small validation branches
  and error strings that need to stay identical.

Suggested verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/session-metadata-patch.test.ts test/routes/sessions-metadata.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-metadata-patch.ts packages/server/test/routes/session-metadata-patch.test.ts
git diff --check
pnpm lint
pnpm typecheck
pnpm test
```

Focused route tests passed with the preexisting sessions-metadata WARN/INFO
log chatter for negative-path Claude resume/compact cases.

### SRR-010: Move Patient Queue Summary Shaping

Status: done. First code slice of the module-boundary campaign
(`docs/tactical/058-typescript-module-boundary-refactor.md`, slice 1.1),
landed together with SRR-011.

Destination: new file
`packages/server/src/routes/session-queue-summaries.ts`.

Line delta: combined SRR-010/SRR-011 route-file delta is `-135` net lines
from `sessions.ts`; this module adds 131 lines.

Problem:

Read-side patient/deferred queue summary shaping sits near the top of the
route file: `persistedPatientQueueSummary`, `recoveredPatientQueueSummaries`,
`recoveredPatientQueueItems`, `sessionQueueSummaries`,
`recoveredPatientUserMessage`, and `livePatientEntriesNewerThan`. These shape
summaries from persisted queue items and live process state; they do not
mutate queues, timers, or process lifecycle.

Likely change:

- move the six shaping helpers into the new module, taking `SessionsDeps` (or
  narrower explicit dependencies) as parameters;
- keep route handlers, queue mutation calls, and event emission in
  `sessions.ts`;
- leave `isApprovalAuditLogEnabled` behind — it is interleaved in the same
  region but belongs to a different domain.

Implemented:

- moved `persistedPatientQueueSummary`, `recoveredPatientQueueSummaries`,
  `recoveredPatientQueueItems`, `sessionQueueSummaries`,
  `recoveredPatientUserMessage`, and `livePatientEntriesNewerThan` into
  `session-queue-summaries.ts`;
- used a narrow `SessionQueueSummaryDeps` interface instead of importing
  `SessionsDeps` back from the route file;
- kept recovered-queue route handlers, queue mutation, process reactivation,
  and event emission in `sessions.ts`.

Relationship to SRR-005: SRR-005 owns the recovered-queue *resume/steer*
machinery. This item is read-side shaping only. If both land they stay
separate modules; do not grow either into a general queue bucket.

Risk:

- low. Shaping is pure given its inputs, but the summary field spreads
  (`tempId`, attachments, metadata, status mapping) must stay byte-identical.

Verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts test/routes/sessions-clone-codex.test.ts test/routes/recents.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-queue-summaries.ts packages/server/src/routes/session-provider-resolution.ts
git diff --check
pnpm lint
pnpm typecheck
pnpm test
```

Focused route tests passed with the preexisting sessions-metadata WARN/INFO
log chatter for negative-path Claude resume/compact cases. Root tests passed
with the baseline suite chatter recorded in doc 058.

### SRR-011: Move Provider Name Guards And Resolution Deps

Status: done. Paired with SRR-010 as campaign slice 1.1.

Destination: new file
`packages/server/src/routes/session-provider-resolution.ts`.

Line delta: included in the combined SRR-010/SRR-011 `sessions.ts` `-135`
net-line delta; this module adds 55 lines.

Problem:

Provider-name guards (`isClaudeSdkProviderName`, `isCodexProviderName`) and
`providerResolutionDeps(deps)` (already deduplicated by SRR-002) are
provider-resolution plumbing living in the generic route file.

Likely change:

- move the two provider-name guards and `providerResolutionDeps` into the new
  module;
- decide placement of the supervisor enqueue-response guards
  (`isQueuedResponse`, `isQueueFullResponse`) explicitly: they are start-path
  response guards, not provider resolution, so they stay in `sessions.ts`
  unless the start/create extraction (item corresponding to campaign slice
  1.3 / SRR-004 territory) gives them a domain home;
- leave `getSessionSlashCommands` in place unless its import graph stays
  clean after the move; do not force it into this module.

Implemented:

- moved `isClaudeSdkProviderName`, `isCodexProviderName`, and
  `providerResolutionDeps` into `session-provider-resolution.ts`;
- used a narrow `SessionProviderResolutionDeps` interface instead of importing
  `SessionsDeps` back from the route file;
- left `isQueuedResponse`, `isQueueFullResponse`, and
  `getSessionSlashCommands` in `sessions.ts`.

Risk:

- low. Guards are pure; the deps builder is a field-mapping function. Every
  call site must pass identical arguments after the move.

Verification:

```bash
pnpm --filter @yep-anywhere/shared build && pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts test/routes/sessions-clone-codex.test.ts test/routes/recents.test.ts
node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-provider-resolution.ts
git diff --check
pnpm lint
pnpm typecheck
pnpm test
```

Focused route tests passed with the preexisting sessions-metadata WARN/INFO
log chatter for negative-path Claude resume/compact cases. Root tests passed
with the baseline suite chatter recorded in doc 058.
