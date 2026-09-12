# Portable Transcript Compiler

> A stable server ingest kernel should turn provider history into bounded,
> identity-safe transcript windows, while a versioned portable compiler turns
> those windows into a platform-neutral presentation model for web, Android,
> and iOS renderers without requiring clients to process full transcripts.

Topic: portable-transcript-compiler

Status: Architecture direction approved; the internal web-only foundation is
complete. The 2026-09-12 consumer sequence starts with a minimal multi-server web
demo of a server-owned Simple Client API, followed closely by Compose and SwiftUI
consumers. Its schema, runtime boundary, and compatibility policy remain under
design; the internal web output is not a published native contract.

See also:

- [simple-client-api](simple-client-api.md) — current three-client API direction,
  message-based limits, and server-owned Conversation views;
- [provider-output-contract](provider-output-contract.md) — the current
  provider-normalized message contract;
- [session-detail-data-layer](session-detail-data-layer.md) — the canonical
  client session-detail reducer/store below rendering;
- [stream-persisted-render-parity](stream-persisted-render-parity.md) — the
  live/durable convergence requirement;
- [task-list-rendering](task-list-rendering.md) — the motivating whole-history
  fold where a bounded tail needs facts from older records;
- [trusted-client-packaging](trusted-client-packaging.md) — signed/local mobile
  client packaging and its trust boundary;
- [conversation-view](conversation-view.md) — the selected compact native
  session-detail presentation and its visibility/failure semantics;
- [mobile-companion-app](../docs/project/mobile-companion-app.md) — Android-first
  native companion product shape and later iOS counterpart;
- [mobile-server-pairing](mobile-server-pairing.md) — native connection
  ownership and the independent permanent bundled-web presentation;
- [hard-development-rules](hard-development-rules.md) — hosted-client protocol
  grace and compatibility policy.

## Web-Only Foundation Checkpoint (2026-07-19)

The first conservative checkpoint is complete. The current bounded client
`Message[]` is now compiled by a pure, browser-free TypeScript module into the
existing client-internal `RenderItem[]`. The same-input identity cache,
browser-owned streaming diagnostics, transcript display objects, prior-row
reference stabilization, React grouping/components, and DOM behavior remain
separate adapters. The primary web session-detail path consumes that compiler
boundary directly.

This checkpoint deliberately does **not** implement the conceptual versioned
envelope or presentation contract described below. There is no public package
ABI, prefix-fact schema, server/client negotiation, Worker or alternate
runtime, server execution path, second renderer, or native application. The
temporary `preprocessMessages` facade has been removed after all callers moved
to their owning compiler, cache, or web-adapter API; there is no production
dual-compile path.

The completed extraction is independently valuable to the web application:
semantic projection has a deterministic owner, cache and web lifecycle work
are explicit, provider-format regressions have exact fixtures and local smoke
evidence, and performance has a repeatable baseline. See the
[`foundation plan`](../docs/tactical/061-portable-transcript-foundation-plan.md),
[`client ledger`](../docs/tactical/061-portable-transcript-client-ledger.md),
and
[`baseline/corpus record`](../docs/tactical/061-portable-transcript-baseline-and-corpus.md)
for the boundary, evidence, and deferred decisions.

No later migration step is authorized by this checkpoint. A human must first
identify a real second consumer and choose the bounded input, minimum projection
contract, package/runtime target, and compatibility policy.

## Current Consumer Sequence (2026-09-12)

The [Simple Client API](simple-client-api.md) is the selected next application
of this boundary. A minimal web demo provides fast iteration on real multi-YA
server summaries, Conversation detail, and machine/project/issue sidebar
grouping. Kotlin/Compose and Swift/SwiftUI follow immediately as consumers of
the same generated schema and fixture corpus, before web behavior stabilizes.
Clients intentionally use a new small state machine rather than adopting the
existing web session-detail logic.

