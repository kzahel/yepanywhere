# Session Detail Data Layer

> YA needs a canonical, data-only session detail layer between provider
> transcript inputs and transcript DOM rendering, so streaming, persisted,
> replayed, augmented, and subagent messages converge before `MessageList`
> receives renderable data.

Topic: session-detail-data-layer

Status: Vision. Use this document to orient design work before editing
`useSession`, `useSessionMessages`, transcript stream handlers, session
message caches, augments, subagent transcript rendering, or `/btw` transcript
surfaces. The tactical implementation plan starts in
[`docs/tactical/043-session-detail-data-layer-plan.md`](../docs/tactical/043-session-detail-data-layer-plan.md).
For the higher-level source/runtime boundary above this transcript data layer,
see
[`client-source-runtime-topology.md`](client-source-runtime-topology.md).
For transcript image/blob payloads that should become server-served handles
before entering retained client state, see
[`session-media-handles.md`](session-media-handles.md).

## Problem

Session detail currently has no well-understood data-only layer of truth. Core
transcript state is spread across hooks, refs, component-local state, route
snapshot caches, stream handlers, renderer contexts, and special feature paths.
That made sense when the session page was smaller, but it now obscures the
semantics that should be testable independently from the mounted DOM.

Observed and recurring symptoms:

- duplicate assistant messages, duplicate user prompts, and stream-vs-durable
  dedupe rules that are difficult to reason about from a top-down view;
- live SDK streaming and persisted/reloaded transcripts can render different
  shapes for the same provider conversation;
- server-authoritative parent/tree message following can behave differently
  during streaming than after a reload;
- subagent transcript rows can have different live, lazy-loaded, and reloaded
  shapes;
- markdown/tool/file augments are order-sensitive and sometimes fail to attach
  even when the underlying transcript data is present;
- inline renderer state, including nested scrollbars, can reset because stable
  data identity and DOM-local state ownership are not cleanly separated;
- same-tab retained transcript snapshots are stored through an implicit global
  side channel rather than an explicit session-detail owner;
- `/btw` asides and related helper-session surfaces act like UI-side channels
  instead of first-class consumers of session detail data.

The important point is not that refs are bad. YA needs ref-heavy streaming and
scroll paths for performance. The problem is that refs and nested hooks now own
semantic transcript decisions that should be visible, reducible, and testable
without mounting the whole session page.

## Target Shape

The desired pipeline is:

```text
provider stream / REST load / replay / catch-up / subagent load
  -> transcript reducer
  -> canonical session detail store
  -> render selector
  -> MessageList DOM and block renderers
```

The data layer should canonicalize provider input before UI rendering. A live
SDK stream sequence and the equivalent persisted transcript read should produce
the same canonical session detail shape, modulo explicitly modeled transient
state such as an in-flight token stream. Subagents are the early exception to
that parity bar: provider persistence and live activity surfaces differ enough
that the first goal is explicit provenance and broad shape correctness, not
claiming exact live/reload equivalence before fixtures prove it.

This document is intentionally below the source-runtime layer. It describes how
one source/project/session/window becomes canonical renderable session detail.
It does not own source selection, source transport, multi-host UI, or the
future `YaSourceRuntime` / `SessionDetailCoordinator` topology.

## Boundaries

### Store-owned data

A session detail store should own core session data and lifecycle:

- session metadata and ownership/process-derived detail facts;
- durable transcript messages in canonical identity/order form;
- pending, deferred, recovered, and project-queue transcript-adjacent rows;
- pagination and loaded-window metadata;
- subagent/agent transcript content;
- tool-use-to-agent mappings and provider parent/tree relationships;
- load state, load progress, replay/catch-up watermarks, and persisted cursors;
- retained scroll snapshot metadata at the cache-entry boundary, outside the
  reducer state, without making every scroll tick a reactive UI event;
- same-tab retention and eviction rules for warm session detail snapshots.

### MessageList-owned state

`MessageList` and block renderers should continue to own DOM-local behavior:

- actual `scrollTop` and layout measurements;
- auto-follow refs, scroll-intent detection, resize observers, and catch-up
  timers;
- progressive DOM rendering cadence;
- selection, quote, isearch, and focused preview UI;
- renderer expansion state that is truly visual-only and keyed by stable
  canonical render ids;
- streaming-markdown DOM patch refs when React state per token would be too
  expensive.

