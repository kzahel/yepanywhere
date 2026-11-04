# Durable session relationships

Status: implementation authorized 2026-11-04;
[plan 176](../docs/tactical/176-durable-session-relationships.md) tracks delivery
and qualification. This document owns the design; completed runtime slices are
recorded in that plan. No new wire contract or provider capability is implied.
This direction replaces a Codex-only child-cache proposal with one
provider-neutral relationship read model. It does not select a new scheduler,
delegation framework, authorization system, or transcript store.

Related owners:

- [Provider children](provider-child-sessions.md): native handles and existing UI.
- [Session identity](session-identity.md) and [plan 171](../docs/tactical/171-durable-session-identity-and-creation.md): public/native binding and common admission.
- [HTTP API v0](http-api-v0.md): trusted creator, receipts, peer filtering and retry semantics.
- [Creation provenance](session-creation-provenance.md): descriptive web/desktop/API source.
- [Principals and grants](principals-and-grants.md): identity, proof and authority are separate.
- [Provider session tree](provider-session-tree.md): branches *within* a transcript.
- [Nested harness launch](nested-harness-launch.md) and its [reverse-link gap](../gaps/nested-harness-session-not-linked-to-launcher.md).

## Problem and selected boundaries

Session detail currently waits for fresh provider-child discovery before
returning its messages. Its compact-tail bound does not bound that independent
discovery. Codex's process-local child projection survives ordinary appends but
not a server restart, and refreshing it can consult the broader session listing
to find an already-selected parent.

Meanwhile, durable relationships already have several owners:

- `ApiReceiptStore.relationships` reads SQLite creation and initiated-command
  receipts. The v0 route already answers who initiated an API operation.
- Common creation admission saves intent, source, ownership and copy context
  before native effects. `CreationCopySnapshot.kind` distinguishes fork/clone.
- Metadata distinguishes `/btw` parenting from `forkedFromSessionId`.
- Provider readers discover separately executed native children.
- Nested shell launches have outbound links but no durable reverse index.

The shared design must coordinate these owners, not create another competing
creator, receipt or identity store. Native persistence and receipts remain
authoritative for their own facts. A durable SQL relationship store supplies
one application query service above them. YA-authored relationship facts commit
through their existing admission/operation owner; provider-derived projections
retain their source evidence and can reconcile from available native records.
The whole store must not be treated as a disposable cache: old source files may
no longer exist. All relationship consumers eventually use that service;
provider-specific in-memory child caches cease being independent read owners.

The existing v0 feature gate must not become a prerequisite for core mobile/web
provider-child navigation. V0 and the ordinary app API are adapters over the
same application service, with their own authorization and compatibility rules.

## Resources and relationship meaning

Use typed, directed relationships rather than one overloaded parent field.
Direction follows the predicate below; incoming and outgoing queries are indexed.
One session may participate in several relationship types and have several
initiators over time. There is no universal single-parent tree.

| Predicate | From → to | Evidence and meaning |
| --- | --- | --- |
| `created_session` | initiating YA session → created YA session | Trusted API/session creation evidence. Does not imply provider-child ownership. |
| `provider_child` | native parent → native child | Provider-owned delegation evidence, including the launching tool call when known. |
| `forked_from` | new YA session → source session | Explicit native/YA fork operation, with the source boundary when available. |
| `cloned_from` | new YA session → source session | Explicit clone operation. Legacy `forkedFromSessionId` alone cannot prove fork versus clone. |
| `derived_from` | derived session → source session | Known legacy copy lineage whose exact fork/clone operation is unknown. Preserve that uncertainty until stronger evidence exists. |
| `aside_of` | YA aside → YA Mother session | Existing `/btw` semantics. It may coexist with a fork/copy relationship. |
| `continued_from` | successor → earlier session | An explicitly recorded retained handoff/successor operation; never inferred from similar titles. |
| `launched_harness` | launching session → named harness session | Bounded shell-command evidence. Resuming an existing session does not prove its creation. |

