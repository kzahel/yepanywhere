# Durable session relationships implementation

Topic: session-relationships

Status: implementation authorized 2026-11-04. The owning contract is
[durable session relationships](../../topics/session-relationships.md).

This work removes provider discovery from transcript delivery and records
accurate creation, lineage and native child evidence in the existing required
profile SQLite database. Existing identity, common admission and API receipt
owners remain authoritative. It follows [plan 171](171-durable-session-identity-and-creation.md)
and uses [plan 175](175-native-provider-integration-scenarios.md) for native
qualification. The [nested-harness reverse-link defect](../../gaps/nested-harness-session-not-linked-to-launcher.md)
is an acceptance input; a command that names a resumed harness proves launch,
not creation. The native fixture's Claude pin drift is repaired and its full-app scenarios
qualified against the declared runtime; broader child-source coverage remains
explicit below.

## Substantial delivery slices

1. Shared SQL foundation: migration, typed scoped resources and edges, separate
   producer evidence, atomic durable checkpoints, replay, source replacement,
   restart, rollback and bounded incoming/outgoing queries. No wire changes.
2. Authoritative YA writers: common creation/copy/aside admission and trusted
   v0 receipts, identity resolution, peer scoping and durable reconciliation.
   Never infer trusted creators from descriptive client provenance.
3. Native child acquisition: qualify actual child spawning with real pinned
   executables and scripted local model APIs, then persist provider observations
   and resumable progress. Cover each retained native source; do not mistake
   Pi transcript-node parents for session children.
4. Nonblocking read integration: serve accepted SQL projections immediately,
   coalesce bounded discovery by exact source, reconcile source changes, and
   preserve existing child navigation. Remove the old independent cache owners
   as their consumers migrate. No per-session pollers or catalog scans.
5. Complete consumers and qualification: generic relationship query adapters,
   bounded nested-harness indexing, authorization, legacy projections, restart
   and source-change coverage, mobile loading/typing and measured detail latency.

Choose coherent implementation boundaries within these slices rather than
committing individual helpers. Update this ledger with completed behavior and
remaining qualification, including unsupported or unavailable provider/platform
cases. A foundation alone is not completion of the full design.

## Review and publication loop

At each substantial commit point, freeze the intended diff and request a
read-only review through the local YA API. The maintainer requested Claude
Opus 5.5, Work pool, Weekly pace policy, bypass permissions and high thinking /
effort. Discover these settings from the running server; do not substitute a
different account or provider. Retain private review/session evidence under
ignored `tasks/session-relationships/`, address actionable findings and rerun
affected checks before committing and pushing. Keep pool/account identifiers
and private histories out of this document and the repository.

Use actual executables against scripted local model APIs first. Live inference
is authorized when necessary for missing evidence, including small sanitized
fixtures, but is not a fallback that turns failed local-routing tests green.
Old Chrome-extension frontend against a newer server is excluded by the
maintainer. New hosted/mobile clients against supported older servers retain
their capability/fallback requirements. An internal SQL migration alone adds
no wire capability and changes no access grants.

## Progress

- Slice 1 implements additive schema v26 and the internal shared store: scoped
  typed resources, independently supported edges, immutable owner replay, fenced
  reconciliation, bounded last-observed evidence, atomic checkpoints and indexed
  incoming/outgoing reads. Partial replacement preserves last-known facts until
  completion. Real-SQL tests cover upgrade/reopen, rollback, stale/replayed work,
  scopes, repeated reconciliation and mixed-direction pagination. Node 22/24 and
  pinned Bun probes exercise the portable SQL boundary. That foundation added
  no writers or wire changes. Ordering is stable hash/key order; provider-child projections
  must preserve their own established display order. Full evidence-history
  cursor navigation remains a query-adapter concern. Writers arrived in the
  authoritative owner slice below; this foundation alone did not add them.
- Design and native qualification strategy recorded. Existing provider-child
  discovery still blocks detail for adapters not yet migrated below.

- Native child acquisition (part 1) qualifies actual Claude/Codex spawning without inference,
  independently verifies native ids/anchors and reopens parent-scoped readers.
  It fixes v2 Codex child discovery, whose task-path-only spawn output was
  insufficient for the old extractor, and centralizes native runtime pins.
  Correlated native start evidence and the child's own immediate-parent
  metadata must agree, so copied fork history cannot invent parenting. The
  existing four full-app reload cases pass against the declared runtimes. Remaining launch variants, providers and SQL
  publication are not claimed qualified by this slice.

- Native child acquisition/read integration (part 2, Codex) adds one bounded
  profile-owned acquisition coordinator and SQL projection. Detail, metadata,
  incremental catch-up and history requests read accepted facts immediately;
  acquisition cannot block them. Structural proof comes from each child's own
  header through the shared scoped catalog, without replaying the parent body.
  Accepted empty, unknown and partial remain distinct; source failure/deletion
  cannot erase history. Source changes fence stale publication; child facts and
  parent progress commit together in bounded transactions. Native handles do
  not become public top-level sessions. Real Codex child creation now qualifies
  SQL publication and restart, alongside the independent native-id oracle.
  Late metadata updates preserve transcript identity and scroll memory; route
  retirement and initial-load ordering have focused race coverage.
