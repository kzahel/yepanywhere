# Session Detail Data Layer Plan

Topic: session-detail-data-layer

This is the current tactical plan for the vision in
[`topics/session-detail-data-layer.md`](../../topics/session-detail-data-layer.md).
Completed-slice detail lives in
[`043-session-detail-data-layer-history.md`](043-session-detail-data-layer-history.md).
The store-backed returned-detail cutover audit lives in
[`043-session-detail-data-layer-toggle-preflight.md`](043-session-detail-data-layer-toggle-preflight.md).
The render-selector preflight lives in
[`043-session-detail-render-selector-preflight.md`](043-session-detail-render-selector-preflight.md).
The current-state audit of the landed detail-store shape lives in
[`045-session-detail-store-current-state-audit.md`](045-session-detail-store-current-state-audit.md).
The boundary-refactor tracker for splitting the cache manager from per-entry
stores lives in
[`046-session-detail-store-boundary-refactor.md`](046-session-detail-store-boundary-refactor.md).

## Current Status

The migration is in the adapter/store cutdown phase. We have a tested
`SessionDetailState` reducer and a small keyed external store, and the store
snapshot is now the returned data source for the main transcript, subagent maps,
and tool-use mapping after hydration/reveal. Transcript local mirrors and
post-reveal transcript fallback refs have been removed; the remaining work is to
continue shaving down reveal/progress/pagination bookkeeping.

What is already in place:

- Reducer fixtures cover persisted load, stream, catch-up, replay, duplicate
  prompts, duplicate assistant rows, pagination, retained scroll snapshots,
  recaps/cursors, Codex-shaped parity, final markdown augments, and several
  subagent/message-cache paths.
- `useSessionMessages` feeds the session detail store at existing load,
  stream, catch-up, pagination, mapping, subagent, metadata, and
  scroll-snapshot boundaries.
- Dev-only diagnostics can compare live hook state against the store without
  logging transcript text. The earlier hook-local shadow reducer ref was
  removed once store parity reporting covered the same comparison; the store
  is the single mirrored reduction.
- The earlier returned-data invariant diagnostic was removed because it
  compared returned data to the same store snapshot that produced it. It did
  not provide an independent safety signal.
- Same-tab route snapshot retention now sits behind
  `defaultSessionDetailStore`, with TTL, byte-cap, retain/release, selector
  subscriptions, and stats. TTL and the byte budget are user-configurable
  Performance-settings sliders (budget 0 = off, replacing the old boolean
  toggle, whose stored value still seeds the budget); the entry-count cap
  is retired in favor of the budget. Row charges are measured per object
  (memoized by identity, calibrated against real transcripts in
  `sessionDetail/transcriptCharge.ts`) and rows shared across entries are
  charged once in aggregate eviction accounting.
- Public raw setter escape hatches have been removed for tool-use mappings,
  session metadata, agent content, and messages.
- Narrow selectors are already used for retained scroll, pagination,
  older-page cursor selection, transcript post-dispatch validation, and main
  streaming placeholder message upsert/cleanup.
- Initial load, warm-route restore, warm catch-up before hydration, and warm
  catch-up after hydration now share one selected-runtime-snapshot reveal path:
  after the store restore/load/catch-up action, the hook reads that snapshot to
  update scroll bookkeeping while preserving the existing loading gate. Cursor
  and timestamp-watermark state are reducer-owned. The store-vs-fallback reveal
  snapshot shape now lives in a tested `sessionDetail/revealSnapshot` helper.
- Warm and cold initial reveal completion now share one hook-local completion
  helper for applying the reveal snapshot, marking reload phases, flushing the
  buffered stream queue, clearing loading, and writing final progress.
- Initial reveal route-cache writes now share a reveal-snapshot cacheability
  helper: only store-backed reveal snapshots are eligible, so missing-selector
  fallback snapshots still cannot be written back to the route cache.
- The stream buffer item shape, append helpers, reset, and drain operation now
  live in a tested `sessionDetail/streamBuffer` helper. The hook still owns the
  initial-load readiness gate and dispatches drained events in order.
- Session-load progress window details now use a tested
  `sessionDetail/loadProgress` helper, so repeated message-count/pagination
  projection is no longer hand-built at each load stage. The hook still owns
  when each progress stage is emitted.
- Route-cache refresh on unmount now reads the current route snapshot directly
  from `defaultSessionDetailStore` instead of rebuilding it from returned hook
  data. The old `latestSnapshotRef` mirror has been removed; diagnostics that
  need local context read store-selected state plus hook-owned scroll context.
