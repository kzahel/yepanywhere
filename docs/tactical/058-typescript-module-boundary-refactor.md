# TypeScript Module Boundary Refactor

Topic: typescript-module-boundary-refactor

Status: Resumed 2026-11-06. The growth guard is live in `pnpm lint`. Work
follows the [priority queue](#priority-queue) below; its first item, the
session launch service, is in progress under plan 177. The `app.ts`
composition-root lane (slice 1.8) and the remaining `sessions.ts`
route-registrar extractions are lower in the queue.

Accepted 2026-10-27: [plan 163](163-http-independent-restart-compaction.md)
and doc 053 SRR-012 describe one HTTP-independent restart-compaction
extraction, followed by a separate observer-lifetime fix. The maintainer
authorized both after independent plan review; SRR-012 landed as `06cff21d6`.
This does not reactivate the other deferred route extractions.

## Priority Queue

Set by the maintainer on 2026-11-06: work this list from the top. Rank is by
how much day-to-day work each item makes easier, not by line count. The
factors are how often the code changes, how much of it is copied rather than
shared, and how risky it is to touch today.

1. **One session-launch service** (server). Starting, resuming, restarting,
   forking and cloning a session are about a dozen hand-written copies of the
   same setup, and the copies have started to disagree. Every launch feature
   and bug fix pays for that, and the
   [core service API](../../topics/core-service-api.md) needs launch as one
   call. This is a behavior-preserving consolidation, not a move-only slice,
   so it has its own plan:
   [session launch service](177-session-launch-service.md). Steps 1-5
   landed 2026-11-06 and 2026-11-07; a copy's sandbox record moved into
   the copy (SRR-025, checked on Linux), and the restarts' and
   continuation's records wait on the clone working-directory gap.
2. **Session page and message composer split** (client). `SessionPage.tsx`
   (about 6,600 lines), `NewSessionForm.tsx` (about 5,500), `MessageInput.tsx`
   (about 4,000) and `MessageInputToolbar.tsx` (about 3,800) are where most UI
   work lands. Their size makes each change slow to review and easy to
   regress, including the keystroke-latency contract. Phase 2 below holds the
   slice rows; slices 2.12 to 2.24 (the composer's bang completion state and
   recall drawer, the page's bang-command wiring, the toolbar's thinking
   control, and the message boxes' shared speech state, handlers, keys, speech
   field and attachment upload step, of which the floating composer shares the
   speech pieces, and the page's submission, send, queue and Project Queue
   decisions and its plain send module) landed 2026-11-07, and slices 2.31
   to 2.36 (the page's fork, queued-message, title, attachment upload,
   recall and route-sync hooks, [plan 181](181-session-page-feature-hooks.md))
   on 2026-11-08. Slices 2.37 to 2.41 move the page's header, composer
   footer and pop-ups into components and its header actions and project
   move menu into hooks
   ([plan 182](182-session-page-header-and-footer.md)) on 2026-11-08.
   [Plan 184](184-message-box-send-routes.md) gives the message box one
   send route and a delivery hook (slices 2.42 and 2.43, 2026-11-08).
   [Plan 187](187-session-page-draft-hooks.md) moves the page's composer
   attachment state, correction draft and draft hydration into hooks (in
   progress). Moving small
   features out one at a time leaves these files structurally as they were;
   the burn-down order and the consolidations it needs (one shared
   message-box core, then sending as plain functions) are in [the session
   page hub gap](../../gaps/session-page-react-hub.md).
3. **Codex provider split** (server). `sdk/providers/codex.ts` (about 8,200
   lines) is the largest source file and changes with every Codex refresh.
   Separating protocol IO from normalization makes those refreshes smaller and
   easier to verify. Phase 4 below holds the slice rows. On 2026-11-08
   slices 4.4 (live event conversion), 4.7 (failure trace), 4.8 (approvals)
   and 4.1 (app-server client), then 4.10 (thread policy and skill input),
   took `codex.ts` from 8,235 to 4,321 lines.
   Row 4.9 is the higher-value lifecycle change and needs its own plan: most
   of the file's recent churn sits in the session controls and the turn
   loop, not in the code that moved.
4. **Supervisor and Process** (server). Both are about 6,500-7,000 lines and
   load-bearing. They come after item 1 because the launch service moves
   launch assembly out of their callers first, which shows where their own
   seams are. Phase 5 below holds the slice rows.
5. **Remaining move-only rows**: the restart/fork and queue routes still in
   `sessions.ts` (rows 1.4 and 1.5) and `app.ts` route mounting (row 1.8).
   These shrink files without changing how code is shared, so their payoff is
   lower. Do them when they unblock one of the items above, or between them.

## Contract

The binding rules for this campaign — slice discipline, naming, coordination,
tripwire matrix, verification tiers, stop conditions, and non-goals — live in
[`topics/typescript-module-boundary-refactor.md`](../../topics/typescript-module-boundary-refactor.md).
Read it before implementing any slice. This document is the worklog: baseline,
inventory, slice ledger, and landing notes.

## Goal

Reduce the largest TypeScript and TSX files by extracting clear module
boundaries, while preserving behavior, performance, public APIs, and the
documented architecture invariants.

This is not a blanket line-count campaign. Large files are prioritized when
they mix responsibilities that already have natural seams: route registration
versus route handling, page orchestration versus feature hooks, provider
protocol IO versus normalization, and DOM-local transcript behavior versus pure
selectors.

## Baseline Gate

Recorded before the first refactor slice so later regressions are attributable
to a slice instead of preexisting repo state.

| Check | Command | Status | Notes |
|---|---|---|---|
| Lint | `pnpm lint` | Passed 2026-07-06 | 1s. Checked 1326 files, no fixes and no warnings. |
| Typecheck | `pnpm typecheck` | Passed 2026-07-06 | 8s. Includes `@yep-anywhere/shared` build. |
| Unit tests | `pnpm test` | Passed with baseline chatter 2026-07-06 | 44s. Existing stderr/WARN chatter observed; do not use this run as warning-free proof until the noted chatter is fixed or explicitly accepted per slice. |
| Client E2E | `pnpm --filter client test:e2e --grep-invert "physical Android"` | Gate clarified 2026-07-06 | Use this as the full client/browser E2E gate for refactor slices. It excludes only the environment-gated physical Android device smoke; run `pnpm test:e2e:android` separately for Android/device-bridge slices. The initial baseline was recorded with raw `pnpm test:e2e`: 41s, 55 passed, 6 skipped, with existing Vite chunk-size/browser-compatibility warnings and Node `NO_COLOR`/`FORCE_COLOR` warnings. |
| Server E2E | `pnpm test:e2e:sdk` | Passed with baseline chatter 2026-07-06 | 18s. 73 passed, 1 skipped. Existing negative-path WebSocket stderr observed. |
| Client console budget | `pnpm console:scan` | Passed at budget 2026-07-06 | 0s. 110/110 warning budget, +0 warnings; 158 info sites hidden by default. |
| Request census | `pnpm --filter client request:census -- --url <session-url>` | Skipped 2026-07-06 | No real session URL was supplied; run before session page/API refactors when available. |

Baseline notes:

- Recorded 2026-07-06 12:08 CEST at `3dd6f88b6d7eaff3b42153242b4f7891ef7c557b`
  and committed as `27dc30af`. The worktree was dirty at record time with
  unrelated project-queue changes (since landed as `eebd23f1`); no source
  movement had started for this refactor.
- Passing checks are attributable as pass/fail gates. The unit/E2E runs are not
  warning-free gates because they emitted existing test/logging chatter:
  settings-fetch stderr in client tests, server `CODEX_* slow scan` WARN logs
  against the local Codex session directory, expected negative-path
  WebSocket/auth stderr, Vite build warnings, and Node `NO_COLOR`/`FORCE_COLOR`
  warnings.
- Client Tier 3 means the full browser/client Playwright suite excluding the
  physical Android device smoke: `pnpm --filter client test:e2e --grep-invert
  "physical Android"`. The Android smoke remains mandatory only for slices
  that touch physical-device streaming, device bridge behavior, or
  Android-specific transport assumptions.
- The console chatter scan is at its current budget, not clean: 110 warning
  call sites, 0 over budget. Client slices must not increase that budget.
- Chatter fixes are their own slices (see the contract); do not bundle them
  into move slices.

## Large-File Inventory: 2026-11-06

Refresh cadence: at each phase completion, or when choosing the next phase's
slices — not after every slice. Production rows come from the
[growth guard](../../topics/typescript-module-boundary-refactor.md#growth-guard)
scope: tracked and untracked-not-ignored `packages/*/src` TS/JS files,
excluding tests, test-support modules, `generated/` trees, and declaration
files. `pnpm source:budgets --list` prints the full list; the budgets live in
`scripts/source-file-budgets.json`.

What the refresh showed: the July slices landed (about 30 move-only
extractions), and then the same hubs grew faster than those slices shrank
them. Between 2026-07-07 and 2026-11-06 `app.ts` took 276 commits
(+4,441/-1,241), `SessionPage.tsx` 214, `server-capabilities.ts` 180
(+5,201/-337, nearly append-only), `routes/sessions.ts` 168 and
`Supervisor.ts` 165. Features land in the file that composes them, so an
extraction-only campaign cannot keep up with inflow. The growth guard below
addresses the inflow; the slices address the stock.

Production TS/TSX top offenders (55 files over the 1,500-line threshold; 24
over 2,000):

| LoC 2026-11-06 | LoC 2026-07-06 | File |
|---:|---:|---|
| 9,354 | 6,278 | `packages/server/src/routes/sessions.ts` |
| 8,235 | 5,724 | `packages/server/src/sdk/providers/codex.ts` |
| 7,773 | 6,080 | `packages/client/src/pages/SessionPage.tsx` |
| 6,966 | 4,322 | `packages/server/src/supervisor/Supervisor.ts` |
| 6,582 | 4,026 | `packages/server/src/supervisor/Process.ts` |
| 5,984 | 3,346 | `packages/client/src/components/NewSessionForm.tsx` |
| 5,702 | 3,615 | `packages/client/src/components/MessageList.tsx` |
| 5,226 | — | `packages/shared/src/server-capabilities.ts` (split by area in slice 7.1; 445 after) |
| 4,781 | 2,339 | `packages/client/src/components/MessageInput.tsx` |
| 4,645 | 1,678 | `packages/server/src/app.ts` (after slice 1.8a; 4,913 before) |
| 4,157 | 2,180 | `packages/server/src/sessions/codex-reader.ts` |
| 4,059 | 3,059 | `packages/client/src/components/MessageInputToolbar.tsx` |
| 3,114 | 1,912 | `packages/server/src/sdk/providers/claude.ts` |
| 3,087 | — | `packages/server/src/routes/ws-relay-handlers.ts` |
| 2,808 | 2,103 | `packages/client/src/hooks/useSession.ts` |
| 2,733 | — | `packages/client/src/components/FileViewer.tsx` |
| 2,451 | — | `packages/server/src/sessions/normalization.ts` |
| 2,448 | 2,195 | `packages/server/src/indexes/SessionIndexService.ts` |
| 2,302 | 2,270 | `packages/client/src/lib/clientSummaryState.ts` |
| 2,095 | 1,884 | `packages/client/src/lib/connection/SecureConnection.ts` |
| 2,088 | — | `packages/client/src/pages/settings/AppearanceSettings.tsx` |
| 2,066 | — | `packages/server/src/sdk/providers/provider-runtime-host.ts` |
| 2,060 | — | `packages/server/src/server-main.ts` |
| 2,003 | 1,936 | `packages/client/src/api/client.ts` |
| 1,965 | 1,711 | `packages/server/src/sdk/providers/opencode.ts` |

Test TS/TSX top offenders (tests are outside the growth guard; see Phase 6):

| LoC 2026-11-06 | File |
|---:|---|
| 8,541 | `packages/server/test/sdk/providers/codex.test.ts` |
| 8,218 | `packages/server/test/routes/sessions-metadata.test.ts` |
| 7,811 | `packages/server/test/supervisor.test.ts` |
| 6,975 | `packages/client/src/components/__tests__/MessageInput.test.tsx` |
| 5,186 | `packages/client/src/components/__tests__/NewSessionForm.test.tsx` |
| 4,532 | `packages/client/src/hooks/__tests__/useSessionMessages.cache.test.tsx` |
| 4,254 | `packages/client/src/lib/__tests__/speechProviders.test.ts` |
| 3,749 | `packages/server/test/sessions/codex-reader-oss.test.ts` |

The 2026-07-06 inventory (25 production and 25 test rows, generated with
`rg --files` over the same exclusions) is in git history:
`git show 760d1f75e:docs/tactical/058-typescript-module-boundary-refactor.md`.

## Growth Guard

Landed 2026-11-06, immediately before slice 1.8a. `pnpm lint` runs
`scripts/check-source-file-budgets.mjs`, which freezes every production
source file over 1,500 lines at its recorded budget, rejects a new file over
the threshold, and requires a `raise` record (the previous limit plus a
reason) before a budget may go up, compared with the pull request base or
pre-push commit in CI. The contract and the authoring rule that
goes with it are in
[the topic's growth guard section](../../topics/typescript-module-boundary-refactor.md#growth-guard).
Slices run `pnpm source:budgets --record` in the same commit so extracted
lines cannot silently regrow.

## Phase 0: Preparation And Tracking

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 0.1 | Recorded 2026-07-06 | Baseline gate | Run and record the baseline command set above. | Pass/fail baseline recorded; warning-free status is not clean because existing test/E2E chatter was observed. |
| 0.2 | Recorded 2026-07-06 | Large-file inventory | Refresh the production/test LoC inventory. | Recorded above; refresh at phase boundaries. |
| 0.3 | Done 2026-07-06 | Contract/worklog split | Extract the binding rules into `topics/typescript-module-boundary-refactor.md` and reconcile this plan with the former doc 053 child ledger. | This doc is the handoff surface for future sessions. |
| 0.4 | In progress | Slice ledger upkeep | After each slice, update the slice row and append a landing note. | Ledger update lands in the same commit as the slice. |

## Phase 1: Server Route Mechanical Splits

High value and comparatively low risk: route files have obvious endpoint
groups, and `create*Routes()` aggregators can remain stable.

**Ownership:** future `packages/server/src/routes/sessions.ts` extraction
should revive or supersede the child ledger in
[`053-sessions-route-refactor-ledger.md`](053-sessions-route-refactor-ledger.md)
and use SRR items there. That child ledger applies only to the server route
file and its `routes/session-*.ts` helper modules; it does not gate Phase 2
client session work, Phase 4 provider work, or Phase 6 test organization. The
ledger has already landed SRR-001 (request parsing helpers), SRR-002
(`providerResolutionDeps` dedup), SRR-004 (thinking launch options), SRR-005
(recovered queue helpers), SRR-006 (Claude resume guard), SRR-007 (worker queue
routes), SRR-008 (compact thresholds), SRR-009 (metadata patch parsing),
SRR-010 (queue summary shaping), SRR-011 (provider resolution helpers),
SRR-013 (metadata/seen-state routes), SRR-014/SRR-015 (session-detail
helpers and read routes), SRR-016 (session project routing), and
SRR-017/SRR-018 (session start/resume helpers and routes), plus
SRR-019 to SRR-026 (the shared launch-metadata writer, successor
launch-settings assembly, launch-outcome mapping, new-session record, one
owner per launch-record field, the launch code's move below the routes, a
copy's sandbox record and the successor title rules, steps 1-5 of
[plan 177](177-session-launch-service.md)) —
the flat domain-named
`routes/session-*.ts` pattern those items established is the pattern here. Do
not create a `routes/sessions/` directory or a shared helpers bucket.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 1.1 | Done 2026-07-06 as SRR-010/SRR-011 | `sessions.ts` queue summary shaping + provider guards | Land SRR-010 (patient/deferred queue summary shaping into `session-queue-summaries.ts`) and SRR-011 (provider name guards and resolution deps into `session-provider-resolution.ts`). | Move-only; shaping and guards, not queue behavior. Restart/fork helpers are excluded — they are larger and behavior-heavy. Tier 1. |
| 1.2 | Done 2026-11-06 as SRR-014/SRR-015 | Session detail routes | Extract metadata, agent content, and `GET /projects/:projectId/sessions/:sessionId` handlers behind a local registrar, in the two sub-slices below. | Deferred 2026-07-06 because this is a route registrar move with pagination, compact-tail, augment, unread, and server-E2E tripwires; revived through doc 053 at the maintainer's request. |
| 1.2a | Done 2026-11-06 as SRR-014 | Session-detail helpers shared with the rest of `sessions.ts` | Move `resolveSessionReader` into `session-provider-resolution.ts`, the SDK-history conversion (`sdkMessagesToClientMessages`, `extractContextUsageFromSDKMessages`) into `session-sdk-history.ts`, and `messageId` into `session-message-id.ts`. | Preflight for 1.2b: the detail routes call these, and except for `extractContextUsageFromSDKMessages` (moved with its SDK-history sibling) so does code that stays (restart, fork, rewind), so they cannot move with the routes without a back-import. Helper functions only; Tier 2. |
| 1.2b | Done 2026-11-06 as SRR-015 | Session-detail read route registrars | Move the agents, agent-content and metadata `GET`s, and the session-detail `GET`, into registrars called at their two original positions. | Tier 3. The six factory closures both registrars use (the project-routing/redirect pair, `storedIdentityFor`, the Grok lookup and redirect, `rewindRecordIdsFor`) become a `routing` parameter. |
| 1.2c | Done 2026-11-06 as SRR-016 | Session project-routing closures | Move `resolveSessionProjectRouting`, `buildSessionProjectRedirectPath`, `getGrokNativeProjectId` with its lazy Grok reader, and `buildGrokNativeRedirectPath` into `createSessionProjectRouting(deps, storedIdentityFor)` in the existing `session-project-routing.ts`, called once at the old position. | Follow-up to 1.2b. Call sites unchanged: the factory destructures the same four names. One lazy Grok reader per factory call. `storedIdentityFor` and `rewindRecordIdsFor` stay. Tier 3. |
| 1.3 | Done 2026-11-06 as SRR-017/SRR-018 | Start/create/resume/reactivate routes | Extract new-session, two-phase create, resume, and reactivation handlers, in the two sub-slices below. | Deferred 2026-07-06 with the sessions route-registrar lane; revived through doc 053 at the maintainer's request. Preserve provider selection, YA-visible session ids, executor persistence, queue-full behavior, durable creation recovery, and remote sync behavior. |
| 1.3a | Done 2026-11-06 as SRR-017 | Start/resume helpers shared with the rest of `sessions.ts` | Move the launch body types and parsers, the start-result guards, the sandbox request settings, `resolveCompactModelSettings`, and the `creationForRequest`/`creationAcceptance` and `getGlobalInstructions`/`buildResumeLaunch` closures (as `createSessionCreationRequests(deps)` and `createSessionLaunchSettings(deps)`) into domain modules. | Preflight for 1.3b: the routes share no factory state, but these are also used by restart, stale-handoff, fork, fork-summary, clone, recap, retitle, `PUT .../mode`, the message route, `/clearloop` and the recovered-queue deps, so they cannot move with the routes without a back-import. Call sites unchanged. Tier 2. |
| 1.3b | Done 2026-11-06 as SRR-018 | Start/resume/reactivate route registrars | Move the two session-creation `POST`s with `ensureDetachedProjectPath`, and resume plus the reactivate admission middleware and `POST` with `parseOptionalReactivateSessionBody`, `REACTIVATE_SHOW_THINKING_OPTIONS` and `isPermissionRules` (used only by these routes), into registrars called at the old position. | Tier 3 plus `pnpm test:e2e:sdk`: creation and reactivation cross project-queue admission. Landed as `registerSessionCreationRoutes` and `registerSessionResumeRoutes`, called back to back at the old position; `creationAcceptance`, `getGlobalInstructions` and `buildResumeLaunch` are a `closures` parameter. |
| 1.4 | Deferred 2026-07-06 | Restart/fork/recap/retitle routes | Extract restart, fork, recap, fork-summary, and retitle flows; propose as an SRR item first if revived. | Deferred with the sessions route-registrar lane. Higher risk; preserve handoff/fork semantics and recap background behavior if revived. |
| 1.5 | Deferred 2026-07-06 | Queue/deferred routes | Extract message queue, deferred patient queue, steer/cancel, pending input, and mode routes. Builds on SRR-005 (recovered queue helpers, done in doc 053). | Deferred with the sessions route-registrar lane. Queue timers and idle ownership are load-bearing; read architecture mandates and run `test:e2e:sdk` if revived. |
| 1.6 | Done 2026-11-06 as SRR-013 | Metadata/notifications routes | Move mark-seen (both verbs), notifications last-seen, debug metadata and the metadata `PUT` (archive/star included) into `session-metadata-routes.ts` as `registerSessionMetadataRoutes`, called at the old position. Builds on SRR-009 (metadata patch parsing). | Revived through doc 053 as SRR-013. Byte-identical block; event-bus emissions and the archive stop boundary unchanged. The session-detail metadata `GET` stays with row 1.2. |
| 1.7 | Done 2026-07-06 | `routes/settings.ts` parser split | Move settings parsers/discovery helpers out of the route factory. | Moved parser/discovery helpers into `settings-parsers.ts`; route factory still owns endpoints, callbacks, config precedence, and response shapes. |
| 1.8 | In progress 2026-11-06 | `app.ts` route composition cleanup | `createApp` is one ~4,000-line function that interleaves service construction with route mounting. Keep it as the composition root, but have it call domain `mount*Routes(app, options, deps)` functions and domain service builders in today's order. Each sub-slice below moves one contiguous group. | Do not alter middleware order, auth policy, or hosted-client endpoint selection. Coordinate with doc 054: workstreams slices (WS-004, WS-008, and later) actively mount routes in `app.ts`. Stop condition specific to this file: late-assigned `let` bindings (`artifactServer`, `supervisor`, `pushNotifier`, `retainedCollections`, `conversationSubscriptions`, `apiCommands`, `agentApiController`, `knownProjectsForGrants`) are read from closures; a group that reads one before assignment cannot move as-is. |
| 1.8a | Done 2026-11-06 | Public-share mounting | Move the public-share loopback loaders and the five public-share route mounts into `routes/public-share-mounting.ts`. | Self-contained: reads only `options` and four already-initialized locals. Mount position preserved. Tier 3 substitute: public-share Playwright specs. |
| 1.8b | Not started | Project file and git route mounting | Move the contiguous `/api/projects` file, glossary, git status/browse/revision, file completion/view search, working-tree, file-owner, incoming-commit and projection mounts into one domain mounting module. | Several routers share the `/api/projects` prefix, so their relative order is load-bearing; move the group whole. `createConversationContextRoutes({ supervisor })` sits inside the run and reads `supervisor` after assignment, which is safe at that point. Tier 3: client E2E for file viewer and source control. |
| 1.8c | Not started | Session reader factories | Move `readerCache`, `getOrCreateReader`, `readerFactory`, the Codex/Gemini/Grok/Pi reader factories, and `disposeSessionReaders` into a session-reader construction module that returns them. | Medium risk: the LRU reader cache, `sessionReadLifetime` abort, and disposal ordering are shared state. Read `topics/architecture-mandates.md` first. Unlocks 1.8e because the Supervisor options read these factories. |
| 1.8d | Not started | Issue and vocabulary services | Move the issue indexer/confirmer/content/status and vocabulary learning construction under `serverSettingsService` into a domain builder returning the services and their disposers. | Late-assigned `let` bindings are reassigned here and read by disposal; return them instead of assigning outer variables. Background refresh timers must keep their idle ownership. |
| 1.8e | Deferred | Supervisor construction | Move the ~270-line `new Supervisor({...})` options literal into a builder. | High risk: its callbacks close over most of `createApp`. Revisit only after 1.8c and 1.8d shrink what it captures. Tier 3 plus `pnpm test:e2e:sdk`. |

## Phase 2: Client Page And Component Boundaries

Prioritize React files where one component function owns many unrelated hooks
and effects. Extract feature hooks/components while keeping visible behavior
and props stable.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 2.1 | Done 2026-07-06 | `SessionPage.tsx` pure helpers | Move attachment conversion, text extraction, public-share prompt parsing, Codex config ack parsing, and title helpers into adjacent domain-named modules. | Move-only. Added focused helper tests; client console budget unchanged. Tier 2 because this is a client-visible page surface. |
| 2.2 | Done 2026-07-06 | `SessionPage.tsx` `/btw` aside orchestration | Extract aside prompt parsing, polling, split-pane focus state, and minimal aside composer helpers into a feature module/hook. | Moved `/btw` provider support, prompt/transcript parsing, poll/hydrate/run/stop state, split-pane routing, and shortcut handling into `useBtwAsides.ts`; page keeps generic composer transfer, custom command dispatch, and JSX wiring. |
| 2.3 | Done 2026-07-06 | `SessionPage.tsx` composer submission/attachments | Extract staged/uploaded attachment preparation and draft transfer helpers. | Preserved object URL cleanup and staged attachment batch invariants. Added focused helper tests; client console budget unchanged. Tier 3 substitute with focused client E2E. |
| 2.4 | Done 2026-07-06 | `MessageList.tsx` selection and quote behavior | Extract selected-text shielding, quote button placement, copy handling, and selection helpers. | Moved DOM-local selection/quote behavior into `useMessageListSelectionQuote.tsx`; `MessageList.tsx` still owns transcript rendering, scroll/follow state, search, and row actions. Tier 3 substitute with focused client E2E. |
| 2.5 | Not started | `MessageList.tsx` scroll/follow snapshots | Extract scroll-follow, catch-up, and retained scroll snapshot hooks. | High risk. Tripwire matrix: rendering row (`RENDERING_PERFORMANCE.md`, scrollback stability). Tier 3 plus manual browser pass. |
| 2.6 | Done 2026-07-06 | `MessageList.tsx` isearch UI state | Extract reverse search state/projections that are still DOM-local. | Moved React state, match projections, visible-group filtering, panel rendering, guide dispatch, and repeat timers into `useMessageListIsearch.tsx`; pure search selectors stay in `lib/sessionDetail/search.ts`. Tier 3 substitute with focused client E2E. |
| 2.7 | Done 2026-07-06 | `MessageInputToolbar.tsx` view/control split | Separate toolbar measurement/overflow logic from presentational controls. | Moved bottom-row overflow measurement helpers, layout signature, measured tier hook, and layout refs into `useMessageInputToolbarLayout.ts`; compact status/liveness display behavior remains in the toolbar. Tier 3 with client E2E. |
| 2.8 | Done 2026-07-06 | `MessageInput.tsx` textarea mechanics | Move undoable textarea edits, resize/collapsed cursor scrolling, slash suggestion matching, and speech target id helpers. | Browser undo/focus call sites stayed in `MessageInput.tsx`; focused helper/MessageInput tests and client E2E preserve behavior. |
| 2.9 | Done 2026-07-06 | `NewSessionForm.tsx` project/options helpers | Move project sorting, provider option resolution, recap/prompt-suggestion defaults, and attachment helpers. | Moved pure helpers only; i18n copy, workstream selector behavior, and staged upload/submission effects stayed in the form. Focused helper tests were added. |
| 2.10a | Done 2026-07-06 | Git diff large-preview admission guard | Add the server/client guard prerequisite before moving `GitStatusPage.tsx` diff preview components. | Server now returns bounded `previewSkipped` metadata before syntax highlighting oversized git previews; client also refuses to inject oversized highlighted HTML from older servers. |
| 2.10 | Done 2026-07-06 | `GitStatusPage.tsx` diff preview module | Extract diff fetch/render preview components after large-diff admission guards are in place. | Moved diff preview fetch/render, modal, skipped-preview state, and low-level diff renderers into `GitStatusDiffPreview.tsx`; page keeps selected-file/action/untracked-folder state and owns route-retention writes. |
| 2.11 | Done 2026-07-06 | `SessionPage.tsx` `/btw` sticky cards | Move sticky `/btw` footer-card JSX into a focused render component after slice 2.2 moved the orchestration hook. | Render-only follow-up to slice 2.2. `SessionPage.tsx` still owns composer routing and callback wiring; focused component tests cover actions and expanded transcript transfer. |
| 2.12 | Done 2026-11-07 | `MessageInput.tsx` bang completion state | Move the `!!` completion menu's state and candidate fetch into a feature hook. | Moved `BangMenuItem`, `bangCompletionQueryKey`, the menu and candidate state and the debounced completion fetch into `hooks/useComposerBangCompletion.ts`; the keyboard handling, Tab completion, Ctrl+↑ history cycling and menu rendering that act on it stay in the composer. Move-only; `MessageInput.tsx` budget 4,781 -> 4,692. `bang-command.spec.ts` now measures, in the browser, that each keystroke of a bang draft shows within 100 ms while the completion menu is open and a fetch comes back between keys. |
| 2.13 | Done 2026-11-07 | `MessageInput.tsx` recall drawer | Move the Ctrl+↑ recall drawer's state, handlers, keys and menu out of the composer. | Moved the drawer state, open/cancel/accept/go-to, and the keys it claims while open plus the Ctrl+↑ opener into `hooks/useComposerRecallDrawer.ts`, and its menu into `components/ComposerRecallMenu.tsx`. The composer keeps the touch-keyboard opener button, the blur cancel, and the bang Ctrl+↑ history that runs first; the ordering note stays at the call site. Move-only; the parameter conversions are listed in the landing note. `MessageInput.tsx` budget 4,692 -> 4,543. Tier 3, plus the new `composer-recall-drawer.spec.ts` keystroke check. |
| 2.14 | Done 2026-11-07 | `SessionPage.tsx` bang-command wiring | Move the page's `!!` command run, echo, transcript row actions and composer bang support into a feature hook. | Moved `runBangCommand`, `echoBangCommand`, the first-load display-object ids, `bangCommandHandlers`, `bangHistory` and `composerBangSupport` into `hooks/useSessionBangCommands.ts`, which returns the handlers and the composer support. Move-only; the parameter conversions are listed in the landing note. `SessionPage.tsx` budget 7,773 -> 7,655. Tier 3; `bang-command.spec.ts` (run, keystroke latency with the completion menu open, receipt) passes unchanged. |
| 2.15 | Done 2026-11-07 | `MessageInputToolbar.tsx` thinking control | Move the toolbar's thinking/effort button and menu, already its own component, into its own module. | Moved `ThinkingToolbarControl`, its `ToolbarThinkingControl` prop type (now exported for the toolbar's props), `getToolbarThinkingLabel`, `getToolbarThinkingTitle` and `THINKING_MENU_VIEWPORT_GUTTER_PX` into `components/ThinkingToolbarControl.tsx`. Move-only; `MessageInputToolbar.tsx` budget 4,059 -> 3,804. Tier 3; no typing path is involved. |
| 2.16 | Done 2026-11-07 | `NewSessionForm.tsx` and `MessageInput.tsx` speech state | Give both message boxes one copy of their dictation state and edit bookkeeping ([plan 178](178-shared-composer-dictation.md) slice 1). | Not move-only: a consolidation under plan 178, after its test pins (slice 0). Both boxes call `hooks/useComposerSpeechState.ts` for the speech refs and state, the textarea edit and replacement remaps, the pending-selection restore and the held-final clear, and `getSpeechInterimPreview` in `lib/speechRecognition.ts` for the interim mirror. No behavior change; the differences plan 178 lists stay as they are. Budgets `MessageInput.tsx` 4,543 -> 4,448 and `NewSessionForm.tsx` 5,975 -> 5,897. Tier 3, plus a new keystroke check in both boxes in `speech-caret-insertion.spec.ts`. |
| 2.17 | Done 2026-11-07 | `NewSessionForm.tsx` and `MessageInput.tsx` speech handlers | Give both message boxes one copy of their dictation handlers ([plan 178](178-shared-composer-dictation.md) slice 2). | Not move-only: a consolidation under plan 178. Both boxes call `hooks/useComposerSpeechHandlers.ts` for listening start and stop, caret retargeting, committing finals and interims, pending-state changes, failed transcriptions and cancel. What differs between the boxes comes in as options (plan 178 D2 to D7). No behavior change. Budgets `MessageInput.tsx` 4,448 -> 4,097 and `NewSessionForm.tsx` 5,897 -> 5,640. Tier 3, plus the slice 0 pins and the slice 1 keystroke check. |
| 2.18 | Done 2026-11-07 | `NewSessionForm.tsx` and `MessageInput.tsx` keys, paste and speech field | Give both message boxes one copy of their speech Escape keys, Enter-sends rule, paste file extraction and speech draft field ([plan 178](178-shared-composer-dictation.md) slice 3). | Not move-only: a consolidation under plan 178. Both boxes call `lib/composerKeys.ts` (`handleSpeechEscapeKey`, `isComposerEnterSend`, `getClipboardFiles`) and render `components/SpeechDraftField.tsx`. Each box keeps its key order and guards (plan 178 D8, D11). No behavior change. Budgets `MessageInput.tsx` 4,097 -> 4,023 and `NewSessionForm.tsx` 5,640 -> 5,571. Tier 3, plus the slice 1 keystroke check. |
| 2.19 | Done 2026-11-07 | `NewSessionForm.tsx` and `lib/sessionComposerSubmission.ts` attachment upload step | Give the message boxes one copy of the per-file attachment prepare step ([plan 178](178-shared-composer-dictation.md) slice 4). | Not move-only: a consolidation under plan 178. The session page's upload helper and the new-session box's three copies call `lib/composerAttachmentUpload.ts` (`prepareComposerAttachmentUpload`); each keeps its own upload call, previews and state (plan 178 A1 to A4). No behavior change. Budget `NewSessionForm.tsx` 5,571 -> 5,535. Tier 3. |
| 2.20 | Done 2026-11-07 | `FloatingActionButton.tsx` dictation | Give the floating composer the shared dictation core ([plan 178](178-shared-composer-dictation.md) slice 5). | Not move-only: a consolidation under plan 178. The floating composer calls `useComposerSpeechState`, `useComposerSpeechHandlers`, `handleSpeechEscapeKey` and `SpeechDraftField`, and keeps its own pending-state and cancel handlers (plan 178 F1 to F6). No behavior change. 739 -> 433 lines (under the budget threshold). Tier 3, plus the floating composer in the keystroke check. |
| 2.21 | Done 2026-11-07 | `SessionPage.tsx` submission decision | Turn the session page's submission preparation into a plain decision ([plan 179](179-session-composer-send-decisions.md) slice 1). | Not move-only: under plan 179. `resolveComposerSubmission` in `lib/sessionComposerSendDecisions.ts` decides; `prepareComposerSubmission` applies it in today's order. No behavior change. Budget `SessionPage.tsx` 7,655 -> 7,563. Tier 3, plus plan 179's slice 0 pins. |
| 2.22 | Done 2026-11-07 | `SessionPage.tsx` send and queue decisions | Move `handleSend`'s and `handleQueue`'s decisions into plain functions ([plan 179](179-session-composer-send-decisions.md) slice 2). | Not move-only: under plan 179. `planSend`, `planQueue`, the resume options, the failure steps, retry predicates and final notice in `lib/sessionComposerSendDecisions.ts`; the page keeps its effects in order. No behavior change. Budget `SessionPage.tsx` 7,563 -> 7,525. Tier 3, plus plan 179's slice 0 pins. |
| 2.23 | Done 2026-11-07 | `SessionPage.tsx` Project Queue decisions | Move `queueComposerForProject`'s decisions into plain functions ([plan 179](179-session-composer-send-decisions.md) slice 3). | Not move-only: under plan 179, after its legacy start-now pin. `resolveProjectQueueCommand`, `planProjectQueue` and `projectQueueQueuedMessage` in `lib/sessionComposerSendDecisions.ts`; the page keeps its effects in order. No behavior change. Budget `SessionPage.tsx` 7,525 -> 7,475. Tier 3, plus plan 179's slice 0 pins. |
| 2.24 | Done 2026-11-07 | `SessionPage.tsx` send module | Move the page's four sending functions into a plain send module the page calls each render ([plan 179](179-session-composer-send-decisions.md) slice 4). | Move-only: `prepareComposerSubmission`, `handleSend`, `handleQueue` and `queueComposerForProject` move verbatim into `createSessionComposerSend` in new `lib/sessionComposerSend.ts`, called where `handleSend` stood. The closure reads become a deps object, and the four callbacks the page declares later are passed as wrappers (listed in the landing note). No behavior change. Budget `SessionPage.tsx` 7,475 -> 6,560; the new module is 1,214 lines. Tier 3, plus plan 179's slice 0 pins. |
| 2.25 | Done 2026-11-07 | `NewSessionForm.tsx` option section | Move the New Session options' section wrapper into its own module. | Move-only: `NewSessionOptionSection` and its props into `components/NewSessionOptionSection.tsx`. `NewSessionForm.tsx` 5,535 -> 5,503 lines; its budget stays at 5,535 until the next commit (see the landing note). Tier 3 at the series tip. |
| 2.26 | Done 2026-11-07 | `NewSessionForm.tsx` option state | Give the New Session form's option choices one owner, a reducer ([plan 180](180-new-session-options-and-start.md) slice 1). | Not move-only: a consolidation under plan 180, after its slice 0 pins. The sixteen option `useState` fields become one `useReducer` over `lib/newSessionOptionsState.ts`, whose plain functions compute the seed, lock, provider switch, model fills, thinking choice, sandbox toggle and the automatic save's body; the form destructures the state under the same names and dispatches where it set state. No behavior change. Budget `NewSessionForm.tsx` 5,526 -> 5,339. Tier 3, plus plan 180's slice 0 pins. |
| 2.27 | Done 2026-11-07 | `NewSessionForm.tsx` options hook | Move the New Session option state, its reads, derived values and effects into one hook ([plan 180](180-new-session-options-and-start.md) slice 2). | Not move-only: a consolidation under plan 180, because hook and effect order change (see the landing note). The reducer, the provider, settings, descriptor, router and subscription reads, every derived option value, the seed, lock, fill, source and save effects, and the provider, model and mode handlers move verbatim into `useNewSessionOptions` in new `hooks/useNewSessionOptions.ts`, called where the sandbox values stood. The inline choices call its `customizeOptions`. No behavior change. Budget `NewSessionForm.tsx` 5,339 -> 4,737; the hook is 820 lines. Tier 3, plus plan 180's slice 0 pins. |
| 2.28 | Done 2026-11-07 | `NewSessionForm.tsx` options panel | Move the New Session options markup into a panel component ([plan 180](180-new-session-options-and-start.md) slice 3). | Move-only apart from props and one declared hunk: the section builders, label maps, model options, catalog notice, captions and advanced-options state, and the provider slot, advanced toggle and secondary options move into `NewSessionOptionsPanel` in new `components/NewSessionOptionsPanel.tsx`, which returns them as a fragment in the same grid. `providerSlotFilled` stays in the form, rewritten over the values the moved sections depend on (see the landing note). No behavior change. Budget `NewSessionForm.tsx` 4,737 -> 3,748; the panel is 1,085 lines. Tier 3, plus plan 180's slice 0 pins. |
| 2.29 | Done 2026-11-07 | `NewSessionForm.tsx` start and Queue decisions | Move the New Session start's and Project Queue's decisions into plain functions ([plan 180](180-new-session-options-and-start.md) slice 4). | Not move-only: a consolidation under plan 180. The start refusals and text, the session options, Queue's refusals on both sides of the dictation defer, Queue's direct-catalog target and the start failure toast become `planNewSessionStart`, `buildNewSessionStartOptions`, `projectQueueRefusalBeforeDefer`, `planNewSessionProjectQueue`, `buildProjectQueueNewSessionTarget` and `newSessionStartErrorMessage` in new `lib/newSessionStartDecisions.ts`, with unit tests per branch; the form keeps its effects, including the defer, in place. No behavior change. Budget `NewSessionForm.tsx` 3,748 -> 3,628. Tier 3, plus plan 180's slice 0 pins. |
| 2.30 | Done 2026-11-07 | `NewSessionForm.tsx` start module | Move the New Session start's and Project Queue's bodies into a plain start module ([plan 180](180-new-session-options-and-start.md) slice 5). | Move-only apart from turning closure reads into deps objects and moving three types the module needs: the bodies of `handleStartSession` and `handleQueueProjectSession` move verbatim into `startNewSession` and `queueNewSessionForProject` in new `lib/newSessionStart.ts`. The form keeps `handleStartSession` as a `useCallback` with its dependency list unchanged and `handleQueueProjectSession` as a plain arrow. No behavior change. Budget `NewSessionForm.tsx` 3,628 -> 3,135; the module is 953 lines. Tier 3, plus plan 180's slice 0 pins. |
| 2.31 | Done 2026-11-08 | `SessionPage.tsx` fork, clone, handoff and copy | Move the page's fork, clone, handoff and copy actions into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 1). | Move-only: the fork-summary draft and its refs, the fork, clone, fork-summary and handoff callbacks, the auto-open effect, `copyUserMessage` and the `messageKey` helper move verbatim into `hooks/useSessionForkActions.ts`, called right after `activityRenderItems`. The draft state moves later in the hook order; no effect changes order. `draftControlsRef` joined four dependency lists (a ref). Budget `SessionPage.tsx` 6,560 -> 6,142; the hook is 575 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.32 | Done 2026-11-08 | `SessionPage.tsx` queued-message actions | Move the page's actions on deferred, recovered and Project Queue messages into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 2). | Move-only: the thirteen handlers, `restoreQueuedMessageToComposer` and the `isMissingDeferredQueueEntryError` helper move verbatim into `hooks/useSessionQueuedMessageActions.ts`, called where they stood. Callbacks only, so no order change. Five refs and `setCorrectionDraft` joined dependency lists (see the landing note). Budget `SessionPage.tsx` 6,142 -> 5,819; the hook is 493 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.33 | Done 2026-11-08 | `SessionPage.tsx` title editing | Move the page's rename field, generated retitle and `/title` command into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 3). | Move-only: the editing state and refs, `attachTitleInput`, the retitle ref sync effect, the title handlers, the two Escape and parked-cancel effects and the `TitleEditMode` and `GeneratedRetitleState` types move verbatim into `hooks/useSessionTitleEditing.ts`, called where the handlers began. The state and the ref sync effect move later in the hook order; the ref sync is not observable (see the landing note). No dependency list changed. Budget `SessionPage.tsx` 5,819 -> 5,546; the hook is 379 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.34 | Done 2026-11-08 | `SessionPage.tsx` attachment upload | Move the page's attachment upload, incoming share and remove step into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 4). | Move-only: `uploadAttachedFiles`, `handleAttach`, the `useIncomingShareFiles` call and `handleRemoveAttachment` move verbatim into `hooks/useSessionAttachmentUploads.ts`, called where they stood, so the share hook's effects keep their place. Two refs and `setUploadProgress` joined dependency lists. Budget `SessionPage.tsx` 5,546 -> 5,383; the hook is 261 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.35 | Done 2026-11-08 | `SessionPage.tsx` recall and navigation actions | Move the page's recall entries, scroll-to-turn requests and navigation-state actions into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 5). | Move-only: the turn and command recall, the scroll-to-turn request, the search-match and non-human-turn navigation hooks and the navigation-state actions with their early-typing effects move verbatim into `hooks/useSessionTranscriptJumps.ts`, called where they stood, so no effect changes order. Three early-typing refs joined dependency lists, including the unmount-only effect's. Budget `SessionPage.tsx` 5,383 -> 5,231; the hook is 260 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.36 | Done 2026-11-08 | `SessionPage.tsx` route sync | Move the page's visit record and URL replacements into a feature hook ([plan 181](181-session-page-feature-hooks.md) slice 6). | Move-only: the four effects that record the visit and replace the URL for a real session id, a native-id viewer URL and the canonical project move verbatim into `hooks/useSessionRouteSync.ts`, called where they stood. No dependency list changed. Budget `SessionPage.tsx` 5,231 -> 5,157; the hook is 122 lines. Tier 3, plus plan 181's slice 0 pins. |
| 2.37 | Done 2026-11-08 | `SessionPage.tsx` header actions | Move the page's archive, star, suggestions, read, terminate, restart and share actions into a feature hook ([plan 182](182-session-page-header-and-footer.md) slice 1). | Move-only: the eleven handlers and values, the read-shortcut effect and the share modal state move verbatim into `hooks/useSessionHeaderActions.ts`, called where the handlers stood, so the effect keeps its place. The share state moves later in the hook order; nothing between reads it. No dependency list changed. Budget `SessionPage.tsx` 5,157 -> 5,019; the hook is 263 lines. Tier 3, plus plan 182's slice 0 pins. |
| 2.38 | Done 2026-11-08 | `SessionPage.tsx` project move menu | Move the page's project move menu into a feature hook ([plan 182](182-session-page-header-and-footer.md) slice 2). | Move-only: the menu state and its two refs, the options, the outside-click and Escape effect and the two handlers move verbatim into `hooks/useProjectReclassifyMenu.ts`, called where the options stood, so the effect keeps its place. The state moves later in the hook order; nothing between reads it. `setShowRecentSessions` joined one dependency list (a state setter). Budget `SessionPage.tsx` 5,019 -> 4,930; the hook is 164 lines. Tier 3, plus plan 182's slice 0 pins. |
| 2.39 | Done 2026-11-08 | `SessionPage.tsx` pop-ups | Move the page's five pop-ups into a component ([plan 182](182-session-page-header-and-footer.md) slice 3). | Move-only: the project defaults, recap, long-context warning, model and info, and handoff pop-ups move verbatim into `components/SessionPageModals.tsx`, rendered where they stood. Every prop is passed as `name={name}`, and the component's JSX equals the moved lines apart from whitespace. The component calls only `useI18n` and `useToastContext`, so the page's hook order is unchanged. Budget `SessionPage.tsx` 4,930 -> 4,813; the component is 296 lines. Tier 3, plus plan 182's slice 0 pins. |
| 2.40 | Done 2026-11-08 | `SessionPage.tsx` header | Move the page's `<header>` into a component ([plan 182](182-session-page-header-and-footer.md) slice 4). | Move-only: the header element and the `SidebarIcon` it renders move verbatim into `components/SessionHeader.tsx`, rendered where the header stood. Every prop is passed as `name={name}`, and the component's JSX equals the moved lines apart from whitespace and one trailing comma the formatter dropped. The component calls only `useI18n`, so the page's hook order is unchanged; `SidebarIcon` is still defined during render. Budget `SessionPage.tsx` 4,813 -> 4,262; the component is 991 lines. Tier 3, plus plan 182's slice 0 pins. |
| 2.41 | Done 2026-11-08 | `SessionPage.tsx` composer footer | Move the page's `<footer>` into a component ([plan 182](182-session-page-header-and-footer.md) slice 5). | Move-only: the footer element moves verbatim into `components/SessionComposerFooter.tsx`, rendered where it stood, with the composer's `lazy()` wrapper, its only user; the shared module fallback moves to `components/SessionRouteModuleFallback.tsx`. Every prop is passed as `name={name}`, and the component's JSX equals the moved lines apart from whitespace and two trailing commas the formatter dropped. The component calls only `useI18n` and `useToastContext`, so the page's hook order is unchanged; the composer stays in its own lazy chunk. Budget `SessionPage.tsx` 4,262 -> 3,909; the component is 799 lines. Tier 3, plus plan 182's slice 0 pins. |
| 2.42 | Done 2026-11-08 | `MessageInput.tsx` send routes | Give the message box one send route ([plan 184](184-message-box-send-routes.md) slice 1). | Not move-only, under plan 184: the eight send functions become one synchronous `deliver(route)`, with its decisions in `lib/composerDelivery.ts` (unit-tested), and the differences between the copies that had no reason behind them unified (plan 184 C1 to C9: fork mode delivers only forks; a press that cannot deliver sets nothing aside; `!!` runs from every route but the forks and a bare `!!` does nothing; empty text is never prefixed; a dictated draft keeps its whole route and comes back if refused; voice auto-send takes the main action's route). Budget `MessageInput.tsx` 4,023 -> 3,616; the decisions module is 200 lines. Tier 3, plus plan 184's slice 0 pins. |
| 2.43 | Done 2026-11-08 | `MessageInput.tsx` delivery hook | Move the message box's delivery into a feature hook ([plan 184](184-message-box-send-routes.md) slice 2). | Move-only apart from parameters: `deliver`, setting a dictated draft aside and replaying or restoring it, the question aside submission, the touch delivery handlers and voice auto-send move into `hooks/useComposerDelivery.ts`, called where the delivery stood, before `useComposerSpeechHandlers`. The five refs only delivery uses move with it; 42 box values become inputs of the same names. Dependency lists gain only refs and setters that became inputs. Budget `MessageInput.tsx` 3,616 -> 3,185; the hook is 675 lines. Tier 3, plus plan 184's slice 0 pins. |
| 2.44 | Done 2026-11-08 | `SessionPage.tsx` attachment state | Move the page's composer attachment state into a feature hook ([plan 187](187-session-page-draft-hooks.md) slice 1). | Move-only: the attachment list and its ref, upload progress, the in-flight uploads, the draft batch and hydration refs, the edit blocker, the navigation guard, the draft write, `setComposerAttachments`, the unmount preview cleanup, `ensureDraftAttachmentBatchId` and `materializeComposerAttachments` move verbatim into `hooks/useSessionComposerAttachments.ts`, called where the edit blocker stood, so the effects keep their order. The state moves later in the hook order; nothing between reads it. Two input refs joined three dependency lists, and a `biome.json` `stableResult` entry keeps the page's lists as they were. Budget `SessionPage.tsx` 3,903 -> 3,803; the hook is 179 lines. Tier 3, plus plan 187's slice 0 pins. |

## Phase 3: Existing Architecture-Aligned Migrations

These areas already have accepted topic/tactical documents. This worklog does
not fork their plans; it only records where LOC reduction can happen as part
of their planned slices.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 3.1 | Done 2026-07-06 | `useSessionMessages.ts` adapter cutdown | Continue the existing session-detail data-layer migration by shaving reveal/progress/pagination bookkeeping into tested helpers. | Moved returned-detail reveal gating, store-backed return selection, empty transcript fallbacks, returned tool-use map construction, and exported agent-content types into `sessionDetail/returnedDetail.ts` / `sessionDetail/types.ts`; hook still owns async load/reveal timing and stream/scroll side effects. |
| 3.2 | Done 2026-07-06 | `clientSummaryState.ts` source-store helpers | Split pure collection/reducer/query helpers only when touching summary-state behavior. | Moved shared summary collection model/defaults into `clientSummaryCollections.ts` and read-only query/selector helpers into `clientSummaryQueries.ts`; reducer/update paths stay in `clientSummaryState.ts`. |
| 3.3 | Not started | `SecureConnection.ts` internals | Extract only when aligned with source-transport boundary work or clear pure helpers. | Owned by `topics/source-transport.md` / doc 057; preserve parity rows and full transport tests. |
| 3.4 | Done 2026-07-06 | `api/client.ts` Git domain client | Extract the first domain-specific API module once source transport shims are stable. | Moved Git endpoint wrappers into `gitClient.ts` and the current-source JSON fetch helper into `sourceApiFetch.ts`; kept the exported `api` facade and `fetchJSON` export stable. |
| 3.5 | Done 2026-07-06 | `api/client.ts` Auth domain client | Continue with standalone endpoint clusters only when they stay behind the stable facade. | Moved auth status/setup/login/logout/password/localhost-access wrappers into `authClient.ts`; kept the exported `api` facade and `AuthStatus` type export stable. |
| 3.6 | Done 2026-07-06 | `api/client.ts` Recents domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved recents fetch/visit/clear wrappers into `recentsClient.ts`; kept the exported `api` facade stable. |
| 3.7 | Done 2026-07-06 | `api/client.ts` Onboarding domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved onboarding status/complete/reset wrappers into `onboardingClient.ts`; kept the exported `api` facade stable. |
| 3.8 | Done 2026-07-06 | `api/client.ts` Browser Profiles domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved browser-profile list/delete wrappers into `browserProfilesClient.ts`; kept the exported `api` facade stable. |
| 3.9 | Done 2026-07-06 | `api/client.ts` Server Metadata domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved version, server-info, env-settings, and restart wrappers plus their public types into `serverMetadataClient.ts`; kept the exported `api` facade and type exports stable. Network binding stayed in `api/client.ts` because it mutates runtime listener configuration. |
| 3.10 | Done 2026-07-07 | `api/client.ts` Push Notifications domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved push public-key, subscribe/unsubscribe, subscriptions, test, delete, and notification-settings wrappers into `pushClient.ts`; kept the exported `api` facade stable. `getConnections` stayed in `api/client.ts` because it is connected-device state, not a push route. |
| 3.11 | Done 2026-07-07 | `api/client.ts` File/Diff domain client | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Moved file fetch, raw file URL, and diff context expansion wrappers into `fileClient.ts`; kept the exported `api` facade stable. |
| 3.12 | Not started | `api/client.ts` additional domain clients | Continue extracting non-session endpoint clusters that stay behind the stable facade. | Good candidates: small read-only settings helpers. Treat public-share as session-adjacent, settings writes as moderate risk because of custom clear semantics, and network binding as runtime configuration work. |

Phase 3 scope note:
- Further `useSessionMessages` / `SessionDetailCoordinator` orchestration is
  out of scope for this lower-risk 058 pass. Doc 051 identifies the next
  coordinator move as consolidating the remaining initial-load effect into
  named hook/coordinator phases; that touches warm hydration order, reveal
  timing, progress state, stream-gate opening, cache writes, and missing-store
  diagnostics. That is real session-detail lifecycle work, not a small
  move-only module-boundary cleanup. Revive it through the session-detail/source
  runtime plans when those semantics are the priority.

## Open seam inventory: later hub growth

[`gaps/sketches/oversized-hub-modules.md`](../../gaps/sketches/oversized-hub-modules.md) records
later feature growth in four files already governed by this worklog. Size alone
does not authorize a split; use these cohesive seams when work next opens the
owning behavior:

- `Process.ts`: effort-control serialization, deferred-queue persistence, and
  Codex terminal-status construction are separate candidates. Queue persistence
  extends deferred slice 5.3; the other two need new Phase 5 rows and their own
  lifecycle/streaming tripwire review before movement.
- `MessageInput.tsx`: the bang completion state and the recall drawer
  moved in slices 2.12 and 2.13, and the send paths, made one route, in
  slices 2.42 and 2.43 (plan 184). The bang keyboard handling and menu
  rendering stay in the composer with the slash menu's; no other named
  candidate remains.
- `clientSummaryState.ts`: session-id aliasing, record merge, and projection
  rewrites around `mergeRemappedSessionRecords` form a candidate remap module.
  It extends slice 3.2 only if the reducer update stays behavior-identical and
  the full remap fixture matrix moves with it.
- `SessionPage.tsx`: recall wiring and navigation-state consumption moved
  in slice 2.35 (plan 181), and the header, title markup included, the
  composer footer and the pop-ups, with the header's actions and project move
  menu, in slices 2.37 to 2.41 (plan 182). The
  correction draft, the attachment state and draft hydration, and the
  transcript region remain as possible follow-ups; choose
  one feature boundary per follow-up rather than another general page-helper
  module.

Remove a candidate from this section when its slice lands or fresh inspection
shows the seam is no longer coherent. Delete the gap only when all four
recorded ownership defects are resolved or replaced by narrower gaps.

## Phase 4: Provider Adapter Splits

Provider files are large, but they touch upstream-facing behavior. Prefer
extracting pure protocol/model/normalization modules with strong fixtures.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 4.1 | Done 2026-11-08 | `sdk/providers/codex.ts` app-server client | Move `CodexAppServerClient`, JSON-RPC queueing and process termination into `codex-app-server-client.ts`. | Tripwire matrix: Codex row. Run Codex provider tests and server E2E. The JSON-RPC wire types already live in `codex-json-rpc.ts` (slice 4.4) and the `log` wrapper in `codex-log.ts` (slice 4.8). Moved with `AsyncQueue`, `CodexNotificationReceipt`, the `terminateChildProcess` helpers and their three timing constants (580 lines). The model-list probe's raw requests and their request-id constants stay in `codex.ts`, which imports `terminateChildProcess` for that probe. The provider-wide termination copies are recorded in `gaps/process-group-signalling-copies.md`; this row keeps Codex's own sequence unchanged. |
| 4.2 | Done 2026-07-06 | Codex model catalog helpers | Move fallback model data, semver parsing, model sorting, and model metadata normalization. | App-server process/query/cache ownership stayed in `codex.ts`; focused catalog tests pin fallback selection and normalized ordering. |
| 4.3 | Done 2026-07-06 | Codex notification guards | Move `as*Notification` guards and raw notification classifiers into a protocol module. | Guard-only extraction; approval request param guards stay in `codex.ts`. Focused guard tests and existing Codex provider fixtures preserve stream/persisted conversion behavior. |
| 4.4 | Done 2026-11-08 | Codex live event conversion | Move the stateless conversion: item normalization and item-to-SDK conversion to `codex-item-conversion.ts`; notification/raw-response conversion, live streaming state and builders, turn usage and error request-id extraction to `codex-live-event-conversion.ts`; JSON-RPC wire types to `codex-json-rpc.ts`. | Re-scoped from "live turn state": the per-turn runtime state, live-delta suppression and replay stay in `runSession`. The two conversion modules are split because one would exceed the 1,500-line new-file ceiling, and the live module imports the item module, never the reverse. The live, durable and Codex OSS copies of the conversion disagree; see `gaps/codex-conversion-three-copies.md`. |
| 4.5 | Done 2026-07-06 | Codex recap/summary helpers | Move recap prompts, fork-backed summary prompt/params, retitle prompt, helper model selection, text cleanup, and summary capture helpers. | App-server orchestration and non-turn request decline behavior stayed in `codex.ts`; focused helper/provider/render-parity tests preserve provider-visible prompts and summary output behavior. |
| 4.6 | Done 2026-07-06 | OpenCode provider model helpers | Move OpenCode model selection, local-GLM model descriptions, and verbose variant parsing. | Provider process/HTTP/SSE orchestration and message conversion stayed in `opencode.ts`; no Claude/OpenCode shared abstraction introduced. |
| 4.7 | Done 2026-11-08 | Codex failure trace | Move the failure-trace recorder, snapshot/format helpers and the notification/SDK-message trace descriptions (`recordCodexFailureTraceEvent` through `previewTraceString`) into `codex-failure-trace.ts`. | 368 lines. They use no provider state; besides each other, the trace constants and interfaces that move with them, and the `codex-notification-guards.ts` guards, they read only the conversion modules' `getOptionalString`, `normalizeStatus`, `extractErrorRecord`, `extractOpenAIRequestId` and `stringifyTraceValue`. `runSession` imports the recorder, snapshot, format and describe functions and the `CodexFailureTrace` type. Move-only, Tier 1 plus the Codex provider tests. |
| 4.8 | Done 2026-11-08 | Codex approvals | Move `handleServerRequestApproval`, the approval decision/permission-response helpers and the approval request param guards (`as*RequestApprovalParams`, `asToolRequestUserInputParams`) into `codex-approvals.ts`. | 519 lines. `normalizePermissionMode` stays in `codex.ts`; the `permissionMode` default that called it became a required parameter (the permitted dependency-parameter conversion), since every caller already passed it. The `codex.ts` `log` wrapper moved verbatim to `codex-log.ts` so both modules log as `codex-provider`. The guards were left out of slice 4.3 on purpose and belong here. The Codex approval tests pin the decisions. |
| 4.9 | Needs plan | Codex session lifecycle | Replace the closure bag that `startSessionInternal` returns (abort, model/effort, steer, interrupt, goal/status/usage/compact commands) with an explicit Codex session object, and split `runSession` into setup, turn consumer and message loop. | Not a move-only slice: it changes how state is shared. Most of the file's churn since 2026-08 is in these two regions (goals, reload survival, liveness probes, stale-turn rejection, overload retry). Write a plan doc first. It should build on the existing `AgentSession`/provider-owner seam, not add a new normalized event vocabulary (see `docs/competitive/t3code-provider-architecture.md`). The config-dependent thread and turn param builders (`buildThreadConfigOverrides`, `createThreadStartParams`/`ResumeParams`/`ForkParams`, `createTurnStartParams`) and the recap/fork-summary helpers stayed in `codex.ts` after slice 4.10 because they read provider configuration getters, the model cache and the provider's own app-server setup; the session object should own that configuration. Tier 3. |
| 4.10 | Done 2026-11-08 | Codex thread policy and skill input | Move the pure thread/turn policy helpers and fork-anchor resolution to `codex-thread-params.ts`, and slash-command and skill-input assembly to `codex-skill-inputs.ts`. | 223 and 102 lines. They read no provider state. `refreshCodexSkills` stays because `codex-dynamic-results.test.ts` stubs it on the provider; `startOrResumeThread` and `createInitializeParams` stay with the app-server setup. Move-only, Tier 1 plus the Codex provider tests. |

## Phase 5: Load-Bearing Supervisor And Process Files

Intentionally late. Size alone is not enough reason to split these files
because they own process lifecycle, replay, fan-out, idle cleanup, queues, and
heartbeat behavior.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 5.1 | Deferred | `Process.ts` pure helper extraction | Move static/pure helpers for message text, API retry status, permission pattern matching, and formatting when touched. | Move-only; no stream/replay/timer changes. Tripwire matrix: architecture-mandates row. |
| 5.2 | Deferred | `Process.ts` recap helper boundary | Consider extracting recap generation helpers if recap work resumes. | Preserve native recap waiters and pending recap flow. |
| 5.3 | Deferred | `Process.ts` queue persistence helpers | Consider extracting patient/deferred queue persistence helpers only with queue-specific tests. | Idle sessions must not retain repeating work. |
| 5.4 | Deferred | `Supervisor.ts` recap/compaction helpers | Extract pure compaction threshold, heartbeat candidate, and recap helper functions opportunistically. | Do not alter worker pool, preemption, liveness, or heartbeat scheduling. |

## Phase 6: Tests And Fixtures Organization

Large tests are acceptable when they read like scenario ledgers, but splitting
can improve review when scenarios are independent.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 6.1 | Done 2026-07-06 | `MessageList.test.tsx` scenario files | Split by behavior area: progressive rendering, thinking, queue rows, selection/copy, scroll, search. | Split into six scenario files plus `MessageList.test-support.tsx`; assertions and shared fixture behavior preserved. |
| 6.2 | Done 2026-07-06 | `process.test.ts` scenario files | Split by queue, approvals, replay/streaming, liveness, recap, termination. | Split into nine scenario files plus `process.test-support.ts`; fake-timer tests stayed in the liveness group and keep their existing `finally` cleanup. |
| 6.3 | Done 2026-07-06 | `codex.test.ts` fixtures | Move repeated raw notification fixtures and expected SDK outputs into fixture modules. | Extracted scenario-named event fixtures only; conversion calls and assertions stay explicit in `codex.test.ts`. |
| 6.4 | Not started | Route metadata tests | Split route metadata tests once route modules split. | Keep request/response assertions explicit. |

## Phase 7: Shared Contract Registries

`packages/shared` registries are data, not control flow, and nearly
append-only: every new client/server contract adds an entry. They are cheap to
split along their own classification fields, and splitting them removes the
merge hot spot that feature work otherwise shares. Read
[server capabilities](../../topics/server-capabilities.md) before touching the
capability registry.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 7.1 | Done 2026-11-06 | `server-capabilities.ts` by `area` | Move each `SERVER_CAPABILITIES` entry into `server-capabilities-<area>.ts` for its existing `area` field, and compose them back into the unchanged registry. | Runtime use is name/key lookup only; `capabilities:audit` output byte-identical. Definition types and the optional-bit allocation table moved to their own modules so area modules do not import the hub. |
| 7.2 | Not started | Sessions capability area | `server-capabilities-sessions.ts` starts at 1,396 lines, a few entries under the 1,500-line threshold. When the next entry would cross it, move the Agent Auth Router entries (`agentAuthRouter*`, six entries) and the session-creation entries (`sessionCreationAdmission`, `stagedSessionCreation`, the four `*TextCreation` entries) into their own modules, still `area: "sessions"`. | Move-only, same checks as 7.1. Do not change any entry's `area` value to fit a module; the field is registry data shown by the audit. |

## Landing Template

Each landed slice updates its row and appends a note here (newest first):

```text
### Slice N.M — <short title> (Landed YYYY-MM-DD, <commit>)
Moved:
- <symbol> -> <new module>
Signature conversions (closure -> parameter), if any:
- ...
Behavior changes:
- None. (Anything else means the slice was mis-cut; see stop conditions.)
Verification:
- Tier <1|2|3>: <commands run>
- Skipped: <required check, reason, substitute> (omit if none)
Follow-ups recorded:
- ...
```

## Landing Notes

### Slice 2.44 — Session Page Attachment State (Landed 2026-11-08, this commit)

Move-only. [Plan 187](187-session-page-draft-hooks.md) slice 1.

Moved to new `packages/client/src/hooks/useSessionComposerAttachments.ts`,
as `useSessionComposerAttachments`, called where the edit-blocker effect
stood, right after `attachmentQuality`:
- `attachments`, `attachmentsRef`, `draftAttachmentBatchIdRef`,
  `draftAttachmentHydrationRef` and `uploadProgress`, with their comment.
  They moved later in the hook order, past the draft signal, the edit
  availability and transcript position stores and `attachmentQuality`;
  none of those reads them.
- The edit-blocker effect and `pendingUploadsRef`.
- The navigation guard, `writeDraftAttachmentState`,
  `setComposerAttachments`, the unmount-only preview cleanup,
  `ensureDraftAttachmentBatchId` and `materializeComposerAttachments`.
- `updateTranscriptDisplayObjectsForSession` and `rememberSentSubmission`,
  which stood between these, stay in the page after the call; they are
  `useCallback`s. The moved effects keep their order, and no page effect
  stood between them.
- `SessionPage.tsx` 3,903 -> 3,803 lines; the hook is 179.

Signature conversions (closure -> parameter):
- The hook takes `composerEditAvailabilityStore`, `draftControlsRef`,
  `preCorrectionDraftRef` (until slice 2 moves the pre-correction cleanup),
  `projectId`, `sessionId` and `sourceTransport`. It returns the five
  state values and refs, `setUploadProgress`, `pendingUploadsRef`,
  `setComposerAttachments`, `ensureDraftAttachmentBatchId` and
  `materializeComposerAttachments`; `writeDraftAttachmentState` stays
  inside.
- Dependency lists gain only input refs: `draftControlsRef` in
  `writeDraftAttachmentState` and `ensureDraftAttachmentBatchId`, and
  `preCorrectionDraftRef` in the unmount cleanup. Refs keep their
  identity, so nothing is rebuilt more often and the cleanup still runs
  only on unmount.
- `biome.json` declares the hook's returned refs and setter
  (`attachmentsRef`, `draftAttachmentBatchIdRef`,
  `draftAttachmentHydrationRef`, `setUploadProgress`,
  `pendingUploadsRef`) stable, as `useComposerSpeechState`'s are, so the
  page code that reads them keeps its dependency lists.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice apart from one server test,
  `claude-gateway-launcher.test.ts` "pins localhost to the address family
  that answers", which got the IPv4 address under load and passed 27 of
  27 run alone. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 581 passed, 13 skipped, 4 failed:
  `artifact-viewer.spec.ts:136`, the known failure recorded in the
  artifact viewer gap; `router-pools.spec.ts:25` and
  `router-recovery.spec.ts:27`, which find a 32 px button where they
  expect at least 38; and `session-page-header-paths.spec.ts:496`, whose
  account chip no longer opens the Info tab. The last three fail the
  same way run alone at `558f978dd`, which was origin/main then, without
  this plan's commits. Plan 187's slice 0 pins pass at this commit.
- A script compared the moved lines with the hook's body, whitespace
  aside: the only differences are the three dependency entries above.

### Slice 2.43 — Message Box Delivery Hook (Landed 2026-11-08, this commit)

Move-only apart from parameters. [Plan 184](184-message-box-send-routes.md)
slice 2.

Moved to new `packages/client/src/hooks/useComposerDelivery.ts`, as
`useComposerDelivery`, called where `deferSpeechDelivery` stood, after the
speech state and composition metadata it reads and before
`useComposerSpeechHandlers`, which takes its replay, restore and
auto-send functions:
- `deferSpeechDelivery`, `handleQuestionAsideSubmission`, `queueHandler`,
  `forkMode`, `primaryRoute`, `deliver`, `restoreSetAsideDraft`,
  `restorePendingSpeechDeliveryDraft`, `runPendingSpeechDelivery` with
  its ref assignment and `maybeRunPendingSpeechDelivery`.
- `runComposerPointerDelivery`, `deliverFromPointer`, the seven touch
  delivery handlers and `queueNewSessionAtChosenTarget`. The new-session
  options' open and close callbacks stay in the box.
- Voice auto-send's ref assignment and `handleSmartTurnSend`, from later in
  the box; nothing between the two places reads them during render.
- The refs only these use (`mobilePointerDeliveryPendingRef`,
  `pendingSpeechDeliveryRef`, `pendingSpeechDeliverySettledRef`,
  `runPendingSpeechDeliveryRef`, `smartTurnSendRef`), declared at the
  hook's start; nothing read them during render before the call. The hook
  returns the two the box still reads.
- The `SubmissionCompositionSnapshot` and `PendingSpeechDelivery` types,
  now exported; the box imports the first.
- `MessageInput.tsx` 3,616 -> 3,185 lines.

Signature conversions (closure -> parameter):
- The box values the bodies read become fields of an exported
  `ComposerDeliveryInputs`, destructured under the same names (42):
  `activeSpeechTargetIdRef`, `attachments`, `bangSupport`,
  `buildSubmissionMetadata`, `canSaveQuestionAside`,
  `consumeSpeechAttribution`, `controls`, `disabled`,
  `effectivePrimaryActionKind`, `forkSummaryMode`, `interimTranscriptRef`,
  `isComposing`, `isRecentSpeechAttribution`,
  `keepMobileKeyboardOpenAfterDelivery`, `lastEditedAtRef`, `onDone`,
  `onProjectQueue`, `onProjectQueueNewSession`, `onQueue`, `onSend`,
  `patientQueueCompactPercent`, `patientQueueEnabled`,
  `pendingSpeechFinalRef`, `pendingSpeechRetargetRef`, `questionAside`,
  `questionAsideEligible`, `resetCompositionMetadata`,
  `setInterimTranscript`, `setNewSessionOptionsMode`,
  `setTextareaImeGeneration`, `speechInsertionRangeRef`,
  `speechInsertionRangesRef`, `speechMessagePrefix`, `speechPendingRef`,
  `speechTranscriptionIdsRef`, `speechTurnIdRef`, `textareaRef`,
  `topicShiftCompactPercent`, `topicShiftSupported`,
  `typingStartedAtRef`, `uploadProgress` and `voiceButtonRef`. The speech
  refs take `useComposerSpeechState`'s types; the props take the parts the
  bodies read.
- Dependency lists gain only the refs and setters that became inputs
  (stable identities), which the hooks lint rule asks for now that they
  are not the hook's own: `deferSpeechDelivery`, `handleQuestionAsideSubmission`,
  `deliver`, `runPendingSpeechDelivery`, `runComposerPointerDelivery`,
  `queueNewSessionAtChosenTarget`, and the box's
  `getDetachedSpeechTransaction` (`pendingSpeechDeliveryRef`). Every body
  is otherwise the moved text.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 2 failed:
  `artifact-viewer.spec.ts:136`, the known failure recorded in the
  artifact viewer gap, and `session-header-responsive.spec.ts:29`, a
  live-update fixture row that did not appear in time; that spec passed
  3 of 3 run alone. Plan 184's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the touched files; `pnpm
  console:scan` is at its budgets (`method.warn` 60 of 60).
- A script compared the moved lines with the hook's body (blank lines
  aside): the only differences are the dependency entries above.

Follow-ups recorded:
- None.

### Slice 2.42 — Message Box Send Routes (Landed 2026-11-08, this commit)

Not move-only. [Plan 184](184-message-box-send-routes.md) slice 1, at
the maintainer's direction (2026-11-08) to unify differences between the
copies that had no reason behind them.

Replaced in `packages/client/src/components/MessageInput.tsx`:
- `handleSubmit`, `handleQueue`, `handleForkSummarySubmit`,
  `handleForkWithoutSummary`, `handleSyntheticDoneSubmission`,
  `submitToProjectQueue`, `handleProjectQueue`, `queueNewSessionAt`,
  `handleProjectQueueNewSession` and `submitPrimaryAction` -> one
  synchronous `deliver(route, options)` that returns whether the press
  was taken; the key handler, the touch delivery handlers, voice
  auto-send, the file view completion and the dictation replay call it
  with the route they called a function for.
- The decisions -> new `packages/client/src/lib/composerDelivery.ts`
  (`resolvePrimaryDeliveryRoute`, `canDeliverOnRoute`,
  `routeTriesQuestionAside`, `planComposerDelivery`), 200 lines, with
  `lib/__tests__/composerDelivery.test.ts`.
- The set-aside dictated draft stores its route; the replay releases it
  before delivering and restores the released copy on refusal or a throw.
  `dispatchingSettledSpeechDeliveryRef` is gone: every replay passes its
  text, so nothing can be set aside during one.
- Voice auto-send is read through a ref assigned during render, like the
  replay, so the voice button's callbacks keep their identity.
- `MessageInput.tsx` 4,023 -> 3,616 lines.

Behavior changes (plan 184 C1 to C9, each with a unit test but C6):
- C1: fork mode delivers only on the fork routes, not while a fork is
  submitting; a busy session's Queue and Steer buttons are hidden in it,
  and an empty box there does not offer to save the Q+A.
- C2: a press that cannot deliver sets no dictated draft aside.
- C3: `!!` runs locally from every route but the forks; C9: a bare `!!`
  does nothing there. No speech cue shows a prefix for either.
- C4: empty text is never prefixed.
- C5: every delivery closes the question aside.
- C6: queue reads the speech attribution before clearing, like the rest.
- C7: a dictated draft keeps its whole route (a topic shift used to come
  back as a plain queue) and comes back if refused or throwing.
- C8: voice auto-send takes the main action's route and reports exactly
  whether it was taken.
- `topics/mic-button-speech-ui.md` now says the pending intent is released
  when its action runs and keeps a copy of the draft until it accepts.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 2 failed:
  `artifact-viewer.spec.ts:136`, the known failure recorded in the
  artifact viewer gap, and `session-page-fork-paths.spec.ts:349`, a
  checkbox click that timed out while another worktree's Tier 2 ran
  alongside; that spec passed 42 of 42 run alone three times.
- The slice 0 pins pass; the topic shift pin now expects the patient
  intent with its source and threshold.

Follow-ups recorded:
- Plan 184 lists one open question (a Project Queue new session aimed at
  another project runs a `!!` draft in this session's project) and K4 (a
  set-aside `!!` command that fails is not restored).

### Slice 4.10 — Codex Thread Policy And Skill Input (Landed 2026-11-08, this commit)

Moved:
- Thread and turn policy -> new
  `packages/server/src/sdk/providers/codex-thread-params.ts`:
  `CODEX_POLICY_OVERRIDES`, `CodexThreadPolicy`, `normalizePermissionMode`,
  `mapPermissionModeToThreadPolicy`, `mapThreadSandboxToTurnSandbox`,
  `buildThreadPermissionParams`, `buildTurnPermissionParams` and
  `limitedUserThreadInstructions`; and fork-anchor resolution:
  `CodexThreadTurn`, `CodexForkAnchor`, `resolveCodexForkLastTurnId`,
  `computeCodexForkLastTurnId`, `findCodexForkAnchor` and
  `codexItemMatchesForkAnchor`.
- Slash-command and skill input -> new `codex-skill-inputs.ts`:
  `CODEX_DESKTOP_BROWSER_SKILL_NAME`, `createCodexSlashCommands` and
  `createCodexUserInputs`.
- Neither module imports `codex.ts`; the thread module imports the client
  type and `getOptionalString`. `codex.ts` went from 4,621 to 4,321 lines.
- Scoped down from the planned "thread/turn params and recap" slice. The
  builders that assemble thread config (`buildThreadConfigOverrides`,
  `createThreadStartParams`, `createThreadResumeParams`,
  `createThreadForkParams`, `createTurnStartParams`) read three provider
  configuration getters and `mapEffortToReasoningEffort`, which reads the
  model cache. About 70 test references reach them through a provider whose
  getters the test configured. Passing that configuration in would rewrite
  those tests and drop the getter-wiring coverage. The recap and fork-summary
  helpers start their own app-server through provider methods. Both stay for
  row 4.9. `refreshCodexSkills` stays because `codex-dynamic-results.test.ts`
  replaces it with `vi.spyOn(provider, ...)` during `runSession`.

Signature conversions:
- None. The 12 moved private methods became module functions with `this.`
  and `provider.` dropped. A whitespace-insensitive comparison of every moved
  block with its original matches once `this.`, `private`, `export`,
  `function` and formatter trailing commas are ignored.
- In `codex.test.ts`, the "pairs every turn approval override" test casts the
  `codexThreadParams` namespace, because all three members it lists moved.
  The "builds stable thread policy params" test keeps its provider cast for
  `createThreadStartParams` and reaches `mapPermissionModeToThreadPolicy`
  through a namespace cast with the same declared type. No assertion changed.

Behavior changes:
- None.

Verification:
- Tier 1: server `tsc --noEmit` (`tsconfig.json`,
  `tsconfig.tool-display-tests.json`); `tsconfig.test.json` shows no new
  errors in the touched files (the two existing `codex.test.ts` errors
  remain); file-scoped `node scripts/biome.cjs check`; `git diff --check`;
  the slice 4.7 focused `vitest` set plus
  `test/provider-runtime-settings.test.ts`: 72 files, 1,091 passed, 10
  skipped.
- Also ran `pnpm lint`, `pnpm format:check` and `pnpm typecheck`: passed.
- `pnpm source:budgets --record` lowered `codex.ts` to 4,321.

Follow-ups recorded:
- Row 4.9 now names the config-dependent builders and recap helpers that
  stayed.

### Slice 4.1 — Codex App-Server Client (Landed 2026-11-08, this commit)

Moved:
- App-server process IO -> new
  `packages/server/src/sdk/providers/codex-app-server-client.ts`:
  `CodexAppServerClient`, `AsyncQueue`, `AppServerRequestHandler`,
  `CodexNotificationReceipt`, `isProcessTargetRunning`,
  `waitForProcessTargetExit`, `terminateChildProcess`, and the termination
  timings `APP_SERVER_SHUTDOWN_GRACE_MS`, `APP_SERVER_FORCE_KILL_WAIT_MS` and
  `APP_SERVER_EXIT_POLL_MS`.
- These were module-level declarations, so nothing was dedented or
  rewrapped. Only `CodexAppServerClient` and `terminateChildProcess` gained
  `export`. `codex.ts` uses the client throughout and calls
  `terminateChildProcess` from the model-list probe, which keeps its raw
  requests and the `APP_SERVER_INIT_REQUEST_ID` and
  `APP_SERVER_MODEL_LIST_REQUEST_ID` constants.
- The module imports the JSON-RPC types, `codex-log.ts` (slice 4.8) and the
  session sandbox type, never `codex.ts`. `codex.ts` went from 5,187 to 4,621
  lines.

Signature conversions:
- None. A whitespace-insensitive comparison of every moved declaration with
  its original matches once `export` is ignored.

Behavior changes:
- None. Spawn options, the process-group termination sequence and its
  timings, queue close and abort handling, and log lines are unchanged.
  `gaps/process-group-signalling-copies.md` still records how other
  providers differ.

Verification:
- Tier 1: server `tsc --noEmit` (`tsconfig.json`,
  `tsconfig.tool-display-tests.json`); `tsconfig.test.json` shows no errors
  in the touched files; file-scoped `node scripts/biome.cjs check`;
  `git diff --check`; the slice 4.7 focused `vitest` set: 71 files, 1,080
  passed, 10 skipped.
- Also ran `pnpm lint`, `pnpm format:check` and `pnpm typecheck`: passed.
- Tier 3 (tripwire: Codex row and server E2E): `pnpm test:e2e:sdk` passed (8
  files, 80 tests, 4 skipped). Its real-provider `/btw` fork smoke needs
  `BTW_ASIDE_PROVIDER_SMOKE=true` and returned early in that run.
  `pnpm test:providers` passed (6 files, 22 tests, 1 skipped). Its 11
  Codex cases run the client against the pinned `@openai/codex` executable
  and the suite's local model server: cancel, cold resume, queued compact,
  steering, children and retry.
- `pnpm source:budgets --record` lowered `codex.ts` to 4,621.

Follow-ups recorded:
- None.

### Slice 4.8 — Codex Approvals (Landed 2026-11-08, this commit)

Moved:
- Server-request approval handling -> new
  `packages/server/src/sdk/providers/codex-approvals.ts`:
  `handleServerRequestApproval`, `resolveApprovalDecision`,
  `resolveToolApprovalResult`, `resolvePermissionRequestApproval`,
  `createGrantedPermissionResponse`, `createDeclinedPermissionResponse`, and
  the approval request param guards `asCommandExecutionRequestApprovalParams`,
  `asFileChangeRequestApprovalParams`, `asPermissionsRequestApprovalParams`
  and `asToolRequestUserInputParams`.
- The module-level `log` wrapper (component `codex-provider`) -> new
  `codex-log.ts`, unchanged. The approval code logs through it, and copying
  it would not be a move. `codex.ts` imports it, and slice 4.1's client will
  too.
- `codex-approvals.ts` imports the item conversion module (for
  `getOptionalString`), `codex-log.ts`, the JSON-RPC and protocol types, and
  never `codex.ts`. `codex.ts` went from 5,711 to 5,187 lines.

Signature conversions:
- `handleServerRequestApproval(request, options, signal, permissionMode =
  this.normalizePermissionMode(options.permissionMode))` now takes
  `permissionMode: PermissionMode` as a required parameter.
  `normalizePermissionMode` stays in `codex.ts`, because turn parameters and
  runtime state also use it. The default was dead: `runSession` passes
  `runtimeState.activePermissionMode`, and all four approval tests pass the
  mode explicitly.
- The 10 moved private methods became module functions: `private name(` ->
  `function name(`, and `this.name(` -> `name(`. Nothing else changed.
  `codex.ts` imports `handleServerRequestApproval` for `runSession`, and
  `createDeclinedPermissionResponse` and `asToolRequestUserInputParams` for
  `handleNonTurnServerRequest`, which declines fork and recap requests and
  stays in `codex.ts`.
- The four approval tests in `codex.test.ts` that cast a `CodexProvider` to
  reach `handleServerRequestApproval` now cast the `codexApprovals` module
  namespace. The cast types and every assertion are unchanged.
- A whitespace-insensitive comparison of every moved block with its original
  matches once `this.`, `private`, `export`, `function` and formatter
  trailing commas are ignored, apart from the `permissionMode` parameter
  line above.

Behavior changes:
- None. Log lines keep the `codex-provider` component and their messages.

Verification:
- Tier 1: server `tsc --noEmit` (`tsconfig.json`,
  `tsconfig.tool-display-tests.json`); `tsconfig.test.json` shows no errors
  in the new modules or `codex.ts`. It reports two existing errors in
  `codex.test.ts` (`processEnvWakeToken`, `CodexProviderConfig.timeout`) that
  are unrelated to approvals. File-scoped `node scripts/biome.cjs` lint and
  format; `git diff --check`; the slice 4.7 focused `vitest` set: 71 files,
  1,080 passed, 10 skipped.
- Also ran `pnpm lint`, `pnpm format:check` and `pnpm typecheck`: passed.
- `pnpm source:budgets --record` lowered `codex.ts` to 5,187.

Follow-ups recorded:
- None.

### Slice 4.7 — Codex Failure Trace (Landed 2026-11-08, this commit)

Moved:
- Failure trace -> new
  `packages/server/src/sdk/providers/codex-failure-trace.ts`:
  `CODEX_FAILURE_TRACE_LIMIT`, `CODEX_FAILURE_PREVIEW_CHARS`,
  `CodexFailureTraceEvent`, `CodexFailureTrace`,
  `recordCodexFailureTraceEvent`, `snapshotCodexFailureTrace`,
  `formatCodexFailureTrace`, `formatCodexTraceEvent`,
  `describeNotificationForFailureTrace`, `describeSDKMessageForFailureTrace`,
  `inferTraceItemTypeFromDeltaEvent`, `normalizeCodexItemType`,
  `getTraceToolName`, `getTraceCommandFromInput` and `previewTraceString`.
- The module imports the item and live conversion modules, the notification
  guards and the JSON-RPC types, never `codex.ts`. `codex.ts` went from
  6,060 to 5,711 lines.

Signature conversions:
- The 11 moved private `CodexProvider` methods became module functions:
  `private name(` -> `function name(`, and `this.name(`/`provider.name(`
  -> `name(`. The parameters did not change. `runSession` imports the five it
  calls and the `CodexFailureTrace` type; the other six are module-private.
- No test reached these methods directly, so no test changed. The
  `codexFailureTrace` assertion in `codex.test.ts` exercises them through
  `runSession`.
- A whitespace-insensitive comparison of every moved block with its original
  matches once `this.`, `private`, `export`, `function` and formatter
  trailing commas are ignored.

Behavior changes:
- None.

Verification:
- Tier 1: server `tsc --noEmit` (`tsconfig.json`,
  `tsconfig.tool-display-tests.json`); `tsconfig.test.json` shows no errors
  in the touched files; file-scoped `node scripts/biome.cjs check`;
  `git diff --check`; focused `vitest run test/sdk/providers/
  test/render-parity.test.ts test/codex-dynamic-results.test.ts test/codex/
  test/captured-provider.test.ts test/simple-client-*.test.ts
  test/tool-display-native.test.ts`: 71 files, 1,080 passed, 10 skipped.
- Also ran `pnpm lint`, `pnpm format:check` and `pnpm typecheck`: passed.
- `pnpm source:budgets --record` lowered `codex.ts` to 5,711. It also
  lowered four budgets to the committed lengths that earlier commits had not
  recorded: `NewSessionForm.tsx` 3,123, `app.ts` 4,624,
  `ProjectQueueService.ts` 1,532 and `shared/src/app-types.ts` 1,504.

Follow-ups recorded:
- None.

### Slice 4.4 — Codex Live Event Conversion (Landed 2026-11-08, this commit)

Moved:
- Item normalization and item-to-SDK conversion -> new
  `packages/server/src/sdk/providers/codex-item-conversion.ts`:
  `NormalizedFileChange`, `NormalizedThreadItem`, `normalizeThreadItem`,
  `getReasoningText`, `normalizeStatus`, the item uuid builders
  (`buildItemEventKey`, `buildItemMessageUuid`, `buildItemToolUuid`,
  `buildItemResultUuid`), `isResultBackedThreadItem`,
  `isToolBackedThreadItem`, `convertItemToSDKMessages`,
  `getOptionalString`, `getOptionalNumber`, and the module-level
  `logSdkCorrelationDebug` and `withCodexTimestamp`.
- Live notification conversion -> new `codex-live-event-conversion.ts`:
  `TokenUsageSnapshot`, `CodexLiveEventState`, the live tool-output preview
  (`CODEX_LIVE_TOOL_OUTPUT_HEAD_CHARS`/`TAIL_CHARS`, `CodexLiveToolOutput`,
  `appendCodexLiveToolOutput`), `createLiveEventState`,
  `convertNotificationToSDKMessages`, `convertRawResponseItemToSDKMessages`,
  the streaming builders (`buildStreamingAssistantMessage`,
  `buildStreamingReasoningSummaryMessage`, `buildStreamingToolResultMessage`),
  the result-backed live tracking (`recordLiveResultBackedToolItem`,
  `clearLiveResultBackedToolItem`, `consumeLiveResultBackedToolItems`),
  `clearLiveEventStateForItem`, `extractTurnUsage`, and the error request-id
  helpers (`extractErrorRecord`, `extractOpenAIRequestId`,
  `findRequestIdInValue`, module-level `stringifyTraceValue`).
- `JsonRpcId`, `JsonRpcError`, `JsonRpcResponse`, `JsonRpcNotification` and
  `JsonRpcServerRequest` -> new type-only `codex-json-rpc.ts`. The live module
  needs `JsonRpcNotification` and may not import `codex.ts`; slice 4.1 will
  share these types with the app-server client.
- One module would have been about 2,150 lines, over the new-file ceiling, so
  the conversion is split along its call graph. The live module imports the
  item module; the item module imports neither the live module nor
  `codex.ts`. `codex.ts` went from 8,235 to 6,060 lines.

Signature conversions:
- The 26 moved private `CodexProvider` methods became module functions:
  `private name(` -> `function name(`, and `this.name(`/`provider.name(`
  -> `name(`. The parameters did not change. The functions read no provider
  state. Callers that still use them import them from the new modules.
- `generateSideSessionRecap` and `generateForkBackedSummary` dropped
  `const normalizeThreadItem = this.normalizeThreadItem.bind(this);`; the
  following uses now refer to the imported function, which needs no `this`.
- Tests that reached the private methods through
  `new CodexProvider() as unknown as {...}` or `provider["..."]` now cast the
  module namespace (`codexItemConversion`, `codexLiveEventConversion`) or call
  the imported function. The casts' member lists and every assertion are
  unchanged. A cast in `codex-dynamic-results.test.ts` that spies on real
  provider methods still uses `CodexProvider`.
- The formatter rewrapped lines that fit once one indent level and `this.`
  were gone. A whitespace-insensitive comparison of every moved method with
  its original matches once `this.`, `private`, `export`, `function` and the
  trailing commas the formatter added or dropped are ignored.

Behavior changes:
- None. Live-delta suppression, the per-turn runtime state, replay and the
  turn loop stay in `codex.ts`.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`; server `tsc --noEmit`
  (`tsconfig.json`, `tsconfig.tool-display-tests.json`); `tsconfig.test.json`
  shows no new errors in the touched files; file-scoped
  `node scripts/biome.cjs lint` and `format`; `git diff --check`; focused
  `vitest run test/sdk/providers/ test/render-parity.test.ts
  test/codex-dynamic-results.test.ts test/codex/
  test/captured-provider.test.ts test/simple-client-*.test.ts
  test/tool-display-native.test.ts`: 67 files, 1,011 passed, 10 skipped.
- Tier 2: `pnpm lint`, `pnpm format:check` and `pnpm typecheck` passed.
  In `pnpm test`, shared, relay, push-broker and client passed; the server
  had 7,178 passed, 94 skipped and 2 failed, both in
  `test/supervisor.test.ts` (`probes provider status for long-silent active
  sessions`, `retains its public id when native init follows the startup
  wait`). Run alone twice, that file passed 124 of 124 both times. These are
  the timer-sensitive supervisor tests already recorded in
  `gaps/full-suite-timing-and-diagnostics.md`, and they do not use the
  moved code.
- Tier 3: `pnpm test:e2e:sdk` passed (8 files, 80 tests, 4 skipped); the
  Codex provider and render-parity tests ran in the focused Tier 1 set.
- `pnpm source:budgets --record` lowered `codex.ts` to 6,060. It also lowered
  `packages/client/src/pages/settings/ProvidersSettings.tsx` from 1,687 to
  its committed length of 1,522, which an earlier commit had not recorded.

Follow-ups recorded:
- `gaps/codex-conversion-three-copies.md`: the live, durable and Codex OSS
  conversions are separate copies that already disagree.
- `gaps/process-group-signalling-copies.md` (extended): how providers stop
  their child processes.
- Rows 4.7 (failure trace), 4.8 (approvals) and 4.9 (session lifecycle plan)
  were added to Phase 4.

### Slice 2.41 — Session Page Composer Footer (Landed 2026-11-08, this commit)

Moved:
- The `<footer>` element (the creation recovery notice and its button,
  the connection bar, the btw sticky cards, the question and tool
  approval panels with the approval toolbar, the question aside card and
  `MessageInput` with its props) -> `SessionComposerFooter` in new
  `packages/client/src/components/SessionComposerFooter.tsx`.
- `LazyMessageInput` and the `MessageInput` Suspense wrapper, used only
  by the footer, moved with it unchanged. `SessionRouteModuleFallback`,
  which the `MessageList` wrapper also uses, moved unchanged to new
  `packages/client/src/components/SessionRouteModuleFallback.tsx`; both
  import it. The page keeps its `import type` of the composer's
  `FullPaneComposerControls` and `UploadProgress`, which it still uses.

Signature conversions (closure -> prop):
- The component takes 108 props, each passed as `name={name}`: `activityAt`, `activityRenderItems`, `actualSessionId`, `allSlashCommands`, `approvalCollapsed`, `attachments`, `attachmentsRef`, `basePath`, `beginForkAfterInitialTurn`, `btwToolbarMode`, `canStopOwnedProcess`, `captureCreationView`, `childSessionParentHref`, `codexPermissionModeChangePending`, `composerBangSupport`, `composerStickyBtwAsides`, `composerTurnRecall`, `correctionDraft`, `creationKey`, `creationRecovery`, `dismissPromptSuggestion`, `draftControlsRef`, `effectiveModelConfig`, `effectiveProvider`, `fileViewCommandOptions`, `focusedBtwAside`, `focusedBtwAsideId`, `forkSummaryDraft`, `generallySupportsSteering`, `handleAbort`, `handleApprove`, `handleApproveAcceptEdits`, `handleAttach`, `handleBtwShortcut`, `handleCancelCorrection`, `handleCancelLatestDeferred`, `handleComposerDraftTextChange`, `handleCustomCommand`, `handleDeny`, `handleDenyWithFeedback`, `handleDoneAction`, `handleDraftControlsReady`, `handleFocusedBtwSend`, `handleFullPaneControlsReady`, `handleProjectQueue`, `handleProjectQueueNewSession`, `handleQuestionSubmit`, `handleRecallLastSubmission`, `handleRemoveAttachment`, `handleSemanticComposerDefer`, `handleSemanticComposerSend`, `handleSetLiveThinkingEffort`, `handleSetLiveThinkingMode`, `handleStopBtwAside`, `handleToolbarSlashCommand`, `hideBtwAside`, `isAskUserQuestion`, `liveBadgeModel`, `liveThinkingSelection`, `mainComposerForAside`, `navigate`, `ownsCreationView`, `pendingInputRequest`, `pendingUploadsRef`, `permissionMode`, `primaryComposerAction`, `processState`, `project`, `projectId`, `projectQueueNewSessionTarget`, `promptSuggestion`, `providerRuntimeStatus`, `questionAside`, `questionAsidesEnabled`, `session`, `sessionConnectionStatus`, `sessionDraftKey`, `sessionDraftReference`, `sessionId`, `sessionLiveness`, `setApprovalCollapsed`, `setComposerAttachments`, `setCreationRecovery`, `setFocusedBtwAsideId`, `setForkSummaryDraft`, `setPermissionMode`, `setProjectAppVoice`, `shouldDeferMessages`, `showProjectQueueAction`, `sourceTransport`, `speechVocabulary`, `status`, `steerNowDefault`, `stickyBtwAsides`, `submitForkAfterSummary`, `submitForkAfterWithoutSummary`, `supportsBtwAsides`, `supportsFileViewCommand`, `supportsForkFromTurn`, `supportsPermissionMode`, `supportsSteerNow`, `supportsThinkingToggle`, `syntheticDoneEnabled`, `toggleBtwAsideExpanded`, `transcriptPositionStore`, `transferBtwTurnToMotherComposer`, `uploadAttachedFiles`, `uploadProgress`.
  Their types are the page's: `ReturnType<typeof useX>[...]` for hook
  results, otherwise the type the checker gives the page's declaration.
  `captureCreationView`'s result keeps the page's inferred `any` for
  `history.state.idx`, with a lint suppression saying so;
  `ownsCreationView` takes that result's type.
- `t` and `showToast` come from `useI18n` and `useToastContext` inside.
  The footer's `catch (error)` binds its own `error`; it is not a prop.
  The inline arrows and objects (`questionAside`, `forkSummaryMode`,
  `onAttachAudioMemo`, the recovery button) stay inline and keep their
  per-render identity; the component is not memoized.
- The JSX equals the moved lines apart from whitespace and two trailing
  commas (`JSON.stringify(controls?.getAttachmentState()?.refs ?? [])`, in
  the creation recovery button), which the formatter dropped when the calls
  fit on one line.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136`, which fails the same way in full runs at
  `e770fca38` and `bbc6244b5` and passes alone; it is recorded in the
  artifact viewer gap. Plan 182's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the moved code. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `bbc6244b5` (from `5e86a07b3`).
- The footer, composer and typing specs pass at this commit (81 cases):
  plan 182's footer pins (approval feedback and Other answer typing
  included), plan 181's four pin specs, `durable-session-creation`,
  `question-aside`, `audio-memo`, `session-send-paths`,
  `queued-message-recall`, `draft-sync`, `bang-command` and
  `composer-recall-drawer`. Tier 3 ran before review amended this commit's
  doc 058 wording; the source is unchanged by it.
- The client build's chunk list is identical to `bbc6244b5`'s, and the
  `MessageInput` chunk is the same size (65.32 kB), so the composer is
  still loaded lazily. The `SessionPage` chunk grew from 378.07 kB to
  391.36 kB (117.18 to 120.48 kB gzipped) across plan 182, from the prop
  names the page now passes to the three components.

Follow-ups recorded:
- None.

### Slice 2.40 — Session Page Header (Landed 2026-11-08, this commit)

Moved:
- The `<header>` element (sidebar opener, app actions, project breadcrumb
  and move menu, title row with the rename and retitle fields, router
  chip, goal flag, recent sessions and generate title, and the right-hand
  controls through the session menu) -> `SessionHeader` in new
  `packages/client/src/components/SessionHeader.tsx`.
- `SidebarIcon`, which only the header renders, moved into the
  component's body unchanged. It is still a component defined during
  render, so its `<svg>` still remounts each render, as before.

Signature conversions (closure -> prop):
- The component takes 110 props, each passed as `name={name}`: `actualSessionId`, `attachTitleInput`, `basePath`, `canCreatePublicShares`, `canStopOwnedProcess`, `clearloopControls`, `cloneSession`, `condensedHeader`, `currentGoal`, `currentProviderInfo`, `displayTitle`, `draftControlsRef`, `effectiveModelConfig`, `effectiveProvider`, `forkAfterDisabled`, `forkUnavailableMessage`, `generatedRetitle`, `generatedTitleEnabled`, `goalDetails`, `handleAcceptGeneratedRetitle`, `handleCancelEditingTitle`, `handleCompactSession`, `handleGenerateAndApplyTitle`, `handleProjectBreadcrumbContextMenu`, `handleReclassifySessionProject`, `handleRestartProvider`, `handleRestorePendingElsewhereWarning`, `handleSaveTitle`, `handleSend`, `handleShare`, `handleShareIndicatorClick`, `handleShareIndicatorContextMenu`, `handleStartEditingTitle`, `handleTerminate`, `handleTitleBlur`, `handleTitleKeyDown`, `handleToggleArchive`, `handleTogglePromptSuggestions`, `handleToggleRead`, `handleToggleStar`, `hasPendingToolCalls`, `hasUnread`, `headerLayout`, `headerRef`, `hideHeaderSecondary`, `isArchived`, `isDomLingerParked`, `isEditingTitle`, `isReclassifyingProject`, `isRenaming`, `isStarred`, `isWideScreen`, `liveBadgeModel`, `loading`, `manualCompactBlocked`, `messages`, `navigate`, `openSessionInfo`, `openSidebar`, `pendingElsewhereDismissed`, `processState`, `project`, `projectAppEnabled`, `projectAppOpen`, `projectAppPress`, `projectBreadcrumbRef`, `projectCodeNamesEnabled`, `projectId`, `projectReclassifyMenuRef`, `projectReclassifyOptions`, `promptSuggestionMode`, `publicShareActionAvailable`, `publicShareGlobalStatus`, `publicShareInitialPrompt`, `publicShareManagementAvailable`, `publicSharesEnabled`, `renamePresentation`, `renameValue`, `rightPane`, `routedSession`, `saveTitleValue`, `session`, `sessionId`, `setModelPanelInitialTab`, `setProjectAppFull`, `setProjectAppOpen`, `setProjectAppOpenedBy`, `setRenameValue`, `setShareModalAnchor`, `setShowHandoffModal`, `setShowModelSwitchModal`, `setShowProjectSettingsModal`, `setShowRecapModal`, `setShowRecentSessions`, `setShowShareModal`, `shareModalAnchor`, `shareModalView`, `showProjectReclassifyMenu`, `showRecentSessions`, `showShareModal`, `status`, `supportsForkFromTurn`, `supportsManualCompact`, `supportsProjectSettings`, `supportsTitleGeneration`, `titleEditControlsRef`, `titleEditMode`, `titleRowRef`, `titleTooltip`, `versionInfo`.
  Their types are the page's: `ReturnType<typeof useX>[...]` for hook
  results, otherwise the type the checker gives the page's declaration.
- `t` comes from `useI18n` inside. Refs (`headerRef`, `titleRowRef`,
  `projectBreadcrumbRef`, `projectReclassifyMenuRef`,
  `titleEditControlsRef` and the `attachTitleInput` callback ref) are
  passed under their own names and attach to the same elements. The
  inline arrows stay inline; the component is not memoized.
- The JSX equals the moved lines apart from whitespace and one trailing
  comma (`routerBindingChip(t, session.routerBinding)`), which the
  formatter dropped when the call fit on one line.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136`, which fails the same way in full runs at
  `e770fca38` and `bbc6244b5` and passes alone; it is recorded in the
  artifact viewer gap. Plan 182's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the moved code. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `bbc6244b5` (from `5e86a07b3`).
- The header-related specs pass at this commit (48 cases):
  `session-page-header-paths`, `session-page-title-attachment-paths`,
  `session-page-fork-paths`, `session-header-responsive` (rename typing
  during live updates), `session-read-state`, `public-share-management`,
  `session-title-access`, `session-resume-settings` and
  `slash-command-argument-completions`.

Follow-ups recorded:
- None.

### Slice 2.39 — Session Page Pop-ups (Landed 2026-11-08, this commit)

Moved:
- The five conditional pop-ups between the header and
  `ExternalSessionWarning` (`ProjectSessionDefaultsModal`,
  `SessionRecapModal`, `LongContextEffortWarningModal`, `ModelSwitchModal`
  with its `ProcessInfoBody`, and `RestartSessionModal`) ->
  `SessionPageModals` in new
  `packages/client/src/components/SessionPageModals.tsx`, wrapped in a
  fragment, which adds no DOM.

Signature conversions (closure -> prop):
- The component takes 41 props, each passed as `name={name}`: `actualSessionId`, `basePath`, `chooseLongContextEffortWarning`, `creationPrincipal`, `creationPrincipalResolved`, `currentProviderInfo`, `effectiveProvider`, `guardEffortChange`, `handleModelChanged`, `isDomLingerParked`, `lastStreamActivityAt`, `liveBadgeModel`, `longContextEffortWarning`, `modelPanelInitialTab`, `navigate`, `permissionMode`, `processState`, `project`, `projectId`, `projects`, `providerRuntimeStatus`, `providers`, `providerServiceTiers`, `routedSession`, `savedLaunchSettings`, `session`, `sessionLiveness`, `sessionUpdatesConnected`, `setShowHandoffModal`, `setShowModelSwitchModal`, `setShowProjectSettingsModal`, `setShowRecapModal`, `setStatus`, `showHandoffModal`, `showModelSwitchModal`, `showProjectSettingsModal`, `showRecapModal`, `status`, `supportsProjectSettings`, `titleTooltip`, `versionInfo`.
  Their types are the page's: `ReturnType<typeof useX>[...]` for hook
  results, otherwise the type the checker gives the page's declaration.
- `t` and `showToast` come from `useI18n` and `useToastContext` inside,
  which return the values the page reads. The inline arrows (`onSaved`,
  `onActivate`, `onRestarted` and the closers) stay inline and keep their
  per-render identity; the component is not memoized.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136`, which fails the same way in full runs at
  `e770fca38` and `bbc6244b5` and passes alone; it is recorded in the
  artifact viewer gap. Plan 182's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the moved code. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `bbc6244b5` (from `5e86a07b3`).
- `session-page-header-paths` and `long-context-effort-warning` pass at
  this commit (17 cases).

Follow-ups recorded:
- None.

### Slice 2.38 — Session Page Project Move Menu (Landed 2026-11-08, this commit)

Moved:
- `showProjectReclassifyMenu`, `isReclassifyingProject`,
  `projectBreadcrumbRef`, `projectReclassifyMenuRef`,
  `projectReclassifyOptions`, the outside-click and Escape effect,
  `handleProjectBreadcrumbContextMenu` and
  `handleReclassifySessionProject` -> `useProjectReclassifyMenu` in new
  `packages/client/src/hooks/useProjectReclassifyMenu.ts`.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `actualSessionId`, `projects`, `basePath`,
  `location`, `navigate`, `isDomLingerParked` and
  `setShowRecentSessions`; `t` and `showToast` come from the context hooks
  inside. `location` is the page's, not the router's.
- It returns the menu state, the two refs, the options and both handlers,
  all read by the header.
- The hook is called where `projectReclassifyOptions` stood, so the effect
  keeps its place. The state and refs moved from before the local metadata
  state to the call; only that state, the collection record and their
  reset effect lie between, and none reads them.
- `handleProjectBreadcrumbContextMenu`'s dependency list gained
  `setShowRecentSessions`, a state setter that never changes identity.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136`, which fails the same way in full runs at
  `e770fca38` and `bbc6244b5` and passes alone; it is recorded in the
  artifact viewer gap. Plan 182's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the moved code. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `bbc6244b5` (from `5e86a07b3`).
- The hook takes the page's `location` and `navigate`; it calls neither
  `useLocation` nor `useNavigate`. The slice 0 move-menu pin fails when the
  handler's own navigation is disabled, so it holds that navigation and not
  route sync's later replace.

Follow-ups recorded:
- None.

### Slice 2.37 — Session Page Header Actions (Landed 2026-11-08, this commit)

Moved:
- The share modal state (`showShareModal`, `shareModalView`,
  `shareModalAnchor`), `handleToggleArchive`, `handleToggleStar`,
  `handleTogglePromptSuggestions`, `hasUnread`, `handleSetUnread`,
  `handleToggleRead`, the read-shortcut effect, `handleTerminate`,
  `handleRestartProvider`, `handleShare`, `handleShareIndicatorClick` and
  `handleShareIndicatorContextMenu` -> `useSessionHeaderActions` in new
  `packages/client/src/hooks/useSessionHeaderActions.ts`.

Signature conversions (closure -> parameter):
- The hook takes `sessionId`, `projectId`, `actualSessionId`, `session`,
  `sessionCollectionRecord`, `status`, `setStatus`, `isArchived`,
  `isStarred`, `promptSuggestionMode`, `localPromptSuggestionMode`,
  `setLocalIsArchived`, `setLocalIsStarred`,
  `setLocalPromptSuggestionMode`, `isDomLingerParked`, `loading`,
  `draftControlsRef` and `publicShareManagementAvailable`; `t` and
  `showToast` come from the context hooks inside.
- It returns the share modal state with `setShowShareModal` and
  `setShareModalAnchor` (the header's close handler), the handlers the
  header and session menu use, and `hasUnread`. `handleSetUnread` stays
  inside.
- The hook is called where `handleToggleArchive` stood, so the
  read-shortcut effect keeps its place. The share state moved from before
  the model switch state to the call, later in the hook order; nothing in
  between reads or sets it. No dependency list changed.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 578 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136`, which fails the same way in full runs at
  `e770fca38` and `bbc6244b5` and passes alone; it is recorded in the
  artifact viewer gap. Plan 182's slice 0 pins pass at this commit.
- `pnpm i18n:scan` reports nothing in the moved code. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `bbc6244b5` (from `5e86a07b3`).
- The new hook calls neither `useLocation` nor `useNavigate`.

Follow-ups recorded:
- None.

### Slice 2.36 — Session Page Route Sync (Landed 2026-11-08, this commit)

Moved:
- The visit record, the temporary-id replacement, the native-id viewer
  URL rewrite and the canonical project redirect effects ->
  `useSessionRouteSync` in new
  `packages/client/src/hooks/useSessionRouteSync.ts`, which returns
  nothing.

Signature conversions (closure -> parameter):
- The hook takes `sessionId`, `projectId`, `actualSessionId`, `session`,
  `location`, `navigate`, `basePath` and `isDomLingerParked`. `location`
  is the page's, not the router's. The effects keep their order and
  dependency lists.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 552 passed, 13 skipped, 2 failed:
  `artifact-viewer.spec.ts:136` (below) and
  `session-header-responsive.spec.ts:29`, which passes when rerun alone at
  this commit. `artifact-viewer.spec.ts:136` fails the same way in a full
  run at `e770fca38` (517 passed, 13 skipped, 1 failed) and passes alone; it
  is recorded in the artifact viewer gap. Tier 3 ran before review folded
  pin and doc fixes into slice 0; the source at this slice is unchanged by
  them, and plan 181's slice 0 pins (37 cases) pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).
- No pin uses route retention, so that the hook reads the page's `location`
  rather than the router's is checked by review and by `rg
  "useLocation|useNavigate"` over the new hooks, which finds nothing.

Follow-ups recorded:
- None.

### Slice 2.35 — Session Page Transcript Jumps (Landed 2026-11-08, this commit)

Moved:
- The composer turn recall cache and entries, `useSessionCommandRecall`,
  `scrollToTurnRequest` and `handleGoToRecallTurn`, the
  `useSessionMessageNavigation` and `useNonHumanUserTurnNavigation` calls,
  `composerTurnRecall`, and the navigation-state actions (prefill, focus,
  scroll) with their early-typing effects -> `useSessionTranscriptJumps`
  in new `packages/client/src/hooks/useSessionTranscriptJumps.ts`, which
  returns `composerTurnRecall`, `recordCommandRecall` and
  `scrollToTurnRequest`.

Signature conversions (closure -> parameter):
- The hook takes `sessionId`, `actualSessionId`, `messages`, `location`,
  `navigate`, `loading`, `loadingOlder`, `isDomLingerParked`,
  `pagination`, `loadOlderMessages`, `navState`, the four seed fields it
  preserves (`initialStatus`, `initialTitle`, `initialModel`,
  `initialProvider`), the early-typing refs and `flushEarlyComposerTyping`,
  and reads `t` and `showToast` from their contexts. `location` is the
  page's (`routeLocation` under route retention), not the router's.
- `earlyComposerTypingRef` and `earlyComposerTypingKeyRef` joined the
  early-typing effect's dependency list, `earlyComposerTypingRef` the
  unmount-only cleanup's (which therefore still runs only on unmount), and
  `pendingEarlyComposerPrefillRef` the navigation-action effect's, as lint
  requires of parameters; refs never change identity.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 551 passed, 13 skipped, 3 failed:
  `artifact-viewer.spec.ts:136` (below); `async-questions-jump.spec.ts:11`,
  whose temporary directory cleanup failed (`ENOTEMPTY`) after the case; and
  `rendez-compose.spec.ts:8`, a New Session draft case. Both pass rerun at
  this slice. `artifact-viewer.spec.ts:136` fails the same way in a full run
  at `e770fca38` (517 passed, 13 skipped, 1 failed) and passes alone; it is
  recorded in the artifact viewer gap. Tier 3 ran before review folded pin
  and doc fixes into slice 0; the source at this slice is unchanged by them,
  and plan 181's slice 0 pins (37 cases) pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).
- No pin uses route retention, so that the hook reads the page's `location`
  rather than the router's is checked by review and by `rg
  "useLocation|useNavigate"` over the new hooks, which finds nothing.

Follow-ups recorded:
- None.

### Slice 2.34 — Session Page Attachment Uploads (Landed 2026-11-08, this commit)

Moved:
- `uploadAttachedFiles`, `handleAttach`, the `useIncomingShareFiles` call
  and `handleRemoveAttachment` -> `useSessionAttachmentUploads` in new
  `packages/client/src/hooks/useSessionAttachmentUploads.ts`, which returns
  the three callbacks.
- Stays in the page: `useAttachmentUploadQuality()`, the attachment state,
  `setComposerAttachments`, the batch id, materializing, collection for
  submission and draft hydration.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `sessionId`, `session`, `project`,
  `sourceTransport`, `attachmentQuality`, `currentProviderInfo`,
  `effectiveModel`, `effectiveModelConfig`, `historyScope`,
  `isDomLingerParked`, `ensureDraftAttachmentBatchId`,
  `setUploadProgress`, `setComposerAttachments`, `attachmentsRef` and
  `pendingUploadsRef`, and reads `t` and `showToast` from their contexts.
- `pendingUploadsRef` and `setUploadProgress` joined
  `uploadAttachedFiles`' dependency list and `attachmentsRef`
  `handleRemoveAttachment`'s, as lint requires of parameters; refs and a
  state setter never change identity.
- `useIncomingShareFiles` still calls the router's `useLocation` and
  `useNavigate` itself, unchanged.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 552 passed, 13 skipped, 2 failed:
  `artifact-viewer.spec.ts:136` (below) and
  `session-header-responsive.spec.ts:29`, which passes when rerun alone at
  the series tip. `artifact-viewer.spec.ts:136` fails the same way in a full
  run at `e770fca38` (517 passed, 13 skipped, 1 failed) and passes alone; it
  is recorded in the artifact viewer gap. Tier 3 ran before review folded
  pin and doc fixes into slice 0; the source at this slice is unchanged by
  them, and plan 181's slice 0 pins (37 cases) pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).

Follow-ups recorded:
- None.

### Slice 2.33 — Session Page Title Editing (Landed 2026-11-08, this commit)

Moved:
- The title editing state (`isEditingTitle`, `renamePresentation`,
  `titleEditMode`, `renameValue`, `isRenaming`, `generatedRetitle`), its
  refs, `attachTitleInput`, the `generatedRetitleRef` sync effect,
  `setRetitleState`, `invalidateGeneratedRetitle`,
  `focusAndSelectTitleInput`, `captureGeneratedRetitleInsertion`,
  `saveTitleValue`, `handleStartEditingTitle`, `handleStartRetitleTitle`,
  `handleGenerateAndApplyTitle`, `handleLocalTitleCommand`,
  `handleCancelEditingTitle` and its ref, `handleTitleBlur`,
  `handleSaveTitle`, `handleAcceptGeneratedRetitle`, `handleTitleKeyDown`,
  the parked-cancel and window Escape effects, and the `TitleEditMode` and
  `GeneratedRetitleState` types -> `useSessionTitleEditing` in new
  `packages/client/src/hooks/useSessionTitleEditing.ts`. It returns the
  state the markup reads, `saveTitleValue` and the handlers.
- Stays in the page: the optimistic metadata (`localCustomTitle` and its
  siblings), `quoteFromTranscript`, the `/v` command and the title
  markup.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `sessionId`, `displayTitle`,
  `condensedHeader`, `titleRowRef`, `setShowRecentSessions`,
  `supportsTitleGeneration`, `routedSession`, `generatedTitleLength`,
  `draftControlsRef`, `setLocalCustomTitle` and `isDomLingerParked`, all
  declared before the call, and reads `t` and `showToast` from their
  contexts. The handlers stay plain functions, so their identity changes
  every render, as before.
- The `/title` wrapper given to the send module still calls
  `handleLocalTitleCommand` when it runs, now the hook's.
- Order: the state moves from before the recent-sessions state to the
  call, and the `generatedRetitleRef` sync effect moves after the effects
  declared between. It only copies state into a ref that `setRetitleState`
  (the only caller of `setGeneratedRetitle`) also writes synchronously, and
  the ref is read only by the retitle response and the accept handler, so
  the move is not observable. The two Escape and parked-cancel effects keep
  their order.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 553 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136` (below). `session-header-responsive.spec.ts`
  covers rename typing during live updates. `artifact-viewer.spec.ts:136`
  fails the same way in a full run at `e770fca38` (517 passed, 13 skipped, 1
  failed) and passes alone; it is recorded in the artifact viewer gap. Tier
  3 ran before review folded pin and doc fixes into slice 0; the source at
  this slice is unchanged by them, and plan 181's slice 0 pins (37 cases)
  pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).

Follow-ups recorded:
- None.

### Slice 2.32 — Session Page Queued-Message Actions (Landed 2026-11-08, this commit)

Moved:
- `handleResumeProjectQueueDispatch`, `handleCancelProjectQueueItem`,
  `restoreQueuedMessageToComposer`, `handleEditProjectQueueItem`,
  `handleSteerProjectQueueItem`, `handleCancelDeferred`,
  `handleEditDeferred`, `handleCancelUnconfirmedUserMessage`,
  `handleSteerDeferred`, `handleDeliverDeferredWithoutCompaction`,
  `handleDeleteRecoveredDeferred`, `handleResumeRecoveredDeferred`,
  `handleSteerRecoveredDeferred`, `handleCancelLatestDeferred` and the
  module helper `isMissingDeferredQueueEntryError` ->
  `useSessionQueuedMessageActions` in new
  `packages/client/src/hooks/useSessionQueuedMessageActions.ts`. It returns
  the thirteen handlers; `restoreQueuedMessageToComposer` stays inside.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `sessionId`, `projectQueues`,
  `projectQueueItemsForProject`, `deferredMessages`,
  `setDeferredMessages`, `setStatus`, `setProcessState`,
  `setPermissionMode`, `removeUnconfirmedSelfSend`, `draftControlsRef`,
  `attachmentsRef`, `pendingUploadsRef`, `lastComposerSubmissionRef`,
  `lastSentComposerSubmissionRef`, `setComposerAttachments` and
  `setCorrectionDraft`, and reads `t` and `showToast` from their contexts.
- Added to dependency lists, as lint requires of parameters:
  `draftControlsRef` and `setCorrectionDraft` in
  `restoreQueuedMessageToComposer`; `draftControlsRef`, `attachmentsRef`
  and `pendingUploadsRef` in `handleEditProjectQueueItem`; the two
  submission refs in `handleCancelDeferred` and
  `handleCancelUnconfirmedUserMessage`; and all five refs in
  `handleEditDeferred`. Refs and a state setter never change identity, so
  nothing recomputes.
- The deferred cancel, edit and unconfirmed-steer cancel still write
  `lastComposerSubmissionRef`, which `handleRecallLastSubmission` in the
  page reads; the ref is the page's, passed in.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 553 passed, 13 skipped, 1 failed:
  `artifact-viewer.spec.ts:136` (below). `artifact-viewer.spec.ts:136` fails
  the same way in a full run at `e770fca38` (517 passed, 13 skipped, 1
  failed) and passes alone; it is recorded in the artifact viewer gap. Tier
  3 ran before review folded pin and doc fixes into slice 0; the source at
  this slice is unchanged by them, and plan 181's slice 0 pins (37 cases)
  pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).

Follow-ups recorded:
- None.

### Slice 2.31 — Session Page Fork Actions (Landed 2026-11-08, this commit)

Moved:
- The fork-summary draft state and its three refs, `submitForkAfterSummary`,
  `submitForkAfterWithoutSummary`, `createDirectTurnFork`, `cloneSession`,
  `cancelForkSummaryJob`, `setForkSummaryAutoOpen`, `followForkSummary`,
  `getForkSummaryTargetHref`, `handleCancelForkSummary`,
  `handleToggleForkSummaryAutoOpen`, the auto-open effect,
  `beginForkAfterSummary`, `beginForkAfterInitialTurn`,
  `forkBeforeUserMessage`, `forkAfterUserMessage`, `copyUserMessage`,
  `handoffFromUserMessage` and the module helper `messageKey` ->
  `useSessionForkActions` in new
  `packages/client/src/hooks/useSessionForkActions.ts`. It returns the
  draft, its setter, `createDirectTurnFork` (for `/fork N` through the
  rewind controls), the fork composer's three callbacks, the nine row
  handlers and `cloneSession`.
- Stays in the page: fork availability, `forkAfterDisabled`,
  `supportsTitleGeneration`, `forkAtEffort` and the long-context effort
  guard, which other features read.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `actualSessionId`, `session`, `messages`,
  `activityRenderItems`, `permissionMode`, `versionInfo`, `basePath`,
  `navigate`, `draftControlsRef`, `attachments`, `uploadProgress`,
  `forkAfterDisabled`, `updateTranscriptDisplayObjectsForSession`,
  `effectiveProvider`, `effectiveModel`, `effectiveModelConfig`,
  `currentGoal`, `project`, `getImplicitComposerThinking` and
  `startNewSessionWithPrefill`. It reads `t` and `showToast` from the same
  contexts the page reads them from.
- `draftControlsRef` joined the dependency lists of
  `submitForkAfterSummary`, `submitForkAfterWithoutSummary`,
  `beginForkAfterSummary` and `beginForkAfterInitialTurn`, as lint
  requires of parameters. It is a ref, whose identity never changes, so the
  `MessageList` props keep their identity.
- Order: the hook is called right after `activityRenderItems`, which stays
  in place. The draft state and refs move from before the attachment state
  to that call, and the auto-open effect moves past only callbacks and a
  memo, so no effect changes order.

Behavior changes:
- None.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`)
  passed at this slice. Tier 3 in a worktree (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`): 552 passed, 13 skipped, 2 failed:
  `artifact-viewer.spec.ts:136` (below) and
  `session-header-responsive.spec.ts:29`, which passes when rerun alone at
  the series tip. `artifact-viewer.spec.ts:136` fails the same way in a full
  run at `e770fca38` (517 passed, 13 skipped, 1 failed) and passes alone; it
  is recorded in the artifact viewer gap. Tier 3 ran before review folded
  pin and doc fixes into slice 0; the source at this slice is unchanged by
  them, and plan 181's slice 0 pins (37 cases) pass at this commit.
- `pnpm i18n:scan` reports nothing in the new hook. `pnpm console:scan`
  reports `method.warn` 61 of 60, as at `e770fca38` (from `5e86a07b3`).

Follow-ups recorded:
- None.

### Slice 2.30 — New Session Start Module (Landed 2026-11-07, this commit)

Move-only apart from deps objects and three moved types.
[Plan 180](180-new-session-options-and-start.md) slice 5 moves the start
and Project Queue bodies out of the form, unchanged.

Moved to new `packages/client/src/lib/newSessionStart.ts`:
- The `launch` prop's inline type -> exported `NewSessionLaunch` (the
  prop's shape is unchanged; `NewSessionFormProps.launch` names it),
  `PendingNewSessionSpeechDeliveryIntent`, and the accepted creation's
  inline state type -> `NewSessionAcceptedCreation`. The module must not
  import the form, so these move first.
- The body of `handleStartSession` -> `startNewSession(deps,
  messageOverride, speechTriggered, propagateFailure, background)`, and
  the body of `handleQueueProjectSession` ->
  `queueNewSessionForProject(deps, messageOverride)`. Both match the old
  bodies apart from indentation and Biome's rewrapping of lines that now
  fit.

Signature conversions (closure -> parameter):
- The form values each body reads become fields of
  `NewSessionStartDeps` (67 fields) and `NewSessionQueueDeps` (39
  fields), destructured under the same names. Option values are typed
  from the options hook's result.
- `principal` is passed to the start as `{ username: principal.username }`,
  so `handleStartSession` keeps depending on `principal.username` rather
  than the principal object, and its identity changes exactly when it did.

Shape changes:
- `handleStartSession` stays a `useCallback` with the same dependency list;
  its body builds the deps object and calls `startNewSession`, so the
  voice button and `handleSmartTurnSend`, which depend on its identity,
  see no change. `handleQueueProjectSession` stays a plain arrow rebuilt
  each render.

Behavior changes:
- None.

Budget:
- `NewSessionForm.tsx` 3,628 -> 3,135. The module is 953 lines.

Verification:
- `NewSessionForm.test.tsx` (148 tests, including plan 180's slice 0
  pins), `newSessionStartDecisions.test.ts` and
  `newSessionOptionsState.test.ts` pass; tsc and Biome are clean.
  `pnpm console:scan` counts are unchanged from the base; its `warn`
  count was already one over its limit there (61 of 60, from
  `5e86a07b3`).
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a worktree.
- Tier 3 (`pnpm --filter client test:e2e --grep-invert "physical
  Android"`) at the same tree, in a worktree: 514 passed, 13 skipped, 4
  failed, all `acli-commentary.spec.ts`, which fails from a worktree
  ([gap](../../gaps/acli-commentary-e2e-fails-from-worktree.md)).

Follow-ups recorded:
- None.

### Slice 2.29 — New Session Start and Queue Decisions (Landed 2026-11-07, this commit)

Not move-only. [Plan 180](180-new-session-options-and-start.md) slice 4
moves the start's and Project Queue's decisions into plain functions with
unit tests. The form keeps every effect where it was: the dictation
defer, the flags, draft capture, requests, toasts and navigation.

Replaced in `NewSessionForm.tsx`, now calling new
`packages/client/src/lib/newSessionStartDecisions.ts`:
- The start's refusals and text (the unusable route, not ready, the
  turn-effort and attachment-only refusals, the speech prefix and the
  turn-effort metadata) -> `planNewSessionStart`, which returns refuse,
  silent (with whether a memo start throws) or proceed. It keeps both file
  counts: the ref's for content, the render's for the attachment-only
  refusal.
- The session options object -> `buildNewSessionStartOptions`, same keys
  in the same order, the lock's overrides last.
- Queue's refusals before the defer -> `projectQueueRefusalBeforeDefer`;
  its text and readiness after it -> `planNewSessionProjectQueue`.
- Queue's direct-catalog thinking, effort and tier and its target ->
  `buildProjectQueueNewSessionTarget`, which also returns the thinking the
  trace logs.
- The start failure toast -> `newSessionStartErrorMessage`.

Shape changes:
- The start now reads the draft text and the recent-speech flag before
  the routed refusal and the readiness check, and Queue reads the flag
  after its file snapshot. The draft read is a plain ref read.
  `isRecent` also clears a speech window that has already expired, which
  its timer would do anyway, so the result and the state afterwards are
  unchanged; a refused start may now do that clearing a timer tick
  early.

Behavior changes:
- None.

Budget:
- `NewSessionForm.tsx` 3,748 -> 3,628. The new module is 410 lines.

Verification:
- `newSessionStartDecisions.test.ts` (14 tests, a case per refusal and
  readiness branch, the routed and direct options, N1 and N3, the
  direct-catalog target and each failure toast) and
  `NewSessionForm.test.tsx` (148 tests, including plan 180's slice 0
  pins) pass; tsc and Biome are clean.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a worktree.
- Tier 3 (`pnpm --filter client test:e2e --grep-invert "physical
  Android"`) at the same tree, in a worktree: 513 passed, 13 skipped, 5
  failed. Four are `acli-commentary.spec.ts`, which fails from a worktree
  ([gap](../../gaps/acli-commentary-e2e-fails-from-worktree.md));
  `provider-steering.spec.ts:12` passed when rerun alone.

Follow-ups recorded:
- None.

### Slice 2.28 — New Session Options Panel (Landed 2026-11-07, this commit)

Move-only apart from props and one declared hunk.
[Plan 180](180-new-session-options-and-start.md) slice 3 moves the options
markup out of the form.

Moved to new `packages/client/src/components/NewSessionOptionsPanel.tsx`,
each block unchanged:
- `ROUTER_MODEL_UNAVAILABLE`;
- `sessionDefaultCopy`, and the `showOptionCaptions` and
  `showAdvancedOptions` state (with its `localStorage` key);
- the label maps, the recap and suggestion mode lists and
  `showHelperSideModel`;
- `modelOptions`;
- `optionPlaceholder` and every section from the provider section to
  `activeAdvancedOptions`, including the catalog notice, the effort slot
  and the fixed-launch section;
- the provider slot, the advanced-options toggle and summary, and the
  secondary options, which were the last three elements of the form's
  grid. The panel returns them as a fragment, so the grid is unchanged.
  The compact branch rendered none of them.

Signature conversions (closure -> parameter):
- The panel takes the hook's result as `options` and destructures the
  values it reads under their names, reads `t` from `useI18n` (the same
  context value), and takes `providerSlotFilled`, `showProviderPicker`,
  `showModelPicker`, `launchLock`, `isStarting`,
  `isProjectChooserExpanded`, `showThinking`, `setShowThinking`,
  `clientSummarySourceKey` and `versionInfo`. The form keeps the hook's
  result as `newSessionOptions` to pass it.

Declared hunk:
- `providerSlotFilled` read the section elements, which now live in the
  panel. It stays in the form as `launchLock.limited ||
  showProviderPicker || showModelPicker || showThinkingControls ||
  !launchLock.effort`: the fixed-launch section renders exactly when the
  launch is limited, the provider and model sections always render (each
  falls back to a placeholder), and the effort slot renders when thinking
  controls are shown or the effort is not locked.

Behavior changes:
- None. The panel's two state hooks and its model-options memo now belong
  to a child component instead of the form; their values are the same.

Budget:
- `NewSessionForm.tsx` 4,737 -> 3,748. The panel is 1,085 lines.

Verification:
- `NewSessionForm.test.tsx` (148 tests, including plan 180's slice 0
  pins) passes unchanged; tsc and Biome are clean; `pnpm i18n:scan`
  reports nothing for the moved copy.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a worktree.
- Tier 3 (`pnpm --filter client test:e2e --grep-invert "physical
  Android"`) at the same tree, in a worktree: 513 passed, 13 skipped, 5
  failed. Four are `acli-commentary.spec.ts`, which fails from a worktree
  ([gap](../../gaps/acli-commentary-e2e-fails-from-worktree.md));
  `session-header-responsive.spec.ts:29` passed when rerun alone.

Follow-ups recorded:
- None.

### Slice 2.27 — New Session Options Hook (Landed 2026-11-07, this commit)

Not move-only. [Plan 180](180-new-session-options-and-start.md) slice 2
moves the option state out of the form. The moved code is verbatim; what
is not a move is the order hooks and effects now run in, and one helper.

Moved to new `packages/client/src/hooks/useNewSessionOptions.ts`, in this
order, each block unchanged:
- the reducer, the source-change effect and `selectMachineControl`;
- `useProviders`, `useProviderRow` and the selected provider's row;
- the three seeding refs;
- the sandbox values (support, configurability, the unavailable reason,
  the effective level and firewall, the local-auth warning);
- `useProviderDescriptors`, `useServerSettings` and the
  `newSessionDefaultsRef` sync;
- the derived values from `providerChoices` to the legacy default seed
  (router selection and discovery, model lists, tiers, pool members,
  connectors, readiness, effort, thinking, permission and machine-control
  eligibility);
- `applyLaunchLock`, `applyInitialDefaults` and the two seeding and the
  lock effects; `handleProviderSelect` and the Gateway and catalog fill
  effects; `handleModelSelect`; `handleModeSelect` and the automatic save.

Signature conversions (closure -> parameter):
- The hook takes `clientSummarySourceKey`, `launch` (as `object |
  undefined`, so the router selection memo keeps its dependency on it),
  `launchLock`, the four preferred-option props, `versionInfo`,
  `versionLoading`, `legacyEffortLevel`, `legacyThinkingMode` and `t`, and
  returns the 63 values the form still reads, plus `customizeOptions`.

Shape changes:
- The ten inline choices (tier, thinking, recap mode and delay, helper
  model, suggestions, sandbox, firewall, router, connectors) called
  `hasUserCustomizedDefaultsRef.current = true` and then dispatched; they
  now call the hook's stable `customizeOptions(action)`, which does the
  same two steps. Their `isStarting` guards stay where they were, so the
  hook takes no `isStarting` (plan 180's status records this departure).
- The hook is called where the sandbox values stood, so every read in it
  starts at that point. `useProviders` and `useProviderRow` now start
  after the hooks between their old place and the call (toolbar presence,
  speech state and capture settings, speech attribution, the voice ref,
  `useModelSettings`, `useVersion`, `useActingPrincipal`, background
  creation and `useRendezCompose`). `useProviderDescriptors`,
  `useServerSettings`, `useRouterDiscovery` and
  `useProviderSubscriptionUsage` now start earlier, before
  `useBrowserXaiSttApiKey`, the launch-seed layout effect and the
  draft-attachment and share-file effects; the router discovery and
  subscription usage requests, which start in passive effects, are sent
  in a different order. The moved effects run in their old order relative
  to each other, after the form's `creationViewOwner` effect and before
  the form's effects declared after the hook. None of those reads option
  state or shares a ref or store with the moved effects.

Behavior changes:
- None.

Budget:
- `NewSessionForm.tsx` 5,339 -> 4,737. The hook is 820 lines.

Verification:
- `NewSessionForm.test.tsx` (148 tests, including plan 180's slice 0
  pins) and `newSessionOptionsState.test.ts` pass unchanged; tsc and Biome
  are clean.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a worktree.
- Tier 3 (`pnpm --filter client test:e2e --grep-invert "physical
  Android"`) at the same tree, in a worktree: 514 passed, 13 skipped, 4
  failed, all `acli-commentary.spec.ts`, which fails from a worktree
  ([gap](../../gaps/acli-commentary-e2e-fails-from-worktree.md)).

Follow-ups recorded:
- None.

### Slice 2.26 — New Session Option State Reducer (Landed 2026-11-07, this commit)

Not move-only. [Plan 180](180-new-session-options-and-start.md) slice 1
gives the form's option choices one owner. Its slice 0 added the pins this
slice relies on.

Replaced in `NewSessionForm.tsx`:
- The sixteen option `useState` fields -> one `useReducer` over
  `newSessionOptionsReducer` in new
  `packages/client/src/lib/newSessionOptionsState.ts`. The form
  destructures the state under the old names, so every read is unchanged.
- The bodies of `applyLaunchLock`, `applyInitialDefaults`,
  `handleProviderSelect`, the Gateway and catalog model-fill effects, the
  thinking choice and the sandbox toggle -> the plain functions
  `lockNewSessionOptions`, `seedNewSessionOptions`,
  `switchNewSessionProvider`, `fillGatewayModel`, `fillCatalogModel`,
  `chooseNewSessionThinking` and `toggleNewSessionSandbox`, each
  returning the fields it changes.
- The automatic save's body -> `newSessionDefaultsToSave`, which takes
  the saved choices field by field, so the save effect keeps its
  dependency list and a machine-control change still saves nothing.

Shape changes:
- Each setter group became one dispatch. React already batched those
  setters into one commit. The reducer returns the previous state when
  nothing changes, so React skips the children and effects; unlike an
  equal `useState` write, a `useReducer` dispatch still re-runs the form
  once. `applyLaunchLock` keeps its early return for a principal who is
  not limited, so the lock effect still queues nothing for one. The other
  no-op dispatches (the source effect on mount, the machine-control
  reset, an unmatched thinking row) each cost that one extra run.
- The customization ref and the `isStarting` guards stay in the form,
  ahead of each dispatch, as before. `selectMachineControl` and
  `handleModelSelect` stay stable callbacks.
- The sandbox toggle reads the recap mode from the reducer's state instead
  of the render's; nothing changes it between the render and the click.

Behavior changes:
- None.

Budget:
- `NewSessionForm.tsx` 5,526 -> 5,339. The new module is 579 lines.

Verification:
- `newSessionOptionsState.test.ts` (17 tests: the no-op identity, each
  transition including the Gateway fill's empty-catalog return and the
  requested model before the catalog answers, the save body) and
  `NewSessionForm.test.tsx` (148 tests, including plan 180's slice 0
  pins) pass; tsc and Biome are clean.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a worktree.
- Tier 3 (`pnpm --filter client test:e2e --grep-invert "physical
  Android"`) at the same tree, in a worktree: 514 passed, 13 skipped, 4
  failed, all `acli-commentary.spec.ts`, which fails from a worktree
  ([gap](../../gaps/acli-commentary-e2e-fails-from-worktree.md)).

Follow-ups recorded:
- None.

### Slice 2.25 — New Session Option Section Module (Landed 2026-11-07, this commit)

Moved:
- `NewSessionOptionSection` and its props interface -> new
  `packages/client/src/components/NewSessionOptionSection.tsx`, unchanged
  apart from exporting the component and adding a doc comment. It keeps
  using `NewSessionForm.module.css`, as `ThinkingToolbarControl` uses the
  toolbar's module.

Signature conversions (closure -> parameter):
- None.

Behavior changes:
- None.

Budget:
- `NewSessionForm.tsx` goes from 5,535 to 5,503 lines, but its budget stays
  at 5,535 in this commit: the next commit, the maintainer-requested
  dictation cleanup, adds lines to the form and ratchets the budget to its
  own count.

Verification:
- `NewSessionForm.test.tsx` passes unchanged; tsc and Biome are clean.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at the tip of the cleanup series that includes this
  commit, in the main checkout. Tier 3 (`pnpm --filter client test:e2e
  --grep-invert "physical Android"`) there: 516 passed, 13 skipped, 1
  failed; `artifact-viewer.spec.ts:136`, the known proxy flake, passed
  when rerun alone. The tip later dropped an unused CSS rule and gained a
  unit test, neither of which changes browser behavior.

Follow-ups recorded:
- None.

### Slice 2.24 — Session Composer Send Module (Landed 2026-11-07, this commit)

Move-only. [Plan 179](179-session-composer-send-decisions.md) slice 4
moves the session page's four sending functions, bodies unchanged, into a
plain function the page calls on every render, so each render still gets
fresh functions that read that render's values.

Moved to new `packages/client/src/lib/sessionComposerSend.ts`:
- `prepareComposerSubmission`, `handleSend`, `handleQueue` and
  `queueComposerForProject`, inside `createSessionComposerSend(deps)`,
  which returns the other three. `SessionPage.tsx` calls it where
  `handleSend` stood (after the declarations its deps read, before
  `handleSendRef`) and keeps `handleSend`, `handleQueue` and
  `queueComposerForProject`.
  `prepareComposerSubmission` moved from earlier in the page; nothing
  between its old place and the call site used it during render.
- `SessionPage.tsx` 7,475 -> 6,560 lines; the new module is 1,214.

Signature conversions (closure -> parameter):
- The page values the bodies read become fields of an exported
  `SessionComposerSendDeps`, destructured under the same names:
  `projectId`, `sessionId`, `t`, `showToast`, `basePath`,
  `sourceRuntime`, `sourceSummary`, `sourceTransport`, `versionInfo`,
  `creationPrincipalResolved`, `creationKey`, `captureCreationView`,
  `ownsCreationView`, `setCreationRecovery`, `syntheticDoneEnabled`,
  `supportsSyntheticDone`, `supportsSyntheticArchive`,
  `supportsSyntheticTerminate`, `navigate`, `session`, `status`,
  `processState`, `setIsCompacting`, `actualSessionId`, `setStatus`,
  `setProcessState`, `addPendingMessage`, `removePendingMessage`,
  `isMessageDelivered`, `updatePendingMessage`, `setDeferredMessages`,
  `reconnectStream`, `permissionMode`, `goalDetails`,
  `effectiveProvider`, `setScrollTrigger`, `draftControlsRef`,
  `lastComposerSubmissionRef`, `routedSession`, `supportsBtwAsides`,
  `beginBeaconSubmission`, `correctionDraft`, `setCorrectionDraft`,
  `attachments`, `attachmentsRef`, `pendingUploadsRef`,
  `rememberSentSubmission`, `setComposerAttachments`,
  `materializeComposerAttachments`, `supportsManualCompact`,
  `supportsTurnEffort`, `supportsRewind`, `supportsFileViewCommand`,
  `getImplicitComposerThinking`, `getResumeSettings`,
  `setShowHandoffModal`, `collectComposerAttachmentsForSubmission` and
  `handleSyntheticSessionBoundary`. Refs pass as the ref objects and are
  still read through `.current` when a path runs.
- The four callbacks the page declares after the call site pass as
  wrappers created there: `clearQuoteAnchors: () => clearQuoteAnchors()`,
  `handleCustomCommand: (command, argument) =>
  handleCustomCommand(command, argument)`, `handleFileViewCommand:
  (argument) => handleFileViewCommand(argument)` and
  `handleLocalTitleCommand: (title) => handleLocalTitleCommand(title)`.
  The bodies call them only after render, when each wrapper resolves to
  its own render's binding, as the closures did. A dependency
  resolution over the original bodies found no other page value
  declared after the call site.
- `handleSend` still reroutes to the same render's `handleQueue`; both
  come from the same call.

Behavior changes:
- None.

Verification:
- `git diff --color-moved` shows the four bodies as moved blocks; the
  only other hunks are the call site, the deps type and import edits.
- `tsc --noEmit` for the client and `biome check packages/client/src`
  pass.
- `sessionComposerSendDecisions.test.ts` and
  `sessionComposerSubmission.test.ts` pass: 42 tests.
- `session-send-paths.spec.ts` and the plan's send and Project Queue
  specs pass: 31 tests across 13 files.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 512 passed, 13 skipped, 4 failed, all four the
  `acli-commentary.spec.ts` cases that fail from a worktree (see slice
  2.17).

Follow-ups recorded:
- None. This completes plan 179.

### Slice 2.23 — Session Composer Project Queue Decisions (Landed 2026-11-07, this commit)

Not move-only. [Plan 179](179-session-composer-send-decisions.md) slice 3
moves `queueComposerForProject`'s decisions into plain functions; the page
keeps every effect in its current place and order. A separate commit just
before it pins the legacy start-now path in `session-send-paths.spec.ts`.

Moved to `packages/client/src/lib/sessionComposerSendDecisions.ts`:
- `resolveProjectQueueCommand`: the queued YA command classification and
  its refusals (composer-only, unsupported, invalid, needs a session, no
  attachments), or the command text to queue, or "prepare as a prompt".
- `planProjectQueue`: the target project, provider and model, the
  turn-effort metadata (plan 179's deferred S7 variant; the old
  caller-wins merge differed only in a `deliveryIntent` that every request
  overwrites), and whether this is a start-now creation and a canonical
  one.
- `projectQueueQueuedMessage`: which of the three success toasts.

Shape changes:
- The saved default model is read through a callback, only when needed,
  as before.
- The plan's Project Queue target, message and navigation builders were
  not added: each object is built once, at its single call site, from
  values the effects produce, so a builder would only restate the call.
  The plan records this.

Behavior changes:
- None.

Verification:
- `sessionComposerSendDecisions.test.ts` gains cases for each refusal
  (composer-only, unsupported, syntax, clear-zero, needs a session,
  attachments or pending uploads), the rewind fallthrough, the queueable
  command, a chosen model winning without reading the saved default, the target, provider and model choice, canonical
  creation with and without the admission capability, the metadata and
  the toasts.
- `session-send-paths.spec.ts` (with the new legacy start-now case) and the
  plan's Project Queue and send specs pass: 30 tests across 12 files.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 511 passed, 13 skipped, 1 failed;
  `session-header-responsive.spec.ts:29` (a visibility timeout, not a
  typing-latency check) passed when rerun alone.

Follow-ups recorded:
- Plan 179 slice 4.

### Slice 2.22 — Session Composer Send and Queue Decisions (Landed 2026-11-07, this commit)

Not move-only. [Plan 179](179-session-composer-send-decisions.md) slice 2
moves `handleSend`'s and `handleQueue`'s decisions into plain functions; the
page keeps every effect in its current place and order.

Moved to `packages/client/src/lib/sessionComposerSendDecisions.ts`:
- `planSend` (the turn-effort reroute, the metadata merge, local control
  and the attachment-only refusal) and `planQueue` (the deferred merge and
  the same refusal), with `mergeTurnEffortMetadata` holding plan 179's two
  S7 variants.
- `buildResumeOptions`, the resume request's settings, with
  `includeShowThinking` true on the first attempt and false on both retries
  (S4).
- `firstSendFailureStep` (delivered, stale redirect, or continue),
  `shouldRetrySendWithResume` and `shouldRetryQueueWithResume` (each path's
  S3 predicate, applied to the original error), and `finalFailureNotice`
  (the handoff dialog and toast, or each path's failure toast), which
  moves `CLAUDE_HANDOFF_REQUIRED_MESSAGE` from the page.

Shape changes:
- The page calls the planners where their code stood and applies the
  result; the failure stages stay in its catch blocks, in today's order.
  `handleSend` still reroutes to the same render's `handleQueue`.

Behavior changes:
- None.

Verification:
- `sessionComposerSendDecisions.test.ts` gains cases for both planners
  (including the attachment-only refusal that `session-send-paths.spec.ts`
  could not reach), the merge variants, the failure steps, both retry
  predicates and every notice.
- `session-send-paths.spec.ts` and the plan's send specs pass: 31 tests
  across 14 files.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 511 passed, 13 skipped, none failed.

Follow-ups recorded:
- Plan 179 slices 3 and 4.

### Slice 2.21 — Session Composer Submission Decision (Landed 2026-11-07, this commit)

Not move-only. [Plan 179](179-session-composer-send-decisions.md) slice 1
turns the session page's `prepareComposerSubmission` into a plain decision
plus the page code that performs it, after the plan's slice 0 pins.

Moved:
- The slash-turn, correction-framing, capability and content decisions of
  `prepareComposerSubmission` and its framing helper
  `getOutgoingMessageText` -> `resolveComposerSubmission` in new
  `packages/client/src/lib/sessionComposerSendDecisions.ts`, which returns
  a refusal (message, severity, text to restore), a local command (with
  whether correction ends first), a custom command (with whether correction
  ends after it is handled and the precomputed fallback), a drop, or the
  prepared submission.

Shape changes:
- `prepareComposerSubmission` stays in the page and applies the decision in
  today's order: a refusal restores and toasts; a local command ends
  correction first, then dispatches; a custom command runs
  `handleCustomCommand` and, when handled, ends correction, else applies
  the fallback. `getOutgoingMessageText` is gone; its "no changes" refusal
  is part of the decision.
- The decision reads what prepare read from the page as a context object;
  its translations come through a `t` restricted to the four keys it uses.

Behavior changes:
- None. The English refusal strings are kept and recorded in new
  `gaps/session-composer-refusals-untranslated.md`.

Verification:
- New `sessionComposerSendDecisions.test.ts`: one case per branch,
  including both correction-end orders, the stripped custom fallback and
  the raw-text restore of the turn-effort refusal.
- `session-send-paths.spec.ts` (plan 179 slice 0) and the send specs the
  plan lists pass: 29 tests across 14 files, including slice 0's case for
  a command the page runs itself ending correction mode, which this slice
  moves.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 510 passed, 13 skipped, 1 failed;
  `selection-during-activity.spec.ts:281` passed when rerun alone.

Follow-ups recorded:
- Plan 179 slices 2 to 4.

### Slice 2.20 — Floating Composer Joins the Shared Dictation Core (Landed 2026-11-07, this commit)

Not move-only. [Plan 178](178-shared-composer-dictation.md) slice 5 replaces
the floating composer's third copy of the dictation code, under that plan's
rules for differences (its table F1 to F6).

Replaced in `FloatingActionButton.tsx`:
- Its speech state, `PendingSpeechFinal` type, `createSpeechTargetId`
  copy, interim preview, textarea edit remap and pending-selection restore
  -> `useComposerSpeechState` and `getSpeechInterimPreview`.
- `handleListeningStart`, `handleSpeechSelectionTarget`,
  `clearSpeechSelectionTarget`, `commitVoiceTranscript`,
  `handleVoiceTranscript`, `flushPendingSpeechFinal`, `handleListeningStop`
  and `handleInterimTranscript` -> `useComposerSpeechHandlers`.
- The Escape pair -> `handleSpeechEscapeKey`; the speech field markup ->
  `SpeechDraftField`.

Shape changes:
- It keeps its own `handlePendingSpeechChange` (submit on `completed`) and
  `handleCancelTranscription` (F1, F3), and passes the shared hook a
  private settled flag and no-op attribution and delivery-run callbacks,
  which make the hook's extra delivery bookkeeping inert there.
- Its select, pointer-up and key-up handlers pass `true` through
  `handleManualSpeechSelection`, as their events did (F4).

Behavior changes:
- None.

Verification:
- `FloatingActionButton.test.tsx` passes unchanged, plus a new check that
  the three voice-button callbacks that keep their identity across a
  keystroke at the previous slice still do.
- `speech-caret-insertion.spec.ts` gains the floating composer in its
  keystroke check (wide viewport, opened on the projects page); it passes
  at the previous slice and at this one.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 497 passed, 13 skipped, 4 failed, all four the
  `acli-commentary.spec.ts` cases that fail from any worktree (see slice
  2.17).

Follow-ups recorded:
- None in plan 178; its open questions are listed under "Differences".

### Slice 2.19 — Shared Message-Box Attachment Upload Step (Landed 2026-11-07, this commit)

Not move-only. [Plan 178](178-shared-composer-dictation.md) slice 4 replaces
four copies with one, under that plan's rules for differences between the
copies (its table A1 to A4).

Replaced:
- The per-file prepare step (resize an image for the profile, then build
  the upload options with its dimensions and a progress callback) in the
  session page's `uploadComposerAttachmentFile`
  (`lib/sessionComposerSubmission.ts`) and in three places in
  `NewSessionForm.tsx` (`addPendingFiles`,
  `resolvePendingAttachmentsForSession` and the start path's staging) ->
  `prepareComposerAttachmentUpload` in new
  `packages/client/src/lib/composerAttachmentUpload.ts`, which also takes
  `imageDimensionOptions` from `sessionComposerSubmission.ts`.

Shape changes:
- Each site keeps its own upload call (staged or direct), batch id,
  previews, pending-file state and toasts.
- The progress callback is optional and only added to the options when
  given (A1). The page's helper passes its wrapper always, as before; the
  new-session progress callbacks read the prepared file's size from the
  callback's second argument, the same file as before.

Behavior changes:
- None.

Verification:
- `NewSessionForm.test.tsx`, `sessionComposerSubmission.test.ts`,
  `newSessionAttachments.test.ts`, `attachmentSubmission.test.ts` and the
  page tests pass unchanged.
- Focused browser specs pass: `attachment-drop.spec.ts`,
  `session-creation-attachments.spec.ts`,
  `session-creation-client.spec.ts` and `audio-memo.spec.ts`.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 496 passed, 13 skipped, 4 failed, all four the
  `acli-commentary.spec.ts` cases that fail from any worktree (see slice
  2.17).

Follow-ups recorded:
- Plan 178 slice 5 (the floating composer).

### Slice 2.18 — Shared Message-Box Keys, Paste and Speech Field (Landed 2026-11-07, this commit)

Not move-only. [Plan 178](178-shared-composer-dictation.md) slice 3 replaces
two copies with one, under that plan's rules for differences between the
copies.

Replaced in both `NewSessionForm.tsx` and `MessageInput.tsx`:
- The Escape pair in `handleKeyDown` (cancel a transcription still pending
  after capture, else stop listening) -> `handleSpeechEscapeKey` in new
  `packages/client/src/lib/composerKeys.ts`.
- The desktop Enter-sends rule and the touch-device newline ->
  `isComposerEnterSend` in the same module.
- The clipboard file loop in `handlePaste` -> `getClipboardFiles` in the
  same module.
- The speech draft field (the interim mirror over the textarea and the
  tentative-transcript status line) -> `SpeechDraftField` in new
  `packages/client/src/components/SpeechDraftField.tsx`, which takes the
  textarea as its children.

Shape changes:
- Each box keeps its own key order and the guards before the Escape pair
  (plan 178 D8, D11), its listening-Enter check, its attach guard and where
  pasted files go. The in-session box read `hasCoarsePointer()` before its
  listening-Enter check and now reads it inside `isComposerEnterSend`,
  after; it has no side effects.
- The voice shortcut already shared `handleVoiceInputShortcutKeyDown`; its
  two-line toggle callback stays in each box.

Behavior changes:
- None.

Verification:
- `MessageInput.test.tsx`, `MessageInput.bangDraft.test.tsx` and
  `NewSessionForm.test.tsx` pass unchanged (334 tests), including
  Escape-cancel, Enter and Ctrl+Enter cases.
- Focused browser specs pass: `speech-caret-insertion.spec.ts` (the
  keystroke check in both boxes), `composer-recall-drawer.spec.ts`,
  `bang-command.spec.ts`, `session-creation-client.spec.ts`,
  `audio-memo.spec.ts`, `new-session-preboot-composer.spec.ts`,
  `composer-beacon.spec.ts`, `attachment-drop.spec.ts`,
  `session-creation-attachments.spec.ts` and
  `file-viewer-minimize.spec.ts`. `pnpm css:check` passes and
  `pnpm i18n:scan` reports nothing new (the status line's existing
  untranslated label moved unchanged).
- CSS ownership: deferred. `pnpm css:touched` reports `SpeechDraftField`
  has no independently owned rule slice: its 14 `speech-*` rules in
  `index.css` are shared with `FloatingActionButton.tsx` and scoped
  through `.message-input`, `.new-session-form` and `.fab-input-panel`,
  and both boxes' CSS modules reach it through `:global(.speech-draft-field)`.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 495 passed, 13 skipped, 5 failed.
  `selection-during-activity.spec.ts:281` passed when rerun; the four
  `acli-commentary.spec.ts` cases fail from any worktree (see slice 2.17).

Follow-ups recorded:
- Plan 178 slice 4.
- The floating composer (`FloatingActionButton.tsx`) holds a third copy of
  the dictation code, including this Escape pair and speech field
  markup; plan 178 slice 5 adopts the shared pieces.

### Slice 2.17 — Shared Message-Box Speech Handlers (Landed 2026-11-07, this commit)

Not move-only. [Plan 178](178-shared-composer-dictation.md) slice 2 replaces
two copies with one, under that plan's rules for differences between the
copies.

Replaced in both `NewSessionForm.tsx` and `MessageInput.tsx`:
- `handleListeningStart`, `handleSpeechSelectionTarget`,
  `clearSpeechSelectionTarget`, `commitVoiceTranscript`,
  `handleVoiceTranscript`, `flushPendingSpeechFinal`, `handleListeningStop`,
  `handleInterimTranscript`, `handlePendingSpeechChange` and
  `handleCancelTranscription`, and the in-session
  `handleTranscriptionSettled` -> `useComposerSpeechHandlers` in new
  `packages/client/src/hooks/useComposerSpeechHandlers.ts`.

Shape changes:
- The hook takes the stable speech state from `useComposerSpeechState` (now
  also returned whole as `speechState`, declared stable in `biome.json`),
  the box's draft controls, textarea and voice-button refs, its
  pending-delivery ref and settled flag, `noteSpeechAttribution`,
  `maybeRunPendingSpeechDelivery`, `abandonPendingDelivery` and
  `onSmartTurnSend`. The in-session box also passes
  `getDetachedSpeechTransaction`, `onTranscriptionId`, `onEdit` and
  `onHeard` (plan 178 D2, D5, D6). Its detached delivery fits the hook's
  `DetachedSpeechTransaction` shape as it is; the hook updates that
  delivery's `draft` and `composition.speechTranscriptionIds` in place, as
  the box did.
- `abandonPendingDelivery` is the in-session
  `restorePendingSpeechDeliveryDraft`, and in the new-session box a new
  `dropPendingSpeechDelivery` holding the two lines its handlers ran (D3).
- The new-session Smart Turn callback, written inline before, is now
  `handleSmartTurnSend`, a `useCallback` over `handleStartSession`, so
  `commitVoiceTranscript` changes identity exactly when it did. The
  in-session `handleSmartTurnSend` moved above the hook call.
- `handleSpeechSelectionTarget` takes a boolean in both boxes; the
  new-session pointer-up and key-up handlers pass `true` through
  `handleManualSpeechSelection`, as their events did (D1).
- Each moved callback keeps its dependencies, plus the refs and setters it
  now receives as options, which never change identity.

Behavior changes:
- None. Plan 178's differences between the boxes are unchanged; the
  new-session box still does not wire the failed-transcription handler
  (D4).

Verification:
- Slice 0's pins pass: both boxes' voice-button callbacks keep their
  identity across a keystroke, the new-session pointer-up caret move keeps
  the fragment in flight in place, and a failed cycle after a press during
  capture starts nothing. `MessageInput.test.tsx`,
  `MessageInput.bangDraft.test.tsx` and `NewSessionForm.test.tsx` pass
  unchanged (334 tests).
- Focused browser specs pass: `speech-caret-insertion.spec.ts` (including
  the keystroke check in both boxes), `composer-recall-drawer.spec.ts`,
  `bang-command.spec.ts`, `session-creation-client.spec.ts`,
  `audio-memo.spec.ts` and `new-session-preboot-composer.spec.ts`.
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree, in a separate worktree. Tier 3
  (`pnpm --filter client test:e2e --grep-invert "physical Android"`) in
  the same worktree: 495 passed, 13 skipped, 5 failed.
  `slash-command-argument-completions.spec.ts:46` passed when rerun.
  The four `acli-commentary.spec.ts` cases fail with 403 responses
  whenever the suite runs from a worktree, at the base commit as well, and
  pass in the main checkout with this slice and the later ones.

Follow-ups recorded:
- Plan 178 slices 3 and 4.

### Slice 2.16 — Shared Message-Box Speech State (Landed 2026-11-07, this commit)

Not move-only. [Plan 178](178-shared-composer-dictation.md) slice 1 replaces
two copies with one, under that plan's rules for differences between the
copies. Its slice 0 added the unit pins this slice relies on.

Replaced in both `NewSessionForm.tsx` and `MessageInput.tsx`:
- The speech refs and state (interim text, pending kind, insertion ranges,
  active target, retarget, held final, edited-during-speech flag, pending
  selection, preview revision, transaction-has-text, turn id), the
  `PendingSpeechFinal` type, `clearPendingSpeechFinal`, the textarea
  `onChange` range remap, the in-session `replaceDraftRangeUndoably` remap
  and the pending-selection restore -> `useComposerSpeechState` in new
  `packages/client/src/hooks/useComposerSpeechState.ts`.
- The interim mirror calculation -> `getSpeechInterimPreview` in
  `packages/client/src/lib/speechRecognition.ts`.
- The new-session box's copies of `createClientSpeechTurnId` and
  `createSpeechTargetId` -> the existing `lib/speechTargets.ts` exports.

Shape changes:
- The remaps became `noteSpeechDraftEdit(previous, next)` and
  `noteSpeechDraftReplacement(previous, next, start, end, length)`, and the
  restore became `restorePendingTextareaSelection(text, textarea)`. Each
  box keeps its layout and unmount effects in place, calling these.
- `biome.json` declares the hook's refs, setters and ref-only callbacks
  stable, so lint neither asks for them in dependency lists nor keeps them
  there; `clearPendingSpeechFinal` left the lists that named it. Each is
  stable, so nothing recomputes.
- The in-session box's transcription ids stay in the box (plan 178 D5).

Behavior changes:
- None. Plan 178's differences between the boxes are unchanged.

Verification:
- Tier 2 (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
  `pnpm test`) passed at this slice's tree. Tier 3 (`pnpm --filter client
  test:e2e --grep-invert "physical Android"`) at the same tree: 497
  passed, 13 skipped, 3 failed. `artifact-viewer.spec.ts:136` (the known
  proxy flake) and `async-questions-jump.spec.ts:11` (its teardown hit
  "directory not empty" removing a temp dir) passed when rerun alone.
  `rendez-composer.spec.ts:86` timed out waiting for the saved draft to
  reach the typed text while the machine's load average was 10 to 20; it
  passed three times alone here and three times at the base, and it reads
  the stored draft rather than the textarea.
- Slice 0's pins pass unchanged: both boxes' voice-button callbacks keep
  their identity across a keystroke, and the new-session caret and
  failed-cycle cases hold.
- New `speech-caret-insertion.spec.ts` keystroke check in both boxes: a
  120-line draft with 20 finals in the open target and an interim showing,
  typing at the start while the interim updates (and, in a session, the
  transcript), each key within 100 ms. It pins where each box puts the
  fragment in flight (plan 178 D10). It passes at the base and at this
  slice.

Follow-ups recorded:
- Plan 178 slices 2 to 4.

### Slice 2.15 — Toolbar Thinking Control (Landed 2026-11-07, this commit)

Moved:
- `ThinkingToolbarControl`, `ToolbarThinkingControl`,
  `getToolbarThinkingLabel`, `getToolbarThinkingTitle` and
  `THINKING_MENU_VIEWPORT_GUTTER_PX` -> new
  `packages/client/src/components/ThinkingToolbarControl.tsx`, unchanged
  apart from exporting the component and its prop type.

Signature conversions (closure -> parameter):
- None. The new module uses the toolbar's CSS module and repeats the
  toolbar's one-line `ToolbarTranslate` alias rather than importing back.

Behavior changes:
- None.

Verification:
- Tier 3 ran once for slices 2.13-2.15, at the series tip before review
  (`6e1d8c535`): `pnpm --filter client test:e2e --grep-invert "physical
  Android"`, 497 passed and 13 skipped; `artifact-viewer.spec.ts:136`
  failed once on a proxy error and passed alone. Each slice's files are
  the same at its commit as at that tip, apart from the 2.13 review fixes
  recorded in its note, and the three slices touch separate files. Tier 2 (`pnpm lint`,
  `pnpm format:check`, `pnpm typecheck`, `pnpm test`) passed at the same
  tip. `pnpm i18n:scan` reports nothing in the new modules.
- `thinking-toolbar-menu-layout.spec.ts`, `session-resume-settings.spec.ts`
  and `long-context-effort-warning.spec.ts` pass unchanged. No typing path
  is involved.

Follow-ups recorded:
- None.

### Slice 2.14 — Session Page Bang-Command Wiring (Landed 2026-11-07, this commit)

Moved:
- `messagesRef`, `runBangCommand`, `echoBangCommand`,
  `initialDisplayObjectsRef`, `bangCommandHandlers`, `bangHistory` and
  `composerBangSupport` -> `useSessionBangCommands` in new
  `packages/client/src/hooks/useSessionBangCommands.ts`, which returns
  `bangCommandHandlers` and `composerBangSupport`.

Signature conversions (closure -> parameter):
- The hook takes `projectId`, `sessionId`, `session`, `messages`,
  `updateTranscriptDisplayObjectsForSession`, `setScrollTrigger`,
  `handleSendRef` and `draftControlsRef`. It reads `t` and `showToast` from
  the same contexts `SessionPageContent` reads them from.
- `setScrollTrigger`, `handleSendRef` and `draftControlsRef` joined the
  dependency lists of the callbacks that use them, as lint requires of
  parameters. They are a state setter and two refs, whose identities never
  change, so nothing recomputes.

Behavior changes:
- None.

Verification:
- Tier 3 ran once for slices 2.13-2.15, at the series tip before review
  (`6e1d8c535`): `pnpm --filter client test:e2e --grep-invert "physical
  Android"`, 497 passed and 13 skipped; `artifact-viewer.spec.ts:136`
  failed once on a proxy error and passed alone. Each slice's files are
  the same at its commit as at that tip, apart from the 2.13 review fixes
  recorded in its note, and the three slices touch separate files. Tier 2 (`pnpm lint`,
  `pnpm format:check`, `pnpm typecheck`, `pnpm test`) passed at the same
  tip. `pnpm i18n:scan` reports nothing in the new modules.
- `bang-command.spec.ts` passes unchanged; it measures keystroke latency
  with the completion menu open.

Follow-ups recorded:
- None.

### Slice 2.13 — Composer Recall Drawer (Landed 2026-11-07, this commit)

Moved:
- The `recallDrawer` state, `openRecallDrawer`, `cancelRecallDrawer`,
  `acceptRecallEntry`, `goToRecallTurn`, and the open-drawer key block with
  the Ctrl+↑ opener -> `useComposerRecallDrawer` in new
  `packages/client/src/hooks/useComposerRecallDrawer.ts`.
- The drawer's menu JSX -> `ComposerRecallMenu` in new
  `packages/client/src/components/ComposerRecallMenu.tsx`.

Signature conversions (closure -> parameter):
- The hook takes `text`, `setText`, `noteComposerEdit`, `textareaRef`,
  `hasNonTextComposerContent` and `turnRecall`, which the moved closures
  captured.
- The key block became `handleRecallDrawerKeyDown(e)`. Each `return;` became
  `return true;` and the end returns `false`, so the composer stops exactly
  where it did.
- The menu takes `matches`, `activeIndex`, `showGoTo` (the inline
  `turnRecall?.onGoToTurn &&` gate), `onHighlight` (the row hover updater,
  now `highlightRecallEntry(index)` in the hook), `onAccept` and `onGoTo`.

Behavior changes:
- None.

Verification:
- Tier 3 ran once for slices 2.13-2.15, at the series tip before review
  (`6e1d8c535`): `pnpm --filter client test:e2e --grep-invert "physical
  Android"`, 497 passed and 13 skipped; `artifact-viewer.spec.ts:136`
  failed once on a proxy error and passed alone. Each slice's files are
  the same at its commit as at that tip, apart from the 2.13 review fixes
  recorded in its note, and the three slices touch separate files. Tier 2 (`pnpm lint`,
  `pnpm format:check`, `pnpm typecheck`, `pnpm test`) passed at the same
  tip. `pnpm i18n:scan` reports nothing in the new modules.
- New `composer-recall-drawer.spec.ts`: over a 300-turn session that updates
  while the drawer is open and halfway through each typing run, each
  keystroke shows within 100 ms when typing dismisses the open drawer and
  after an accepted row; Escape restores the draft.
- Review fixes made the spec wait for the transcript, assert the drawer is
  open before typing and add the updates, and moved a comment back to the
  call site. The final spec passed 3 runs in the main checkout and 5 more
  against the pre-review tip. Two earlier main-checkout runs each had one
  key over 100 ms (174 ms and 526 ms) while other work kept the machine's
  load average at 20-29. The slow key was the tenth typed, not the one that
  dismisses the drawer, and 11 runs at the base and 5 at the pre-review tip
  under lighter load had no key above 22 ms.

Follow-ups recorded:
- None.

### Slice 1.3b — Session Start, Resume And Reactivate Routes (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-018; completes row 1.3 after slice 1.3a.

Moved:
- `startProjectSession` with `POST /projects/:projectId/session-creations`,
  `startDetachedSession` with `POST /session-creations`, and the factory
  closure `ensureDetachedProjectPath` -> `registerSessionCreationRoutes` in
  new `packages/server/src/routes/session-creation-routes.ts`.
- `POST /projects/:projectId/sessions/:sessionId/resume`, the reactivate
  project-queue admission `routes.use(...)` and
  `POST /projects/:projectId/sessions/:sessionId/reactivate`, plus the
  module-level `REACTIVATE_SHOW_THINKING_OPTIONS`, `isPermissionRules` and
  `parseOptionalReactivateSessionBody` -> `registerSessionResumeRoutes` in
  new `packages/server/src/routes/session-resume-routes.ts`.
- All five moved chunks are byte-identical to `HEAD` (checked as
  substrings of the new modules). `createSessionsRoutes` calls the two
  registrars back to back where the first route block began, so route and
  middleware registration order is unchanged.
Signature conversions (closure -> parameter):
- `deps` is a parameter, typed as `SessionCreationRouteDeps` and
  `SessionResumeRouteDeps` rather than `SessionsDeps`; the route factory
  passes its own `deps` object.
- The factory closures `creationAcceptance`, `getGlobalInstructions` and
  `buildResumeLaunch` are a `closures` parameter, destructured under the
  same names at the top of each registrar; they are the instances the route
  factory built through slice 1.3a's factories.
Behavior changes:
- None. `ensureDetachedProjectPath` is now created when the registrar runs
  instead of earlier in the factory; it is stateless and called only at
  request time.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome check on changed
  files; `git diff --check`; byte-identity check of the moved chunks; the
  same focused set as slice 1.3a through `run-with-safe-home.js`: 2,006
  passed, 13 skipped (186 files), no failures.
- Tier 2: root `pnpm lint` (zero warnings, including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,128; shared 980; relay 139;
  push-broker 45).
- Tier 3: the client gate
  `pnpm --filter client test:e2e --grep-invert "physical Android"`
  (server from source through `tsx`): 493 passed, 13 skipped, 3 failed.
  `provider-sign-in.spec.ts:161` is the known `HEAD` baseline failure.
  `artifact-viewer.spec.ts:136` and `selection-during-activity.spec.ts:281`
  passed 3/3 each in isolation (`--repeat-each=3`, 6/6), so neither
  persists and no `HEAD` comparison was needed.
- `pnpm test:e2e:sdk` (session creation and reactivation cross
  project-queue admission): 80 passed, 4 skipped (8 files passed, 3
  skipped).
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  6,713 -> 5,703.
- Independent review (claude-opus-5-5, xhigh): all five chunks match
  `HEAD` exactly; every identifier in them resolves to the same module and
  symbol, and only `deps`, `routes`, the three closures,
  `ensureDetachedProjectPath` and the reactivate parser are rebound; with
  the registrars inlined, the 39-entry route, middleware and registrar
  sequence equals `HEAD`'s; each closure is still the factory's single
  instance; `SessionsDeps` satisfies both deps interfaces without a cast;
  no unused, duplicate or back-import. Its findings, all in doc 053's
  SRR-018 entry, were fixed: two module line counts and the moved-block
  length were off, the problem statement omitted `deps` and
  `ensureDetachedProjectPath`, and the list of code keeping the closures
  was incomplete.
Follow-ups recorded:
- None.

### Slice 1.3a — Session Start/Resume Shared Helpers (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-017; it prepares slice 1.3b (SRR-018).

Moved:
- `permissionModeError`, `StartSessionBody`, `hasSessionMessageContent`,
  `CreateSessionBody`, `parseOptionalJsonObjectBody` -> new
  `packages/server/src/routes/session-launch-request.ts`.
- `isQueuedResponse`, `isQueueFullResponse` -> new
  `packages/server/src/routes/session-launch-results.ts`.
- `parseSessionSandboxLevel`, `persistedSandboxNetworkFirewall`,
  `inheritedSandboxSettings` -> new
  `packages/server/src/routes/session-sandbox-settings.ts`.
- `resolveCompactModelSettings` -> existing
  `packages/server/src/routes/session-compact-thresholds.ts`.
- `ResumeLaunchRequest`, plus the factory closures `getGlobalInstructions`
  and `buildResumeLaunch` (one contiguous block) inside
  `createSessionLaunchSettings` -> new
  `packages/server/src/routes/session-launch-settings.ts`.
- `requestCreationProvenance`, plus the factory closures
  `creationForRequest` and `creationAcceptance` (one contiguous block)
  inside `createSessionCreationRequests` -> new
  `packages/server/src/routes/session-creation-requests.ts`.
- All eleven moved chunks are byte-identical to `HEAD` apart from the
  `export` added to each module-level declaration except the module-private
  `requestCreationProvenance`, and the `deps` parameter type noted below (checked as
  substrings of their new modules). `createSessionsRoutes` calls each
  factory once at its block's old position and destructures the same
  names, so call sites are unchanged.
Signature conversions (closure -> parameter):
- The two factories take the route factory's `deps` as a parameter, typed
  as `SessionCreationRequestDeps` and `SessionLaunchSettingsDeps`.
- `resolveCompactModelSettings`'s `deps` parameter changed type from
  `SessionsDeps` to the new `CompactModelSettingsDeps`, the two services it
  reads; `SessionLaunchSettingsDeps` extends it. Callers still pass
  `SessionsDeps`, which satisfies all three without a cast.
Behavior changes:
- None. The helpers are pure and the closures are stateless, read `deps` at
  request time, and are not called while the route factory is being built.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome check on changed
  files; `git diff --check`; byte-identity check of the moved chunks;
  focused `test/routes`, `test/sessions`, `test/api/sessions.test.ts`,
  `test/auth/limitedUsers.test.ts`, `test/auth/session-access-app.test.ts`,
  `test/native-app/app-creation-relationships.test.ts`, the two
  `test/projects/template-*` creation tests and
  `test/agent-auth-router.test.ts`, through `run-with-safe-home.js`: 2,006
  passed, 13 skipped (186 files), no failures.
- Tier 2: root `pnpm lint` (zero warnings, including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,128; shared 980; relay 139;
  push-broker 45).
- Skipped: Tier 3 client E2E and `pnpm test:e2e:sdk`; no route, admission,
  timer or liveness code moved. Both run for slice 1.3b, which moves the
  routes that call these helpers.
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  7,265 -> 6,713.
- Independent review (claude-opus-5-5, xhigh): every moved chunk matches
  `HEAD` exactly; every free identifier resolves to the same binding, with
  no shadowing; neither factory holds mutable state, and
  `creationAcceptance`'s per-request promise is unchanged; `SessionsDeps`
  satisfies the three deps interfaces without a cast; registration order
  is unchanged and no destructured name is read before its old position;
  no cycle or back-import. Its findings were fixed: the ledger still read
  as dormant and lacked an SRR-018 item, the caller lists were wrong or
  incomplete (the docs and the `createSessionLaunchSettings` comment), row
  1.3b did not name the parser and `ensureDetachedProjectPath` that must
  travel with the routes, and `requestCreationProvenance` had an unneeded
  `export`. Server `tsc --noEmit`, Biome check, `pnpm lint` and
  `pnpm format:check` were re-run after the fixes.
Follow-ups recorded:
- None.

### Slice 1.2c — Session Project Routing (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-016; the follow-up slice 1.2b recorded.

Moved:
- `unscopedGrokReader`, `getUnscopedGrokReader`, `getGrokNativeProjectId`,
  `buildGrokNativeRedirectPath`, `buildSessionProjectRedirectPath` and
  `resolveSessionProjectRouting` (one contiguous block of
  `createSessionsRoutes`) -> the body of `createSessionProjectRouting` in
  the existing `packages/server/src/routes/session-project-routing.ts`,
  which returns the four closures. The block is byte-identical to `HEAD`
  (checked as a substring of the new module).
- `createSessionsRoutes` calls the factory once at the block's old position
  and destructures the four names, so `POST .../refresh-preview` and the
  `sessionDetailRouting` object reference them unchanged.
Signature conversions (closure -> parameter):
- `deps` became a parameter, typed as the new `SessionProjectRoutingDeps`
  so the module does not import `SessionsDeps`; `createSessionsRoutes`
  passes its own `deps` object.
- The factory closure `storedIdentityFor` became the second parameter under
  the same name. It stays in `sessions.ts` for
  `GET /sessions/:sessionId/native-source`, `POST .../clone` and the
  routing object.
Behavior changes:
- None. The closures are invoked only at request time; the routing object
  literal, the only construction-time reader, still follows the call. The
  lazy Grok reader is still created on first use and shared by both
  detail registrars, one per `createSessionsRoutes` call.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome check on changed
  files; `git diff --check`; byte-identity check of the moved block;
  focused `test/routes`, `test/sessions` and every other server test
  matching `redirectProjectId`, `refresh-preview`, `workingProjectId`,
  `grokSessionsDir` or `session-project-routing`, plus
  `session-path-scope.test.ts`, through `run-with-safe-home.js`: 2,069
  passed, 32 skipped (190 files). The first run had one failed test; only
  its summary line was kept, so the test is unnamed and the failure is
  unattributed. Six later runs of the same command with this change, the
  last three logged in full, and the full Tier 2 server suite all passed
  with no failures.
- Tier 2: root `pnpm lint` (zero warnings, including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,128; shared 980; relay 139;
  push-broker 45).
- Tier 3: the client gate
  `pnpm --filter client test:e2e --grep-invert "physical Android"`
  (server from source through `tsx`): 491 passed, 13 skipped, 5 failed.
  `provider-sign-in.spec.ts:161` is the known `HEAD` baseline failure. The
  other four, `artifact-viewer.spec.ts:136`, `async-questions-jump.spec.ts:11`,
  `durable-session-creation.spec.ts:438` and `rendez-compose.spec.ts:8`,
  passed 3/3 each in isolation (`--repeat-each=3`, 12/12), so none
  persists and no `HEAD` comparison was needed.
- Skipped: `pnpm test:e2e:sdk`; it has no case that calls these routes, and
  no queue, timer or liveness code moved.
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  7,423 -> 7,265.
- Independent review (claude-opus-5-5, xhigh): the moved block matches
  `HEAD` lines 1896-2058 exactly; every free identifier resolves to the
  same binding; one lazy Grok reader per factory call, used by both
  registrars; `SessionsDeps` satisfies `SessionProjectRoutingDeps` without
  a cast, and the `Pick<>` narrowing is type-only, so the calls remain
  method calls on `deps.supervisor`/`deps.scanner`; no TDZ, ordering, cycle
  or back-import issue. Its findings were fixed: the docs named the wrong
  `storedIdentityFor` caller, `SessionProjectRoutingDeps` redeclared the
  inherited `grokSessionsDir`, and the Tier 1 note implied the unnamed
  failure was unrelated. The redeclaration was dropped after Tier 2/3 ran
  (a type-only edit; server `tsc --noEmit`, Biome check and
  `pnpm lint` re-run).
Follow-ups recorded:
- `buildGrokNativeRedirectPath` and `buildSessionProjectRedirectPath` have
  identical bodies; only the `suffix` parameter type differs. Folding them
  together changes call sites and the registrars' destructuring, so it was
  left out of this move.
- `SessionProjectRouting` in `session-detail-routes.ts` restates the
  inline return type of `resolveSessionProjectRouting`; declaring it once
  in `session-project-routing.ts` is a type-only follow-up.

### Slice 1.2b — Session-Detail Read Routes (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-015; completes row 1.2 after slice 1.2a.

Moved:
- `GET /projects/:projectId/sessions/:sessionId` ->
  `packages/server/src/routes/session-detail-routes.ts` as
  `registerSessionDetailRoute(routes, deps, routing)`, with the
  factory-level `loadProviderSession` and `boundSessionReads` it alone uses,
  and the module-level `SESSION_DETAIL_SLOW_LOG_MS`,
  `DEFAULT_SESSION_DETAIL_TAIL_COMPACTIONS`,
  `LARGE_FULL_HISTORY_MESSAGE_THRESHOLD`, `roundedMs`,
  `DurableSessionOverlayMessage`, `findDurableOverlayCursor`,
  `sliceAfterDurableOverlayCursor`, `completedPublicShareMessageCount`,
  `getSessionSlashCommands` and `effectiveModelSettingsFromMetadata` (the
  last two exported for the subresource module).
- `GET .../agents`, `GET .../agents/:agentId` and `GET .../metadata` (one
  contiguous block) ->
  `packages/server/src/routes/session-detail-subresource-routes.ts` as
  `registerSessionDetailSubresourceRoutes(routes, deps, routing)`.
- Every moved block is byte-identical to `HEAD` (each checked as a
  substring of its new module); the only edits are the `export` added to
  `getSessionSlashCommands` and `effectiveModelSettingsFromMetadata`.
  `createSessionsRoutes` calls the two registrars at the two blocks' old
  positions.
Signature conversions (closure -> parameter):
- `routes` and `deps` became parameters; `deps` is typed as
  `SessionDetailRouteDeps` so neither module imports `SessionsDeps`.
- The factory closures `resolveSessionProjectRouting`,
  `buildSessionProjectRedirectPath`, `getGrokNativeProjectId`,
  `buildGrokNativeRedirectPath`, `rewindRecordIdsFor` and
  `storedIdentityFor` stay in `sessions.ts` and arrive as the `routing`
  object. Both registrars use all six; the routing pair is also called by
  `POST .../refresh-preview`, `storedIdentityFor` by other routes, and
  `getGrokNativeProjectId` owns the lazy Grok reader both must share. The
  object is destructured at the top of each registrar.
Behavior changes:
- None. Route order, the session-scoped middleware ahead of them, response
  shapes, redirects, error strings and log events are unchanged.
  `boundSessionReads` is now constructed inside `registerSessionDetailRoute`,
  later in the same synchronous `createSessionsRoutes` call; its constructor
  has no side effects.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome check on changed
  files; `git diff --check`; byte-identity check of every moved block;
  focused `test/routes` plus every server test that drives these paths
  (50 files matched by `tailCompactions`, `afterMessageId=`, `/agents/`,
  `/metadata` or `createSessionsRoutes`), through
  `run-with-safe-home.js`: 1,536 passed, 19 skipped.
- Tier 2: root `pnpm lint` (zero warnings, including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,127; shared 980; relay 139;
  push-broker 45).
- Tier 3: the client gate
  `pnpm --filter client test:e2e --grep-invert "physical Android"`
  (server from source through `tsx`): 492 passed, 13 skipped, 4 failed.
  `provider-sign-in.spec.ts:161` is the known `HEAD` baseline failure.
  `artifact-viewer.spec.ts:136` and `durable-session-creation.spec.ts:324`
  passed 3/3 each in isolation. The latter reloads a session through the
  detail read; in the full run it failed earlier, on a 5 s
  `page.waitForResponse` timeout for `POST .../session-creations`, a route
  this slice did not move. `slash-command-argument-completions.spec.ts:344` is flaky with
  the same strict-mode violation (two `status` elements in the goal dialog)
  with this change (4/6), at `132bd5252` (5/6) and with the pre-series
  `161f2d1eb` routes (7/8), so it is a pre-existing client race.
  `pnpm test:e2e:sdk` was not run: it has no case that calls these routes,
  and no queue, timer or liveness code moved.
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  8,943 -> 7,423.
- Independent review (claude-opus-5-5, xhigh), covering 1.2a and 1.2b:
  every moved block found in its new module with only the declared edits;
  the 41-route registration sequence, including the session-scoped
  middleware, identical to `HEAD`; all six routing closures `const` and
  declared before the routing object; one shared lazy Grok reader; one
  `BoundSessionReads` per factory call; same `deps` object; no cycle,
  back-import or shim. It found no code issues. Its doc findings (the
  reason the closures stay, an overstated identity claim, the undisclosed
  `messageId` doc comment, "pure functions", and the follow-up's scope) are
  fixed, and it confirmed the fixes.
Follow-ups recorded:
- Rows 1.3-1.5 remain deferred; each revival is its own SRR item.
- `getGrokNativeProjectId` (with `unscopedGrokReader`),
  `buildGrokNativeRedirectPath` and `rewindRecordIdsFor` now sit in
  `sessions.ts` only as wiring for the two registrars, and
  `resolveSessionProjectRouting`/`buildSessionProjectRedirectPath` are
  shared only with `POST .../refresh-preview`. Lifting them into a domain module
  that takes `deps` would let later registrars stop receiving them as
  parameters; that changes call sites, so it is its own slice. Done as slice
  1.2c (SRR-016), which keeps the call sites and the `routing` parameter.
- `slash-command-argument-completions.spec.ts:344` flakes about 1 in 6-8
  isolated runs at `161f2d1eb` with a strict-mode violation: the goal
  dialog briefly renders two `status` elements. Client race, not
  investigated in these move slices.

### Slice 1.2a — Session-Detail Shared Helpers (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-014; prepares slice 1.2b.

Moved:
- `resolveSessionReader` -> `packages/server/src/routes/session-provider-resolution.ts`.
- `sdkMessagesToClientMessages`, `extractContextUsageFromSDKMessages` and
  the module-private `isCompactBoundaryMessage` ->
  `packages/server/src/routes/session-sdk-history.ts` (new).
- `messageId` -> `packages/server/src/routes/session-message-id.ts` (new).
- Bodies are identical to `HEAD` (checked with `diff`); the only differences
  are a one-line doc comment added above `messageId`, the added `export`
  keywords, the formatter's rewrap of
  `sdkMessagesToClientMessages`'s signature after it, and the `deps` type
  below.
Signature conversions (closure -> parameter):
- None. `resolveSessionReader`'s `deps` parameter is retyped from
  `SessionsDeps` to `SessionReaderResolutionDeps`
  (`SessionProviderResolutionDeps` plus `sessionMetadataService.getMetadata`)
  so the module does not import `sessions.ts`. Callers still pass
  `SessionsDeps`.
Behavior changes:
- None. Helper functions only; call sites unchanged apart from the import.
  `extractContextUsageFromSDKMessages` had only the detail `GET` as caller
  and moved with `sdkMessagesToClientMessages` as the same domain.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome check on changed files;
  `git diff --check`; focused `test/routes`, `test/agent-auth-router.test.ts`,
  `test/media/tool-result-media.test.ts` and
  `test/supervisor/forkLaunchSettings.test.ts`: 1,195 passed, 1 failed.
  The failure, `test/routes/session-path-scope.test.ts:140`, is an artifact
  of running `vitest` directly: it fails the same way at `HEAD`, and passes
  (4/4) through the package's `run-with-safe-home.js --temporary-home`
  wrapper that `pnpm test` uses.
- Tier 2: root `pnpm lint` (zero warnings, including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,127; shared 980; relay 139;
  push-broker 45).
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  9,180 -> 8,943.
- Independent review: see slice 1.2b, which was reviewed together with this
  slice.
Follow-ups recorded:
- Focused server test runs should go through
  `node ../../scripts/run-with-safe-home.js --temporary-home vitest run <files>`
  from `packages/server`; bare `npx vitest run` leaves the host temp
  directory in place and `session-path-scope.test.ts:140` then fails on macOS.

### Slice 1.6 — Session Metadata And Seen-State Routes (Landed 2026-11-06, this commit)

Tracked in doc 053 as SRR-013.

Moved:
- The contiguous `createSessionsRoutes` block registering
  `POST`/`DELETE /sessions/:sessionId/mark-seen`,
  `GET /notifications/last-seen`, `GET /debug/metadata` and
  `PUT /sessions/:sessionId/metadata` ->
  `packages/server/src/routes/session-metadata-routes.ts` as
  `registerSessionMetadataRoutes(routes, deps)`. The block is byte-identical
  to `HEAD` (checked with `diff`); `createSessionsRoutes` calls the registrar
  at the block's old position.
- Imports used only by the block (`SESSION_UNREAD_TIMESTAMP`,
  `parseSessionMetadataPatch`) moved with it.
Signature conversions (closure -> parameter):
- `routes` and `deps` became parameters. `deps` is typed as the narrow
  `SessionMetadataRoutesDeps` (`supervisor`, `notificationService`,
  `sessionMetadataService`, `eventBus`) so the module does not import
  `SessionsDeps` back from `sessions.ts`.
Behavior changes:
- None. The five routes register on the same Hono instance in the same
  relative order, between `POST /sessions/:sessionId/input` and the clone
  route, so matching, mounted paths and `app.ts` middleware are unchanged.
  Event-bus emissions, the archive stop boundary, response shapes and error
  strings moved verbatim.
Verification:
- Tier 1: shared build; server `tsc --noEmit`; Biome lint and format on
  changed files; `git diff --check`; focused
  `test/routes/sessions-metadata.test.ts`,
  `test/routes/non-human-user-turn.test.ts`,
  `test/routes/session-metadata-patch.test.ts`,
  `test/auth/limitedUsers.test.ts`,
  `test/routes/ws-transport-message-auth.test.ts`,
  `test/routes/public-shares.test.ts` and
  `test/routes/sessions-fork-discovery.test.ts`: 275 passed.
- Tier 2: root `pnpm lint` (including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed (server
  7,111 passed / 87 skipped; client 7,127; shared 980; relay 139;
  push-broker 45).
- Tier 3: the client gate
  `pnpm --filter client test:e2e --grep-invert "physical Android"`
  (server from source through `tsx`): 491 passed, 13 skipped, 5 failed.
  None of the five failing specs calls a moved route. Rerun in isolation,
  three passed. `provider-sign-in.spec.ts:161` also fails at `HEAD`
  without this change (baseline). `slash-command-argument-completions.spec.ts:344`
  passed 4/4 at `HEAD` and 4/4 with the change, so it is a load flake. The
  four specs that drive the moved routes (`session-read-state`,
  `non-human-user-turn` at both widths, `question-aside`,
  `session-header-responsive`) passed. `pnpm test:e2e:sdk` was not run: it
  has no case that calls these routes (its files cover real providers and
  WebSocket auth), and no queue, timer or liveness code moved.
- Budget: `pnpm source:budgets --record` lowered `sessions.ts`
  9,354 -> 9,180.
- Independent review (claude-opus-5-5): block byte-identical to `HEAD`;
  registration order, wildcard and param matching, deps identity (plain
  object literal from `app.ts`), event-bus emissions, the archive stop
  boundary and error strings preserved; no cycle, back-import or shim. Its
  two doc nits are addressed: the dated doc 053 pivot note now points at
  SRR-013, and the full client gate replaced a four-spec substitute.
Follow-ups recorded:
- Rows 1.2-1.5 remain deferred; each revival is its own SRR item.
- `provider-sign-in.spec.ts:161` ("focused sign-in keeps startup failures
  visible…") fails at `HEAD` 2026-11-06: the predicate expecting a
  positive count times out at 5 s. Not investigated in this move slice.

### Slice 7.1 — Server Capability Registry By Area (Landed 2026-11-06, this commit)

Moved:
- The 167 `SERVER_CAPABILITIES` entries -> eleven modules named for their
  existing `area` value: `server-capabilities-device-bridge.ts`,
  `-git-status.ts`, `-local-access.ts`, `-project-queue.ts`,
  `-providers.ts`, `-remote-access.ts`, `-rendering.ts`, `-security.ts`,
  `-sessions.ts`, `-settings.ts` and `-speech.ts` (all in
  `packages/shared/src/`), each exporting `<AREA>_SERVER_CAPABILITIES`
  `as const satisfies Record<string, ServerCapabilityDefinition>`. Entries
  are byte-identical and keep their relative order within each area.
  `server-capabilities.ts` composes the eleven objects by spread, in
  alphabetical area order, under the same `as const satisfies` clause.
- `ServerCapabilityKind`, `ServerCapabilityAdvertisement`,
  `ServerCapabilityPermanentLifecycle`,
  `ServerCapabilityTransitionalLifecycle` and `ServerCapabilityDefinition` ->
  `server-capability-definition.ts`; `OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS`
  -> `server-capability-optional-bits.ts`. The area modules need both, and
  importing them from the hub would be a back-import. The wire types
  (`VersionedServerCapabilityAdvertisement`, `ServerCapabilitySource`), the
  exported `*_CAPABILITY` name constants, the by-name map, the encoders and
  `serverHasCapability` stay in the hub.
- Importers repointed: `index.ts` (explicit named exports from the two new
  modules), `scripts/audit-server-capabilities.ts`,
  `scripts/capability-inventory.ts`, `scripts/compatibility-sunsets.ts` and
  their two server tests. No re-export shim remains in the hub.
Signature conversions (closure -> parameter):
- None.
Behavior changes:
- None at runtime. One declared exception to the contract's ordering rule:
  property enumeration order of `SERVER_CAPABILITIES` is now grouped by area
  rather than insertion order. The slice request (2026-11-06) approved
  reordering on condition that no consumer depends on key order; keeping the
  old order would have meant either interleaved area modules or a
  hand-maintained 167-key ordering list in the hub. Consumers checked: the
  only production enumeration builds the by-name
  `Map`, which is order-insensitive because names are unique (checked).
  `/api/version` builds its supported list from explicit constants, not by
  enumerating the registry. The two server tests and two client E2E specs
  that enumerate it assert per name, expect an empty difference, or feed the
  names to the bitset encoder, so none depends on order. The audit's text
  report, the one human-facing listing, is byte-identical (below).
- Public surface of `@yep-anywhere/shared`: unchanged. The barrel names the
  moved exports explicitly; `export *` would have saved four lines but
  would also have exposed the two lifecycle interfaces.
Verification:
- Equivalence against `HEAD` (throwaway check, not committed): a type-level
  exact-equality assertion for `typeof SERVER_CAPABILITIES`,
  `ServerCapabilityKey`, `ServerCapabilityName`, every moved type and the
  optional-bit table (confirmed live by flipping one assertion); runtime deep
  equality of the registry, the optional-bit table (including key order) and
  every remaining exported constant; 167 keys, unique names.
- `pnpm capabilities:audit --as-of 2026-11-06`: text output byte-identical to
  `HEAD`; `--json` inventory, sunsets and findings equal.
- Tier 1: shared build; Biome check on changed files; focused
  `src/__tests__/server-capabilities.test.ts` (33) and server
  `test/version.test.ts`, `test/routes/version.test.ts`,
  `test/scripts/capability-inventory.test.ts`,
  `test/scripts/compatibility-sunsets.test.ts` (81) passed.
- Tier 2: root `pnpm lint` (including the budget check),
  `pnpm format:check`, `pnpm typecheck` and `pnpm test` passed
  (server 7,111 passed / 87 skipped; client 7,127; shared 980; relay 139;
  push-broker 45).
- Budget: `pnpm source:budgets --record` retired the
  `server-capabilities.ts` entry (5,226 -> 445). `index.ts` was raised
  1,719 -> 1,721 with a maintainer-approved `raise` record for the
  explicit barrel exports.
- Tier 3 not required: no route, mount or client-visible surface moved; the
  registry objects are runtime-equal.
- Independent review (gpt-6.1-sol): all 167 entries byte-identical; values
  and types match `HEAD`; client-reference discovery still finds all 179
  locations; no cycle, back-import or shim. Its one finding was the
  enumeration-order change, recorded above as the approved exception.
Follow-ups recorded:
- Slice 7.2 (sessions area is 104 lines under the threshold).
- A key duplicated across two area modules would silently resolve to the
  later spread instead of failing as a duplicate object-literal key.
  `capabilities:audit` catches it only through the ID ledger checks. Not
  changed here; an explicit duplicate-key check would belong in the audit.

### Slice 1.8a — Public-Share Mounting (Landed 2026-11-06, this commit)

Moved:
- The `if (options.publicShareService) { ... }` block from `createApp`
  (`PublicShareSessionDetailEnvelope`, `parsePublicShareSessionDetail`,
  `fetchPublicShareSession`, `loadPublicShareSession`,
  `loadCompletePublicShareSession`, `loadPublicShareSessionUpdatedAt`,
  `loadPublicShareSessionSummary`, `fetchPublicShareProjectFile`,
  `publicShareDeps`, and the five `app.route` mounts) ->
  `packages/server/src/routes/public-share-mounting.ts` as
  `mountPublicShareRoutes`. The body, including its guard and leading
  comment, is byte-identical; `createApp` calls it at the same position.
Signature conversions (closure -> parameter):
- `app`, `options` (typed as `PublicShareMountOptions`, the four services the
  block reads) and the locals `scanner`, `projectDisplayName`,
  `effectiveDataDir` and `localResourcePathPolicy` became parameters. All
  four locals are initialized before the call, so no late binding moved.
Behavior changes:
- None. The loopback `app.fetch` calls still run against the same Hono
  instance at request time, so mount order relative to session detail,
  metadata and files routes is unchanged.
Verification:
- Tier 1: server `tsc --noEmit`; Biome lint on changed files; focused
  `test/routes/public-shares.test.ts`, `test/routes/public-file-shares.test.ts`,
  `test/api/sessions.test.ts` (covers frozen capture through `createApp`) and
  `test/incremental-session.test.ts`: 88 passed, 2 skipped.
- Tier 2: root `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
  `pnpm test` passed (server 7,111 passed / 87 skipped; client 7,127;
  shared 980; relay 139; push-broker 45), with only the baseline
  negative-path log chatter.
- Independent review (gpt-6.1-sol): moved block byte-identical to `HEAD`;
  mount position, options identity, narrowing and request-time loopback
  calls preserved; no extraction issue found.
- Budget: `pnpm source:budgets --record` lowered `app.ts` 4,913 -> 4,645.
- Tier 3 substitute: `pnpm --filter client test:e2e
  e2e/public-share-management.spec.ts e2e/public-share-viewer.spec.ts` — 6
  passed against a real server. Server E2E has no public-share cases, and no
  other mount moved.
Follow-ups recorded:
- Slices 1.8b–1.8e above.

### Slice 3.11 — api/client File/Diff Domain Client (Landed 2026-07-07, this commit)

Moved:
- File fetch, raw file URL construction, and diff context expansion endpoint
  wrappers -> `fileClient.ts`.
- `FileContentResponse` type dependency -> `fileClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same `api.getFile`,
  `api.getFileRawUrl`, and `api.expandDiffContext` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, URLSearchParams query encoding,
  raw file URL construction, diff expansion request bodies, current-source
  transport routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts
  src/components/__tests__/FileViewer.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, file-serving
  server behavior, diff generation behavior, transport framing, or rendered UI
  behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.12 tracks remaining non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, settings writes remain
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization, and network binding remains runtime configuration
  work.

### Slice 3.10 — api/client Push Notifications Domain Client (Landed 2026-07-07, this commit)

Moved:
- Push public-key, subscribe, unsubscribe, subscriptions list, test, delete,
  notification settings read, and notification settings update endpoint
  wrappers -> `pushClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same
  `api.getPushPublicKey`, `api.subscribePush`, `api.unsubscribePush`,
  `api.getPushSubscriptions`, `api.testPush`, `api.deletePushSubscription`,
  `api.getNotificationSettings`, and `api.updateNotificationSettings` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, request bodies, encoded delete
  ids, current-source transport routing, and public call sites were preserved.
- `getConnections` stayed in `api/client.ts`; it reads connected-device state
  from `/connections`, not a `/push/*` route.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts`; scoped `node scripts/biome.cjs lint`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration,
  push-notification server behavior, transport framing, or rendered UI
  behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.11 tracks remaining non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, settings writes remain
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization, and network binding remains runtime configuration
  work.

### Slice 3.9 — api/client Server Metadata Domain Client (Landed 2026-07-06, this commit)

Moved:
- Version, server-info, env-settings, and restart endpoint wrappers ->
  `serverMetadataClient.ts`.
- `VersionInfo`, `ServerInfo`, `EnvSettingEntry`, `EnvSettingsReport`, and
  `GetVersionOptions` type dependencies -> `serverMetadataClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same `api.getVersion`,
  `api.getServerInfo`, `api.getEnvSettings`, and `api.restartServer` methods.
- `api/client.ts` still re-exports the moved public metadata types.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, version refresh query behavior,
  current-source transport routing, and public call sites were preserved.
- Network binding stayed in `api/client.ts`; it mutates runtime listener
  configuration and is a separate risk class from metadata reads/restart.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts
  src/pages/settings/__tests__/LocalAccessSettings.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, server
  metadata/admin behavior, transport framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.10 tracks remaining non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, settings writes remain
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization, and network binding remains runtime configuration
  work.

### Slice 3.8 — api/client Browser Profiles Domain Client (Landed 2026-07-06, this commit)

Moved:
- Browser-profile list and delete endpoint wrappers ->
  `browserProfilesClient.ts`.
- `BrowserProfilesResponse` type dependency -> `browserProfilesClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same
  `api.getBrowserProfiles` and `api.deleteBrowserProfile` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, encoded delete ids,
  current-source transport routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts`; scoped `node scripts/biome.cjs lint`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration,
  browser-profile server behavior, transport framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.9 tracks additional non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, and settings remains
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization.

### Slice 3.7 — api/client Onboarding Domain Client (Landed 2026-07-06, this commit)

Moved:
- Onboarding status, complete, and reset endpoint wrappers ->
  `onboardingClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same
  `api.getOnboardingStatus`, `api.completeOnboarding`, and
  `api.resetOnboarding` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, current-source transport
  routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts`; scoped `node scripts/biome.cjs lint`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, onboarding
  server behavior, transport framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.8 tracks additional non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, and settings remains
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization.

### Slice 3.6 — api/client Recents Domain Client (Landed 2026-07-06, this commit)

Moved:
- Recents fetch, visit-recording, and clear endpoint wrappers ->
  `recentsClient.ts`.
- `EnrichedRecentEntry` type dependency -> `recentsClient.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same `api.getRecents`,
  `api.recordVisit`, and `api.clearRecents` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, request bodies, current-source
  transport routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts
  src/components/__tests__/RecentSessionsDropdown.test.tsx
  src/pages/__tests__/NewSessionPage.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, recents server
  behavior, transport framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.7 tracks additional non-session `api/client.ts` domain-client
  candidates. Public-share remains session-adjacent, and settings remains
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization.

### Slice 3.5 — api/client Auth Domain Client (Landed 2026-07-06, this commit)

Moved:
- Auth status, enable, disable, setup, login, logout, password-change, and
  localhost-access endpoint wrappers -> `authClient.ts`.
- `AuthStatus` type -> `authClient.ts`, re-exported from `api/client.ts`.

Signature conversions:
- None. The exported `api` facade still exposes the same `api.getAuthStatus`,
  `api.enableAuth`, `api.disableAuth`, `api.setupAccount`, `api.login`,
  `api.logout`, `api.changePassword`, and `api.setLocalhostAccess` methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, request bodies, current-source
  transport routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts
  src/pages/settings/__tests__/LocalAccessSettings.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, auth server
  behavior, transport framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints its
  existing negative-path server/client logs. No new chatter was attributed to
  this slice.

Follow-ups recorded:
- Row 3.6 tracks additional non-session `api/client.ts` domain-client
  candidates. Public-share is explicitly session-adjacent, and settings is
  moderate risk because `updateServerSettings` preserves explicit clears with
  custom JSON serialization.

### Slice 3.4 — api/client Git Domain Client (Landed 2026-07-06, this commit)

Moved:
- Current-source JSON fetch helper -> `sourceApiFetch.ts`.
- Git status, untracked-folder, remote-check, integration-options, pull, push,
  and diff endpoint wrappers -> `gitClient.ts`.

Signature conversions:
- None. `api/client.ts` still exports `fetchJSON`, and the exported `api`
  facade still exposes the same `api.getGit*` / `api.pullGit` / `api.pushGit`
  methods.

Behavior changes:
- None intended. Endpoint paths, HTTP methods, request bodies, current-source
  transport routing, and public call sites were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/api/client.test.ts src/hooks/__tests__/useGitStatus.test.tsx
  src/pages/__tests__/GitStatusPage.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan` unchanged from the current budget.
- Tier 3 not run. This slice moved API wrappers behind the same facade and
  added facade-path tests; it did not change route registration, transport
  framing, or rendered UI behavior.
- Residual output: focused API tests still print the existing
  `ConnectionManager` transition lines, and the broad suite still prints
  existing negative-path server/client transport logs. No new chatter was
  attributed to this slice.

Follow-ups recorded:
- Row 3.5 tracks additional `api/client.ts` domain-client candidates. Session
  methods remain explicitly higher risk because they mix resume, queue,
  recap, provider-option, permission, and process-control behavior.

### Slice 3.2 — clientSummaryState Source-Store Queries (Landed 2026-07-06, this commit)

Moved:
- Shared summary collection state, record, snapshot, query descriptor, provider
  runtime snapshot types, and immutable collection defaults ->
  `clientSummaryCollections.ts`.
- Global-session query descriptor/key helpers, provider/project/inbox/project
  queue/session selectors, active-activity classification, record-group
  ordering selectors, and `toProjectId` -> `clientSummaryQueries.ts`.

Signature conversions:
- None. Moved functions already accepted state or records explicitly.

Behavior changes:
- None intended. `clientSummaryState.ts` still owns every `apply*` reducer
  entry point, observation freshness rule, summary merge rule, and source-store
  mutation path; callers now import selectors and shared collection types from
  their owning modules directly.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/lib/__tests__/clientSummaryState.test.ts
  src/lib/__tests__/sourceRuntime.test.ts
  src/lib/__tests__/clientSummaryStore.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm console:scan`.
- Tier 3 was not required: this moved pure summary model/query code and import
  paths only, with no route registration, client-visible surface, transport,
  or rendering behavior change.
- Residual chatter: full tests still emit the baseline broad-suite server/client
  logs, SecureConnection negative-path stderr, and server process termination
  warning/error logs already documented for this refactor series. Console scan
  stayed at warnings `110/110`, method.warn `61/61`, and method.error `95/95`,
  all `+0`.

Follow-ups recorded:
- None.

### Slice 2.11 — SessionPage /btw Sticky Cards (Landed 2026-07-06, this commit)

Moved:
- Sticky `/btw` footer-card stack rendering, card action buttons, expanded
  transcript rendering, and transfer-to-Mother-composer button wiring ->
  `BtwAsideStickyCards.tsx`.

Signature conversions:
- `SessionPage.tsx` now passes aside card items and callbacks into
  `BtwAsideStickyCards`; the page still owns focused aside state, hide/stop
  handlers, expanded-state toggling, and composer-transfer behavior.

Behavior changes:
- None intended. Card text/classes, expand/show behavior, Done/Hide/Stop
  actions, and expanded transcript transfer behavior were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/components/__tests__/BtwAsideStickyCards.test.tsx
  src/components/__tests__/BtwAsidePane.test.tsx
  src/hooks/__tests__/useBtwAsides.test.ts`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2/3: `pnpm test`; `pnpm lint`; `pnpm typecheck`;
  `pnpm console:scan`; Android-excluded client E2E via
  `pnpm --filter @yep-anywhere/client test:e2e --grep-invert "physical Android"`.
- Residual chatter: full tests and client E2E still emit the baseline
  server/client log chatter, Vite chunk/browser-compatibility warnings, and
  Node `NO_COLOR`/`FORCE_COLOR` warnings tracked in the baseline notes.

Follow-ups recorded:
- None.

### Slice 3.1 — useSessionMessages Returned-Detail Adapter Cutdown (Landed 2026-07-06, this commit)

Moved:
- Returned-detail reveal gating, store-backed return selector memoization, empty
  returned transcript fallbacks, and returned tool-use `Map` construction ->
  `sessionDetail/returnedDetail.ts`.
- `AgentContent` / `AgentContentMap` hook exports now re-export the existing
  reducer/store types from `sessionDetail/types.ts` instead of duplicating the
  shape inside `useSessionMessages.ts`.

Signature conversions:
- `buildReturnedToolUseToAgent` accepts the revealed returned-detail slice
  explicitly so `useSessionMessages.ts` keeps the same memoization dependency
  as before.

Behavior changes:
- None intended. `useSessionMessages.ts` still owns initial load and warm
  hydration timing, `useSyncExternalStore` subscription wiring, stream-buffer
  readiness, scroll refs, cache writes, and missing-store diagnostics.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/lib/sessionDetail/__tests__/returnedDetail.test.ts
  src/hooks/__tests__/useSessionMessages.cache.test.tsx
  src/lib/sessionDetail/__tests__/loadProgress.test.ts
  src/lib/sessionDetail/__tests__/revealSnapshot.test.ts
  src/lib/sessionDetail/__tests__/streamBuffer.test.ts`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2/3: `pnpm test`; `pnpm lint`; `pnpm typecheck`;
  `pnpm console:scan`; Android-excluded client E2E via
  `pnpm --filter @yep-anywhere/client test:e2e --grep-invert "physical Android"`.
- Residual chatter: full tests and client E2E still emit the baseline
  server/client log chatter, Vite chunk/browser-compatibility warnings, and
  Node `NO_COLOR`/`FORCE_COLOR` warnings tracked in the baseline notes.

Follow-ups recorded:
- Out of scope for the current lower-risk 058 lane: moving the remaining
  initial-load/warm-hydration orchestration into `SessionDetailCoordinator`.
  That work coordinates warm snapshot reveal, progress state, stream-buffer
  gate opening, cache writes, and missing-store diagnostics, so it should be a
  dedicated session-detail/source-runtime slice rather than a follow-up in this
  module-boundary cleanup.

### Slice 2.2 — SessionPage /btw Aside Orchestration (Landed 2026-07-06, this commit)

Moved:
- `/btw` provider support, prompt builders, side-request extraction, live text
  preview formatting, transcript-turn derivation, aside polling/hydration,
  fork/resume launch, stop/done state, split-pane collapse/focus state, and
  Ctrl+B routing -> `useBtwAsides.ts`.

Signature conversions:
- `SessionPage.tsx` now passes project/session ids, source API, effective
  provider/model/session metadata, permission mode, parent link, toast, and
  parent-navigation callback into the hook instead of letting the moved code
  close over the page.
- The page still owns the generic custom command dispatcher, Mother composer
  transfer/draft attachment behavior, sticky card JSX, and MessageList /
  MessageInput prop wiring.

Behavior changes:
- None intended. `/btw` provider gating, unsupported-provider rejection,
  focused-aside composer routing, split-pane focus/collapse behavior, `/done`
  close-only handling, polling cadence, and parent-link hydration were
  preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/hooks/__tests__/useBtwAsides.test.ts
  src/components/__tests__/BtwAsidePane.test.tsx
  src/lib/__tests__/btwAsideRouting.test.ts`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2/3: `pnpm test`; `pnpm lint`; `pnpm typecheck`;
  `pnpm console:scan`; Android-excluded client E2E via
  `pnpm --filter @yep-anywhere/client test:e2e --grep-invert "physical Android"`.
- Residual chatter: full tests and client E2E still emit the baseline
  server/client log chatter, Vite chunk/browser-compatibility warnings, and
  Node `NO_COLOR`/`FORCE_COLOR` warnings tracked in the baseline notes.

Follow-ups recorded:
- Resolved by Slice 2.11.

### Slice 2.10 — GitStatusPage Diff Preview Module (Landed 2026-07-06, this commit)

Moved:
- `GitDiffPreview`, `GitDiffModal`, diff fetch/loading/error handling,
  full-context and markdown-preview toggles, skipped-preview rendering,
  highlighted diff injection, and plain diff-line fallback ->
  `GitStatusDiffPreview.tsx`.

Signature conversions:
- `GitStatusPage.tsx` now passes selected `fileKey`, retained diff scroll/view
  snapshots, and retention callbacks into the diff preview module instead of
  giving the extracted components the full `SourceControlRouteState`.
- The page still owns selected file state, git action state, untracked folder
  expansion, and route-retention writes.

Behavior changes:
- None intended. The skipped-preview behavior from row 2.10a, full-context
  loading, markdown preview toggle, split-pane scroll retention, and narrow
  modal behavior were preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/client test --
  src/pages/__tests__/GitStatusPage.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2/3: `pnpm test`; `pnpm lint`; `pnpm typecheck`;
  `pnpm console:scan`; Android-excluded client E2E via
  `pnpm --filter @yep-anywhere/client test:e2e --grep-invert "physical Android"`.
- Residual chatter: full tests and client E2E still emit the baseline
  server/client log chatter, Vite chunk/browser-compatibility warnings, and
  Node `NO_COLOR`/`FORCE_COLOR` warnings tracked in the baseline notes.

Follow-ups recorded:
- `GitStatusPage.tsx` still owns git action state and untracked folder modal
  state; further Source Control page cleanup should be proposed as a new row if
  it still ranks above remaining Phase 2/4 items.

### Slice 2.10a — Git Diff Large-Preview Admission Guard (Landed 2026-07-06, this commit)

Moved:
- No component/module boundary move yet; this landed the documented prerequisite
  for row 2.10.

Signature/API changes:
- Added shared `GitDiffResult` and `GitDiffPreviewSkipped` response metadata
  for `/git/diff`.
- Client API typing now consumes the shared `GitDiffResult` instead of a local
  inline shape.

Behavior changes:
- Oversized git diff previews now return bounded skipped-preview metadata
  before syntax highlighting. The server skips untracked files above the
  256 KiB preview byte budget and skips any preview with a line above 20,000
  characters.
- The client renders a compact skipped-preview state and refuses to inject
  highlighted diff HTML above its defense-in-depth render budget.
- Normal small git diff previews still render highlighted diffs.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `pnpm --filter @yep-anywhere/server test --
  test/routes/git-status.test.ts`; focused
  `pnpm --filter @yep-anywhere/client test --
  src/pages/__tests__/GitStatusPage.test.tsx`; scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Tier 3: `pnpm --filter @yep-anywhere/client test:e2e --grep-invert
  "physical Android"`.
- Client tripwire: `pnpm console:scan` stayed at warnings `110/110`,
  method.warn `61/61`, and method.error `95/95`, all `+0`.
- I18n advisory: `pnpm i18n:scan` reported only the preexisting three
  `main.tsx` raw-copy warnings.
- Residual chatter: root `pnpm test` passed with the existing broad suite
  server logs, negative-path WebSocket/SecureConnection stderr, and Codex
  slow-scan WARN entries already documented for this refactor series. Client
  E2E passed with the existing Vite browser-compatibility/chunk-size and Node
  `NO_COLOR`/`FORCE_COLOR` warnings.

Follow-ups recorded:
- Row 2.10 is now unblocked for extracting `GitStatusPage.tsx` diff preview
  fetch/render components into a focused module.

### Slice 4.6 — OpenCode Provider Model Helpers (Landed 2026-07-06, this commit)

Moved:
- `OpenCodeModelSelection`, `LOCAL_GLM_MODEL_PREFIX`,
  `getLocalGlmModelDescription(...)`, `parseOpenCodeModelSelection(...)`, and
  `parseOpenCodeModelVariants(...)` -> `opencode-models.ts`.

Signature conversions:
- None. The moved helpers already accepted all inputs as parameters.

Behavior changes:
- None intended. `opencode.ts` still owns CLI discovery, per-session server
  lifecycle, HTTP/SSE flow, liveness/status handling, interactive prompts, and
  message conversion.
- No provider-general or Claude/OpenCode shared abstraction was introduced.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `pnpm --filter @yep-anywhere/server test --
  test/sdk/providers/opencode-model-variants.test.ts
  test/sdk/providers/opencode.test.ts`; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Chatter: focused OpenCode provider tests retain their existing OpenCode
  server lifecycle info logs; root tests passed with the existing broad suite
  logging and negative-path stderr already documented for this refactor series.

### Slice 2.8 — MessageInput Textarea Mechanics (Landed 2026-07-06, this commit)

Moved:
- Undoable textarea clear/range replacement, inserted-text derivation,
  expanded textarea resize, collapsed cursor scrolling, and draft line counting
  -> `composerTextarea.ts`.
- Leading slash suggestion query and slash command matching normalization ->
  `slashCommands.ts`.
- Client speech turn id and speech target id generation -> `speechTargets.ts`.

Signature conversions:
- None. The moved helpers already accepted their DOM/text dependencies as
  parameters.

Behavior changes:
- None intended. `MessageInput.tsx` still owns draft state, focus/ref timing,
  speech transaction state, submission routing, and slash command selection.
- Browser undo/focus preservation remains at the same call sites: `Ctrl+G`
  clear still edits the textarea before React state, and range replacement still
  goes through the textarea before updating draft state.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter client exec tsc --noEmit`; focused
  `pnpm --filter client test --
  src/lib/__tests__/composerTextarea.test.ts
  src/lib/__tests__/slashCommands.test.ts
  src/lib/__tests__/speechTargets.test.ts
  src/components/__tests__/MessageInput.test.tsx`;
  file-scoped `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 3: `pnpm --filter client test:e2e --grep-invert "physical Android"`.
  The run passed with the documented Vite chunk-size/browser-compatibility and
  Node `NO_COLOR`/`FORCE_COLOR` baseline warnings.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Console budget: `pnpm console:scan` stayed at warnings `110/110`, method.warn
  `61/61`, and method.error `95/95`, all `+0`.
- Chatter: root `pnpm test` passed with the existing broad suite logging and
  negative-path stderr already documented for this refactor series.

### Slice 4.5 — Codex Recap/Summary Helpers (Landed 2026-07-06, this commit)

Moved:
- Side-session recap prompt construction, fork recap/retitle/handoff prompt
  construction, fork helper resume params, recap helper-model selection, summary
  text cleanup/joining, raw response text extraction, and summary text capture
  from turn items/notifications -> `codex-summary-helpers.ts`.

Signature conversions:
- `captureRecapTextFromTurnItems(...)` and
  `captureRecapTextFromNotification(...)` became
  `captureCodexSummaryTextFromTurnItems(...)` and
  `captureCodexSummaryTextFromNotification(...)`. They now receive the
  provider's existing `normalizeThreadItem` function as an explicit dependency.

Behavior changes:
- None intended. `codex.ts` still owns app-server lifecycle, timeout/abort
  flow, helper thread/fork execution, and non-turn server request decline
  behavior.
- Provider-visible prompt strings, developer instructions, timeout values,
  helper model preference order, and empty-summary errors are preserved.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `pnpm --filter @yep-anywhere/server test --
  test/sdk/providers/codex-summary-helpers.test.ts
  test/sdk/providers/codex.test.ts test/render-parity.test.ts`;
  file-scoped `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Chatter: the root `pnpm test` run still emits existing unrelated suite
  stdout/stderr and the existing Codex reader slow-scan warning from default
  app-test access to `~/.codex/sessions`. The focused Codex
  summary/provider/render-parity runs for this slice were warning-free.

### Slice 4.3 — Codex Notification Guards (Landed 2026-07-06, this commit)

Moved:
- Codex notification shape guards and the live-delta method/env classifiers ->
  `codex-notification-guards.ts`.

Signature conversions:
- Private provider methods such as `asTurnCompletedNotification(...)` and
  `asRawResponseItemCompletedNotification(...)` became exported
  `asCodex...Notification(...)` functions. Callers still pass the same unknown
  payloads and receive the same typed object-or-null result.

Behavior changes:
- None intended. The guard predicates and live-delta suppression env check are
  preserved.
- Command/file/permission/user-input approval request guards intentionally stay
  in `codex.ts`; they validate server request params, not notifications.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `pnpm --filter @yep-anywhere/server test --
  test/sdk/providers/codex-notification-guards.test.ts
  test/sdk/providers/codex.test.ts`; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Existing Codex provider fixtures were the relevant stream/persisted parity
  check for this slice because only guard/classifier placement changed; live
  conversion and durable item rendering stayed in `codex.ts`.
- Explicit parity: `pnpm --filter @yep-anywhere/server test --
  test/render-parity.test.ts`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Chatter: the root `pnpm test` run still emits existing unrelated suite
  stdout/stderr and, in the normal local environment, an existing Codex reader
  slow-scan warning from default app-test access to `~/.codex/sessions`. The
  focused Codex guard/provider/render-parity runs for this slice were
  warning-free.

### Slice 6.2 — Process Scenario Test Split (Landed 2026-07-06, this commit)

Moved:
- Shared Process test helpers (`createMockIterator`,
  `createControllableIterator`, `waitFor`, session-queue persistence setup,
  recap provider setup, and common Process/MessageQueue/type imports) ->
  `process.test-support.ts`.
- The 103 Process/MessageQueue scenarios -> `process.queue.test.ts`,
  `process.events-liveness.test.ts`, `process.runtime-status.test.ts`,
  `process.recaps.test.ts`, `process.deferred-queue.test.ts`,
  `process.lifecycle.test.ts`, `process.permission-mode.test.ts`,
  `process.message-history.test.ts`, and `process.termination.test.ts`.

Signature conversions:
- None. Test bodies keep the same assertions and setup. The split follows the
  former nested `describe` groups, with `deferred queue` separated from the
  ordinary message-queue and slash-command cases.

Behavior changes:
- None. This is test-only organization. The three fake-timer tests remain in
  `process.events-liveness.test.ts` and still restore real timers in `finally`
  blocks.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `pnpm --filter @yep-anywhere/server test -- test/process.queue.test.ts
  test/process.events-liveness.test.ts test/process.runtime-status.test.ts
  test/process.recaps.test.ts test/process.deferred-queue.test.ts
  test/process.lifecycle.test.ts test/process.permission-mode.test.ts
  test/process.message-history.test.ts test/process.termination.test.ts`;
  file-scoped `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Integrity check: a local indentation-aware script verified all 103 moved
  `it(...)` bodies match `HEAD` exactly.
- Architecture tripwire: `topics/architecture-mandates.md` was read before
  editing because the split covers Process liveness, idle retention, deferred
  queue, interrupt, and termination tests.
- Chatter: the focused Process run and root test run still emit existing
  approval/termination/session logger stdout/stderr; this slice did not add
  production logging or change the test assertions that exercise those paths.

Follow-ups recorded:
- `process.deferred-queue.test.ts` remains the largest split file because the
  patient/deferred queue scenarios share promotion, persistence, and join-window
  setup. Further split it only if a queue-specific fixture helper can reduce
  repetition without hiding delivery-boundary inputs.

### Slice 6.1 — MessageList Scenario Test Split (Landed 2026-07-06, this commit)

Moved:
- Shared jsdom cleanup, ResizeObserver setup, i18n mock translations, message
  builders, clipboard/pointer helpers, and the transcript harness ->
  `MessageList.test-support.tsx`.
- The 62 `MessageList` scenarios -> `MessageList.rendering.test.tsx`,
  `MessageList.thinking.test.tsx`, `MessageList.queue.test.tsx`,
  `MessageList.selection.test.tsx`, `MessageList.scroll.test.tsx`, and
  `MessageList.search.test.tsx`.

Signature conversions:
- None. Test bodies keep the same assertions and props. Scenario files import
  the shared support module before `MessageList` so the hoisted i18n mock is
  registered before the component under test loads.

Behavior changes:
- None. This is test-only organization.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/client exec tsc --noEmit`; focused
  `pnpm --filter @yep-anywhere/client test -- MessageList`; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`. The focused
  `MessageList` run was warning-free; the root test run still emitted existing
  unrelated suite stdout/stderr chatter.
- Client tripwires: `packages/client/RENDERING_PERFORMANCE.md`,
  `topics/scrollback-view-stability.md`, and `topics/console-chatter.md` were
  read before editing; `pnpm console:scan` stayed within the committed budget
  at warnings 110/110, `method.warn` 61/61, and `method.error` 95/95.
- Client E2E: skipped because no production client code or user-visible
  behavior changed; the split preserves the existing scenario assertions.

Follow-ups recorded:
- `MessageList.scroll.test.tsx` remains the largest scenario file because the
  scroll/follow cases share dense DOM geometry setup. Split it further only
  with enough helper extraction to improve readability without hiding the
  scroll-anchor inputs.

### Slice 1.7 — Settings Parser Split (Landed 2026-07-06, this commit)

Moved:
- Settings request parsers, client-default merging, OpenAI-compatible helper
  target URL/model discovery helpers, file-access setting parsing, speech audio
  retention parsing, prompt-cache keepalive parsing, and cache-miss billing
  parsing -> `settings-parsers.ts`.

Signature conversions:
- None. The route factory imports the same parser functions and still passes
  the same raw payload/current-setting values.

Behavior changes:
- None intended. `settings.ts` still owns endpoint registration, runtime
  callbacks, `ServerSettingsService` calls, config default/precedence handling,
  public-share revocation, remote executor SSH testing, and response/error
  shapes.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `settings.test.ts`; file-scoped `node scripts/biome.cjs lint`;
  `git diff --check`; staged diff reviewed with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Settings/config tripwire: `topics/hard-development-rules.md` was read before
  editing; the slice does not alter defaults, environment precedence, hosted
  endpoints, relay selection, migrations, provider/model defaults, or
  configuration persistence.

Follow-ups recorded:
- `settings.ts` still contains the large `PUT /api/settings` update flow. A
  later slice could extract a request-update builder only if it preserves the
  current error strings, callback order, and settings-service update shape.

### Slice 6.3 — Codex Provider Event Fixtures (Landed 2026-07-06, this commit)

Moved:
- Live event-state test setup plus repeated Codex app-server notification
  fixtures and expected SDK/render outputs for agent message deltas, context
  compaction, interrupted turns, and raw function-call/result events ->
  `codex-event-fixtures.ts`.

Signature conversions:
- None. The tests still call `convertNotificationToSDKMessages()` directly and
  still assert concrete expected objects; only the literal fixture data moved.

Behavior changes:
- None. This is test-only fixture organization.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `codex.test.ts`; file-scoped `node scripts/biome.cjs lint`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Codex tripwire: Codex provider tests ran. Stream/persisted render parity was
  not required because no production event conversion, persistence, or
  transcript rendering code moved.

Follow-ups recorded:
- Command-execution orphan/background-process edge-case notifications remain
  inline in `codex.test.ts`; move them only if a later fixture slice can keep
  those scenario assertions as readable as the current inline form.

### Slice 4.2 — Codex Model Catalog Helpers (Landed 2026-07-06, this commit)

Moved:
- Current and legacy fallback Codex model lists, preferred model ordering, the
  GPT-5.5 fallback cutoff, semver normalization/comparison, app-server model
  shape, model list normalization, model metadata normalization, service-tier
  cleanup, sort ranking, and display-name formatting ->
  `codex-model-catalog.ts`.
- The former provider-private model-list assertion moved from the large
  `codex.test.ts` file to `codex-model-catalog.test.ts`, with added semver and
  fallback-selection coverage.

Signature conversions:
- `CodexProvider.getModelsFromAppServer()` now passes app-server model data to
  `normalizeCodexModelList()`.
- `CodexProvider.getFallbackCodexModels()` still owns CLI version discovery,
  then passes the normalized version to
  `getFallbackCodexModelsForCliVersion()`.

Behavior changes:
- None intended. `codex.ts` still owns model cache timing, CLI/app-server
  process execution, JSON-RPC model/list handling, and fallback-on-query-error
  behavior. The Codex CLI target version and compatibility markers were not
  changed.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`; focused
  `codex-model-catalog.test.ts` and `codex.test.ts`; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`; staged diff reviewed
  with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Codex tripwire: `references/codex` was present; the Codex provider tests ran.
- Skipped: provider stream/persisted render parity, because this slice only
  moved model catalog selection/normalization and does not touch event
  conversion, persistence, or transcript rendering.

Follow-ups recorded:
- `CodexProvider` still owns app-server model/list process startup, JSON-RPC
  handshake parsing, cache TTL, and fallback decision timing. Those belong with
  the app-server client or provider lifecycle slices, not this catalog move.

### Slice 2.9 — NewSessionForm Helper Modules (Landed 2026-07-06, this commit)

Moved:
- Pending new-session attachment union types, display metadata helpers, staged
  ref persistence, and object URL cleanup -> `newSessionAttachments.ts`.
- Recap/prompt-suggestion option ordering, default resolution, helper-side
  model default validation, and thinking launch option shaping ->
  `newSessionOptions.ts`.
- Project chooser sorting, typed-path normalization, typed-project lookup, and
  chooser/suggestion counts -> `newSessionProjects.ts`.

Signature conversions:
- The new helper modules take explicit project lists, provider capability
  objects, model lists, defaults, and pending-file values instead of closing
  over `NewSessionForm.tsx` locals.
- New-session staged attachment persistence reuses the existing session
  composer persistence helper for the shared `StagedAttachmentRef` shape.

Behavior changes:
- None intended. The New Session form still owns i18n copy, provider/default
  state transitions, WS-006 workstream selection, draft hydration, staged upload
  effects, and submission/project-queue orchestration.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`; focused
  `NewSessionForm` and new helper tests; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`; staged diff reviewed
  with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Client tripwire: `topics/console-chatter.md` was read before editing and
  `pnpm console:scan` stayed within the committed budget.
- Client E2E: `pnpm --filter client test:e2e --grep-invert
  "physical Android"`.
- Skipped: `pnpm i18n:scan`, because no user-visible copy moved or changed.

Follow-ups recorded:
- Stateful draft hydration, staged upload promises, local-file materialization,
  speech target helpers, and submission/project-queue orchestration remain in
  `NewSessionForm.tsx`; those need separate slices if they are moved.

### Slice 2.7 — MessageInputToolbar Layout Measurement (Landed 2026-07-06, this commit)

Moved:
- Bottom-row overflow tier state, width/gap measurement helpers, toolbar layout
  refs type, and the pure overflow layout signature ->
  `useMessageInputToolbarLayout.ts`.
- `MessageInputToolbarView` now imports the measured overflow tier hook and
  signature builder instead of owning the DOM measurement loop directly.

Signature conversions:
- `MessageInputToolbarViewProps.refs` now uses the exported
  `MessageInputToolbarLayoutRefs` type. The hook still takes explicit
  `layoutKey`, `hasControls`, and optional refs.
- Existing focused tests now import
  `getComposerToolbarOverflowLayoutSignature` and its input type from the
  layout hook module.

Behavior changes:
- None intended. The CSS class names, overflow tier progression, resize
  observer scheduling, pinned-control handling, compact status float logic, and
  liveness display projection are unchanged. Compact status measurement remains
  in `MessageInputToolbar.tsx` because it is coupled to liveness/status
  projections rather than the bottom-row overflow menu.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `MessageInput`, `SessionToolbarPreview`, and
  `useSessionToolbarPresence` tests; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`; staged diff reviewed
  with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Client tripwire: `topics/console-chatter.md` was read before editing and
  `pnpm console:scan` stayed within the committed budget.
- Client E2E: `pnpm --filter client test:e2e --grep-invert
  "physical Android"`.

Follow-ups recorded:
- `MessageInputToolbar.tsx` still owns compact status/liveness projections and
  shortcut popover interactions. Those are separable future slices, but this
  slice kept the high-risk liveness display behavior local.

### Slice 2.6 — MessageList Isearch UI State (Landed 2026-07-06, this commit)

Moved:
- Reverse-search React state, selected-target tracking, input/focus restore
  refs, arrow-repeat timers, match/selection/panel/navigator projections,
  visible-turn-group filtering, guide-state dispatch, search panel rendering,
  and query/case/selection callbacks -> `useMessageListIsearch.tsx`.

Signature conversions:
- The hook takes explicit `containerRef`, `displayRenderItems`, `turnGroups`,
  and `inert` inputs instead of closing over `MessageList.tsx` locals.
- `MessageList.tsx` keeps the keyboard coordinator for Ctrl+End/Ctrl+O and
  delegates search-specific actions to hook callbacks. Search Enter still calls
  `MessageList`'s `scrollToRenderId`, so transcript scroll/follow ownership
  remains in the component.

Behavior changes:
- None intended. The pure match, scope, panel-label, navigator-state, and
  visible-group selector functions stayed in `lib/sessionDetail/search.ts` via
  the existing `renderSelectors` surface.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `MessageList` and `renderSelectors` tests; file-scoped
  `node scripts/biome.cjs lint`; `git diff --check`; staged diff reviewed
  with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`. The root test run still
  emitted the baseline suite chatter recorded above.
- Client tripwires: `packages/client/RENDERING_PERFORMANCE.md`,
  `topics/scrollback-view-stability.md`, and `topics/console-chatter.md` were
  read before editing; `pnpm console:scan` stayed within the committed budget.
- User-visible copy move: `pnpm i18n:scan` passed with the existing 3 warnings
  outside this slice.
- Client E2E substitute: focused `pnpm --filter client test:e2e --
  e2e/session-streams.spec.ts e2e/project-new-session-cta.spec.ts` passed
  with the existing Vite and `NO_COLOR`/`FORCE_COLOR` warnings. The raw
  Android-including `pnpm test:e2e` command was not rerun for this docs/code
  slice because the previous run in this environment failed only in the
  environment-gated physical Android stream smoke (`2G0YC1ZF93041Z` reported
  `failed` instead of `connected`); the focused transcript/session specs are
  the relevant substitute under the pre-clarification gate wording.

Follow-ups recorded:
- `MessageList.tsx` still owns scroll/follow snapshots; row 2.5 remains the
  next `MessageList` boundary slice, but it is higher risk and should include
  browser/manual scroll verification if started.

### Slice 2.4 — MessageList Selection/Quote Behavior (Landed 2026-07-06, this commit)

Moved:
- Transcript selection copy listener, coarse-pointer chrome shielding,
  selected-text quote button state/placement/rendering, keyboard quote typing,
  quote-anchor tint reconciliation, and text-block quote-circle mode handling
  -> `useMessageListSelectionQuote.tsx`.

Signature conversions:
- The hook takes explicit `containerRef`, `inert`, quote composer callbacks,
  composer draft state, `quoteClearSignal`, follow-button visibility, and an
  `isInteractiveTarget` predicate instead of closing over `MessageList.tsx`
  locals.

Behavior changes:
- None intended. The hook is called at the old selection-effect position so
  copy, selection, pointer, resize, scroll, and key listener registration order
  relative to the surrounding `MessageList` effects stays aligned with the
  pre-extraction code. `MessageList.tsx` still owns transcript rendering,
  scroll/follow state, search state, and row action wiring.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused `MessageList`, markdown-selection-copy, and comment-anchor tests;
  file-scoped `node scripts/biome.cjs lint`; `git diff --check`; staged diff
  reviewed with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`. The root test run
  still emitted the baseline suite chatter recorded above.
- Client tripwire: `packages/client/RENDERING_PERFORMANCE.md`,
  `topics/scrollback-view-stability.md`, and `topics/console-chatter.md` were
  read before editing; `pnpm console:scan` stayed within the committed budget.
- Client E2E substitute: focused `pnpm --filter client test:e2e --
  e2e/session-streams.spec.ts e2e/project-new-session-cta.spec.ts` passed
  with the existing Vite and `NO_COLOR`/`FORCE_COLOR` warnings. The raw
  Android-including `pnpm test:e2e` command was not rerun for this docs/code
  slice because the previous run in this environment failed only in the
  environment-gated physical Android stream smoke (`2G0YC1ZF93041Z` reported
  `failed` instead of `connected`); the focused transcript/session specs are
  the relevant substitute under the pre-clarification gate wording.

Follow-ups recorded:
- `MessageList.tsx` still owns scroll/follow snapshots and isearch UI state;
  rows 2.5 and 2.6 remain the next `MessageList` boundary slices.

### Slice 2.3 — SessionPage Composer Submission/Attachments (Landed 2026-07-06, this commit)

Moved:
- Composer draft-transfer helpers -> `sessionComposerSubmission.ts`:
  `getComposerTransferReplacement`, `appendComposerTransferDraft`, and
  `appendSlashCommandDraft`.
- Submission attachment collection/materialization helpers ->
  `sessionComposerSubmission.ts`: `collectComposerAttachmentsForSubmission`,
  `createComposerDraftAttachmentState`,
  `splitComposerAttachmentsForSubmission`, and
  `materializeComposerAttachmentsForSubmission`.
- Core per-file composer upload preparation -> `sessionComposerSubmission.ts`
  as `uploadComposerAttachmentFile`.

Signature conversions:
- Attachment collection now takes explicit current attachments, pending upload
  promises, pending-message update callbacks, and composer-setter callback
  instead of closing over `SessionPage.tsx` refs/state.
- Materialization and upload helpers take explicit `sourceTransport`,
  `projectId`, `sessionId`, upload sizing, and progress callback parameters.
  `SessionPage.tsx` still owns React state transitions, API send branches,
  toasts, pending-message rows, and preview-cache side effects.

Behavior changes:
- None intended. Draft clearing/restoring, object URL revocation, staged batch
  validation, pending upload waiting, and send/queue/project-queue API calls
  preserve the existing flow.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused attachment/draft tests; file-scoped `node scripts/biome.cjs lint`;
  `git diff --check`; staged diff reviewed with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Client tripwire: `topics/console-chatter.md` was read before editing and
  `pnpm console:scan` stayed within the committed budget.
- Client E2E substitute: focused `pnpm --filter client test:e2e --
  e2e/session-streams.spec.ts e2e/project-new-session-cta.spec.ts` passed
  with the existing Vite and `NO_COLOR`/`FORCE_COLOR` warnings. The raw
  Android-including `pnpm test:e2e` command was not rerun for this docs/code
  slice because the previous run in this environment failed only in the
  environment-gated physical Android stream smoke (`2G0YC1ZF93041Z` reported
  `failed` instead of `connected`); the focused session/page specs are the
  relevant substitute under the pre-clarification gate wording.

Follow-ups recorded:
- `SessionPage.tsx` still owns `/btw` orchestration and title-edit UI state;
  rows 2.2 and 2.4 remain the next high-value client-page/component slices.
- `NewSessionForm.tsx` has similar staged/direct attachment upload structure;
  leave that for row 2.9 rather than widening this slice.

### Slice 2.1 — SessionPage Pure Helpers (Landed 2026-07-06, this commit)

Moved:
- Composer attachment type guards/conversion/preview cleanup ->
  `sessionComposerAttachments.ts`.
- Turn/message text extraction -> `sessionMessageText.ts`.
- Public-share initial prompt parsing -> `sessionPublicSharePrompt.ts`.
- Codex config-ack parsing -> `sessionCodexConfigAck.ts`.
- Session page title display, retitle prompt, and generated-title insertion
  helpers -> `sessionTitleHelpers.ts`.

Signature conversions:
- Title display resolution now takes an explicit structural input object and
  returns `{ sessionTitle, headerAutoTitle, displayTitle, titleTooltip }`.
  `SessionPage.tsx` uses the same `displayTitle` and `titleTooltip` values as
  before.

Behavior changes:
- None intended. This is a pure helper move; `SessionPage.tsx` call sites,
  state ownership, API calls, rendering, and UI copy are unchanged.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/client exec tsc --noEmit`;
  focused client helper tests; file-scoped `node scripts/biome.cjs lint`;
  `git diff --check`; staged diff reviewed with `--color-moved`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Client tripwire: `topics/console-chatter.md` was read before editing and
  `pnpm console:scan` stayed within the committed budget.
- Client E2E: focused `pnpm --filter client test:e2e --
  e2e/session-streams.spec.ts e2e/project-new-session-cta.spec.ts` passed
  with the existing Vite and `NO_COLOR`/`FORCE_COLOR` warnings. The raw
  Android-including `pnpm test:e2e` command was attempted; the session/page
  specs passed, but the run failed in the environment-gated physical Android
  stream smoke because the attached device `2G0YC1ZF93041Z` reported `failed`
  instead of `connected`.

Follow-ups recorded:
- `SessionPage.tsx` still owns `/btw` orchestration, composer submission, and
  title-edit UI state; rows 2.2 and 2.3 are the next high-value page slices.

### SRR-009 — Session Metadata Patch Parsing (Landed 2026-07-06, this commit)

Moved:
- `PUT /sessions/:sessionId/metadata` request-body validation and
  normalization -> `session-metadata-patch.ts` as
  `parseSessionMetadataPatch`.

Signature conversions:
- The route now parses `unknown` JSON, receives either a normalized
  `SessionMetadataPatch` or an error/status pair, and passes the normalized
  patch to `SessionMetadataService.updateMetadata`.

Behavior changes:
- None intended. Metadata service updates, SSE event emission, route path, and
  response shape stayed in `sessions.ts`; parser tests pin the existing error
  strings and normalization rules.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`;
  `pnpm --filter @yep-anywhere/server test -- test/routes/session-metadata-patch.test.ts test/routes/sessions-metadata.test.ts`;
  `node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-metadata-patch.ts packages/server/test/routes/session-metadata-patch.test.ts`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Residual risk: the focused route test run still emits the preexisting
  sessions-metadata WARN/INFO log chatter for negative-path Claude
  resume/compact cases, and root `pnpm test` still emits the baseline suite
  chatter recorded above.

Follow-ups recorded:
- Phase 1.6 remains the larger metadata/notifications route extraction
  (landed as slice 1.6 / SRR-013, 2026-11-06).

### SRR-005 — Recovered Queue Helpers (Landed 2026-07-06, this commit)

Moved:
- `ensureProcessForRecoveredItem`, `resumeRecoveredGroup`,
  `reportableProcessState`, and `resolveRecoveredGroupForDelivery` ->
  `session-recovered-queue.ts`.

Signature conversions:
- Recovered queue helpers accept `RecoveredQueueDeps` instead of closing over
  the sessions route's `deps`, `getGlobalInstructions`, and
  `persistLaunchMetadata`.

Behavior changes:
- None. Recovered-queue route handlers, route paths, response shapes, and
  `waitForPatientQueuePersistenceIdle()` waits stayed in `sessions.ts`.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`;
  `pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts`;
  `node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-recovered-queue.ts`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Tier 3 / tripwire: `topics/architecture-mandates.md` was read before
  editing; `pnpm test:e2e:sdk` was run for queue/liveness coverage.
- Residual risk: the focused route test run still emits the preexisting
  sessions-metadata WARN/INFO log chatter for negative-path Claude
  resume/compact cases, and root `pnpm test` still emits the baseline suite
  chatter recorded above.

Follow-ups recorded:
- Phase 1.5 remains the larger queue/deferred route extraction.

### SRR-004 — Session Thinking Options (Landed 2026-07-06, this commit)

Moved:
- repeated launch/resume/restart/message `body.thinking` conversion ->
  `session-thinking-options.ts` as `buildThinkingOptions`.

Signature conversions:
- The new helper accepts a narrow body shape with `thinking` and
  `showThinking`, then delegates to shared `thinkingOptionToConfig`.

Behavior changes:
- None. Model/default, service-tier, provider, executor, recap, and
  prompt-suggestion fallback rules stayed in `sessions.ts`.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`;
  `pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts`;
  `node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-thinking-options.ts`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Residual risk: the focused route test run still emits the preexisting
  sessions-metadata WARN/INFO log chatter for negative-path Claude
  resume/compact cases, and root `pnpm test` still emits the baseline suite
  chatter recorded above.

Follow-ups recorded:
- Phase 1.3 still owns route extraction for start/create/resume/reactivate
  paths; remaining model/default normalization can be revisited there if it
  stays move-only.

### Slice 1.1 — Sessions Route Helper Boundaries (Landed 2026-07-06, this commit)

Moved:
- `persistedPatientQueueSummary`,
  `recoveredPatientQueueSummaries`, `recoveredPatientQueueItems`,
  `sessionQueueSummaries`, `recoveredPatientUserMessage`, and
  `livePatientEntriesNewerThan` -> `session-queue-summaries.ts`.
- `isClaudeSdkProviderName`, `isCodexProviderName`, and
  `providerResolutionDeps` -> `session-provider-resolution.ts`.

Signature conversions:
- Queue summary helpers accept `SessionQueueSummaryDeps` instead of the route
  file's `SessionsDeps`.
- `providerResolutionDeps` accepts `SessionProviderResolutionDeps` instead of
  the route file's `SessionsDeps`.

Behavior changes:
- None.

Verification:
- Tier 1: `pnpm --filter @yep-anywhere/shared build`;
  `pnpm --filter @yep-anywhere/server exec tsc --noEmit`;
  `pnpm --filter @yep-anywhere/server test -- test/routes/sessions-metadata.test.ts test/routes/sessions-clone-codex.test.ts test/routes/recents.test.ts`;
  `node scripts/biome.cjs lint packages/server/src/routes/sessions.ts packages/server/src/routes/session-queue-summaries.ts packages/server/src/routes/session-provider-resolution.ts`;
  `git diff --check`.
- Tier 2: `pnpm lint`; `pnpm typecheck`; `pnpm test`.
- Residual risk: the focused route test run still emits the preexisting
  sessions-metadata WARN/INFO log chatter for negative-path Claude
  resume/compact cases, and root `pnpm test` still emits the baseline suite
  chatter recorded above; chatter cleanup remains outside this move slice.

Follow-ups recorded:
- Phase 1.2 still needs a proposed SRR item before implementation.


### Restart compaction outside HTTP — 2026-10-27

Doc 053 SRR-012 moves the restart-only compaction attempt to
`supervisor/restart-compaction.ts`, with a type-only Process dependency and no
Hono dependency or back-import. Both HTTP callers and existing route tests
remain unchanged. Verbatim helper comparison passed except exports; no
parameter conversion. Plan 163 records Tier 1/2 and SDK timer-tripwire evidence.
Client E2E is unnecessary for this slice: no route registration, UI or wire
contract changes; unchanged route tests exercise both HTTP callers. Cleanup
of refused/thrown dispatch is a separate behavior fix, outside the move.