The store should make data identity stable enough that DOM-local state can be
keyed predictably. It should not become a sink for every browser scroll event
or token-sized text mutation.

## Canonical Reducer

The center of the design should be a pure transcript reducer. It should accept
normalized actions and produce a canonical session detail state:

```ts
loadPersistedTranscript(...)
applySdkStreamEvent(...)
applyReplayEvent(...)
applyCatchupMessages(...)
loadSubagentContent(...)
prependOlderMessages(...)
applyMetadataPatch(...)
patchScrollSnapshot(...)
```

Those actions should be testable without React. The reducer is where YA should
settle duplicate suppression, stable ids, parent/tree projection, subagent
attachment, durable-vs-live parity, and augment attachment identity.

Duplicate suppression requires shared provenance identity. Equal type, role,
content, attachment set, parent, or timestamp does not make two provider log
rows duplicates: repeated prompts and responses are valid transcript events.
When live and durable sources expose the same provider item id, or a provider
persists YA's supplied client id, the reducer merges by that id. When an older
server or provider cannot supply it, the reducer preserves both rows rather
than guessing from content or client-observed time. A provider-log timestamp
may advance a durable freshness watermark, but it is not message identity.

Codex, Antigravity, and Grok can anchor linear catch-up using shared message
IDs. The durable batch's sequence takes precedence over the arrival positions
of matching live rows. This places missed user turns before a reply already
received live while retaining intervening rows and unmatched live output.
Without a shared ID, a batch is placed before the first retained row with a
later known timestamp. Equal or missing timestamps preserve the existing
order of unmatched rows. Codex and Antigravity recognize previously loaded
replay rows by ID. Grok retains its timestamp watermark for replayed echoes
whose IDs can differ from the durable record.

The shared `transcriptReducer.ordering.test.ts` cases exercise the reducer
through the visible timeline. They cover catch-up after a reply, overlapping
refresh, older pages, and cold reload with equal, missing, and nonmonotonic
timestamps. Reconnect cases cover ID matching for Codex and Antigravity and
the watermark for a Grok echo whose ID differs. A Claude case checks
parent-chain ordering. See
[provider user-turn identities](../gaps/provider-user-turn-durable-identity.md)
for gaps in ID alignment.

The visible timeline preserves canonical turn order even when timestamps are
missing or out of order. This keeps dated live replies below older
Antigravity history restored without timestamps. Known timestamps still
place `/btw` asides between transcript turns. When the transcript has no
dated turns to anchor the asides, the asides follow the transcript.

## Augment Contract

Augments should attach at the data layer by stable message/block identity, not
by incidental DOM render order or event arrival timing. The render selector may
decide how to display an augment, but the data layer should answer whether the
augment belongs to a canonical message/block.

This is especially important for server-rendered markdown/file/diff augments,
tool result cards, task-list snapshots, subagent excerpts, and any provider
that emits live stream events with ids that later differ from durable rows.

## Streaming Contract

Streaming remains performance-sensitive. The data layer should distinguish:

- stable message envelope identity and turn/tree placement, which should be
  store-owned;
- high-frequency token or streaming markdown DOM updates, which may remain
  ref-backed and renderer-owned;
- commit points where streamed content becomes durable/canonical and can be
  compared against persisted transcript reads.

The goal is not to force every token through React or an external store
notification. The goal is to make the lifecycle of incoming messages explicit:
received, normalized, maybe streaming, committed, reconciled with durable data,
and selected for rendering.

An append-only Codex detail read extends the accepted normalized projection
rather than converting its complete retained transcript again. It preserves
the prior message prefix and carries user-turn pairing and tool-lifecycle state
forward. A previously returned projection remains immutable: an appended event
that completes or orphans an earlier tool row updates a copy for the new
projection. A replaced, shortened, or compacted source may rebuild because its
historical projection can change. These cache rules do not change durable
message ids or the selected compact-tail/full-history window.

Incremental catch-up serializes reads per mounted session window, but
serialization must not erase demand. Calls arriving during one in-flight read
coalesce into one trailing read after it settles; calls during that trailing
read preserve another trailing pass. This bounds concurrent parsing while
ensuring that a file event, reconnect, or liveness heartbeat observed during a
slow transcript read is eventually reconciled.