The initial registry is explicit and versioned. Future types can add semantics
without adding another `parentX` column or rewriting every provider adapter.
Unknown types must remain non-authoritative and must not acquire UI parenting,
execution, or access-control behavior by accident.

Sending a message, steering, interruption and other initiated commands stay in
the existing receipt/audit history. A send to an existing session is not a
`created_session` edge. The v0 relationship view can present that history beside
structural relationships without duplicating all commands into graph rows.

An operator or peer principal is not fabricated into a session endpoint when
the trusted source session is unknown. Its creator attribution remains visible
through the receipt. `creationProvenance.surface` is descriptive client input;
it cannot establish an authenticated creator edge.

### Reuse public/native identity

Two internal resource references are necessary:

- YA session: owning public server id and canonical YA session id.
- Native session: owning server id, audited native storage family, exact
  canonical native storage scope, and native session id.

Launch provider and native storage family remain distinct. Claude variants and
Codex variants share namespaces only where the existing native binding contract
proves that they do. A storage scope is private local identity, never a path
accepted from a browser or sent to a peer.

Resolve these references through `SessionIdentityStore` and existing alias
owners; do not create a second identity registry. Adoption/binding makes native
evidence joinable to an existing public session without minting another public
id or rewriting its historical source evidence. Project moves do not change
relationship identity. Binding collisions remain conflicts rather than merges.

Provider children retain native handles beneath the canonical YA parent's
`/agents/:child` route. Recording an edge does not promote them into top-level
sessions or change project counts. A provider child can itself be a parent,
which the model must represent even when today's UI exposes only one level.
Native transcript nodes may anchor an edge's evidence or fork cutoff, but a
provider's intra-transcript branch tree remains its separate model.

## Persistence, source ownership and trust

Use the existing required profile SQLite database, prepared statements and
portable Node/Bun adapter. The logical storage has three responsibilities:

1. Typed edges with indexed source and destination resource keys. Identical
   endpoint ids in another server, native family or root cannot collide.
2. Evidence identifying the producer, source record/receipt and observation
   version. Replaying an observation is idempotent. Multiple observations can
   support one logical edge without erasing each other's evidence. Keep one
   row per distinct producer/source/record/edge, updating its last-observed
   version during fenced reconciliation, rather than retaining a new row for
   every unchanged re-observation. Superseded records retain their last known
   supporting version; this is structural history, not a version event log.
3. Per-source checkpoints with source identity, extractor version and durable
   progress through complete records. Store pending launch identifiers when a
   call and its result are separated; no fabricated child edge precedes a
   known destination.

This is a small relational index, not a graph database or arbitrary execution
event log. Titles/descriptions are bounded display metadata; full prompts,
transcripts, tool outputs, credentials and request objects do not belong here.
Current runtime status, current child activity and content availability are
separate observations, not mutable definitions of the historical relationship.

Evidence may refine an unknown subtype, but it must not silently overwrite a
conflicting native binding or another producer's relationship. Keep conflicting
observations inspectable and withhold an ambiguous resolved link. Superseding a
provider's current-membership observation affects only that producer/version;
it does not erase an independently recorded YA creation or API receipt fact.

| Producer | Source of truth | Publication rule |
| --- | --- | --- |
| YA creation, fork/clone, `/btw`, explicit successor | Existing common admission/copy owner and durable metadata | Record the known relationship in that owner's transaction when possible; publish only after commit. |
| Local v0 creation | Existing receipt plus authenticated launch identity | Materialize a creator edge when the durable destination is known. Preserve request/receipt/launch correlation and uncertain outcomes. |
| Incoming/outgoing peer creation | Existing immediate-peer receipts and source-side records | Preserve both server ids and the source-attested attribution level. Either end can remain unconfirmed; there is no cross-server transaction. |
| Provider child | Provider-native persistence and qualified live observations | Commit accepted facts and their checkpoint atomically. Re-stat/revalidate the source before publication. |
| Nested harness | Existing bounded command detector and exact source record | Keep it descriptive. A missing target id, unresolved project or quoted command produces no invented target. |

