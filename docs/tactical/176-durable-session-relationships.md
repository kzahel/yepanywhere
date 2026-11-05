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

- Codex current-native launch mappings and optional SQL anchor enrichment are
  implemented. The lazy reader shares the already audited started-item
  interpretation with the direct projection, retaining older result formats.
  Exact-parent handovers reuse already-read records, verify file proof and
  join only children whose own native headers prove parentage. Independent
  structural acquisition remains body-free. Per-child versions and unchanged
  anchors avoid activity writes; accepted anchors survive source loss/reopen.
  A real SQL/filesystem case covers bounded detail publication without redemand,
  copied foreign history, unchanged activity, incomplete/complete start records,
  prompt exclusion and reopen. Nested merged roots forward only the selected
  scope handover; restarted readers reuse exact SQL anchor history with no
  writes. Sibling revisions stay fixed when another anchor changes. A real
  stream interleaving proves a concurrent append retains lazy mappings, and
  escaped/noncanonical legacy envelopes retain their full-parser fallback.
  Actual Codex/Codex OSS cases pass the formerly failing fresh mapping and
  SQL-reopen anchor assertion; all seven native launch variants pass without
  inference (10.39 seconds test work / 13.65 total). Opus accepts the final
  source after fixing active-append failure, oldest-page completeness, sibling
  rewrites, unchanged-activity work, merged handovers and repeated SQL hints.
  Eighty-seven focused cases pass with two expected skips (0.77 seconds test
  work / 1.53 total). All root gates pass: zero lint warnings, format/types and
  7,044 server / 7,110 client / 952 shared tests. Existing negative-fixture and
  navigation diagnostic debt stays in its owning gaps.
  Node 22/24 and Bun probes publish 205 launch anchors from a bounded tail of
  an 8 MiB-padded parent in 16–21 ms; detail extraction itself takes 2.7–3.5 ms.
  Complete SQL reads take 6.6–7.1 ms and reopen without the native store takes
  6.8–8.0 ms. Initial structural acquisition is 41–70 ms. The first restarted
  source resolves 205 exact SQL hints once; validation and the next acquisition
  repeat none. Unchanged activity writes nothing. These local diagnostics
  include automatic host samples, with unavailable Darwin CPU-busy/swap fields;
  they are not portable ceilings. Node/Bun desktop/phone checks use 2,000 input
  messages plus 8 MiB padding and return a 41-message tail including a launch.
  Readable content arrives in 0.83–0.84 seconds; sequential typing stays below
  27 ms during native child creation and anchor publication. SQL metadata and
  lazy mappings converge while messages/DOM/draft stay mounted. All four final
  captures were inspected. No client wire contract or native target changed.

- Retained global collections and lazy agent mappings now consume the shared
  SQL read model. Exact native scopes survive public-id projection, and managed
  control rows can precede the native catalog. Unknown, accepted empty and
  stored children survive restart/source loss without requesting discovery.
  Fresh native launch anchors and pending children remain available; stored
  ambiguous anchors are withheld. Claude uses current bounded sidecars without
  reading child bodies and streams only legacy header records when needed.
  Real SQLite/API tests cover cross-root collisions, source deletion, managed
  admission, unchanged catalog generation and fresh-versus-stored mappings.
  Only the authorized filtered response page queries child SQL; Inbox does
  none. Opus accepts the final source with that bound, a linear JSONL splitter
  for large legacy records, and native-failure fallback coverage. The actual
  Claude fresh-plus-SQL mapping check and all seven structural native launch
  variants pass without inference (7.88 seconds test work / 9.18 total).
  The actual Codex v2 mapping check exposed a pre-existing missing started-item
  consumer, subsequently fixed and qualified by the coordinated Codex consumer
  slice above; the retained-collection slice alone did not qualify those anchors.
  Sixty-seven focused filesystem/SQLite/API cases pass in 0.70 seconds test
  work / 2.53 total. Node 22/24 and Bun diagnostics keep exactly 20 child
  lookups for a 20-row response across 100, 1,000 and 5,000 catalog parents,
  including 205 stored children after reopen with no native store. Complete
  handler medians range from 8–23 ms; this is local evidence, not a portable
  ceiling. Current Claude sidecars map 32 sparse 128 MiB child files in
  3.8–7.8 ms; Node instrumentation records no child body streams. Bun timing
  passes but that instrumentation is unavailable. The legacy 128 MiB case
  reads 128 KiB on Node. A 32 MiB single-record before/after probe improves
  from 922 to 80 ms on Node and 236 to 10 ms on Bun with no new record cutoff.
  Automatic host samples record contention/headroom; Darwin CPU-busy/swap
  counters are unavailable. Node/Bun 2,000-native-message desktop/phone checks
  load the 40-message tail in 0.82–0.85 seconds, with every measured sequential
  keystroke below 26 ms during child publication. Messages, DOM and draft stay
  mounted; all four final captures were inspected. All required root gates
  pass: lint has zero warnings, format/types pass, and 7,041 server / 7,110
  client / 952 shared cases pass. Existing negative-fixture/navigation logger
  debt remains in its owning gaps. No client contract changes.

