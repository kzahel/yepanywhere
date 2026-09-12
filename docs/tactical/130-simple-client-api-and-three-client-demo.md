# Simple Client API And Three-Client Demo

Topic: simple-client-api
Topic: portable-transcript-compiler
Topic: client-source-runtime-topology

Status: Direction selected 2026-09-12; contract and implementation plan under
design. No API, demo route, deployment, or iOS app has been implemented here.

## Outcome

A small web client proves a new YA server API for simple clients, connecting to
several real YA servers and switching its sidebar between machine, project,
and issue grouping. It becomes testable at an unlisted Latest URL. Android
Compose and iOS SwiftUI follow closely and constrain the same schemas and
behavior before the API stabilizes. The product remains publishing mobile
apps, with the demo providing a faster design and verification loop.

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
  read-only three-client projection proof.
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

Choose schema source and deterministic TypeScript/Kotlin/Swift generation only
after checking tagged-union and unknown-variant support in all three targets.
Create shared serialized examples that compile and decode in all three
languages. Native consumption is part of this first checkpoint, not a promise
after the web feature is finished.

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
helpers into the new semantic output. Inventory browser-bound dependencies
before choosing package placement. Derive issue associations through existing
enabled server facilities and preserve coverage when unavailable.

Implement bounded reads and one subscription binding, including an atomic
snapshot/live boundary and authoritative reset after lost continuity. Measure
coalesced replacement snapshots before choosing whether small row updates are
necessary. Share in-flight server computations and prove final-owner teardown.
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

### 5 — bring the same vertical slice to Android and iOS

Begin native renderer/decoder work during the preceding slices, using the same
fixture corpus. Before expanding the web demo beyond overview, grouping, and
Conversation, both native clients must consume the live contract.

Android reuses its Kotlin runtime. iOS introduces a small SwiftUI consumer and
the minimum foreground transport/authentication implementation needed to connect
to real paired servers. Offline fixtures alone are not iOS integration evidence.
Both exercise multiple sources and the same message identities, unknown variants,
coverage, and reconnect/reset outcomes. Match semantic outcomes rather than
pixel layout or implementation code.

**Exit:** web, Android, and iOS browse real sessions with the same API and can
recover from a source failure independently. Contract changes include fixtures
and decoder checks for all three. Native differences feed back before schema
stabilization; iOS is not deferred until Android is feature-complete.

### 6 — develop shared behavior toward store releases

Before public mobile releases depend on the new API, promote a reviewed contract
out of `/api/experimental/`. Decide whether and how to version the stable URLs,
record the support policy, and verify the preview-to-stable transition for all
three clients. Preview deployment and generated types do not freeze the API.

Add basic reply, stop, and appropriate question answering to the contract and
all three clients in small slices. Then connect the existing push work and
full-web handoff to the native session identity/navigation model. Continue
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

## Decisions still to make

- Exact logical-message grouping, activity attachment, and behavior for a large
  message or an incomplete provider transcript.
- Schema format, generator/package placement, and unknown-variant representation
  proven in Kotlin and Swift.
- Subscription snapshot/update/reset envelope; client facade versus wire history
  operations; window anchoring and limits while reading older messages.
- Relationship of `maxMessages` to the existing compaction-based history scope;
  any new older-history coverage requires an explicit reviewed decision.
- Bounded overview collection/attention completeness, issue-reference coverage,
  and the first optional cross-machine project-mapping experiment.
- Exact operations below `/api/experimental/`, preview revision matching, and
  eventual stable namespace/versioning and promotion policy.
- Exact demo entry URL, remote bundle boundary, and iOS foreground connection
  slice. The public route is unlisted, not an authentication secret.

These are the next design work, not reasons to restart normalization, rewrite
all source runtimes, or port the existing web transcript state machine.