These clients consume finished server projections. A client-bundled portable
compiler remains a possible broader architecture, not a prerequisite for this
experiment. Public limits use logical user/agent message counts, not turns;
history and reconnect bookkeeping belong below the simple screen-facing API.
The [implementation plan](../docs/tactical/130-simple-client-api-and-three-client-demo.md)
owns the exact schema, history-scope, transport, and compatibility decisions.
This sequencing supersedes the native-first prototype order recorded below.

## Original Native Consumer Direction (2026-08-02)

The real second consumer is now identified: an Android Compose companion whose
default session detail is the compact Conversation view, followed later by a
SwiftUI renderer for iOS. The existing bundled web client remains a permanent
full-fidelity alternative for users who prefer it, full activity, rich tool
inspection, settings, and other surfaces outside the native companion. It does
not need to become the native home screen or share the Kotlin transport.

The first native slice is a read-only Compose renderer over saved projection
fixtures. It should cover user prompts, assistant text, status/boundary rows,
important failures, media, compact per-turn activity, and bounded generic tool
fallbacks before adding live transport, approvals, or a composer. Basic text
response can follow once foreground transport and reconciliation are proven.
Approvals that need command, diff, or provider-specific context continue into
the full web presentation until native can support an informed decision.

The shared asset is the versioned semantic contract: projection schemas and
generated types, stable identities, fixtures, pagination/coverage, action
meanings, and generic fallbacks. Compose, SwiftUI, and React keep independent
platform views. Server projection remains the preferred mobile-efficient mode;
this decision does not authorize Kotlin and Swift ports of provider
normalization or the current client-internal `RenderItem[]` ABI.

This checkpoint resolves the consumer and product-surface choice only. Before
source or protocol work begins, a reviewed plan must still choose the minimum
bounded envelope/projection, package and execution boundary, native
connection-core ownership, capability/version negotiation, stable-release
corpus, and exact fallback that makes no unsupported request to an older server.

## Decision

YA should evolve toward three explicit layers:

```text
provider storage / provider live stream
  -> stable server ingest kernel
  -> bounded transcript window + prefix facts
  -> portable presentation compiler
  -> platform renderer (web / Android / iOS)
```

The portable compiler owns the data work that prepares a transcript for
rendering. It does **not** own React JSX, DOM behavior, native widgets, layout,
scrolling, gestures, selection, or accessibility. Each platform keeps a real
renderer suited to that platform, but those renderers consume the same semantic
presentation model instead of independently rediscovering provider behavior.

The compiler implementation may be bundled with frequently updated clients and
may also run on the YA server. The normal efficient path is server compilation:
when the server can emit a presentation schema the client understands, it does
the history-aware and expensive work and sends a compact projection. A bundled
client compiler is the compatibility path for a server that can provide a
bounded canonical window but cannot emit the client's preferred projection.

This direction is intended to reduce the set of provider changes that require a
YA server update. It cannot eliminate server updates: changes to provider file
formats, compression, discovery, app-server framing, authentication, or facts
that only the server can observe still belong at the server boundary.

## Motivation

The current browser client does more than draw already-semantic rows. It pairs
tool calls and results, coalesces provider artifacts, groups assistant actions,
derives timelines and action eligibility, attaches augments, and reconciles
multiple transcript sources before selecting React components. Much of that
work has already been extracted into pure `sessionDetail` selectors, but its
types and execution boundary remain client/web-shaped.

At the same time, some apparently presentational features require facts outside
the returned window. Incremental Claude `TaskCreate`/`TaskUpdate` records are the
clearest example: a task updated in the current two-compaction tail may have
been created far earlier. A phone cannot reconstruct the correct checklist
from the tail alone, and sending a 100 MiB provider transcript so it can try is
not acceptable.

There are also two independent version-skew problems:

- the hosted web client can update ahead of independently installed YA servers;
- installed Android and iOS clients can lag a newer server because app updates
  are not atomic or universal.

Treating the API as an internal same-release React endpoint is therefore no
longer sufficient. Transcript projection is a distributed, versioned contract.

## Terminology and Stages

