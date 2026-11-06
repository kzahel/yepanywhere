# Sessions Route Refactor Ledger

Status: Dormant again, 2026-11-06: SRR-013 revived one route-registrar
extraction (the metadata/seen-state group, doc 058 row 1.6) at the
maintainer's request and landed it. SRR-012 landed 2026-10-27 as `06cff21d6`
under [plan 163](163-http-independent-restart-compaction.md); its separate
observer cleanup does not extend the move slice. The other route-registrar
extractions (doc 058 rows 1.2-1.5) remain deferred; revive each as its own
SRR item.

See also: `topics/core-service-api.md` — the sessions REST surface this
ledger refactors is the surface that topic proposes exposing as an
embeddable core API, so ownership-boundary moves here shape that
extraction.

See also: `topics/typescript-module-boundary-refactor.md` and
`docs/tactical/058-typescript-module-boundary-refactor.md` — the repo-wide
module-boundary campaign. This ledger owns the limited SRR-012 and SRR-013
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
as SRR-013 on 2026-11-06). Future `sessions.ts`
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
