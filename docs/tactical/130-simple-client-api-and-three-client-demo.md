# Simple Client API And Web/Android Demo

Topic: simple-client-api
Topic: portable-transcript-compiler
Topic: client-source-runtime-topology

Status: Offline contract spike implemented 2026-09-12: JSON Schema, generated
TypeScript/Kotlin decoders, and shared real-derived/synthetic examples. Wire
compatibility review and server/client implementation remain open. No endpoint
or demo route is implemented. iOS is outside this plan’s current scope.

## Outcome

A small web client proves a new YA server API for simple clients, connecting to
several real YA servers and switching its sidebar between machine, project,
and issue grouping. It becomes testable at an unlisted Latest URL. Android
Compose follows closely and constrains the same schemas and behavior before
the API stabilizes. iOS comes later, with separately scoped transport and schema
consumption work; it does not block this experiment. The product remains
publishing mobile apps, with the demo providing a faster design and verification
loop.

The owning proposal is [Simple Client API](../../topics/simple-client-api.md).
The roadmap's release priority remains authoritative.

## Existing work and evidence

- [061 compiler foundation](061-portable-transcript-foundation-plan.md): pure
  web transcript derivation exists; the output is still internal `RenderItem[]`.
- [066 monitor](066-multi-host-monitor-coexistence-harness.md): a real hidden
  `/-/monitor` route, concurrent secure source controller, and legacy/mux tests
  already exist. Reuse the narrow transport/controller seams rather than
  duplicating SRP or adopting its existing full summary model wholesale.
- [084 Android runtime](084-android-native-multi-host-runtime.md): native
  multi-host demand, pairing, summary UI, isolation, and device evidence exist.
- [083 WebView bridge](083-android-bundled-web-native-transport.md): still needed
  for the planned seamless full-web mobile handoff, but does not block a
  read-only web/Android projection proof.
- [129 issue discovery](129-issue-discovery-and-session-browser.md) and the
  [association contract](../../topics/issue-session-associations.md): reuse
  canonical references and coverage; do not create another indexing system.
- Relevant open gaps: [multi-host harness setup under load](../../gaps/multi-host-e2e-setup-timeout.md),
  [ordinary zero-match search shown as a failure](../../gaps/conversation-view-zero-match-grep.md),
  and [forwarded media duplication](../../gaps/code-mode-forwarded-image-duplication.md).
  Use these as test inputs or known evidence limits; this plan does not close them.

## Sequence and exit gates

### 1 — review the small contract with concrete fixture payloads

