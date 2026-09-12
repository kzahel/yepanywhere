# Simple Client API And Web/Android Demo

Topic: simple-client-api
Topic: portable-transcript-compiler
Topic: client-source-runtime-topology

Status: Offline TypeScript/Kotlin contract, shared compiler and bounded live
Conversation API implemented 2026-09-12. The first deliberate-entry multi-server
web preview is implemented at `/-/preview`; browser validation is recorded in the
checkpoint below. The Android Compose preview and direct-server AVD proof are
implemented; remaining measurement/acquisition gates are open. Raw token assembly is explicitly deferred. iOS remains out of scope.

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

**Implemented checkpoint:** the semantic compiler, its structural types and pure
parsers now live in `packages/shared/src/transcript`, consumed by the existing
web adapter and the new server producer. `prepareConversation` compiles/groups
once; `selectConversation` chooses anchored bounded windows without repeating
compilation. Native capture fixtures are actual outputs, with adapter replay
checking identities and facts using explicitly supplied recorded user inputs.
Synthetic tests cover interruptions, retries, scope/prefix identity, unknown
content, missing results, and serialized limits. See the
[owning contract](../../topics/simple-client-api.md#implemented-projection-checkpoint-2026-09-12).

The live service is now implemented, as recorded in the backend checkpoint
below. Representative cost and real provider-loop continuity evidence remain
open; offline reuse alone is not subscription evidence.

The compiler extraction keeps web rendering adapters local; the condensed
wire model remains independent of `RenderItem[]`. Continue with catalog facts
and issue associations through existing enabled server facilities, preserving
coverage when unavailable.

Implement bounded reads and one subscription binding, including an atomic
snapshot/live boundary and authoritative reset after lost continuity. Measure
coalesced replacement snapshots before choosing whether small row updates are
necessary. Apply the spike’s acceptance budgets: 200 ms coalescing, at most five
publications/s, 32 KiB for its specified 20-message workload, 256 KiB hard cap,
and p95 projection/encoding at most 20 ms on a documented host. Prove shared
per-session projection with one versus ten subscribers and final-owner teardown.
A diagnostic cost sample is recorded below; this is not a performance-gate pass.
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
Android’s decoding spike and first direct-server live Compose proof are complete.
The AVD checkpoint below records its boundaries; broader grouping, deployed
relay UI evidence and release acceptance remain open.

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

The first live backend checkpoint now implements HTTP, SSE and both WebSocket
bindings. Each client still needs its own live consumption/reconnect evidence;
server binding coverage alone does not complete that gate.

## Compatibility review to finish before protocol implementation

Treat the deliberate-entry demo as a new optional surface. The stable npm/server
release listing checked on 2026-09-12 identifies `v0.8.1` (2026-09-05) and
`v0.8.0` (2026-08-31) as the latest two and all stable server releases in the
preceding 14 days. Desktop tags are a separate distribution. Their source trees
are locally available, but a route/schema audit against the final proposed
operations is recorded in the approved first live-operation review below.

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

## First live-operation review proposal (2026-09-12)

**Review status:** approved by the maintainer on 2026-09-12 ("sounds good proceed")
after presentation of the exact routes, release corpus, capability, revision and
fallback below. Implementation may enact this contract without a second review.
Advertisement still depends on the bindings being implemented.

**Release audit:** GitHub's release listing was checked on 2026-09-12. The
optional-feature horizon contains server releases `v0.8.0` (2026-08-31,
`03b96b9c40054f639edcdec5dfb869309d7179d9`) and `v0.8.1` (2026-09-05,
`2fb6557234b67ea4f806c9df39b919e2e950c7fa`). Desktop tags are separate
products. Both source trees lack the experimental Conversation routes, payload
models, capability and revision metadata; their subscription dispatcher rejects
unknown channels. Neither can be probed by sending the proposed subscription.

Proposed operations, using the existing authentication and authorization:

| Binding | Operation | Meaning |
| --- | --- | --- |
| HTTP or tunneled request | `GET /api/experimental/conversation` | One bounded authoritative snapshot, using the shared owner and releasing request demand after delivery/cancellation |
| HTTP SSE | `GET /api/experimental/conversation/subscribe` | Initial snapshot and coalesced authoritative replacements; `snapshot` event data is the same envelope |
| Plain/encrypted WebSocket | Existing `subscribe` frame with channel `/api/experimental/conversation/subscribe` | Same operation and payload over existing authenticated multiplexing; existing `unsubscribe` releases demand |

Reads carry `apiRevision`, `subscriptionId`, `sessionId`, `maxMessages`, and
optional `anchorMessageId` query parameters; omitted anchor means null. Counts
must be whole decimal integers from 1 to 100. WebSocket subscribe carries
`apiRevision` and generated `query: ConversationQuery` alongside the existing
`subscriptionId`. No project path or client-owned source identity is sent.
Application operations always receive an explicit client source binding.

Proposed capability: `experimental-simple-client-conversation`, an explicit
optional sparse bit, with permanent global ID **69** if still free when the
approved change lands. `/api/version` adds
`experimentalSimpleClientApiRevision: "simple-client-spike-1"` only while this
feature is available. Do not infer experimental support from release semver.
The bit means the Conversation read/subscription bindings are implemented, not
that overview/actions exist or that every provider/history can be represented.
Existing capability definitions and remote compatibility floors do not change.

Before opening a binding, the client requires both the capability and the exact
revision. Missing support shows an update-required state for that saved source,
with its existing full-client handoff; revision mismatch shows a preview-version
mismatch. Both send **zero experimental requests** and leave other sources usable.
Requests also carry the expected revision; the server rejects mismatch before
source acquisition with HTTP/relay response status 409, rather than opening a
stream the decoder cannot understand. Other failures retain the bounded error
view and existing auth failure behavior.

The envelope keeps `apiRevision`, `subscriptionId`, `sequence`, and `view`.
WebSocket event type is `snapshot`; SSE event name is `snapshot`. Each binding
starts at zero. Reconnect/query change creates a fresh binding and initial
snapshot, ignoring replay cursors. A server-initiated binding close must be
surfaced by the transport (SSE closes the response; WebSocket emits a `closed`
event for that subscription); consumers reconnect deliberately with a new ID.
No provider message/delta event enters this channel. The current read-only
schema does not enable reply, stop, or approval actions.

**Proof required when enacted:** capability/revision absence causes zero calls
in TypeScript and Kotlin, including mixed-source failure; unknown/rejected
channels in the audited releases retain their old meaning; both authenticated
WebSocket modes carry the exact snapshots; SSE disconnect and request abort
release their demand; reconnect rejects stale bindings. Use one versus ten
subscribers to measure reads, compilation, bytes and timing on the same input.

### Implementation evidence and acquisition seam

Validation: repository lint has zero errors/warnings, formatting and typecheck
pass, and the full workspace unit suite passes. The final focused suite has
16 subscription-owner tests, 25 projection tests and 4 captured example tests.
No production transport or native screen is exercised by this checkpoint.

The internal subscription owner is implemented and tested; the subsequent live
checkpoint now mounts the approved routes and capability. Its [owning checkpoint](../../topics/simple-client-api.md#subscription-owner-checkpoint-2026-09-12)
defines sharing, invalidation, coalescing, cancellation and admission bounds.

The first real source adapter must not simply call the current detail route
on each invalidation. Claude's `getSession` ignores `tailCompactions` and loads
its cached full transcript. Codex has a compact-window reader, but falls back
to a full snapshot without the required indexed hint/window. The existing
[message-storm gap](../../gaps/session-stays-usable-under-message-storm.md) records
13 MB/10,765 rows after the compact boundary; scope alone is not a byte bound.

Bound acquisition before materializing input. Reuse provider caches/indexes and
normalizers; refuse unsupported or over-budget acquisition with `unavailable`
until a bounded path exists. Managed live changes should feed one normalized
in-memory source and refresh durable evidence at controlled boundaries. The
adapter must reconcile YA input-queue identities and return bounded preceding-
user identity facts. Synthetic owner tests cannot establish those properties.
No new canonical transcript store is authorized.

## Remaining decisions and next action

The [spike record](../../packages/shared/contracts/README.md) owns the concrete
candidate and its evidence limits. Gate 1's offline decoding work is complete;
the first live operation/capability review was approved and implemented. The
remote web preview now consumes Conversation snapshots from multiple servers.

Next add the Android Compose screen and evaluate the web preview on Latest.
Replace its temporary legacy catalog adapter with a reviewed SourceOverview
operation once grouping and coverage feedback establish the needed shape.
Overview row/byte limits and stable-contract promotion remain open. Cross-machine
project mappings remain an optional experiment.

Extend indexed native acquisition beyond the initial bounded-reader refusal and
prove real input-queue reconciliation and cold-reader prefix identity. Measure
the stated projection/acquisition budgets on a qualified host. Raw token assembly
is deferred; it is not a prerequisite for the current web/Android preview.

These are implementation and review tasks over the existing normalization and
source-runtime work. They do not require a second transcript store or a port of
the web session state machine. Keep the historical filename for existing links.


### First live backend implementation

The [owning topic](../../topics/simple-client-api.md#first-live-operation-checkpoint-2026-09-12)
records the implemented route/gate, lifecycle and acquisition limits. Native reads
reuse existing normalization and match both real capture projections. HTTP/SSE and
plain/encrypted dispatcher tests cover exact snapshots and demand release; source
tests cover user identity, finalized-message memory, idle reconciliation and
subagent marking. TypeScript/Kotlin request and binding helpers test absent gates,
revision mismatch, source collisions and stale frames. This is not a live Android
screen or completed web demo gate.

The bounded reader deliberately refuses files above 8 MiB/10,000 records or with
records above 1 MiB, plus inherited Codex histories. It does not slice byte tails
through Claude branch evidence. Indexed acquisition should remove that restriction
later without changing the public `maxMessages` query. Managed live finalized
messages are supported; raw token assembly and real provider-loop echo/reader
continuity still need evidence. Next mount the minimal multi-source web preview
and Android screen against these helpers, then measure the stated cost budgets on
representative histories before broadening the preview.


### Validation and diagnostic cost sample

Workspace lint/format/typecheck and the full non-Android unit suite passed;
the final focused suite has 74 server tests and 3 TypeScript client tests,
covering source invalidation and client fallback changes. Android hosted-Latest debug unit tests and lint pass, including typed
requests over the existing lease interface. A full-app test reads the Claude
capture through the retained catalog, mounted route, version gate and TypeScript
client. It stubs unrelated project discovery, and does not claim a running
provider or deployed Android UI test.

Run `pnpm --filter @yep-anywhere/server exec tsx --conditions source
scripts/benchmark-simple-client.mjs` for the 20-message, 1 KiB-prose workload.
The 2026-09-12 diagnostic run produced 24,763 bytes per snapshot (123,815
bytes/second at five updates). One and ten subscribers each performed one source
read and one source close. Projection plus encoding p95 was 4.48 ms for one
consumer and 16.47 ms for ten consumers across 100 measured samples after warmup.
These are **diagnostic**, not a performance-gate pass: capacity
`host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47` lacked baseline CPU/swap
samples in the shared host profiler. Repeat on an eligible measurement host;
representative acquisition costs and terminal-to-client latency remain open.

The app-level test also exposed [scanner persistence after shutdown](../../gaps/project-scanner-shutdown-persistence.md),
recorded separately from this API work. Validation here is macOS plus JVM;
Linux/Windows filesystem execution and real Android-device consumption remain
unverified by this checkpoint.


### First web preview

The [owning topic](../../topics/simple-client-api.md#first-web-preview-2026-09-12)
records the route, transitional legacy catalog adapter, saved-host lifecycle,
grouping rules, issue coverage, history controls and safe renderer behavior.
`/-/preview` mounts outside the full session runtime in the remote bundle.
The existing API revision is unchanged. Partial-message assembly is deferred by
maintainer direction; finalized-message snapshots remain live.

The real encrypted multi-server harness now supports optional profile preparation.
The preview test records Claude as previously used before expecting its retained
catalog to discover fixtures; mere transcript presence intentionally does not
enroll a provider. It exercises colliding session/project IDs, grouping, disabled
issue coverage, a disconnected peer, saved selection and route teardown. Unit
checks cover revision gates, late/cross-source frames, reconnect, cancellation,
anchored windows, unknown content and read-only issue queries.

Next implement the Android Compose preview against the same contract and saved
host leases. Then evaluate the web layout on Latest and replace the transitional
catalog adapter with a reviewed SourceOverview operation. Indexed history and
representative projection/acquisition cost evidence remain separate open gates.
This checkpoint does not publish mobile apps or promote the API contract.


Web preview validation on macOS: workspace lint (zero warnings), format check,
TypeScript checking and the full workspace unit suite passed. The full browser
suite passed 228 tests with 8 skipped. After final handoff/auth recovery changes,
39 focused unit tests and 15 browser tests passed, including both existing monitor
transport modes and the preview in the built remote bundle. The preview case
also verifies a finalized native append reaching the current live subscription,
source isolation, reload, and connection release. Desktop (1000×600) and phone
(375×812) captures were generated through the artifact capture facility and
visually inspected. CSS ownership checks pass; the console scan adds no new
production logging. No Latest deployment or Android-device validation is claimed.


### First Android Compose preview — 2026-09-12

Session cards on the existing multi-host native home now open a source-scoped,
read-only Conversation activity. It uses the generated Kotlin contract and the
existing native secure runtime, with the same 20-message initial window, anchored
Show more increments, 100-message cap, Latest behavior and safe content fallbacks
as the web preview. This slice retains the native home's existing catalog and
grouping; it does not claim a SourceOverview migration or grouping parity.

Foreground visibility owns a connection lease. Leaving the activity releases it;
returning acquires a fresh binding after checking capability and exact revision.
Conversation subscriptions close on transport loss instead of replaying their old
sequence, while existing summary/activity subscriptions retain their replay
behavior. Explicit reconnect keeps the previous snapshot visibly stale until a
fresh sequence-zero snapshot arrives. Full-session handoff preserves the source:
known direct endpoints open their own deployment in a browser, and relay sources
open the configured full web client's selected relay sign-in/return route. Web
authentication remains separate; the native-to-WebView credential bridge is not
part of this slice. Unknown direct endpoint shapes disable the handoff.

A repeatable instrumentation test pairs through real SRP/encryption with an
isolated diagnostic server, taps the actual home session card, expands history,
observes a uniquely identified finalized native append, rotates, verifies the
external full-session intent, forces a transport disconnect, reconnects, and
checks lease release in the background and fresh live updates on return. It
cleans up only its own paired profile. The existing probe now passes app data,
provider catalog eligibility and Conversation subscription ownership explicitly;
its optional fixture controls exist only in that disposable loopback process.

Validation used an existing API 34 arm64 phone AVD (1080×2400); portrait and landscape captures were
visually inspected. This proves direct encrypted transport and the Compose UI on
an emulator, not a physical-device, store-release or deployed relay UI milestone.
The native runtime's prior relay/crypto interoperability tests remain applicable.
Partial-message tokens, reply/approval actions, iOS, rich rendering and indexed
history acquisition remain deferred.


To repeat the native proof, start
`packages/server/scripts/android-native-secure-probe-server.ts` with
`YA_NATIVE_PROBE_CONVERSATION=true`, a disposable `YA_NATIVE_PROBE_USERNAME` and
`YA_NATIVE_PROBE_PASSWORD` (at least eight characters). Its default port is
38901. Select an AVD explicitly, reverse TCP port 38901 with ADB, and build/install
`assembleHostedLatestDebug` and `assembleHostedLatestDebugAndroidTest` with
`-PyaNativeProbeCleartext=true`. Run
`com.yepanywhere.mobile.ui.YaConversationInstrumentedTest` with instrumentation
arguments `yaProbeWsUrl=ws://127.0.0.1:38901/api/ws`, `yaProbeUsername` and
`yaProbePassword`. The cleartext allowance is debug-only; the YA payload still
uses native encryption. Captures are under the application's external files
`conversation-captures` directory; present them through the repository artifact
capture facility. Stop the probe and remove the ADB reverse mapping afterward.

Final checks: 84 Android JVM tests, Android lint and both debug APK builds
passed. The new AVD instrumentation test passed, including distinct live appends
before and after background/foreground. Workspace lint, formatting and typecheck
passed; final server and client runs passed 5,225 and 5,780 tests respectively.
The full browser run passed 231 tests with seven skipped; subsequent focused
checks passed the relay handoff without remembered credentials, fresh relay login
and remembered-session resumption. The first workspace unit run hit the already
recorded [filesystem watcher deadline](../../gaps/project-file-completion-watcher-test-deadline.md);
both its focused rerun and the final full server rerun passed.