If source admission and projection cannot share one existing transaction, use
a source-owned durable reconciliation cursor/outbox. Do not add a second
launch journal or move provider effects into an index transaction. A failed
index projection never causes a provider command to be replayed. Existing
receipt capacity, retention, payload conflict and retry contracts stay owned
by the receipt store. The relationship index grants no extra idempotency window.

Keep the evidence classes distinct: authenticated local launch, authenticated
immediate peer with source-attested session, provider-observed structural fact,
and descriptive command observation. Provider observation can authoritatively
describe native structure without granting the child any YA authority. A
caller-supplied session id never upgrades descriptive evidence to trusted proof.

Historical creation evidence does not disappear because a transcript file is
missing or a child is no longer active. Represent unavailable content,
superseded membership and explicitly retracted observations separately.
Truncation, replacement, rewind and deleted metadata trigger producer-specific
reconciliation; they must not erase unrelated v0 or YA-created edges. Preserve
source history when the producer's evidence supports it, and never interpret a
failed read as an authoritative empty set.

## Provider acquisition

Every adapter describes its source/version, enumeration semantics and accepted
progress. Providers are not forced through a JSONL byte-cursor interface.

| Provider/source | Existing evidence | Appropriate observation path |
| --- | --- | --- |
| Claude SDK family | Parent-scoped `subagents/agent-*` JSONL and metadata sidecars | Exact parent directory events and bounded sidecar reconciliation; retain native tool-call/type/depth facts. |
| Codex family | Parent rollout `spawn_agent` call/output pairs | Exact known parent source; persisted complete-record cursor and pending launch ids; append inspection rather than repeated full replay. |
| OpenCode | Native SQL `session.parent_id`, legacy file `parentID`, task parts | Bounded native row queries with logical DB/WAL versioning; task parts enrich launch anchors when available. A main-file mtime alone is insufficient. |
| Grok | Parent `subagents/*/meta.json` and child session records | Exact parent metadata directory observation; fork `parent_session_id` remains a different predicate. |
| Pi | Explicit YA creation/fork evidence; native within-transcript parent links | Import proved session-to-session operations only. `parentId` entry links are not native child-session evidence. |
| Other retained/new providers | Shared YA/v0 creation evidence immediately; native structures only after audit | Omit unsupported native-child acquisition. Do not infer support from a related transport or provider name; preserve the legacy Gemini freeze and independent Antigravity scope. |

The adapter capability distinguishes observing relationships from controlling a
child, switching a branch or launching work. Adding a provider implementation
does not grant those operations or require the provider to implement them.

One process-wide coordinator coalesces work by exact source, requested
projection and source version. It uses existing file/provider observations and
explicit demand. No per-session polling timer or recurring full-corpus scan is
introduced. A cold large parent backfills in bounded resumable batches; detail
navigation does not synchronously acquire or await it. Bounded RAM caches can
evict without forgetting SQL facts/checkpoints. Durable checkpoints end at
complete records so a partial tail can be reread without persisting its body.

## Read and presentation contract

Session-detail messages must not await native relationship discovery, on a
first visit, a restart, a warm return, incremental catch-up or older pagination.
An exact SQL lookup may attach already-known children. Discovery continues
independently and only updates the applicable relationship projection.

Expose the distinction between unpublished/unknown, a known empty set,
partially indexed and caught-up-to-a-specific-source-version. A failed source
read can return last-known facts with an error/freshness indication; it cannot
publish a false empty list. New events or reads delivering relationship changes
must not reset the transcript, scroll position or composer.

The query service supports paginated incoming/outgoing edges and type filters,
plus bounded evidence references. No default transitive graph expansion or
whole-install materialization. Session status overlays and receipt outcomes
remain separate joins. Stable cursors/order and bounded page/query/cache work
must be exercised against large fan-out and concurrent source changes.

