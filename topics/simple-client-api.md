# Simple Client API

Topic: simple-client-api

Status: Product, sequencing, and `/api/experimental/` namespace direction selected
on 2026-09-12. The offline JSON Schema/TypeScript/Kotlin contract spike is
implemented, and the server now produces bounded Conversation snapshots over
the shared compiler. Operation names, synchronization implementation, and release
compatibility remain proposals; no new endpoint or live consumer is implemented.

## Purpose and first consumers

YA should expose a small, transport-independent application API for basic
clients. Each server interprets its own provider history and live activity and
returns typed session summaries and a finished, condensed Conversation view.
Clients should not need the existing web session reducer, provider event
interpretation, compaction bookkeeping, or live/durable reconciliation.

The first consumer is a minimal experimental web client for rapid iteration.
It connects to multiple YA servers from its first useful slice and experiments
with sidebar grouping by machine, project, and issue. It should be testable at
an unlisted URL on `latest.yepanywhere.com` through the existing Latest release
pipeline. Kotlin/Compose follows closely in small vertical slices and helps
shape the same contract before it stabilizes. iOS is deferred until a later,
separately scoped transport and client effort.
React Native is not the chosen mobile direction.

The web demo is a real API consumer with its own small state machine. Shared
transport/authentication primitives and design tokens may be reused, but
importing the existing session-detail machinery would defeat this experiment.
Shipping Android and iOS remains the product outcome; the demo is not a new
full-web rewrite prerequisite.

Implementation sequence and unresolved decisions live in
[`docs/tactical/130-simple-client-api-and-three-client-demo.md`](../docs/tactical/130-simple-client-api-and-three-client-demo.md).

## Relationship to existing work

- [Portable transcript compiler](portable-transcript-compiler.md) supplies the
  server-ingest and semantic-projection direction. The internal web compiler
  is useful source material, not the new wire schema. For these consumers,
  projection runs on the server; a client-bundled compiler is not a prerequisite.
- [Conversation view](conversation-view.md) owns the meaning of condensed
  content: user/agent prose, media, important failures, and summarized activity.
- [Source transport](source-transport.md),
  [source runtimes](client-source-runtime-topology.md), and the landed
  [multi-host monitor](../docs/tactical/066-multi-host-monitor-coexistence-harness.md)
  provide reusable connection ownership and coexistence evidence. Reuse from the
  monitor is transport/lifecycle, not its full existing summary data model.
- [Android multi-host](../docs/tactical/084-android-native-multi-host-runtime.md)
  and [mobile pairing](mobile-server-pairing.md) supply existing native
  connection ownership. An API redesign is not a reason to rewrite crypto.
- [Issue/session associations](issue-session-associations.md) owns association
  discovery, canonical references, feature enablement, and coverage.

## Server and client responsibilities

Each YA server owns provider reads, stable YA session identity, live/durable
reconciliation, message grouping, activity summaries, failure classification,
media references, and the selection of a bounded conversation window. Its
existing provider-native history remains authoritative. A new canonical shadow
transcript or event-sourced database is not a prerequisite.

Each client owns its saved-server catalog, source-scoped connection demand,
aggregation, sidebar grouping, selected session, scroll state, and later local
draft/action state. A screen consumes typed models and a small client API;
transport or provider conditionals do not belong in the renderer.

Server computations must follow [architecture mandates](architecture-mandates.md):
shared keyed work, bounded acquisition, no transcript scan per sidebar render,
no refetch per provider token, and subscription teardown after the final owner
leaves. Moving interpretation server-side must not multiply full-history work
by the number of connected clients.

## Proposed data boundary

The first schema review should cover these semantic families without assuming
these are final type or operation names:

| Family | Required meaning |
| --- | --- |
| Source overview | Server display facts, projects, session summaries, attention, freshness and coverage |
| Session summary | YA session identity, source-local project reference, title, provider, activity, latest text preview, pending-input state, and issue references where available |
| Conversation | Ordered user/agent messages with stable IDs, structured content, compact activity, important failures, current session state, and pending requests |
| History coverage | Whether earlier messages exist, whether the returned window is complete for the request, and explicit content/payload limits |
| Subscription delivery | An authoritative initial state, ordered subsequent delivery, and a defined snapshot recovery/reset path |
| Actions, later | Explicit request identity, acceptance/failure outcome, and action eligibility for reply, stop, and question answering |

Message limits count logical user-visible user or agent messages, not provider
events, stream chunks, tool calls, or ambiguous "turns". Streaming growth of one
message does not consume another slot. The spike groups consecutive agent prose
and activity associated with a user submission into one agent message, preserving
failures and prose order. System boundaries, orphan agent history and interrupted
response identity still need producer evidence.
Pending requests and current session status remain available even when the
message that originated them is outside the requested window.

The [offline contract spike](../packages/shared/contracts/README.md) selects
JSON Schema with a deterministic TypeScript/Zod and Kotlin/org.json emitter.
It defines tagged content, string identities, timestamps, explicit nulls, errors,
and generated opaque unknown-kind fallbacks. Both decoders consume the same
serialized examples. Swift generation/decoding is future iOS work. This native
decoding evidence does not yet establish a live producer or UI.