Use explicit stage names rather than calling every intermediate object a
"normalized message":

```text
ProviderRecord
  -> IngestRecord
  -> CanonicalTranscriptEvent
  -> TranscriptProjectionNode
  -> PlatformView
```

- **Provider record** — the provider-owned durable or live shape: Codex rollout
  entry, Claude SDK/JSONL entry, OpenCode event, and so on.
- **Ingest record** — an ordered, bounded, source-provenance-preserving record
  that the stable server kernel can safely expose to later stages.
- **Canonical transcript event** — a provider-neutral semantic fact such as a
  user turn, assistant content block, tool call/result, task update, status, or
  boundary.
- **Transcript projection node** — a platform-neutral display object such as a
  user row, assistant text block, thinking block, tool presentation, task-list
  snapshot, or compact boundary.
- **Platform view** — React/DOM, Android native, or iOS native UI and its local
  interaction/layout state.

Transformations should be one-way, pure where practical, and versioned. Do not
mutate an open-ended message repeatedly and then ask downstream code to infer
which normalizers have already run.

## Stable Server Ingest Kernel

The server remains the authority for work that depends on provider storage,
complete-history access, or trusted transport state.

It owns:

- discovering, reading, decompressing, and parsing provider-owned history;
- observing and adapting provider live protocols;
- preserving YA-visible session identity and provider resume handles;
- resolving provider order/DAG paths before projection;
- reconciling live and durable records where both are needed to establish
  identity or provenance;
- deriving stable source occurrence and semantic entity ids where the provider
  supplies enough evidence;
- enforcing authentication, public-share scope, redaction, and payload limits;
- replacing retained inline media with authenticated handles when that design
  lands;
- selecting a bounded tail or explicit older page before sending client data;
- computing prefix facts for known cross-window folds;
- optionally running the portable compiler and returning a finished
  projection.

The kernel should preserve unknown fields on already-visible bounded records
when doing so is safe and useful. It must not blindly forward arbitrary rollout
records, internal-only provider state, unbounded blobs, or hidden material to
every client or public share. Unknown visible records need a bounded opaque
form with provenance and a safe textual fallback.

### Provider changes that still require a server update

A client compiler cannot repair information the installed server cannot read or
never sends. Server work remains necessary when:

- a provider changes the history container, compression, discovery layout, or
  basic record envelope;
- an app-server/SDK changes RPC framing, lifecycle, authentication, or streaming
  semantics;
- stable identity depends on comparing live and durable sources that the client
  does not possess;
- a new cross-history fold needs prefix facts an old server never computed;
- safe exposure requires new filtering, authorization, or media handling.

The goal is a smaller and more stable server-facing surface, not a permanently
unchanging provider integration.

## Bounded Transcript Window Envelope

The portable compiler must never require a full transcript for ordinary
session display. The server supplies a bounded envelope containing the visible
window and compact facts derived from its omitted prefix.

A conceptual shape is:

```ts
interface TranscriptWindowEnvelope {
  envelopeVersion: number;
  canonicalSchemaVersion: number;
  sourceRevision: string;

  coverage: {
    firstMessageId: string | null;
    lastMessageId: string | null;
    prefixKnowledge: "complete" | "partial";
    hasOlderMessages: boolean;
  };

  prefixFacts?: TranscriptPrefixFacts;
  records: CanonicalTranscriptEvent[];
  olderPageCursor?: string;
}
```

The exact schema is future work. The load-bearing requirements are:

- input is bounded by serialized bytes as well as record/node count;
- ordinary rendering never silently requests `fullHistory=1`;
- omitted history is represented by coverage metadata rather than silently
  treated as nonexistent;
- prefix facts are independently bounded and versioned;
- older history remains available through explicit pagination;
- binary/media payloads do not defeat the byte bound;
- client compilation cost is proportional to the returned window plus prefix
  facts, not total provider history.

The existing two-compaction session-detail default remains the baseline scope.
This architecture may improve what that bounded scope means, but it does not
authorize clients or new endpoints to bypass it.