- OpenCode child SQL integration is independently reviewed and qualified.
  It acquires native parent/descendant proof
  from one read-only committed database snapshot, including WAL-only changes.
  Legacy bounded JSON headers share the existing scope and give current SQL
  proof precedence. Descendants retain immediate parents. Activity versions
  avoid relationship writes for time-only updates. A real macOS test reproduced
  directory watches missing open-WAL writes; two fixed provider-owned inode
  watches now cover that boundary, with a nonrecursive DB directory watch
  and no public wire event. Frozen legacy headers refresh on detail demand. The actual pinned 1.18.9 Task scenario passes raw
  native identity, production content/exclusion and SQL publication/reopen on
  the owned local model API. Default direct children are qualified; deeper
  native nesting, other platforms and 2.x are not claimed by this evidence.
  Review findings are addressed: native watch allocation is nonrecursive;
  one shared indexed WAL probe updates activity and refreshes only changed
  lineages; activity re-sorts; legacy failures and missing older-schema/ancestor
  proof stay partial without blocking independent native facts. Per-lineage
  validation prevents unrelated spawns from cancelling initial publication.
  DB/WAL changes share one pending key per parent, including the full 128-source
  queue. Regression probes reproduce both prior failures; the corrected cases
  pass. Eleven real filesystem/SQLite cases take about 0.5 seconds with retained
  service tests; the complete focused group passes. Final Node 22/24 and Bun
  qualification with 128 registered parents and a native writer checkpoint
  uses one or two shared snapshots, with no relationship writes for activity.
  Opus accepts the final pinned source with no actionable correctness findings.
  All root checks pass: 7,037 server, 7,110 client and 952 shared cases, with
  the previously recorded unrelated Rendez failures preserved in their gap.

- Grok child SQL integration is implemented and independently reviewed.
  The source proves canonical parent identity, project/root and explicit native
  sidecar links without reading transcript bodies. Native JSON records are
  bounded to 1 MiB; malformed/oversized data is partial and preserves accepted
  facts. SQL whitelists structural/display fields and excludes delegated prompts,
  child cwd and attempt ids. The existing reader cache supplies only a locator;
  missing locators use a direct native-id path or finite bounded-header legacy
  lookup outside requests. An internal global watcher channel avoids new wire
  events and shares the existing bounded acquisition coordinator. Actual Grok
  1.0.70 spawn, independent native metadata/child identity, production child
  content and SQL reopen pass without inference. Seven real filesystem/SQLite
  cases cover source loss, partial/mismatching data, legacy directory spellings,
  root rebinds, corrected locators, activity and private watcher delivery. Node
  and Bun desktop/phone late updates and sequential typing pass locally (under
  22 ms), preserving messages/DOM/draft. Opus accepts the corrected source,
  including corrupt self-reference isolation and late-first-persistence recovery.
  Final root gates pass: 7,026 server tests, 7,110 client tests and 952 shared
  tests. Seven filesystem/SQL cases take approximately 0.33 seconds; the six
  actual native child launch variants pass in 8.24 seconds test work / 11.81
  seconds wall time while the workspace suite runs. Node 22/24 and Bun 1.3.14
  qualify 206-child SQL/reopen, a real private watcher and activity without SQL,
  Unicode cwd and prompt omission under the 64-statement ceiling. Cross-cwd
  native child navigation/exclusion and retained native catalog consumers are
  not qualified by the default-cwd scenario.