Media travels by authenticated, source-scoped reference rather than inline
unbounded payloads. Counts and serialized bytes both have limits, including a
defined representation and recovery path for an oversized individual message.
Unknown visible content gets an explicit safe fallback; unsupported pending
actions cannot acquire an unexplained native approval button.

## Simple history and synchronization

A basic consumer asks for the latest `maxMessages` and may never browse older
history. Older history is an optional explicit operation, expressed to screen
code as "show earlier messages". Provider offsets, compaction boundaries,
prefix-fact folds, and raw replay cursors stay on the server or below the
small client facade.

The first candidate is an authoritative snapshot on subscription and after
recovery, with coalesced replacement snapshots for a small bounded window.
An expanded window can likewise replace client data using stable message IDs
to preserve the reading anchor. This is a candidate to measure, not a promise
to resend the whole window on every token. Bounded row updates may be needed;
their reducer must remain small and have snapshot recovery.

The selected history rule applies the existing two-compaction session-detail
scope first, groups messages, then selects the `maxMessages` tail within it.
The client facade defaults to 20; the explicit request count is 1–100. Coverage
separates earlier content inside that scope from older content beyond it
(`yes`/`no`/`unknown`). A complete requested tail does not mean complete history.
Count/scope limits, unavailable content and truncation are explicit; no new API
bypasses the existing scope or changes the present web API contract.

The candidate query uses `anchorMessageId: null` to follow the latest tail.
A fixed anchor is the newest included message while expanding earlier history;
new messages do not evict it. An unavailable anchor produces an explicit error.
Every query/reconnect/reset gets a fresh binding ID, and replacement snapshots
carry increasing sequence numbers within that binding. Clients reject old
bindings and stale sequences. The schema does not implement atomic handoff,
continuity recovery, or cancellation; those still need live evidence.

The spike records concrete gate-2 budgets for 200 ms coalescing, encoded bytes,
projection latency, shared computation across subscribers and teardown. Those
are acceptance thresholds to measure during server implementation, not a
performance claim established by offline payload decoding.

## Implemented projection checkpoint (2026-09-12)

The internal producer now compiles normalized active-branch messages into the
experimental Conversation contract. The reusable semantic compiler, structural
message/row types and parsers live under `packages/shared/src/transcript`; the
web client retains its cache, reconciliation, rendering and DOM adapters. Both
consumers use the same tool pairing, failure classification and shell folding.
No experimental route or capability is advertised by this checkpoint.

Preparation and window selection are separate. One prepared source revision can
serve multiple `maxMessages`/anchor requests without compiling again. This is
pure reuse evidence, not an implemented subscription owner or live fan-out
benchmark. The producer reuses the existing server compaction selector before
compilation and grouping. Intake is capped at 10,000 normalized records and
8 MiB for the scoped input; over-budget input produces `unavailable`. The caller
must acquire bounded data and provide honest source coverage. This function
does not read provider files or schedule any work.

Observable projection rules:

- User submissions retain their normalized IDs; responses use `agent:<user ID>`.
  Long derived IDs use a deterministic SHA-256 suffix. Missing or ambiguous
  visible source/group identities return `unavailable`; no clock/index identity
  is invented. Input contains one current normalized snapshot per record ID.
- A response ID persists through thinking-only/empty working state, streamed
  prose, completed prose, interruption and a same-submission retry. An explicit
  interruption remains visible; later response content can resume the same ID.
  A new user input starts a new response. Completion metadata can end a reply
  even while coarse session activity still reports working.
- When a reader cuts through an existing response, it may supply the bounded
  `leadingUserMessageId` prefix fact. The producer can also recover only that
  ID from an already supplied pre-scope prefix; it does not compile or return
  older text. Without the fact, a leading agent response has a deterministic
  orphan ID and explicit incomplete coverage. Recovering that identity across
  real cold-reader/live transitions remains a service-integration obligation.
- Routine calls become factual activity counts. Failures stay in order with
  bounded original output and structured exit status. Missing results on an
  ended response are visible unavailable content, not successful completion.
  Pending results in a working response do not imply missing history.
- Agent prose is Markdown data, user text is plain data, and HTML augments are
  excluded. Unsupported content becomes a bounded opaque fallback identifying
  the unsupported type; raw provider objects are not forwarded. Inline media
  has an unavailable reference until a serving media adapter exists; stored
  tool-media handles retain their existing source-scoped identity.
- Current pending requests survive historical window selection. Unknown requests
  remain opaque; this read-only revision never enables an action. More than 16
  requests or 32 KiB of request models returns `unavailable`, rather than hiding
  a pending decision to make the snapshot fit.
- Content-count/text limits mark affected messages truncated. If the complete
  encoded snapshot exceeds 256 KiB, older selected rows are omitted first while
  retaining the requested newest anchor. An individually oversized remaining
  message becomes a visible omission notice that explicitly mentions omitted
  failures when present. Coverage records the byte limit and incompleteness.
  `serializeConversationSnapshot` restores the original kinds of opaque content
  and pending requests before validating the actual wire representation.