## Prefix Facts and Whole-History Folds

Some semantic state is an event-log reduction. Examples include:

- task id -> subject/current status;
- background command id -> lifecycle state;
- tool-use id -> subagent/session relationship;
- compaction, recap, or display-object placement anchors.

Model such work as explicit fold state rather than renderer-local searches:

```ts
interface TranscriptFold<State, Output> {
  initialState(): State;
  reduce(state: State, event: CanonicalTranscriptEvent): State;
  project(state: State, event: CanonicalTranscriptEvent): Output | null;
  checkpoint(state: State): SerializableCheckpoint;
}
```

This is a conceptual interface, not a requirement to build a generic plugin
framework. Prefer a few concrete, testable folds until repetition proves a
shared abstraction useful.

Execution policy:

- **Cold read:** when the server already materializes the normalized transcript,
  fold the complete ordered array before slicing and discard request-local
  state afterward.
- **Live process:** keep only the small incremental fold state already needed by
  the active augmenter/process path and discard it with that path.
- **Persisted checkpoint:** add a sidecar or compaction-boundary checkpoint only
  if profiling shows repeated cold folds are materially expensive. It is a
  derived cache, never a second durable transcript authority.

No compiler fold may keep an idle provider process or closed client session
alive indefinitely. The lifecycle/resource rules in
[architecture-mandates](architecture-mandates.md) apply.

An old server cannot produce prefix facts for a semantic feature invented
later. That is an expected compatibility limit: the newer client renders a
bounded event-level or generic fallback until the server is updated. It must
not fetch the full transcript to simulate completeness.

## Portable Presentation Compiler

The compiler consumes a bounded envelope and produces a platform-neutral
projection. Candidate responsibilities include:

- pairing canonical tool calls and results;
- interpreting known tools and structured result fields;
- deriving Read/Search/Edit/Shell and exploration action semantics;
- coalescing provider artifacts that should be one visible event;
- producing task-list, agent-work, status, setup, recap, and boundary nodes;
- attaching safe structured augments and their fallbacks;
- deriving presentation action eligibility from semantic facts;
- emitting generic nodes for unknown but visible events;
- applying small incremental events to an existing live projection.

It must not contain:

- React, JSX, DOM calls, CSS, native widget APIs, or navigation objects;
- viewport measurements, scroll state, selection, gestures, or focus;
- platform accessibility implementations;
- Shiki, a full markdown renderer, or other heavyweight rich rendering by
  default;
- server filesystem, provider process, authentication, or transport access;
- unbounded caches or timers.

Heavy transformations remain optional server augments. The semantic source is
canonical structured data; highlighted HTML is a web optimization, not the IR:

```ts
interface EditProjectionNode {
  kind: "edit";
  id: string;
  path: string;
  hunks: StructuredDiffHunk[];
  webHtmlAugment?: string;
}
```

Web can consume the HTML augment. Native renderers consume structured hunks.
If the augment is absent, every renderer has a plain structured/text fallback.

## Projection Identity and Provenance

Keep three identities distinct:

1. **Source occurrence id** — durable message/tool/event identity from the
   provider or YA ingest boundary.
2. **Semantic entity id** — task, agent, background command, file operation, or
   another entity that survives several source events.
3. **Projection node id** — the visible row/block representing an occurrence or
   entity under a particular projection schema.

The server is best placed to establish source and semantic identity when the
evidence is outside the returned window. Clients must not manufacture durable
identity from array position or unstable content hashes merely because older
history is absent.

Projection grouping may evolve without changing semantic entity identity. A
new compiler may group several source actions differently while retaining the
same parent execution and task ids. Search anchors, update-in-place behavior,
and streaming patches should key on the narrowest stable identity appropriate
to their layer.

Projection nodes should carry bounded provenance references such as source
message ids, not retain complete source message objects. Raw detail can be
fetched explicitly for diagnostics or inspection.

## Execution Modes and Negotiation