Start from [127's real captured provider corpus](127-captured-provider-fixtures.md)
and its native/adapter replay helper when deriving the first Conversation
examples. The two-message Claude/Codex cases provide read/write, success/failure,
and follow-up evidence. They are provider inputs, not an already-designed
experimental API schema; add explicitly synthetic source collisions, disabled
issue discovery, and unknown contract variants separately. The captured Codex
native failure-status regression is now repaired and enforced by replay.
The broader fixture tactical need not finish before schema
design starts.

Draft source overview, session summary, issue references, conversation messages,
pending requests, coverage, and subscription envelopes. Decide logical message
grouping and limits using actual user/agent exchanges; do not expose `turns` as
the count unit. Enumerate null/absence, unknown variants, IDs, timestamps,
errors, source ownership, and maximum payload behavior.

The [contract spike](../../packages/shared/contracts/README.md) selects JSON
Schema with a small deterministic TypeScript/Zod and Kotlin/org.json emitter.
Both targets compile and decode the same serialized examples, including unknown
variants and malformed-known rejection. No Swift evidence is required now.
The spike records message grouping, two-compaction scope before `maxMessages`,
coverage, nullable fields, limits, and replacement-snapshot binding semantics.
The provenance tests compare proposed Conversation examples to real native
replay; synthetic cases cover source collisions, disabled issue discovery, and
limited history. These are offline evidence, not a live producer or consumer.

Complete the compatibility review below before implementing wire behavior.
Record proposed operations under `/api/experimental/` and exact server fallback
with the schema review. Experimental contracts may change incompatibly; define
revision detection and a clear mismatch state rather than promising permanent
support for every preview. Stable namespace/versioning is a later promotion
decision, not implied by the working name "v2".

**Exit:** a reviewable, bounded schema with example data and demonstrated native
decoding; message grouping, view revision/reset, history coverage, and the
compatibility decisions are explicit.

### 2 — produce authoritative server views over existing data

Map existing provider normalization, catalog facts, and browser-free projection
helpers into the new semantic output. First extract the reusable browser-free
compiler core into a server-usable package and keep its existing parity and
identity tests passing. This package seam is an explicit deliverable, not just
an inventory. Keep web rendering adapters local; the new condensed output does
not reuse `RenderItem[]` as its wire model. Derive issue associations through
existing enabled server facilities and preserve coverage when unavailable.

Implement bounded reads and one subscription binding, including an atomic
snapshot/live boundary and authoritative reset after lost continuity. Measure
coalesced replacement snapshots before choosing whether small row updates are
necessary. Apply the spike’s acceptance budgets: 200 ms coalescing, at most five
publications/s, 32 KiB for its specified 20-message workload, 256 KiB hard cap,
and p95 projection/encoding at most 20 ms on a documented host. Prove shared
per-session projection with one versus ten subscribers and final-owner teardown.
These budgets are not yet measured.
Do not build another canonical transcript store.

**Exit:** a minimal client can show current data and recover from reconnect
without knowing provider event formats, compaction offsets, or dedupe heuristics.

### 3 — connect the minimal web client to multiple real servers

Build a small responsive sidebar and Conversation pane with an independent
data-only state owner. Reuse existing source-scoped authentication/transport
primitives. Include deliberate add/sign-in, saved/included profiles, per-source
freshness and failure, and session selection keyed by source and YA session ID.

Exercise at least two capable sources plus an unavailable or incompatible
source. Use colliding local IDs and independent failures. Switch machine,
project, and issue grouping over the same data; switching grouping must preserve
the selected session and must not reconnect machines or read their transcripts.
Retain source-local projects initially; explicit cross-machine mappings can be
added as a grouping experiment. Use real canonical issue identity and honest
coverage, including multi-issue and unassociated sessions.

Start read-only. Basic reply/stop is a subsequent shared action slice, after
acceptance, retry/idempotency, and eligibility are defined. Rich approval context
continues toward the complete-web handoff.

**Exit:** real multi-server browsing and grouping, source-isolated errors, and
simple session detail pass focused protocol and browser checks. Fixtures alone
do not satisfy this checkpoint.

### 4 — publish the deliberate-entry Latest preview

Integrate the demo into the existing remote-client artifact and Latest workflow.
Choose an unlisted `/-/` route and verify direct navigation, refresh, nested
session routes, asset paths, CSP, and interaction with existing caching. Avoid
loading the old session application merely to mount the new demo. The standard
app remains the normal entry point; settings and demo state are isolated.

Prove real encrypted remote connections through the hosted entry, including
older-server gating and one healthy peer while another fails. Display build
identity where a tester can find it. Use the repository's artifact capture
facility for desktop/phone evidence, following [UI testing](../../topics/ui-testing.md).

**Exit:** a verified URL and exact source commit are available through the
existing Latest delivery system, not just a locally rendered screenshot.

### 5 — bring the same vertical slice to Android

Begin Compose consumption during the preceding slices, using the generated
Kotlin models and shared corpus. Before expanding the web demo beyond overview,
grouping, and Conversation, Android must consume the live contract through its
existing Kotlin pairing/authentication/multi-host runtime. The monitor supplies
web transport and connection ownership, not the demo's summary data model.

Exercise multiple sources, message identities, unknown fallbacks, disabled issue
coverage, and reconnect/reset outcomes. Match semantic outcomes rather than
pixel layout or implementation code.

**Exit:** web and Android browse real sessions and independently recover from a
source failure. Contract changes include fixtures and both decoder checks.
Android’s offline decoding spike is complete; live consumption is not.

iOS is deferred. Its eventual work includes SRP, NaCl, pairing, endpoint/relay
selection and connection ownership before live SwiftUI consumption, in addition
to schema generation/decoding. Scope that transport port separately when starting
iOS; neither a renderer estimate nor offline fixtures substitutes for it.

### 6 — develop shared behavior toward store releases

Before public mobile releases depend on the new API, promote a reviewed contract
out of `/api/experimental/`. Decide whether and how to version the stable URLs,
record the support policy, and verify the preview-to-stable transition for all
participating clients. Preview deployment and generated types do not freeze
the API.

Add basic reply, stop, and appropriate question answering to the contract and
web and Android in small slices. iOS joins in a later scoped effort. Then connect
the existing push work and full-web handoff to the native session identity/
navigation model. Continue
signing, update-persistence, internal distribution, and store-publication work
under the roadmap; do not treat a preview URL or fixture app as release completion.

Add the remaining HTTP/SSE/plain-WebSocket bindings with equivalent semantics
and focused conformance evidence. Shipping every binding is not a prerequisite
for the first hosted/native experiment, while transport independence is.

## Compatibility review to finish before protocol implementation

Treat the deliberate-entry demo as a new optional surface. The stable npm/server
release listing checked on 2026-09-12 identifies `v0.8.1` (2026-09-05) and
`v0.8.0` (2026-08-31) as the latest two and all stable server releases in the
preceding 14 days. Desktop tags are a separate distribution. Their source trees
are locally available, but a route/schema audit against the final proposed
operations remains required; no compatibility approval is recorded here.

Proposed gate: a new explicitly experimental sparse capability with an exact
schema revision. Allocate its permanent registry identity during the reviewed
implementation; do not borrow an existing summary or projection capability.
Without support, show that source as requiring an update for the preview and
offer its existing full-client route. Keep healthy supported sources usable and
make no unsupported API calls. Existing web/native fallbacks retain their meaning.

Before enacting the contract, present the final release audit, routes, fields,
events, gate, schema compatibility, and fallback for maintainer review under
[server capabilities](../../topics/server-capabilities.md#minimum-compatibility-horizons).
Recheck the release listing at implementation time. If this becomes a replacement
for core existing behavior, apply the core horizon rather than this optional one.

## Remaining decisions and next action

The [spike record](../../packages/shared/contracts/README.md) owns the concrete
candidate and its evidence limits. Gate 1's offline decoding work is complete;
the final operation/capability compatibility review is still outstanding.

Next, prepare the compiler extraction and the reviewed first read/subscription
binding. Prove grouped IDs across live/durable reconciliation, system boundaries,
interruption and retry; the two clean captures cannot settle those edge cases.
Measure the stated projection and snapshot budgets before expanding web scope.

Still open: exact operations under `/api/experimental/`, capability registry
identity and release audit, atomic binding and cancellation, oversized-content
producer behavior, the unlisted demo route/bundle boundary, and stable-contract
promotion policy. Cross-machine project mappings remain an optional experiment.

These are implementation and review tasks over the existing normalization and
source-runtime work. They do not require a second transcript store or a port of
the web session state machine. Keep the historical filename for existing links.