- This slice reuses existing optional `providerChildren`, the metadata route
  and metadata-change event. A release-corpus audit of every supported core
  tag from v0.8.0 through v0.11.0 finds all three. Older servers retain their
  initial child projection, and omitted optional fields retain accepted data;
  no new route, wire field or capability is required. Pre-slice clients on a new
  server may need a reload to show initially unpublished children. Metadata
  field-bearing events do not induce fresh discovery on supported older servers.
  The audit evidence is
  retained under the ignored task directory. Other providers, authoritative
  generic queries and removal of remaining legacy discovery owners and retained
  collection-feed joins remain outstanding. YA/v0 writers follow below.
- Opus review found activity-triggered SQL/event churn and missing list-only
  acquisition. The fixes split structural versions from catalog activity
  overlays, coalesce scope/child invalidations, register finite list acquisition
  and route ordinary global-list enrichment through the same SQL owner. Follow-up
  coverage includes unchanged-structure appends, partial-batch resume, ambiguous
  parenting, repaired failed headers and nonblocking retirement. Explicit review
  and internal Codex delegates remain unqualified/excluded from child navigation.
  Their truthful native parent fields alone do not expand the UI source.
- Follow-up review caught large-list registry churn. Background demand now
  refuses eviction at capacity, and a 150-parent persisted/reopened test proves
  zero observations on the second pass while retaining the viewed parent.
  Global enrichment runs only on the requested page and preserves cross-project
  order. Legacy Codex references resolve in one catalog/root batch per source;
  other providers retain their old list path. Failed change batches invalidate
  bounded live scope owners, and reader retirement removes subscriptions while
  preserving the existing leased-read completion contract.
- Final review accepts the slice after the registered-unknown R1 correction;
  the 150-parent regression covers published and partial-empty rows, zero
  second-pass observations and an explicit foreground retry. A final real
  hook/cache test reproduced and fixed a fast warm-HTTP/hydration ordering race.
  Metadata cannot apply until both HTTP settlement and warm hydration finish.
  Opus re-reviewed and accepted that lifecycle correction without new findings.
- The actual frozen 1,718-message browser qualification exposed a configured
  versus canonical root alias mismatch in native file invalidation. Internal
  normalization now coordinates both reader caches and SQL source scheduling,
  with bounded epoch-fenced alias resolution, synchronous original-root
  invalidation and no duplicate file reads. A real aliased directory watcher
  regression covers late child publication, physical paths and epoch recovery.
  This changes no configured path, startup eligibility or wire event payload.

### Codex read-integration verification

The November 4 isolated Node 24 probe used a frozen real long transcript and
duplicated only the history preceding its last two compactions. All three
variants returned the same 1,718 messages / approximately 4.5 MB response from
a 19.9 MiB native tail. This is a local diagnostic, not a portable performance
ceiling or a Wi-Fi/browser measurement:

| Total history | Fresh profile detail | Warm detail median (5 reads) | Detail after process restart |
| --- | --- | --- | --- |
| 112.1 MiB | 0.99 s | 0.36 s | 0.45 s |
| 204.3 MiB | 1.25 s | 0.37 s | 0.45 s |
| 388.7 MiB | 1.69 s | 0.37 s | 0.45 s |

Warm route metadata work was 0.2 ms and post-restart work approximately 1 ms.
Complete `/metadata` HTTP requests had 1.09–1.13 ms medians across these
variants (15 reads each, including after restart). A separate synthetic
3,700-thread installation returned the same 50-row global page in 78–86 ms
for five forced warm collection walks; first-profile indexing took 1.85 s.
These requests used different future cursors to bypass result-cache reuse.
The first profile still constructs its summary; subsequent reads/restarts use
SQL. Tail read, normalization and rich-content augmentation remain separate
costs. No quadratic dependence on preceding history appeared in this sample.
The Apple M4 Pro host had 14 logical CPUs, at least 23 GiB available RAM, maximum
one-minute load per CPU 0.744, and unchanged 435.6 MiB swap usage. Darwin's
generic CPU-busy/pressure counters were unavailable; source identity, capacity
key, start/end host samples and raw clocks stay in the ignored task evidence.
Every standalone server was disposed without touching the live port 3400.

The retained desktop/phone browser case loads 160 messages and publishes
repeated metadata changes during sequential typing. It verifies the late child
button, retained draft, original transcript DOM and no publication-induced
transcript request, with each input acknowledgement below 100 ms. Final
1000×600 / 375×812 captures show the count in the existing compact header and
the intact composer, without overflow. Unit tests additionally cover initial
load deferral, in-flight coalescing, older optional replies, route retirement
and scroll-memory retention.