Keep execution placement coarse. Do not build a distributed optimizer that
assigns arbitrary compiler passes independently to server and client.

### Mode 1: server projection (preferred)

```text
server ingest + folds + portable compiler
  -> TranscriptProjection
  -> thin client renderer
```

Use when the server can emit a projection schema the client accepts. This is
the normal mobile-efficient path.

### Mode 2: portable client compilation

```text
server bounded envelope + prefix facts
  -> client-bundled portable compiler
  -> TranscriptProjection
  -> platform renderer
```

Use when the server understands a canonical envelope accepted by the client but
cannot emit the client's preferred projection. On web, the compiler should be
lazy-loaded and run in a Worker. Native runtimes should keep it off the UI
thread. The fallback compiler may be less rich when prefix knowledge is partial.

### Mode 3: legacy adapter

```text
legacy Message[] response
  -> client legacy adapter
  -> basic TranscriptProjection
  -> platform renderer
```

Use for servers predating the envelope/projection negotiation. This preserves
basic use while showing existing compatibility guidance. It is not a promise
that an old server can support every new semantic feature.

### Negotiated fields

Keep these version axes separate:

- transport/application protocol version;
- canonical/envelope schema version;
- projection schema version;
- compiler revision (behavioral fixes that retain a projection schema);
- optional semantic capabilities such as task-prefix checkpoints.

A conceptual client offer is:

```ts
interface TranscriptProjectionOffer {
  acceptedProjectionSchemas: number[];
  acceptedCanonicalSchemas: number[];
  portableCompilerRevision?: number;
  capabilities: string[];
}
```

A compatible server compiler need not have the same revision as the client
compiler. If both emit the same defined projection schema, the client normally
accepts server work. Compiler revision is diagnostic and feature-selection
metadata, not an excuse to recompute every projection on mobile.

Protocol grace follows [hard-development-rules](hard-development-rules.md):
preserve a safe previous-protocol path for a rollout window, warn before a
cutoff, and reserve immediate blocking for explicit security exceptions.

## Streaming and Reconnect

Live compilation should update a bounded projection incrementally. A conceptual
patch vocabulary is:

```ts
type ProjectionPatch =
  | { op: "insert"; afterId?: string; node: TranscriptProjectionNode }
  | { op: "replace"; id: string; node: TranscriptProjectionNode }
  | { op: "append-text"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "settle"; id: string; sourceRevision: string };
```

Actual names are future work. Required behavior:

- patches carry base/result projection revisions or equivalent cursors;
- a gap, stale base, or incompatible compiler mode yields a fresh bounded
  snapshot rather than speculative patch application;
- token-sized updates do not rebuild or reserialize the full projection;
- durable reconciliation settles live nodes in place where provider identity
  permits;
- stream and persisted fixtures converge under the existing parity contract;
- current ref-backed leaf streaming remains valid where it is cheaper than
  reactive state per token.

This document does not authorize changes to reconnect, replay, throttle, or
catch-up policy. Those remain governed by the existing transport and rendering
architecture documents.

## Platform Renderers

Platform renderers are intentionally separate implementations:

- **Web:** React/DOM/CSS, browser selection, server HTML augments, current file
  viewers, and browser scroll behavior.
- **Android:** native list, text, code/diff, notification, and navigation
  surfaces appropriate to the selected Android framework.
- **iOS:** corresponding native surfaces appropriate to the selected iOS
  framework.

They share:

- projection schemas and generated types;
- semantic node/action meanings;
- compiler fixtures and compatibility cases;
- stable ids, coverage, and pagination semantics;
- generic fallback rules.

They do not need pixel-identical UI. Each platform may exploit its native
capabilities while preserving semantic and action parity.

A native client may initially implement only inbox, notification,
Conversation-view user/assistant text, compact activity, generic tool, media,
status, and error nodes. Unsupported rich nodes must retain a bounded native
fallback rather than involuntarily replacing the entire session with a WebView.
The user may explicitly enter the packaged full-web session for richer detail.
Approval actions remain there until native presents enough command, diff, and
provider-specific context for an informed choice.