- Claude native-child SQL integration is implemented and independently reviewed.
  Exact physical parent directories and bounded sidecars establish structure;
  missing enrichment preserves known anchors, source failure preserves history,
  and native appends overlay activity without structural SQL churn. Existing
  provider watcher events feed the same bounded coordinator. Merged readers
  forward exact scope ownership across nested merges without same-id fallback.
  A real 205-child interruption case resumes at the committed 100-child frontier.
  Native inference-free child spawning, independent native-id checks, SQL
  publication and reopen pass for Claude, Claude Gateway, Claude Ollama, Codex
  and Codex OSS. Gateway's fixture explicitly enables its default-disabled
  Agent tool; this does not alter production defaults or qualify availability
  of a particular remote child model. Node 22/24 and Bun 1.3.14 source/205-child
  SQL/reopen probes pass, including malformed enrichment and deleted native
  files. Node and Bun desktop/phone checks retain transcript DOM and draft while
  actual watcher events publish late children; every sequential key acknowledges
  within 28 ms locally. A 2,000-message fixture uses its normal 40-message tail.
  These local observations are diagnostics, not portable latency ceilings.
  Opus reproduced per-request activity loss; stable source lifecycle ownership
  and coalesced fresh demand repair it. Bun browser qualification exposed a
  directory-only native notification, now accepted by the exact scoped source.
  A separate delayed-watcher regression establishes initial-baseline handover.
  Sustained overflow requests follow-up acquisition without canceling every
  running batch; sidecar opens reject symlinks and cannot block on a POSIX FIFO.
  Opus accepts the corrective delta. All root gates pass: 7,019 server tests,
  7,110 client tests and 952 shared tests (143.18 / 120.96 seconds server/client).
  The retained 50-case source/coordinator/watcher group takes 0.81 seconds; five
  native child launch variants take 2.99 seconds of test work / 4.85 seconds wall
  time. The earlier full run hit the documented Rendez restart-event flake; its
  red evidence and isolated passing rerun remain recorded in the owning gap.
  Continuous private-root observation and deeper native
  agent nesting remain explicit follow-ups rather than claimed coverage.

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
The full design is not complete with these writers and child adapters.

Claude relationship projection diagnostics on the same macOS host read all
205 children in approximately 7.2 ms on Node 22/24 and 7.7 ms on Bun 1.3.14
(median of 25 reads). The first read after SQL reopen, with native files
deleted, took 8.8–10.5 ms. These are full child projections, not generic
100-edge page timings. Automatic host samples recorded up to 1.15 load per
effective CPU while the workspace suite ran; CPU/swap counters were unavailable.
They are local diagnostics, not portable performance gates.

Grok source diagnostics use 205 initial sidecars with 112,500 bytes of delegated
prompt each (about 22 MiB of prompt data), plus one late child. The prompts
are transient parse input and do not enter SQL. On this macOS host, final
Node 22/24 and Bun runs acquire the first 205 children in 40–77 ms;
full 206-child SQL projections take 5.9–7.2 ms median of 25 reads. SQL reopen
with native files deleted takes 6.5–8.2 ms. Automatic host evidence is retained
with the ignored raw results; these local observations are not portable ceilings.

OpenCode diagnostics use 205 initial children plus a late child, alongside 127
other registered parents. Each native session carries 118,750 bytes of unused
prompt metadata; the relationship query never selects it. During concurrent
workspace verification, the final Node 22/24 and Bun runs acquire the first
205 children in 64–91 ms. Full 206-child SQL projections take 6.9–7.1 ms median
of 25 reads, and reopen after deleting native storage takes 6.9–7.9 ms. Automatic
host samples report up to 1.54 load per effective CPU and at least 6.6 GB
available memory. These are local diagnostics, not portable ceilings. Actual
OpenCode Task/child content and SQL reopen also pass on the owned model API.