- `toolUseToAgent` registration now dispatches through the reducer/store and
  validates the selector-backed mapping read after dispatch instead of keeping a
  hook-local returned-data `Map`.
- `agentContent` ordinary subagent stream events, loaded subagent content,
  context-usage updates, and subagent streaming placeholder upsert/cleanup now
  dispatch through the reducer/store and validate the selector-backed map read
  after dispatch instead of copying it back into a hook-local mirror.
- Ordinary stream, streaming-placeholder, subagent, tool-use mapping,
  persisted catch-up, and older-page adapter paths no longer independently
  recompute or retain legacy fallback transcript data after dispatch. They read
  the store-selected result only where post-dispatch diagnostics or
  missing-selector diagnostics need it.
- Selected runtime-snapshot reveal updates hook-owned scroll bookkeeping but
  does not write local `messages`, `agentContent`, tool-use, session,
  pagination, cursor, or timestamp-watermark state. Reset-to-loading uses an
  explicit current-route reveal gate instead of clearing local transcript state,
  so warm store data and stale route detail stay hidden until the route
  snapshot is revealed.
- No-signal store/local diagnostics have been removed from store-selected
  stream, placeholder, subagent, tool-use, reveal, cursor, and watermark paths.
  Remaining `[SessionDetailStore]` logs cover metadata, catch-up/older
  selected-data checks, scroll snapshots, and unexpected missing selectors.
- Store-selected `messages`, `agentContent`, and tool-use mappings are now the
  only returned hook data after initial hydration has reached the reveal point.
  The Development settings rollback switch has been removed. If the store entry
  is unexpectedly missing after reveal, the hook returns empty transcript
  surfaces and logs `session-detail-store-missing-after-reveal` in dev.
- The returned-detail subscription now selects only `messages`, `agentContent`,
  and tool-use mapping entries. Metadata, pagination, scroll, and other
  non-transcript store updates no longer notify that returned transcript
  subscription.
- Returned-detail reveal gating, store-backed return selection, empty returned
  transcript fallbacks, and returned tool-use `Map` construction now live in a
  tested `sessionDetail/returnedDetail` helper. The hook still owns the
  `useSyncExternalStore` subscription, reveal timing, and missing-store
  diagnostic emission.
- Warm-refresh merge and pagination preparation now lives in a tested
  `sessionDetail/warmRefresh` helper that shares persisted-message merge/tagging
  helpers with the reducer. The hook still coordinates loading progress and
  dispatch timing, but it no longer owns the warm merge/pagination candidate
  calculations inline.
- Focused hook coverage now verifies that store-authoritative returned
  `messages` preserve selector-only rows across ordinary stream events,
  incremental catch-up, and older-page prepend.
- Focused hook coverage also verifies that store-authoritative returned
  `agentContent` is gated during warm hydration and returns selector-only
  entries after reveal.
- Focused hook coverage now verifies that store-authoritative returned
  tool-use mappings can expose selector-only entries after reveal.
- Focused hook coverage also verifies that same-hook route changes keep stale
  route detail hidden before the next route has revealed, including an
  initial-load error path, and that a missing store entry after reveal returns
  empty transcript surfaces with an explicit dev diagnostic.
- Focused hook coverage now verifies that metadata-only store updates do not
  rerender the returned transcript subscription or replace returned transcript
  references.
- Focused helper coverage verifies warm-refresh pre-hydration cursor/no-cursor
  merge behavior and after-hydration use of the latest store snapshot as the
  merge base. Reducer coverage owns loaded-window pagination invariants.
- Focused helper coverage verifies reveal snapshot construction from a selected
  runtime snapshot, including the empty-transcript fallback path for unexpected
  missing store selection, cursor derivation, retained scroll fallback, and
  cloned message/tool-use arrays. It also verifies that only store-backed reveal
  snapshots are exposed for route-cache writes.
- Focused helper coverage verifies session-load progress construction, including
  injectable timestamps, pagination projection, and the fact that callers choose
  the message count rather than implicitly using `returnedMessageCount`.
- Focused helper coverage verifies stream-buffer ordering, drain-clears
  behavior, and reset behavior for queued main/subagent stream events.
- Warm-cache hook coverage now verifies that an after-cursor refresh which
  returns compacted-tail pagination is treated as an explicit anchor-miss
  replacement: the reducer replaces the loaded tail window instead of smuggling
  a boundary change through ordinary catch-up.
- The catch-up store-authoritative hook fixture now guards against React's
  cross-update warning. Metadata reconciliation no longer dispatches to the
  external store from inside the legacy `setSession` functional updater.