## Graceful Degradation

Every projection schema and renderer needs deliberate fallbacks:

- unknown tool -> generic tool name/input/status/output node;
- unknown provider event -> bounded safe summary with source provenance;
- missing prefix fact -> event-level presentation marked partial, never an
  invented complete snapshot;
- missing rich augment -> structured/plain text;
- unknown optional action -> omit that action, not the row;
- unknown projection node -> generic fallback content carried by the node;
- unsupported compiler/envelope -> legacy adapter and compatibility notice.

Unknown records should not default to a giant raw JSON blob. A compact generic
row is the ordinary fallback; authenticated raw inspection may be available on
explicit expansion or in developer tooling.

Public shares require a separately filtered projection/envelope. A generic
fallback must never reveal fields the public-share route would otherwise omit.

## Provider-Change Allocation

The intended future split is:

| Provider change | Expected update |
| --- | --- |
| New tool name/result fields inside a readable visible record | portable compiler/client |
| Better grouping, labels, or action presentation | portable compiler/client |
| New history-local semantic interpretation | portable compiler/client |
| New cross-history relationship | server prefix fold + compiler; old server degrades |
| New rollout container/compression/discovery shape | server ingest |
| New app-server/SDK framing or lifecycle semantics | server provider adapter |
| Changed live/durable identity relationship | server/shared ingest and parity tests |
| Styling, gestures, selection, or platform navigation | platform renderer |

This table is a target allocation, not a promise that every provider release
fits one row. When a change crosses boundaries, fix each fact at the earliest
layer that can establish it without making downstream consumers guess.

## Implementation Language and Runtime Direction

The schemas and fixtures are language-neutral. Do not bind the architecture to
one implementation language before a native client or profile justifies it.

The preferred first reference implementation is TypeScript because:

- the current server normalization and client projection logic are TypeScript;
- Node can import it directly;
- hosted web can lazy-load it in a Worker;
- React Native includes a JavaScript runtime;
- native iOS can host JavaScriptCore without a WebView;
- modern Android exposes Jetpack JavaScriptEngine for non-interactive
  JavaScript/WebAssembly evaluation without allocating a WebView on supported
  devices.

Useful current platform references:

