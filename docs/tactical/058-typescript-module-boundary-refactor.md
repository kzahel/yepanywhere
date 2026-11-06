# TypeScript Module Boundary Refactor

Topic: typescript-module-boundary-refactor

Status: Resumed 2026-11-06. The growth guard is live in `pnpm lint`, and the
`app.ts` composition-root lane (slice 1.8) is in progress. The remaining
`sessions.ts` route-registrar extractions are still deferred.

Accepted 2026-10-27: [plan 163](163-http-independent-restart-compaction.md)
and doc 053 SRR-012 describe one HTTP-independent restart-compaction
extraction, followed by a separate observer-lifetime fix. The maintainer
authorized both after independent plan review; SRR-012 landed as `06cff21d6`.
This does not reactivate the other deferred route extractions.

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
should revive or supersede the dormant child ledger in
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
helpers and read routes), and SRR-016 (session project routing) —
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
| 1.3 | Deferred 2026-07-06 | Start/create/resume/reactivate routes | Extract new-session, two-phase create, resume, and reactivation handlers; propose as an SRR item first if revived. | Deferred with the sessions route-registrar lane. Preserve provider selection, YA-visible session ids, executor persistence, queue-full behavior, and remote sync behavior if revived. |
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
- `MessageInput.tsx`: bang completion/menu ownership and the recall drawer each
  communicate with the composer through a narrow text/ref surface. Add separate
  Phase 2 slices when either feature is next modified; preserve keyboard,
  focus, undo, and measured toolbar behavior.
- `clientSummaryState.ts`: session-id aliasing, record merge, and projection
  rewrites around `mergeRemappedSessionRecords` form a candidate remap module.
  It extends slice 3.2 only if the reducer update stays behavior-identical and
  the full remap fixture matrix moves with it.
- `SessionPage.tsx`: recall wiring and navigation-state consumption are the
  remaining named candidates after the landed pure-helper, `/btw`, attachment,
  and sticky-card slices. Choose one feature boundary per follow-up rather than
  another general page-helper module.

Remove a candidate from this section when its slice lands or fresh inspection
shows the seam is no longer coherent. Delete the gap only when all four
recorded ownership defects are resolved or replaced by narrower gaps.

## Phase 4: Provider Adapter Splits

Provider files are large, but they touch upstream-facing behavior. Prefer
extracting pure protocol/model/normalization modules with strong fixtures.

| Slice | Status | Target | Intent | Tripwires / Notes |
|---|---|---|---|---|
| 4.1 | Not started | `sdk/providers/codex.ts` app-server client | Move `CodexAppServerClient`, JSON-RPC queueing, process termination, and raw request helpers into focused modules. | Tripwire matrix: Codex row. Run Codex provider tests and server E2E. |
| 4.2 | Done 2026-07-06 | Codex model catalog helpers | Move fallback model data, semver parsing, model sorting, and model metadata normalization. | App-server process/query/cache ownership stayed in `codex.ts`; focused catalog tests pin fallback selection and normalized ordering. |
| 4.3 | Done 2026-07-06 | Codex notification guards | Move `as*Notification` guards and raw notification classifiers into a protocol module. | Guard-only extraction; approval request param guards stay in `codex.ts`. Focused guard tests and existing Codex provider fixtures preserve stream/persisted conversion behavior. |
| 4.4 | Not started | Codex live event conversion | Move live turn state, streaming message construction, and item-to-SDK conversion. | Higher risk; preserve live-delta suppression and replay behavior. Tier 3. |
| 4.5 | Done 2026-07-06 | Codex recap/summary helpers | Move recap prompts, fork-backed summary prompt/params, retitle prompt, helper model selection, text cleanup, and summary capture helpers. | App-server orchestration and non-turn request decline behavior stayed in `codex.ts`; focused helper/provider/render-parity tests preserve provider-visible prompts and summary output behavior. |
| 4.6 | Done 2026-07-06 | OpenCode provider model helpers | Move OpenCode model selection, local-GLM model descriptions, and verbose variant parsing. | Provider process/HTTP/SSE orchestration and message conversion stayed in `opencode.ts`; no Claude/OpenCode shared abstraction introduced. |

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