Adapt today's `providerChildren`, `/agents` navigation, fork and `/btw` fields
from this model as their owning writers migrate. They retain their established
semantics. A generic related-session view may show additional predicates, but
API-created independent sessions must not become provider-native read-only
children or inherit that UI's control limitations.

The v0 `relationships` resource should reuse the query service while keeping
its creation receipt and initiated-command evidence. New normalized edge fields
or a revised resource version require an explicit contract. The ordinary app
must not depend on experimental v0 availability to obtain provider children.
No hosted client may depend on a new field/event/route until the compatibility
corpus, capability/version gate and older-server fallback are agreed. A newer
internal model can replace old internals without requiring parallel permanent
stores; supported wire projections remain adapters for their required horizon.

### Authorization

Relationships describe causality, lineage and structure; they confer no grant,
ownership, permission to send input, or reverse/transitive server access.
Authorize both endpoints and the evidence before exposing ids, titles, counts,
receipts or pagination information. Filtering only the final browser view is
insufficient. Native scopes/paths and secret proof material never cross the API.

Preserve today's v0 operator restriction and peer projection: a peer sees only
its visible creation receipt, not the target's initiated command history.
Expanding those views is a separate authorization decision. A remote source
session id is resolved only within its source server; local aliases cannot
rewrite it. Unknown or inaccessible endpoints remain undisclosed under the
existing policy, and relationship traversal never bypasses project grants.

## Delivery and qualification

### Native harness and independent evidence

Use [native provider scenarios](native-provider-testing.md) and
[plan 175](../docs/tactical/175-native-provider-integration-scenarios.md) as the
primary acquisition test boundary. Real provider executables execute scripted
tool calls against owned loopback model APIs. Script parent delegation and
child replies explicitly; no model inference is intrinsically required to
exercise the provider's child-session machinery or its durable records.

Current coverage is a foundation, not complete relationship qualification:

| Boundary | Existing evidence | Required relationship extension |
| --- | --- | --- |
| Native execution | Actual launch, tools, queue/control, history and resume scenarios across qualified launch paths | Actual child-tool invocation, child model exchanges, returned native id, parent/child files or DB rows, and independent reopen through the production reader. |
| Child extraction | Constructed Claude/Codex/Grok/OpenCode persistence, scoped readers and route tests | Native-generated specimens for the exact qualified versions; independent expectations from native tool results and raw storage, not the same parser on both sides of an assertion. |
| YA/v0 creation | Real admission/SQLite, retry, creator, peer, remap and restart checks; some boundaries use scripted provider peers | A real parent executable's tool invokes the owned API, creates a real child executable, and verifies its trusted launch attribution and public/native bindings after restart. Exercise every retained admission ingress independently at its cheapest meaningful boundary. |
| UI and latency | Existing real Claude/Codex source-app/browser harness | Block relationship acquisition while the transcript loads, publish relationships later, and prove stable navigation/scroll and sequential typing under concurrent updates. |

A child request must remain on the owned model endpoint with synthetic
credentials, including child-specific model selection and nested child
launches. Verify the executable's actual tool inventory/configuration rather
than assuming a tool exists or that the parent's endpoint override propagates.
The general fixture disables some background features; relationship scenarios
must explicitly enable only the native behavior they intend to qualify.
Missing routing, unsupported native tools or unexpected external requests fail
the selected qualification; they do not silently switch to paid inference or
manufactured child files.

Live inference is a separate, small optional smoke boundary for real model
tool selection, subscription authentication, or a provider's child path that
cannot actually target a local model API. It is not the default regression
oracle and is not needed to test SQL transactions, scopes, checkpoints,
receipt outcomes or authorization. Until such a native path is demonstrated,
mark it unqualified rather than claiming that a constructed fixture proves it.