- The render-selector preflight is complete: transcript/view shape
  derivation — render items and turn grouping, search anchors/projections,
  timeline and progressive-reveal entries, thinking summaries, composer tail
  rows, and action eligibility — lives in the `sessionDetail/` render-selector
  concern modules, which callers import directly (the former
  `renderSelectors` barrel was removed with the `export *` ban). The full
  covered-output list is
  in
  [`043-session-detail-render-selector-preflight.md`](043-session-detail-render-selector-preflight.md).

Current diagnostic stance:

- Treat `scroll-snapshot` store divergence logs as known noisy signal
  from the older snapshot path. Do not spend migration time chasing those until
  returned `messages`/`agentContent` and render-selector parity are otherwise
  boring enough for a cleaner cutover audit.
- Keep dogfooding the default store-backed returned-detail path and turn
  visible regressions or non-scroll store/local divergences into compact
  fixtures. Store/local diagnostics now have residual signal mostly for
  metadata handoff, scroll snapshots, and unexpected missing selectors.
- Do not use absence of `[SessionDetailReturnedData]` logs as evidence. That
  diagnostic was removed because the default returned data is store-selected by
  construction. Current confidence comes from reducer fixtures, focused hook
  tests, and dogfooding the real browser path.
- Browser mismatch checks should use the real inbox-to-session path, not only
  unit fixtures. A useful read-only pass is: launch Playwright against
  `https://127.0.0.1:3400`, ignore local HTTPS errors, block service workers
  if possible, set
  `yep-anywhere-session-detail-shadow-diagnostics-enabled` to `true`, click a
  few visible `/inbox` session links, and capture console/page/request
  failures plus `[SessionDetailShadow]` and `[SessionDetailStore]` logs. Also
  sample
  `main.session-messages` `scrollTop`, `scrollHeight`, and `clientHeight` so
  scroll-to-top symptoms are separated from data divergence.
- A 2026-07-02 browser pass found no scroll-to-top reproduction and no
  data-visible regression, but did expose two follow-up signals: a Codex
  compaction-tail case where live state represented a returned tail window
  while the store/shadow entry had a much larger accumulated transcript, and a
  React warning caused by external-store notification during a React state
  reducer. The tail-window/full-history contract now has reducer/store/hook
  fixtures and an explicit `replaceTailWindow` anchor-miss action; the warning
  case is covered by the catch-up hook fixture and fixed by keeping metadata store
  dispatch out of the legacy state updater.

The key remaining truth is simple: the reducer/store is now the default source
for returned `messages`, `agentContent`, and tool-use mappings after hydration.
The Development settings switch was removed once it stopped providing an
independent data-semantics rollback. Hook-local transcript fallback ownership is
gone, including the warm/initial reveal helper's former full-transcript fallback
payloads. The render-selector preflight is complete enough for cutover planning:
`MessageList` still owns stateful UI, callbacks, scroll, DOM behavior, and JSX,
but broad transcript/view shape derivation is no longer hidden inside the
component.

## Why This Exists

Session detail state grew inside hooks and render components. That made several
classes of bugs hard to reason about or test:

- duplicate prompts or assistant rows;
- live stream vs reload shape drift;
- order-dependent markdown/file/diff augments;
- subagent rows that differ between streaming SDK state and persisted logs;
- inline renderer resets after cache restore or DOM linger;
- scroll bugs whose visible symptom is far away from the data transition that
  caused them.

The goal is a data lifecycle that can be tested from payload snapshots and
reducer actions before we look at the DOM.

## Current Ownership

Ownership is intentionally still split while we migrate:

- `useSession` owns session status, liveness, stream/watch subscriptions, and
  page-level actions.
- `useSessionMessages` owns initial REST load, stream-buffer readiness timing,
  metadata updates, older-page request timing, scroll bookkeeping, and snapshot
  lifecycle. Returned transcript data, pagination, session metadata, cursors,
  and replay watermarks are store-selected or reducer-owned rather than kept in
  local mirrors.
- `defaultSessionDetailStore` owns the reducer-fed canonical mirror and retained
  same-tab cache entries.
- `MessageList` still owns display policy, progressive rendering, scroll
  snapshots, selection, quote/search UI, and DOM timing. Pure render-item,
  assistant-segment, search-anchor, visible-group, search-match, latest
  correctable prompt, timeline-entry, progressive-count, and
  progressive-visibility projections plus thinking summary/display, timestamp,
  composer-tail, composer-tail row metadata, and assistant timeline row
  metadata and timeline display-row metadata derivation now live outside the
  component.
- Renderer contexts still own DOM/render conveniences, but lazy-loaded agent
  content now enters through the action layer.