Standalone Node/Bun browser checks read the ordinary 40-message tail from
2,000 synthetic native SQLite messages and parts. Desktop and phone become
readable in 0.83–0.86 seconds; late WAL child updates retain transcript DOM and
drafts, with every sequential keystroke acknowledged within 27 ms. Final
captures are produced through the repository facility and visually checked.
Linux/Windows native observation, deeper native spawning and unsupported
OpenCode 2.x remain outside this local qualification.


### Requested-parent metadata revalidation

Registered parents outside normal watcher coverage can become stale after their
first observation. Aged requests now schedule finite exact-parent metadata
refreshes while returning accepted SQL facts immediately. This extends the
existing bounded coordinator rather than adding session timers or native
watcher allocations. Claude/Grok use exact-parent metadata; OpenCode excludes
legacy catalog acquisition; Codex uses its native indexed spawn locators plus
child-owned scoped headers. Native indexes do not establish creation parentage.
Missing/unsupported cheap metadata preserves history and does not authorize a
provider-corpus walk. Full and partial metadata progress have separate durable
checkpoints. See the [provider-child contract](../../topics/provider-child-sessions.md)
for freshness, resource and fallback limits.

Opus accepts the final source after reproduced aliased-home and unavailable
parent-locator handoff failures were fixed. Real-source/service regressions
cover successful cheap publication, unavailable-locator fallback and a partial
native index missing an already-read anchor. Only meaningful handoffs can
escalate; ordinary aged reads retain partial positives. Foreground/native work
starts before queued aged jobs, and OpenCode preserves older-schema routing
membership without reloading legacy metadata. Reader leases remain finite.

All four root gates pass: zero lint warnings, formatting/types and 7,050 server
/ 7,110 client / 952 shared tests. The final server suite takes 148.20 seconds;
the seven actual native child variants take 9.23 seconds test work / 10.65
total. Existing negative-fixture and navigation diagnostic debt stays in its
owning gaps. The final reviewed source/test pins match the qualified tree.

Compiled Node 22/24 and Bun diagnostics with 205 initial children plus a late
child and an 8 MiB parent perform no corpus scan. After the broad checks end,
initial metadata acquisition takes 86–93 ms and the late refresh 76–94 ms.
Queueing costs less than 0.1 ms; concurrent SQL reads take 6.1–6.8 ms. Complete
206-child projections take 5.7–6.2 ms median, and reopen after deleting native
content takes 6.3–7.4 ms. WAL-only changes are detected; ordinary activity adds
zero relationship writes/events; retirement leaves no native DB leases. Host
samples report maximum load 0.73 per effective CPU and at least 12 GiB
available memory; generic Darwin CPU-busy/swap counters are unavailable.
During concurrent workspace testing, the same refresh took 0.30–0.92 seconds;
these are local diagnostics, not portable ceilings or HTTP timings.

Node/Bun standalone browser checks seed the native SQLite spawn index and
2,000 messages plus the large parent prefix. Desktop/phone become readable in
0.81–0.85 seconds. Late launch anchors reach SQL and existing lazy mappings
while the transcript DOM and draft survive concurrent sequential typing;
every key is acknowledged within 24 ms. Four repository-facility captures are
individually checked. Source-only review fixes retain that UI path; targeted
real-source alias/fallback tests cover their changed boundaries.

Native SQLite reads may create WAL/SHM reader sidecars. Custom SQLite homes
without a scoped locator may be stale or unavailable; indexed observations
remain partial. Nested symlinks inside a native sessions tree can still withhold
optional anchor enrichment; physical scope proof and durable history remain.
Generic authorized projections, nested-harness indexing and remaining legacy
consumers are separate work; this slice adds no public API.

### Native launch-bound v0 creation qualification

Actual Claude and Codex parent tools now exercise their private management lease
against the real application, create another actual native session, repeat an
identical request and submit a conflicting retry. The fixture verifies one
receipt/dispatch, canonical creator attribution, incoming/outgoing SQL creation
edges and source evidence, API provenance and native bindings. An owned API
replacement preserves those facts while the parent provider remains active;
the browser-independent socket reconnects before the parent finishes.