Before claiming current-native coverage, align executable pins, the root
compatibility markers and the versions actually exercised. The November 4
source review found the full-app fixture's Claude expectation at 2.1.312 while
the root declares 2.1.318 / SDK 0.3.318; the Process-level fixture already uses
the root marker. The app-fixture mismatch is tracked in the
[pin-drift gap](../gaps/native-provider-claude-version-pin-drift.md).
The captured corpus explicitly lacks child sidecars/subagent scenarios and
contains older baseline versions; keep it for historical parser regressions,
not as proof of current native spawning. OpenCode 1.x qualification does not
qualify its explicitly unsupported 2.x implementation.

Keep a provider × ingress × relationship-kind qualification matrix. Cover
distinct execution/storage mechanisms and deliberate unsupported cells;
avoid duplicating every UI scenario for every provider variant. Record
scenario/startup/cleanup cost and platform/version evidence. Current
macOS/limited Linux results do not establish the entire Windows or mobile
lifecycle matrix.

### Capabilities and compatibility

Internal SQL persistence/query changes need no client capability by themselves.
A normalized relationship resource, unknown/partial/complete status or a new
update event does need an explicit contract and a support/fallback review.
Existing `providerChildren` and creator receipts must not silently acquire new
required meanings. The provider observation capability remains independent
from YA/v0 creation, native fork, child control and transcript-tree support.

Maintainer decision, 2026-11-04: old Chrome-extension frontend against a newer
server is excluded from qualification for this relationship work. Do not build
or retain an extension-specific compatibility implementation for that case.
This does not waive current hosted/mobile clients against supported older
servers. They must use the existing supported projection or omit the new
relationship view when its contract is absent, without issuing unsupported
requests. Other persisted/native-mobile and client/server skew obligations
remain under [server capabilities](server-capabilities.md) and
[hosted compatibility](remote-hosted-compatibility.md).

Keep the SQL migration additive and existing authoritative records recoverable
through the migration. Provider extractor/checkpoint versions and historical
fixture formats have their own compatibility tests; a UI gate cannot repair an
incorrect native parser. Server downgrade to a database schema it cannot read
retains the existing explicit refusal/recovery policy.

### Implementation sequence

1. **Introduce the shared read model and source adapters.** Define the typed
   resources/predicates/evidence, SQL indexes, bounded queries and checkpoint
   protocol. Reuse the existing identity and receipt owners. Import current
   YA lineage without guessing fork versus clone from legacy metadata.
2. **Remove relationship acquisition from transcript delivery.** Adapt known
   provider children through SQL, exact-parent lookup and independent refresh.
   Support cold/unknown and later publication through an agreed wire contract.
   Retire superseded provider-specific query/cache ownership as each adapter
   migrates; retain each provider's extraction logic as an adapter.
3. **Coordinate trusted creation and reverse navigation.** Feed common
   admission and v0/peer receipt evidence into the same model; project both
   relationship directions. Add bounded nested-harness indexing where evidence
   exists, without broadening its command parser or assuming the target was new.
4. **Migrate remaining writers and surfaces.** Make old metadata fields and UI
   shapes projections, remove migrated dual writes, then expand relation kinds
   and providers through their own audited capabilities. Do not hold the
   loading fix hostage to every future provider/UI feature.

Required evidence includes real SQLite reopen and interrupted projection,
receipt retries/remaps/uncertainty, public/native and cross-root collisions,
source-versus-destination server identity, changed DB WAL with unchanged main
file, partial lines, append/truncate/replace/delete, nested grandchildren,
multiple relation kinds per pair and unsupported-provider behavior. Verify
that unauthorized endpoints/evidence cannot leak through either direction.

Benchmark selected relationship reads and complete session-detail latency
separately on Node and pinned Bun, with automatic host evidence. Include
restart with an existing durable index, first-ever cold discovery, a large
parent with no new child records, high fan-out and concurrent subscribers.
Hold discovery blocked and prove that the initial transcript still arrives;
then publish children and verify stable rows/scroll and sequential typing
within the existing 100 ms acknowledgement requirement. Linux/macOS/Windows
qualification and released-client/native-mobile compatibility remain explicit.