This split is acceptable while the hook return shape remains compatible. The
selector preflight should not continue as an open-ended cleanup project; the
next meaningful migration work is in the hook/store adapter.

## Constraints

- Keep token-sized streaming and scroll ticks out of ordinary React
  subscriptions.
- Keep same-tab retention memory-only unless a product requirement asks for
  durable browser persistence.
- Preserve user-visible behavior unless a fixture exposes a clear bug.
- Prefer explicit actions and selectors over a broad global rerender source.
- Keep the coarse client summary store separate from session detail state.
- Default user-facing behavior must stay provider-like. New experimental
  runtime changes should start default-off in Developer settings before they
  graduate into the default path.

## Migration Shape

The strategy remains shadow-first and adapter-first:

1. Keep the reducer/store fed from existing hook boundaries.
2. Add compact fixtures when diagnostics expose a divergence.
3. Replace one local derivation at a time with a store selector plus fallback.
4. Promote store-authoritative returned surfaces once fixtures and dogfooding
   show parity.
5. Keep `MessageList` and DOM-local scroll/progressive rendering out of the
   data-layer cutover until the data model is boring.

Avoid a full split-world UI where old and new session pages both render
production traffic. That would duplicate stream ownership, cache retention, and
DOM timing problems.

## Near-Term Plan

Next likely slice:

- Treat the render-selector preflight as complete enough. Do not keep
  extracting every remaining branch from `MessageList` unless it directly
  unlocks store cutover or fixes a fixture-backed bug.
- Continue dogfooding the default store-authoritative returned
  `messages`/`agentContent`/tool-use mapping path and turn any visible
  regression or meaningful non-scroll store/local divergence into a compact
  reducer or hook fixture. Do not reintroduce a returned-data invariant unless
  it compares two genuinely independent sources.
- Treat legacy local transcript mirror ownership as removed. Ordinary stream,
  placeholder, mapping, catch-up, and older-page recompute fallbacks are gone;
  warm/initial reveal reads one selected runtime snapshot and no longer carries
  full transcript fallback payloads; route-cache persistence reads back from the
  store; reset/loading uses a separate returned-detail reveal gate; and
  no-signal store/local diagnostics have been narrowed out.
- Keep the compaction/tail invariant explicit: `loadPersistedTranscript`
  represents the REST-returned transcript window, including ordinary
  `tailCompactions: 2` responses whose `pagination.totalMessageCount` is larger
  than `pagination.returnedMessageCount`; `prependOlderMessages` expands the
  window backward, and `replaceTailWindow` explicitly replaces an anchor-miss
  fallback tail. Ordinary catch-up may extend the live tail and update counts,
  but it must not move `hasOlderMessages` or the older-page cursor.
- Move the next implementation chunk back to `useSessionMessages`: keep shaving
  down reveal/progress/pagination bookkeeping. Warm-refresh merge preparation,
  reveal snapshot construction/cacheability, and progress detail construction
  are now pure/tested; initial reveal completion is centralized; stream-buffer
  item/drain mechanics are helper-owned; the reveal path no longer owns
  transcript fallback data; and the returned transcript subscription is
  selector-specific.

Then:

- Do not broaden to scroll ownership or `/btw` until returned `messages` and
  `agentContent` are boring.

Store-backed return path:

- Scope: returned `messages`, `agentContent`, and tool-use mappings.
- Behavior today: read store-selected `messages`, `agentContent`, and tool-use
  mappings from one coherent store-state snapshot after hydration/reveal.
- Missing-store behavior: after reveal, an unexpectedly missing retained store
  entry returns empty transcript surfaces and logs
  `session-detail-store-missing-after-reveal` in dev. This is an
  adapter/retention bug, not an alternate data path.
- Missing-selector behavior: if warm/initial reveal cannot read a runtime
  snapshot after a store dispatch, it logs
  `session-detail-selector-missing-after-dispatch`, applies the warned empty
  transcript fallback, and skips writing that empty result back to the route
  cache.
- Keep local refs only where they still support imperative side effects for
  independently owned fields such as scroll. Cursor, timestamp watermark,
  pagination, and metadata reads should go through the store/reducer layer.
- Ordinary post-dispatch store-selected paths no longer update local transcript
  refs or local mirror state.
- Reveal follows the same rule for returned store-backed surfaces. Reset starts
  an explicit returned-detail reveal gate instead of clearing transcript state to
  preserve warm-hydration gating.
- Store/local diagnostics no longer run on paths where the live payload is just
  the selected store result; remaining logs are for metadata, scroll, or missing
  selector cases.
- Do not include render selectors or `/btw` in this cutover.

## Current Risks