The final local-model probe passes both cases without inference (14.33 seconds
test work / 14.96 total). All six native-app scenarios pass on the reviewed
source (52.93 seconds aggregate / 18.77 wall). Opus independently ran the
suite twice under concurrent gate load: 74.8–75.5 seconds aggregate / 26.9–27.3
wall, with a maximum creation case of 11.88 seconds. The existing 30-second
budget remains over twice that measured maximum; no timeout is raised.

Opus accepted the final tests after two oracle gaps were corrected. A finite
publication wait now returns raw rows from one read-only SQL snapshot, with
semantic assertions outside the wait and a teardown fence. Model failure/egress
and request counts are checked after joined teardown, and the post-restart
catalog contains exactly the parent and child. The parent keeps its native PID
and process group across replacement; a new attached API generation and new
WebSocket deliver its final text. Provider-child absence follows an accepted
complete structural observation, which deliberately does not imply a new
parent-body revision. V0 creation proof is independently read after restart.

All four root gates pass on the final reviewed source: zero lint warnings,
format/types and 7,050 server / 7,110 client / 952 shared tests. The server
suite takes 147.29 seconds; the two new native cases are skipped by ordinary
workspace runs. Existing failure-fixture/navigation diagnostics remain in their
owning gaps. Early probe failures exposed incorrect test-owner lookup, a closed
WebSocket and a transient SQL read lock; corrected lifecycle ownership and the
publication barrier handle them without changing product behavior.

No product timeout, provider defaults, production source or client contract is
changed. At this stage cross-provider/peer-native creation and Windows remain
explicit limits; the cross-provider matrix is qualified in the later section
below.


### Direct Codex reader metadata consolidation

The retained direct-reader fallback now uses the same scoped header
source as durable SQL acquisition. This removes the separate 8 MiB parent-body
projection cache and its incremental parser, rather than keeping two child
read models. Structural children no longer depend on copied or missing launch
records. Optional anchors remain with explicit mapping reads and already-read
verified metadata. Accepted direct reads are synchronous and do no work;
explicit fresh reads acquire and validate native metadata. The diagnostic
command is updated to cover metadata/SQL/reopen cost and automatic host evidence.

Focused real-filesystem tests cover concurrent readers with an unread 8 MiB
parent, later child creation, parent rewrite, fork/native-parent overlap, launch
correlation and partial lines through the explicit mapping reader, cold versus
accepted empty, expiry and retirement. Unrelated catalog churn cannot erase a
successfully observed child; native read failures fall back to accepted
headers. Exact bindings remain authoritative across project/worktree changes,
while raw discovery still filters its selected project. Opus accepted the
source and the regression checks after these boundaries were corrected.

All four root gates pass, with 7,051 server / 7,110 client / 952 shared tests;
the server suite takes 146.31 seconds. The final focused cases pass 22/22 and
the seven actual native child variants pass in 12.15 seconds test work / 15.28
wall. An earlier root run reproduced the existing Rendez restart watcher gap;
its raw failure remains recorded in the owning gap, and is not fixed here.

Final Node 22/24 and Bun diagnostics acquire 205 child headers for 20 concurrent
readers with an unread 8 MiB parent in 49–51 ms. SQL publication takes 17–25 ms,
complete projections 6.3–6.7 ms median, and reopen after native deletion 6.8–7.1
ms. All transcript caches remain empty. A negative control validates zero body
streams on Node; Bun does not support that instrumentation and reports the
counter as unavailable. Automatic host samples report maximum load 0.21 per
effective CPU and at least 10 GiB available memory. These are local metadata
diagnostics, not HTTP or mobile latency ceilings. No client contract changes.

### Shared authorized relationship projection

The internal query adapter now accepts a canonical YA resource and its existing
exact native binding, merges bounded incoming/outgoing/type-filtered SQL pages,
and requires caller-owned endpoint and evidence projection. Provider-child
reads are its first retained consumer, preserving unique-parent and
provider-observed evidence policy within the already authorized parent scope.
No identity/grant registry, native I/O, additional statements, cache or recurring
work is added. Private raw scan progress cannot be serialized by JSON or object
spread; it is not an API continuation. Generic routes, public authorized-page
semantics, v0 adapters and bounded nested-harness acquisition remain separate.