- [Android JavaScriptEngine](https://developer.android.com/develop/ui/views/layout/webapps/jsengine)
- [Apple JavaScriptCore](https://developer.apple.com/documentation/javascriptcore)
- [React Native Hermes](https://reactnative.dev/docs/hermes/)

The TypeScript package must target a conservative engine subset and be tested
against the actual runtimes adopted by clients. Android JavaScriptEngine is a
capability, not a universal assumption; a native client must detect support and
retain server/generic fallback.

Rust remains a credible later implementation if both native clients are
committed or profiling shows a real CPU/memory/engine problem. The same Rust
source could compile to native mobile libraries and WebAssembly for web/Node,
but serialization, bindings, build complexity, and rewriting existing
TypeScript are real costs. This workload is string/object heavy, so WebAssembly
must be measured rather than presumed faster.

Kotlin Multiplatform is viable for Android/iOS/native logic and has JVM/JS/Wasm
targets, but it makes the existing Node/web TypeScript system the integration
edge. Reconsider it only if the native client stack makes Kotlin the dominant
implementation environment.

Whichever implementation is chosen should expose a narrow serializable ABI:

```text
compileWindow(envelope) -> projection
createLiveCompiler(checkpoint) -> handle
applyEvent(handle, event) -> projection patch
dispose(handle)
```

Native app releases should bundle compiler code. Do not make downloaded
executable compiler modules part of the compatibility contract; that creates
client-code trust, signing, platform-policy, and rollback concerns beyond this
architecture.

## Migration Strategy

Do not replace the current session page or normalization pipeline in one
rewrite. Use adapter-first, parity-first slices:

1. **Name the current stages.** Inventory provider ingest, canonical message,
   preprocessing, render selectors, and JSX ownership without moving behavior.
2. **Define a minimal projection union.** Cover text, thinking, user prompt,
   generic tool, known tool, task snapshot, system/boundary, and fallback.
3. **Promote the pure reference compiler.** Move suitable internal
   `transcriptProjection` and `sessionDetail` logic into a platform-free package
   while keeping the existing web adapter as the sole production renderer.
4. **Prove semantic sufficiency.** Add a second non-DOM consumer such as a
   deterministic text/static renderer over real sanitized Claude and Codex
   fixtures.
5. **Establish server/client parity.** Run the same bounded envelopes through
   server and Worker compilers and compare projections.
6. **Add opt-in projection transport.** Negotiate a capability without changing
   the default hosted-client path; retain legacy fallback and compatibility
   notices.
7. **Move expensive/history-aware work server-first.** Add bounded prefix facts
   and server augments one measured domain at a time.
8. **Prototype Android Conversation rendering.** Build a read-only Compose
   renderer over saved projection fixtures before adding live transport,
   approvals, or composer behavior; reuse the same fixtures for later SwiftUI.
9. **Graduate only after parity and profiling.** Preserve existing vanilla UI
   behavior and provider-like presentation throughout migration.

The current session-detail store migration remains the nearer-term data
authority. This compiler direction should consume that clean boundary, not
restart it or create a competing session page.

## Verification Contract

Implementation work should add fixtures at each boundary:

- provider live and persisted inputs representing the same logical turn;
- bounded window plus complete prefix facts;
- bounded window plus deliberately partial prefix facts;
- old canonical schema -> new client compiler;
- new additive projection fields -> old generic renderer;
- unknown tool/provider event fallbacks;
- server-compiled projection == client-compiled projection for the same
  compiler/schema;
- streaming patches settle to the persisted projection;
- pagination preserves stable identities and coverage;
- input byte/node limits hold on large synthetic transcripts;
- public-share projection does not expose private/raw fallback fields.

Golden projection snapshots are useful, but behavioral assertions must also
cover identity, grouping, action ownership, completeness, and fallback. Do not
weaken live/durable parity merely to accommodate a compiler discrepancy.

## Non-Goals

- Do not create a generic cross-platform pixel/layout DSL.
- Do not require web, Android, and iOS to share component implementations.
- Do not send full provider transcripts to clients for rendering correctness.
- Do not replace provider persistence with a YA-owned durable transcript.
- Do not keep provider processes alive to retain compiler state.
- Do not move authentication, transport, file access, or public-share policy
  into the compiler.
- Do not promise that every new provider storage/protocol change can be fixed by
  a client update.
- Do not introduce dynamically downloaded native compiler code.
- Do not enact unrelated reconnect, streaming-throttle, replay, or
  virtualization refactors as part of the first extraction.

## Open Questions

- What is the smallest loss-preserving `IngestRecord`/canonical envelope that
  lets newer clients understand new visible provider fields without exposing
  internal or unbounded records?
- Which prefix facts are stable primitives and which should remain
  feature-specific snapshots?
- Should a server return canonical fallback input with every projection, or
  only on a second capability-gated request when local compilation is needed?
- How are compiler/projection caches keyed and invalidated against provider file
  replacement, compaction, and live/durable reconciliation?
- Which projection version must the server retain during hosted-client protocol
  grace, and for how long?
- Is TypeScript sufficiently small and deterministic across adopted runtimes, or
  do measurements justify a Rust/native implementation later?
- What is the minimum Conversation-view projection that preserves failures,
  media, partial coverage, generic tool expansion, and safe movement into the
  complete web presentation?
- What exact Kotlin interfaces and cross-language fixtures prove native
  SRP/resume, direct/relay transport, reconnect, and secure session state while
  the bundled web client retains its independent TypeScript transport?

Resolve these through bounded prototypes and fixtures. They are not reasons to
collapse the layer separation or begin with a whole-session rewrite.