The focused session watch requests catch-up on its initial open as well as
after a reconnect, except while initial snapshot hydration is still pending.
The pending snapshot already closes the pre-watch interval; another full-tail
read at watch-open or reconnect only duplicates that work. Once hydration has
settled, watch-open and reconnect catch-up resume normally. File-change demand
observed during hydration still reaches the serialized trailing-read path.

A provider-progress heartbeat compares its progress timestamp with
`transcriptSnapshotUpdatedAt` from the last REST transcript response whose rows
the detail store applied. Each provider reader captures that timestamp with its
accepted file, database, export, or in-process message snapshot; later summary
or metadata work cannot advance it. Activity-channel metadata patches are not a
transcript watermark: they can advance `session.updatedAt` even when the
corresponding content-stream events did not reach this browser.

A successful initial load, incremental catch-up, or full-tail reconciliation
advances the watermark only when it applies at least one returned row. An empty
incremental response, a failed read, or an older server that omits the additive
snapshot field leaves the watermark unchanged. The same provider heartbeat can
therefore request another bounded catch-up until a row-bearing snapshot closes
the gap. An owned session that misses live content recovers while the turn
remains active, without waiting for idle or a page reload.

## Store Model

The store should be a custom external store with keyed selectors, not a generic
global rerender source. Useful properties:

- synchronous reads for first render and cache restoration;
- imperative reducer actions for stream, REST, replay, pagination, and subagent
  events;
- selector-based subscriptions so metadata changes do not rerender the whole
  transcript. Scroll snapshot patches should stay outside reducer selectors
  entirely and be read through explicit cache-entry APIs;
- explicit same-tab retention with TTL and byte-budget caps (both
  user-configurable in Performance settings; no entry-count cap),
  source/auth scoping, diagnostics, and clear APIs;
- no hidden `globalThis.__YA_SESSION_ROUTE_SNAPSHOTS__` ownership.

The store can still be memory-only. Memory-only is correct for same-tab warm
session detail retention. The cleanup is about explicit ownership, testability,
and lifecycle visibility, not durable browser persistence.

## Capabilities This Unlocks

The data layer should make the following substantially easier:

- snapshot tests for provider stream vs persisted transcript parity;
- regression tests for duplicate user prompts and duplicate assistant rows;
- deterministic augment attachment tests;
- explicit subagent provenance across live, lazy-loaded, and reloaded paths, so
  later provider-specific parity work starts from inspectable data;
- side-by-side rendering of two session detail consumers;
- a cleaner `/btw` model as a related session/detail consumer instead of a
  polling UI side-channel;
- better performance instrumentation because data transitions and DOM work are
  separated.
- bounded active transcript windows that can atomically trim messages,
  pagination, augments, and tool/agent mappings without turning DOM state into
  transcript truth; see
  [`docs/tactical/060-bounded-active-transcript-window.md`](../docs/tactical/060-bounded-active-transcript-window.md).

## Non-Goals

- Do not replace the coarse `clientSummaryStore`. Session detail is heavier and
  has different update/retention constraints.
- Do not move composer draft persistence into the transcript store.
- Do not make every scroll update reactive.
- Do not make every streaming token a React state update.
- Do not introduce transcript virtualization as part of the first data-layer
  extraction. Virtualization can consume the render selector later.
- Do not change provider wire protocols merely to satisfy the client store
  shape. Normalize at the boundary.

## Relationship To Existing Documents

- [`client-source-runtime-topology.md`](client-source-runtime-topology.md)
  records the higher-level source runtime, API transport, coordinator, and
  cache topology that should eventually own this data layer per source.
- [`stream-persisted-render-parity.md`](stream-persisted-render-parity.md)
  records the invariant this layer should enforce: live-stream and durable
  reload rendering must converge.
- [`session-dom-linger-speedup.md`](session-dom-linger-speedup.md) remains a
  render-retention layer. It should not be the owner of data freshness.
- [`docs/tactical/025-zustand-client-summary-store.md`](../docs/tactical/025-zustand-client-summary-store.md)
  and [`docs/tactical/030-client-summary-store-closeout.md`](../docs/tactical/030-client-summary-store-closeout.md)
  deliberately kept transcript state out of the summary store. This topic is
  the follow-on for that excluded heavy session-detail domain.
- [`docs/tactical/041-cached-session-restore-performance.md`](../docs/tactical/041-cached-session-restore-performance.md)
  documents the current retained snapshot behavior that should migrate behind
  explicit session-detail store ownership.