Real SQLite cases exercise existing identity bindings, cross-root native-id
collisions, remote/unresolved endpoints, separately hidden receipt evidence,
mixed-direction alias pagination beyond a full batch and concurrent unrelated
writes. A 510-fact scan also inserts 32 related edges between batches and checks
the actual stored ids on both sides of its saved cursor: later keys appear
exactly once, earlier keys require a fresh scan. Raw edge ids hash private
scope paths, so they are excluded from projected output rather than mistaken
for redacted identifiers. Opus accepted the final implementation after this
privacy fix, binary cursor ordering and the stronger insertion oracle.

All four root gates pass, with zero lint warnings and 7,054 server / 7,110
client / 952 shared tests. The final server suite takes 147.15 seconds. The
focused final graph/service cases pass 26/26 in 0.40 seconds test work / 0.89
wall; all seven actual native child variants pass in 11.58 / 15.03 seconds.
The existing failure-fixture/navigation diagnostic debt remains in its owning
gaps. No client, route, v0, grant or native provider target changes.
After rebasing concurrent app-viewer/reload work, all four combined-tree gates
also pass: 7,059 server / 7,110 client / 952 shared tests, with the server suite
at 147.72 seconds. The reviewed runtime and test bodies are unchanged.

Node 22/24 and Bun diagnostics retain empty transcript caches and metadata-only
child discovery: 20 concurrent readers / 205 children / 8 MiB parent take
50–52 ms; SQL publication takes 18–21 ms, projection medians 6.6–6.9 ms and
reopen after native deletion 7.0–8.0 ms. Node records zero body streams; Bun's
counter remains explicitly unavailable. Automatic host samples report maximum
load 0.57 per effective CPU and at least 9 GiB available memory; Darwin
CPU-busy/swap counters remain unavailable. These are local diagnostics, not a
portable regression ceiling or end-to-end session-load claim.

### Cross-provider native v0 creation

The existing launch-bound creation scenario now covers Claude→Claude,
Claude→Codex, Codex→Claude and Codex→Codex. Its owned listener explicitly selects
both native model protocols for mixed fixtures, dispatches each response using
the request's actual protocol and retains the same synthetic-credential,
loopback, unexpected-request and teardown checks. Both selected executable
versions are verified; production launch defaults and public contracts do not
change. The exact native family of each endpoint, direct per-exchange protocol
assertions and the post-teardown two-parent/one-child protocol multiset
complement the existing creator/receipt, retry, SQL, API replacement and catalog
assertions. Opus accepted the final source after those protocol checks and a
measured test-budget correction: the matrix reached 18.00 seconds per case
under concurrent broad suites, so its guard is now 40 seconds (>2x). No creation
case had failed its former 30-second guard; this is headroom, not acceleration.

All eight final native-app cases pass without inference: 72.59 seconds
aggregate / 35.45 wall. The four creation cases take 8.4–8.8 seconds each.
Automatic host samples report maximum load 0.51 per effective CPU and at least
23 GiB available memory; Darwin CPU-busy/swap counters are unavailable. An
earlier concurrent run passes all eight in 131.78 seconds aggregate / 62.90
wall; that contention sample remains part of the budget evidence.

The standalone all-provider suite passes all 68 cases in 97.09 seconds
aggregate / 41.66 wall, with automatic host load at most 0.34 per effective CPU
and at least 31 GiB available memory. Running it alongside the workspace and
native-app suites first produced three timeouts (65 passes): the existing
Antigravity cold-resume gap and two OpenCode scenario-budget findings. Their
raw failures remain captured in their owning gaps; their budgets and assertions
are unchanged, and the later control does not establish a fix under load.

All four root gates pass on the final reviewed source: zero lint warnings,
format/types and 7,059 server / 7,110 client / 952 shared tests. The server
suite takes 151.18 seconds; ordinary runs skip the four native creation cases.
Existing failure-fixture/navigation diagnostic debt remains tracked separately.
Peer-native dispatch, Windows and new public graph contracts remain outside
this local matrix.