The Claude/Codex fixtures are now exact native-input producer outputs consumed
by TypeScript and Kotlin tests. Adapter replay also verifies grouped identities,
prose, counts and failure metadata after fixture assembly supplies the recorded
user IDs and coalesces repeated normalized snapshots. The adapter recordings do
not contain YA's input queue; this does not prove a live queue/reader merger.
Synthetic tests cover growth, interruption, scope cuts, fixed anchors, missing
results, unknown content and count/byte limits. The wider web regression suites
continue to exercise the extracted core through the existing web adapter.

## Transport bindings

Application operations and payload meanings are independent of framing:

- HTTP can deliver reads and actions, with SSE for subscriptions.
- Plain WebSocket can carry requests and subscriptions.
- Existing authenticated encrypted WebSocket/relay connections can carry the
  same operations and payloads.

SSE is server-to-client; its actions need an accompanying request transport.
Every binding must preserve authorization, cancellation, recovery, and error
meanings. Existing endpoint selection and SRP/NaCl behavior stay authoritative.
The first hosted proof needs encrypted WebSocket; adapters can land in sequence,
but the contract must not depend on that binding or require every client to
implement every transport.

## Multi-server identity and sidebar experiments

A source is explicit in every client operation and entity key. Use a client
saved-profile/source key plus the server's YA session/project ID; equal IDs on
two servers must remain distinct. A server response need not echo a client-only
profile ID. Machine filtering and grouping are presentation state, not a global
connection switch. Healthy sources stay useful when another source is loading,
offline, incompatible, revoked, or requires sign-in.

Do not identify a machine by its display name, relay username, or shared SRP
credentials. Do not add a public installation ID as an implicit requirement.
Route continuity follows the existing pairing/source contracts; independent
saved profiles are not automatically deduplicated.

Server data supplies facts and relationships; clients arrange them. The first
demo should support switching these strategies without a new server endpoint:

- **Machine:** source, then its sessions or projects.
- **Project:** source-local project groups, with source badges. Cross-machine
  project merging needs an explicit mapping or authoritative repository identity;
  matching basenames or filesystem paths alone is insufficient.
- **Issue:** canonical tracker identities collect associated sessions, retaining
  source badges. Equal short keys on different tracker sites remain distinct.
  A session can appear under several issues while sharing one selected-session
  identity. Unassociated sessions remain reachable.

Grouping preferences belong to the client. Coverage must distinguish "no known
association" from disabled, unsupported, partial, or unavailable indexing.
The new API must reuse permitted server association discovery; opening this
demo must not silently enable Issues & PRs or trigger tracker requests. Audit
the existing viewed-window capture path so the new API does not accidentally
bypass discovery that currently happens during ordinary session reads.

## Experimental hosting and compatibility

All new API URLs begin with `/api/experimental/`. This explicitly marks an
iteration surface rather than a promoted, supported public contract. Operation
names, payload shapes, and behavior may change incompatibly during the
experiment; publishing preview builds does not freeze them. Requests carried
over WebSocket or encrypted WebSocket retain the same experimental operation
identity. This namespace is separate from the web demo's entry URL.

Generated models and fixtures still describe each experimental revision
precisely. Preview clients and servers must detect unsupported revisions and
show a source-scoped preview-version mismatch rather than misinterpret data.
Experimental revisions identify compatible builds; they do not promise a
long-term version-support policy or a permanent fallback for every experiment.
The existing supported API retains its compatibility obligations.

Before published mobile apps rely on this as their supported API, explicitly
promote the contract out of `/api/experimental/`: choose its stable namespace
and any public versioning scheme, document compatibility/support policy, and
define the preview-to-stable client/server transition. A versioned stable URL
is a candidate, not a decision already made. Generated types alone do not
constitute promotion.

Use an unlisted route in the reserved `/-/` namespace on the existing Latest
origin; the exact path is a deployment detail to settle with the demo. The URL
is a discoverability choice, not a credential. Each source still requires its
ordinary authentication. Keep the demo absent from ordinary navigation and
avoid changing the main app's startup, persistent settings, or service-worker
behavior. Demo preferences should have their own storage namespace.

Extend the existing
[`latest-remote-client.yml`](../.github/workflows/latest-remote-client.yml)
build/deployment path, preserving exact-CI-commit publication and previous
asset-generation retention. Hosted preview code does not change the signed,
bundled trust model selected for production native apps.

The experimental API is additive and needs a capability and supported-revision
check that distinguish its presence from schema compatibility.
Proposed older-server behavior is a source-scoped "preview API requires a server
update" state with an explicit route to the existing full client. Other sources
continue working. The demo makes no new API request before support is known;
it does not import the old transcript reducer as a hidden compatibility layer.

The [compatibility review](server-capabilities.md#minimum-compatibility-horizons)
must settle the release corpus, exact operations/events, gate, and fallback
before implementing the wire contract. "v2" is the working name for this new
surface, not approval to raise the existing web client's compatibility floor.