Actual long-session browser qualification uses a fresh Chromium context with
a warmed standalone server and the frozen 1,718-message response. Desktop and
phone became readable in 1.34 / 1.33 seconds. Creating synthetic native child
headers during sequential typing exercised the real watcher → SQL → metadata
event → client path. Maximum input acknowledgement was 20.9 / 14.3 ms; both
drafts and the existing transcript DOM were preserved. This is a local
qualification sample, not a network or low-end-device latency guarantee.

The same real-data late-child/typing qualification also passes with the pinned
Bun 1.3.14 server under a Node fixture coordinator: 1.34 / 1.33 seconds readable
and maximum input acknowledgement 22.9 / 14.8 ms on desktop / phone. The final
Node run under concurrent workspace verification remained below 32 ms per key.
All owned browser/server processes were disposed after each run.

### Authoritative creation and receipt writers

Common admission now commits exact copy, aside and successor relationships
with its identity/operation/metadata transaction. Restart-fork preserves both
continuation and copy meaning; the existing clone route records the actual
typed provider copy operation. Legacy metadata yields `derived_from` only when
the exact subtype is unavailable. Content deletion and saved-payload retention
do not erase historical facts or weaken an exact copy into ambiguous lineage.

V0 creator publication joins the existing trusted receipt and exact admitted
input correlation before provider effects, closing the admission-to-callback
crash window without adding a launch journal. Later receipt and confirmed
outbound-peer changes commit their graph updates atomically; observers run
after commit. Pending identities remain absent, and an outcome becoming
uncertain never resends work or erases a proved creation. Incoming peer
attestation and source-side authenticated intent retain distinct trust and
both server ids. Operator-only calls and existing-session sends create no
session-to-session creator edge.

A finite SQL-only reconciliation imports existing owners in 100-row pages,
with atomic progress, restart and cancellation. It selects structural fields
rather than prompts, credentials, proofs or native source paths. A
profile-connection owner shares the lazy graph statements across all writers
and native acquisition. Existing alias resolution remains with the receipt
owner. There is no new wire contract or authorization behavior.

Qualification passes: real SQLite admission/receipt/outbound rollback,
reopen, corrected targets, peer namespaces, missing attestation, exact native
receipt correlation, interrupted 205-row import and source/payload deletion.
Existing native admission checks now inspect creation edges before provider
startup; the retained restart-fork integration checks both predicates after a
failed continuation. The portable runtime contract exercises atomic admission,
correlated backfill and reopen on Node 22/24 and pinned Bun 1.3.14. The final
root checks pass: lint has zero warnings, formatting and types pass, and
7,010 server / 7,110 client tests pass (148.24 / 127.02 seconds locally).
The existing negative-fixture and asynchronous client navigation diagnostic
debt remains under its existing gaps; focused writer/admission checks are clean.

Opus review found two authority/projection defects. Caller-provided clone
parents now become immutable aside intent only when equal to the authorized
clone source; other pointers stay descriptive metadata. Explicitly clearing
metadata lineage now retires that producer while preserving independently
admitted facts. Real clone-route cases cover matched, unrelated and legacy
invalid parent syntax; real-SQL cases cover clear/re-point/delete and independent
evidence. Optional review notes on importer-version completion, retained
conflicts and local intent versus peer-reported outcomes are explicit in the
owning contract. Opus re-reviewed and accepted both corrections.

A further reproduced import defect mixed JS UTF-16 order with SQLite UTF-8
binary order for opaque Unicode ids at a full-page boundary. SQL now owns all
ordering/range comparisons; the page terminates only on a short page or exact
high-key equality. Both a real-SQL regression and the Node 22/24/Bun contract
exercise the formerly skipped astral id. The v23 migration test now seeds frozen
historical owner/allocation rows before upgrading, then uses current writers;
it no longer invokes today's writer against a schema missing its tables.
Opus reviewed that delta and accepted it. Nine new SQL integration cases take
approximately 0.1 seconds; the expanded 26-case owner/admission group passes.

The local M4 Pro diagnostic imported 1,000 synthetic admitted sessions, each
with a 100 KB prompt in both saved intent and metadata (approximately 200 MB
of source bodies), in 0.20 seconds on Node 24 and 0.26 seconds on Bun 1.3.14.
It yielded through 22 transactions; the maximum transaction was 19.4 / 28.8 ms.
A 100-edge indexed page had a 0.12 / 0.095 ms median across 15 reads.
These are diagnostics during concurrent workspace verification, not portable
ceilings or HTTP timings. Automatic host samples reported up to 2.13 load per
effective CPU and at least 2.6 GiB available memory; generic Darwin CPU-busy
and swap counters were unavailable. Raw host/source evidence stays ignored.

Remaining work includes generic authorized graph projections, other provider
child adapters and qualification, retained collection-feed joins, bounded
nested-harness reverse indexing, and migration of remaining legacy consumers.
The full design is not complete with these writers.