- Initial load and warm hydration still contain the most sequencing logic
  because they coordinate loading progress, warm-cache reveal, cache writes,
  and stream-buffer flushing inside the hook. Their visible reveal now comes
  from one selected store snapshot; warm refresh merge/pagination preparation,
  reveal snapshot construction/cacheability, and progress detail construction
  are pure; and initial reveal completion is centralized, but the hook still
  owns progress timing, cache writes, and the readiness timing for stream-buffer
  flushing.
- Transcript fallback refs are gone, so a missing retained store entry after
  reveal intentionally empties returned transcript surfaces and logs a dev
  diagnostic. Treat that as a retention/adapter failure, not a recoverable
  rollback mode.
- Compaction-tail and full-history states are easy to confuse because the
  default route has no explicit `tailTurns`/`tailFrom` URL parameter even
  though the client requests `tailCompactions: 2`. Treat message-count
  differences where `totalMessageCount > returnedMessageCount` as a cutover
  invariant to classify, not automatic noise.
- Retention pre-creates the entry for mounted sessions, so the store dispatch
  guard only protects completely missing/unretained entries. If a required
  selector read after dispatch ever logs
  `session-detail-selector-missing-after-dispatch`, treat that as an
  adapter/retention bug and add a fixture.
- Returned transcript data no longer subscribes to the broad state object, but
  other hook-local bookkeeping still reads broader runtime snapshots for reveal
  and diagnostics. Keep the next cleanup focused there before expanding scope.
- Subagent live-vs-durable parity is intentionally broad-shape only. Some
  providers may not persist enough SDK-side subagent data to guarantee exact
  equivalence.
- `MessageList` still performs semantic display work for stateful UI,
  especially progressive reveal state/timing, search navigation state, and
  `/btw` ownership. Store canonical state does not yet mean render canonical
  state.
- Scroll symptoms can still be caused by DOM timing, retained snapshots, or
  render-item identity, not just data shape.
- `scroll-snapshot` diagnostics are currently useful as a reminder that final
  cutover needs a cleaner parity signal, but they are not a near-term blocker
  while the rest of the data/render layer is still migrating.
- Store-authoritative returned messages can expose reducer gaps quickly; turn
  any such signal into a reducer or hook fixture before widening scope.

## Later Work

### Bounded Active Transcript Window

Use the reducer/store ownership established by this migration to discard an old
loaded prefix while a long-running session follows the live tail. The approved
policy, cheap-check requirement, pagination/auxiliary-state cleanup, and
mount-scoped Load older suppression are specified in
[`060-bounded-active-transcript-window.md`](060-bounded-active-transcript-window.md).
Keep that work separate from the remaining adapter cutdown and from row
virtualization.

### Hook Adapter Migration

Make `useSessionMessages` mostly a compatibility adapter over the store while
preserving its public return shape.

Important tests:

- initial load and warm restore produce equivalent store/local state;
- stream buffering before initial load applies once and in order;
- catch-up after cached restore does not reset the transcript;
- older-page prepend preserves scroll metadata and cursors;
- multiple consumers of the same session detail key see coherent data.

### Render Selector

Make the renderable transcript view a deterministic selector before changing
`MessageList` ownership.

Important tests:

- same canonical state yields stable render item ids/order;
- equivalent stream and persisted state produce equivalent render items;
- inline renderer keys survive cache restore and DOM linger reveal;
- display settings do not mutate canonical state.

### `/btw` And Multi-Consumer Cleanup

Represent related session consumers as explicit session detail entries instead
of page-local side channels.

Important tests:

- `/btw` aside preview updates through session detail data;
- side-by-side consumers do not share scroll or selection state;
- unmounting one consumer does not evict data retained by another;
- stream/watch ownership remains explicit.

## Verification Matrix

Keep coverage growing in three layers:

- Reducer fixtures for data shape, dedupe, provenance, cursor, and augment
  behavior.
- Hook/store tests for adapter boundaries, selector fallback, warm retention,
  and lifecycle cleanup.
- Browser tests only when the risk is DOM-local: scroll, progressive rendering,
  inline renderer identity, or visible layout.

When behavior differs from current runtime, capture the existing behavior or bug
as a failing reducer/selector test before changing UI code.

## Rollout Notes

- Prefer adapters over large rewrites.
- Keep dev diagnostics available during dogfooding.
- Store stats should answer which sessions are retained, why, approximate bytes,
  and expiry time.
- New experimental toggles should be default-off and easy to disable. The
  store-backed returned-detail switch has graduated into the default path and
  has been removed.
- A successful dogfood period should leave behind fixtures for any divergence
  that was found and fixed.
