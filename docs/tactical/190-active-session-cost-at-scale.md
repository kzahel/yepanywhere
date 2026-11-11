# Active session cost at scale

Topic: catalog-identity-projection-cost

Status: in progress. Shared Codex discovery ownership is implemented as the
first bounded-working-set slice; correctness, measurements and qualification
are recorded below. Retained list/Inbox SQL queries form the second slice,
canonical seen/lazy metadata the third, and SQL catalog ownership plus safe
query restoration the fourth. Stage 3 now has a shared transcript ingestion
and resolved-provider dispatch slice; Claude indexed warm windows are
implemented, with durable SQL facts, bounded cold windows and SQL-owned ordinary
append state. First construction, exceptional metadata selection and full
qualification remain open.
Stage 4 now carries authoritative bounded session/Inbox query changes with
capability-gated fallback. Projects and ProjectQueue now share that architecture
under a separate extension capability. Full scenario targets remain open. Combined-scale qualification is now recorded;
source-owned Claude/Codex project facts and indexed points are implemented.
Structural/ambiguous discovery, metadata delivery and transcript rendering
remain open.
Proposed 2026-11-10; the maintainer agreed the scenario, the targets and that step 2
(reading a long session incrementally) must happen. Step 1 (the scenario and
a measured baseline) is done; at the scenario's scale both providers saturate
the server (below). What was fixed before the plan (a draft-index request
storm, shared list walks, per-row
lookups after each catalog update) is in `77e1feba4` and `f196db4c7`; the
costs that remain are in
[active session tab cost](../../gaps/active-session-tab-background-cost.md).
The maintainer subsequently selected architecture-led prioritization over
following the original step order. The stages and selected focus below own
that order; the numbered steps remain implementation/evidence references.

## Goal

Work per transcript write depends only on what changed: never on how many
sessions the host has, nor on how long the written session's history is.
Then 50,000 sessions and a 200-compaction session cost the same per write as
50 sessions and a short one, and a quiet host costs nothing.

Non-goals:

- No change to provider readers' transcript formats or to what a session
  page shows.
- Older clients keep working: anything sent differently to tabs goes behind
  a capability, with today's full reload kept as the fallback.
- Memory work covers the catalog, session metadata and their dependent
  projections/working sets. This is not an unrelated whole-server cache or
  memory-pressure redesign. The scenario's memory target remains unchanged.

## Architectural stages and priority

Selected 2026-11-10: performance should follow from explicit ownership,
bounded reads/retention and updates to affected records. Each implementation
slice moves a real consumer to the intended architecture and removes its old
path where compatibility permits. Additional caches and provider-specific
request paths need a justification beyond improving one benchmark.

| Order | Stage | Scope and relation to original steps | Status |
|---|---|---|---|
| 1 | Establish ownership and cost boundaries | Audit durable facts, live overlays, list/detail consumers and retained copies; use step 1's baseline | Source audit and isolated ownership diagnostics recorded; ownership and SQL query slices implemented; remaining owners open |
| 2 | Complete the SQL-owned catalog and bounded session working set | Indexed lists/Inbox/counts, changed-file publication, on-demand metadata and project projections; original steps 4–5 and catalog-related restart work in step 8 | Shared Codex discovery and retained SQL queries implemented; canonical seen/lazy metadata implemented; SQL catalog reads/deltas, safe checkpoint restoration and source-owned Claude/Codex project facts implemented; structural discovery/remaining consumers open |
| 3 | Complete bounded transcript ingestion | Shared reader lifecycle/contract with provider-specific decoding; original step 2, still required for both Claude and Codex | Shared acquisition/Codex dispatch, indexed Claude warm windows and durable SQL cold-window queries and SQL-owned ordinary append state implemented; first construction and exceptional metadata work remain open |
| 4 | Carry authoritative changes through clients | List/page/count changes, reconnect catch-up and incremental transcript rendering; original steps 3 and 6 | Bounded session/Inbox query updates implemented behind a new capability; project/queue extension implemented; transcript rendering remains open |
| 5 | Qualify sustained operation and retain regression gates | Measure every slice, then full end-to-end acceptance; remaining idle work in step 8 and ratchets in step 7 | Full fixture plus population/history controls recorded; numeric guards implemented; CPU/bytes/render/cold and qualitative acceptance remain open |

These are architectural dependencies, not five large all-or-nothing rewrites.
An implementation slice must stand on its own with response parity and an
observable reduction in whole-corpus work. Measurement and correctness gates
apply throughout, rather than waiting for the last stage.

### Current focus — source-owned project discovery and indexed points

The [project discovery outcome](../research/190-project-discovery-facts.md)
implements the next architecture slice selected by the population controls.
One profile SQL owner stores compact native project facts. Known Claude/Codex
modifications update affected activity rows; detail consumers use indexed point
lookups. Native counts/path elections and activity semantics retain full-rebuild
parity. Watcher epochs, registration existence and local metadata revisions
cover freshness without another polling loop. Structural or ambiguous changes
still rediscover; other-provider SQL aggregates still have population work.
The outcome records final measurements and review. Full goal acceptance remains
open; collection metadata replacement, transcript consumers and quiet-host work
remain next candidates.

### Previous focus — combined qualification and the next ownership boundary

The [combined qualification](../research/190-combined-scale-qualification.md)
measures the frozen `be7b474c3` architecture at 50,000 idle sessions with each
200-compaction provider, plus independent population/history controls and
separate diagnostic profiles. Warm list/Inbox medians, loop p99 and typing
meet their observed ceilings. CPU/write, browser work, collection bytes and
cold opens miss; full goal acceptance remains open. Population controls selected
source-owned Claude/Codex project facts and point lookups; the outcome above
records that implementation. Codex preview refresh still parses the full rollout and is an
explicit bounded-reader follow-up. Numerical gates preserve missing evidence
and profiling exclusions; repeated flatness/additional-tab qualification and
quiet-host/retention attribution remain open.

### Previous focus — authoritative client collection updates

Stage 4 now carries canonical SQL query results through one source-owned client
stream. Session feeds (up to 500 rows) and Inbox receive changed rows and exact
membership/count updates, share identical server acquisitions within an auth
scope, and reacquire a bounded replacement after reconnect. Older servers and
complete search keep existing reads. Projects and ProjectQueue now use the same
owner with group-qualified rows and server-owned queue deadlines; the
[project extension outcome](../research/190-project-collection-updates.md) owns its
verification. Transcript rendering remains a separate consumer. [Collection-update evidence](../research/190-collection-query-updates.md)
records correctness, runtime checks and the bounded browser result; it does not
certify the full 50,000-session targets.

### Previous focus — bounded transcript ingestion

The SQL ownership slices below have landed. Stage 3 now shares acquisition and
serves Claude bounded windows from a compact source/branch index, extending
ordinary updates without rebuilding historical payload. The
[Claude index outcome](../research/190-claude-source-index.md) owns semantics,
review, parity and measurements. Durable profile-owned source facts and SQL
window queries now serve unchanged restart/eviction without reparsing source or
hydrating the history graph; [durable-index evidence](../research/190-claude-durable-index.md)
owns that slice. The [SQL writer outcome](../research/190-claude-sql-writer.md)
now removes ordinary first-changed-read restoration and active graph retention.
First construction still streams source; exceptional branch/rewind selection and
full qualification remain open.
Full active-tab qualification and incremental transcript delivery/rendering remain
open. Native project aggregation and oversized complete consumers still have
population work.

### Previous focus — SQL-owned catalog and bounded working set

Research: [cold session ownership and query boundaries](../research/190-cold-session-ownership.md).
The selected focus spans original steps 4 and 5: neither removing resident
objects alone nor paging only the visible rows resolves the current design.
Lists also need population statistics, unread state, identity and overlays;
catalog writers and secondary projections currently expect all rows in RAM.

Why first: this foundation serves Inbox, sidebar/global/project lists,
catalog publication, startup and cold-session memory across providers. It
also gives later client deltas one authoritative source. It does not solve
large-transcript ingestion, which remains the next required workstream.
The isolated source/retention audit found the largest tested cold owner:
200 project-scoped Codex readers each mirror the 25,000-session Codex tree in
two maps. At 50,000 mixed sessions, ordered destructive release freed
502.6 MiB from reader maps versus 91.2 MiB from the published catalog.
These are diagnostic release observations, not implementation savings or an
exact additive decomposition of the original baseline.

Research and implementation checkpoints, in dependency order:

1. Attribute retained memory and startup/query work on isolated worlds:
   catalog, metadata, provider indexes, project projections and transient
   list construction. Vary cold-session count separately from metadata size
   and active transcript size. Record unexplained residuals.
2. Specify the smallest SQL query/update boundary that preserves existing
   identity, filters, ordering, aggregates, unread and live-overlay semantics.
   Prefer existing tables/joins; add a maintained projection only where
   measured query work or missing facts require one. Name each writer and
   transaction boundary. Do not substitute a SQL full scan for a JS full scan
   and call the request bounded.
3. First implementation slice, selected by the diagnostic: put Codex
   discovered-file and rollout-path lookup under the existing root-scope
   owner; project readers use scoped views, without whole-tree mirrors.
   Preserve source precedence, exact observations, watcher epochs,
   active-window scopes, lineage and independent reader retirement. The
   research note specifies the boundary and verification gate.
4. Build the SQL-backed seen-state and shared list/Inbox query foundation,
   including statistics/project options that currently force the population
   walk. The query consumer is implemented with a rebuildable TEMP index;
   canonical seen durability and bounded metadata reads are now implemented;
   safe checkpoint restoration is implemented (invalidated checkpoints rebuild).
5. Replace changed-file whole-generation construction and remaining
   whole-catalog consumers with point, paged or change queries; include
   optional question enrichment and per-session project membership mirrors.
   Known changed files, question/activity lookups and production project
   membership ownership are now migrated; complete consumers remain explicit.
6. Remove eager metadata/catalog loading only after those consumers are
   migrated. Metadata is now bounded, including negative lookups and pinned
   failed/deleted mutations; the native catalog now retains only a bounded
   point cache.
7. Qualify list/Inbox parity, changed-row work, restart and retained memory
   at scale on Node and Bun. Record what remains in other stages instead of
   claiming all plan targets are met.

Research checkpoint, 2026-11-10: the source audit, four isolated scale/project
configurations, paired metadata restarts and SQL query-shape probes are
recorded in the research/evidence. At 5,000 sessions, changing 200 projects to
20 reduces the reader-map release from 59.0 to 5.9 MiB. This selects
checkpoint 3 before the formerly provisional seen-state migration. Heap
sampling/inspector release and incomplete Darwin eligibility make these
**diagnostic-only** figures; no plan target is newly met. The next runtime
commit must prove shared ownership while preserving existing reader behavior,
then measure a functioning server. Full SQL-list design remains a later gate.


### Shared Codex discovery ownership — implementation outcome

The selected first slice is implemented: project readers share discovered
session/rollout locators with the existing source-root cache instead of
retaining complete copies. Shared enumeration versions and visibility views
also avoid per-project initial hydration. Source invalidation, exact point
observations, filtered coverage, sibling retirement and authoritative deletion
are protected by real-file/interleaving checks. No public API, provider
format, SDK, SQL or client change is required.

Two interleaved fresh-world comparisons at 50,000 mixed idle sessions / 200
projects, no browser or long transcript open, reduce post-list retained heap
from 715.2/715.1 MiB to 217.5/217.3 MiB. RSS falls from 1,124.9/1,136.1 MiB
to 613.8/632.0 MiB. A census finds one root owner with 25,000 session and
25,000 path entries, and no complete locator maps in 200 project readers.
These are functioning-server samples, not destructive release estimates.

[Research outcome and evidence](../research/190-cold-session-ownership.md#shared-discovery-implementation-outcome)
own the protocol, hashes, native host evidence and limitations. The host is
contended, suite Darwin CPU/swap evidence is incomplete, and no latency/CPU
ratchet or full active-tab target is passed here. RSS still exceeds the plan's
approximate 300 MB memory goal. The focused checks pass 97 cases (two platform
skips). Four original ownership cases fail on the old reader; ten review
regressions fail on the respective earlier revisions. Full checks and review
are recorded in the research outcome.

### Retained SQL collection queries — implementation outcome

Retained lists and Inbox now share a provider-independent SQL query owner.
It applies filters/grants and limits before JSON hydration, maintains grouped
counts, and consumes catalog/metadata/creation/seen changes by session key.
The old retained full-walk implementation is removed. This is a derived TEMP
working index, not a second durable authority or a main schema migration.

[Research and evidence](../research/190-sql-collection-queries.md) record the
50,000-row route comparison, cold-build cost, runtime checks and review.
Warm list/Inbox queries no longer call metadata getters for the cold corpus.
The first read still constructs a population-sized projection; optional
substring search and large timestamp ties have additional documented costs.
Legacy unstable identities retain revalidation. No full scenario target is
newly certified by this isolated query diagnostic.

Canonical seen-state persistence and lazy metadata are now implemented below.
SQL-owned catalog publication and safe query checkpoint restoration follow
below. They address native residency and repeated first-list reconstruction.
Long-transcript bounded ingestion remains required; the shared ingestion slice
below is implemented, while Claude bounded projection remains open.

### Canonical cold state in SQL — implementation outcome

Seen state now commits one SQL row instead of rewriting `notifications.json`,
with atomic one-time import and commit-before-publication semantics. Metadata
startup and feature queries no longer require the resident corpus; clean
objects/misses are bounded and failed mutations/tombstones remain pinned.
Initial/changed collection construction consumes bounded metadata snapshots.

[Cold-state evidence](../research/190-cold-state-sql.md) owns the service-only
restart, full-traversal residency, seen-write measurements and review/checks.
The next slice adds transactional canonical revisions and recoverable derived
checkpoints below. Long-session readers remain open. No full
active-tab target is certified by the isolated cold-state diagnostic.

### SQL catalog ownership and query restoration — implementation outcome

Native catalog rows now stay in SQL, with a bounded parsed point cache. Changed
files publish explicit row/removal deltas; optional question enrichment and
creation/activity lookups no longer read the whole accepted generation. Native
project views retain SQL aggregates rather than per-session membership maps.
Derived list/Inbox checkpoints restore only at a compatible canonical revision;
transactional invalidation, owner fencing and live-overlay refresh protect
restart parity. Canonical changes while the query owner is absent conservatively
force a rebuild. This avoids a second authority or unsafe saved-response cache.

[Catalog ownership evidence](../research/190-catalog-sql-ownership.md) owns the
isolated residency, write, restoration and review/check results. Full SQL restore
and eligible-project aggregation still scale with their SQL populations. Other
complete consumers, unknown-file classification, long transcripts and client
change delivery remain open. No full active-tab target is certified here.

### Shared transcript acquisition — implementation outcome

Both plain-provider readers now use one chunked, byte-position-preserving JSONL
framer. Their existing reader caches own decoded rows, with source-byte budgets
and a 128-file cap. Valid unterminated records remain provisional and replay
before commitment; append reads validate the prior accepted source around
acquisition. Invalidated Claude waiters retry the current owner on success or
failure. Summary projections are shared per Claude parse version and context.
No transcript format, public API, protocol capability or client behavior changes.

The Codex baseline was caused by route dispatch, not an inherently failing
window reader: a Claude-default project stripped the actual Codex cursor/window
intent. Cursor selection now uses the resolved provider at the reader boundary.
The isolated real-reader/Hono diagnostic reduces median cursor update wall
time at 488 MB from 1,249.54 to 2.15 ms; the new 49 MB case is 2.63 ms.
Warm replay matches fresh full rebuilds at three cuts on real 81 MB Claude
and 112 MB Codex copies. Protocol, hashes, checks and qualifications are in
[the evidence](../research/190-transcript-ingestion.md). These do not qualify
the full active-tab targets; Claude above-budget reads and branch normalization,
old-anchor complete fallbacks, client reloads and polling remain open.

### Claude source index — implementation outcome

The existing cache owns a compact metadata/compaction index plus the decoded
logical window, preserving full-source branch, queue/turn, task, rewind and
historical harness semantics. Ordinary tip extensions and fresh queue delivery
extend projections; exceptional changes reuse the existing metadata selector.
Acquisition mode, source/projection generation, provisional retention and
hydration are fenced. Public message/pagination shape and full counts remain.

[Implementation/evidence](../research/190-claude-source-index.md) records median
cursor updates of 25.74 → 1.50 ms at 20 compactions and 2,127.28 → 1.46 ms at
200, plus real-copy full-rebuild parity. First detail regresses from 2.35 to
2.93 seconds at 200 because it builds the index. Indexed metadata retains
225.8 MiB heap versus 43.2 MiB after the old uncached reader's GC, while RSS
falls from 1,448.8 to 596.1 MiB after repeated updates. These are isolated
diagnostics, not full target qualification. The first
unseen-source index build still streams history, restart/eviction repeats it,
and metadata itself remains O(history) under the budget. These costs keep
original step 2 and cold-open/memory targets open; client reload/poll/render
costs are unchanged. No full-scenario target is newly certified here.

### Durable Claude source facts — implementation outcome

The app now owns one profile-scoped transcript cache/writer backed by the required
SQLite database. Persisted compact source facts and visible positions answer
unchanged cold window queries without hydrating the complete history graph.
Accepted source probes, generation/revision and cache ownership fence restoration,
hydration and publication. Ordinary warm writes update changed rows; replacement
projections stage bounded leased batches. Cleanup protects accepted generations
and live peer builds, with bounded expired-stage recovery on source acquisition.
Historical harness evidence keeps original row slots through bounded SQL lookups.

[Implementation/evidence](../research/190-claude-durable-index.md) records real-copy
warm/restored parity, Node/Bun checks and isolated restart diagnostics: at 200
compactions, unchanged reader reopen falls 2,861.73 → 71.09 ms and post-GC heap
198.44 → 14.81 MiB. First
construction still requires a full source stream and costs more to persist the
index (2.86 → 5.03 seconds at 200). The first write after restart reconstructs
complete compact metadata from SQL (2.21 seconds at 200); subsequent writes reuse
the incremental graph (remaining-seven median 1.33 ms versus 0.47 ms before). That history-dependent writer
restoration and active metadata residency were the next boundary; the SQL writer
slice below removes them for ordinary appends. Full scenario qualification remains
open. No original target is newly certified by component diagnostics.

### SQL-owned Claude append state — implementation outcome

The profile-owned SQL index now owns ordinary incremental branch/tool/queue/task
facts. The first append after restart and subsequent ordinary appends no longer
restore or retain the complete historical graph. Native payload stays in its
source file; the original decoder, selector, summary witnesses and task reducer
preserve existing output. Provisional rows overlay the same window selector;
complete prefix lines alone advance SQL. Branch/open-rewind/unsupported facts
still use the original complete metadata selector, publishing a fresh fenced,
leased generation before releasing its graph. Existing writerless checkpoints
bootstrap facts lazily, with no startup backfill or new watcher.

[Implementation/evidence](../research/190-claude-sql-writer.md) records the final
profiler-off interleave versus `a6ac5ab5d`, both in durable mode:

| Component diagnostic | 20 compactions, before → after | 200 compactions, before → after |
|---|---:|---:|
| First append after restart | 103.80 → 3.44 ms | 2,217.23 → 3.52 ms |
| Remaining seven appends, median | 1.38 → 1.52 ms | 1.40 → 1.58 ms |
| Active post-GC heap | 34.11 → 15.28 MiB | 199.99 → 15.29 MiB |
| Unchanged reopen | 24.35 → 19.91 ms | 70.75 → 20.58 ms |
| First unseen-source construction | 360.02 → 404.30 ms | 4,692.76 → 5,557.73 ms |

A measured generation-only compaction lookup scan was removed by requiring the
existing ordinal index; an actual-query-plan regression protects the seek.
Real-copy warm/restored output matches full rebuilds at three committed prefixes.
Sol 6.1 high/bypass review reports no remaining findings after verified fixes;
final server/client, root/workspace, Node/Bun SQLite and source checks pass.
Initial construction, exceptional metadata work, semantic task population cost,
disk retention and full host/browser qualification remain open. These isolated
reader/SQL measurements do not certify the original CPU or full scenario targets.

## Scenario

One host, one YA server, one browser tab open on the active session. It is
built by `scripts/perf-repro/active-session.mjs` (synthetic world, the
default) with the transcript shapes in
`scripts/perf-repro/scenario-transcripts.mjs`.

- **50,000 idle sessions, half Claude and half Codex.** 25,000 Claude
  transcripts and 25,000 Codex rollouts (date directories, as Codex writes
  them), spread over 200 projects and the past year, each 2–6 turns of a few
  KB. Codex rollouts map to the same projects through their `cwd`. Beside
  them sits Codex's thread index (`state_5.sqlite`, reduced to the columns YA
  reads), as on a host where Codex runs; `--codex-index false` models a host
  without one. Nothing writes to them during a run.
- **One very long, active session**, run once as Claude and once as Codex:
  200 compactions of history. On the maintainer's host a Claude session holds
  about 2.3 MB of transcript per compaction (this session: 30 MB, 13
  compactions), so the generated session is about 470 MB and 170,000 lines.
  Turns are agent-shaped: prompt, tool call, tool result, Markdown answer.
  The generators follow current provider output (Claude Code 2.1.3xx:
  assistant messages split over rows with thinking blocks, metadata rows and
  attachments; Codex 0.16x: `item_completed` items beside response items,
  `custom_tool_call`, token records, `compacted` items with window ids).
  Generated: Claude 465 MB and 176,832 lines (55 turns per compaction);
  Codex 488 MB and 151,979 lines (42 turns per compaction). Real sessions on
  the maintainer's host hold more per compaction (Claude: 81 MB over 8
  compactions; Codex: 512 MB and 53,000 lines over 66), so the scenario is
  conservative in bytes per compaction; its rows are smaller than Codex's
  real ones (about 3 KB against 10 KB), so per-row costs weigh a little more.
- **Writes:** one write a second to the long session (a few rows each, as a
  provider appends during a turn), and a compaction every 300 writes, taken
  between turns; the first is due half way, so the active phase crosses one.
  The history ends part way between compactions. For Codex the thread index
  row is bumped at most every five seconds, as Codex does.
- **Runs:** an idle phase (nothing written) and an active phase, three
  minutes each after 20 s of warm-up writes; then each list route timed
  alone; a server restart with nothing changed and no tab open; and a cold
  open of the long session in a new tab on the restarted server. The harness
  waits for the server to settle between phases.

## Targets

Measured on an Apple Silicon laptop, one tab, one write a second. Per-write
figures are a phase's total divided by its writes.

| Measure | Target |
|---|---|
| Server main-thread CPU per write | ≤ 5 ms, flat in session count and history length |
| Server process CPU per write (GC and workers included) | ≤ 15 ms, so ≤ 1.5% of a core |
| Each further open tab | ≤ 1 ms more per write |
| Event-loop delay, p99 | ≤ 50 ms |
| Idle phase | about 0 CPU; no periodic work that grows with session count |
| Requests per write per tab | no list reloads; one pushed change of a few KB, or one small incremental fetch |
| Tab work per write | ≤ 5 ms of rendering, ≤ 1% of a core |
| Write to visible in the open tab | ≤ 250 ms p95; typing unaffected (each keystroke within 100 ms, `AGENTS.md`) |
| Cold open of the long session | ≤ 300 ms of server time to first paint, flat in history length |
| A list page or Inbox | ≤ 10 ms of server time, paged |
| Server memory, 50,000 idle sessions | ≤ about 300 MB; the long session never held whole |
| Restart with nothing changed | lists usable within about 1 s; nothing rescanned |

The repro attaches the inspector for CPU, memory and event-loop probes; its
1 ms CPU profiler is opt-in (`--cpu-profile`) and off when targets are
checked. Write-to-visible is measured from the append to the moment the
write's marker appears in the tab's DOM.

## Where it stands

Project-facts checkpoint, 2026-11-11: ordinary known Claude/Codex modifications
now update source-owned compact project facts; points use indexed identities.
Fresh full-fixture before → after main CPU is 118.7 → 68.6 / 163.3 → 91.2
ms/write, process 275.3 → 83.9 / 337.2 → 151.1. These remain above 5/15 ms
targets. Collection bytes stay 99–100 KiB/write; tab work is 72.4/75.3 ms/write.
Loop p99 is 13.8/14.9 ms; typing maxima 26.44/23.03 ms, all visible markers
received. The [project outcome](../research/190-project-discovery-facts.md) owns
freshness/parity, bounds, controls, host/runtime identity and qualifications.
These active-only observations do not replace the cold/restart/idle evidence
below or certify all-write flatness. Structural/ambiguous discovery remains.

Combined checkpoint, 2026-11-11 (`be7b474c3` runtime): Claude/Codex main CPU is
127.7/169.7 ms per write (target 5), process 298.4/351.5 (15), browser task
65.8/68.1 (5); loop p99 19.6/24.6 ms (50). List reloads are zero, but live
collection bytes are 99/100 KiB per write and detail fetches 1.97/write.
Warm list/Inbox loopback medians are below 10 ms; sequential typing maxima are
26.71/25.41 ms with exact prefixes. First cold detail server clocks are
415.5/872.3 ms (300); restart lists complete in 1.404/1.416 s (~1 s).
After opening the long tab, no-write RSS is 711/780 MiB; before reopening
post-restart it is 291/289 MiB. These are different lifecycle states, not
proof of the idle-only memory ceiling. Codex preview still reads the whole
~495 MB rollout. Full results, controls, limitations and build/host evidence
are in the [qualification](../research/190-combined-scale-qualification.md).
The historical baseline below remains unchanged; no all-target claim is made.

Project extension checkpoint, 2026-11-11: bounded Projects and ProjectQueue now
share the same source/auth-scoped query stream and server-owned queue wake.
A three-page real browser checks caption and queue edits, Inbox and transcript
freshness during native writes and sequential typing. Full combined-scale target
acceptance remains pending; native SQL project aggregation remains population work.

Stage 4 checkpoint, 2026-11-11: bounded session feeds and Inbox now consume
server-owned query changes. A real two-page browser scenario with 401 sessions
sharing a timestamp, native writes and 25 sequential keystrokes makes zero
session/Inbox GETs during typing on both Node and Bun; Inbox changes are asserted.
The full combined-scale baseline below remains unchanged pending qualification.


Architecture checkpoint, 2026-11-10: the source audit and isolated retention
experiments select shared Codex discovery ownership as the first foundation
slice (above). The 50,000-session no-detail case retained 715.2 MiB after
lists; releasing duplicated reader maps freed 502.6 MiB. See the research
for project-count controls, metadata-size variation and SQL plans. These are
diagnostic attribution measurements. The shared-root implementation outcome
above records functioning-server memory comparisons and qualification; it
removes the project × session map multiplier. No full active-tab target is
passed. All original baseline figures below remain unchanged.

The second foundation slice replaces retained list/Inbox full walks with
SQL page/tier/count queries; its outcome and cold/legacy qualifications are
above. The original end-to-end baseline is retained until a full scenario run
qualifies the combined architecture.

The third foundation slice removes canonical metadata/seen corpus mirrors and
uses per-row seen commits. Its isolated service-restart/memory evidence is in
[the cold-state outcome](../research/190-cold-state-sql.md). Native catalog
residency and derived query reconstruction remain; these component figures do
not replace the full active-tab baseline below.

Stage 3 now shares plain transcript acquisition and repairs Codex cursor/window
dispatch after actual provider resolution. Component detail-path and real-copy
parity evidence is in [the ingestion outcome](../research/190-transcript-ingestion.md).
Claude warm projection and unchanged SQL restoration are now implemented;
ordinary append state is now SQL-owned without a resident history graph. First
construction and exceptional metadata selection remain open. These
component results do not replace the original full-scenario target table below.
The current SQL writer outcome above records the history-independent ordinary
append comparison (3.44 / 3.52 ms at 20 / 200 compactions, about 15.3 MiB active
heap); first construction and exceptional paths remain separately qualified.

Baseline measured 2026-11-10 with the repro on the maintainer's host (Apple
Silicon): production builds of server and client code as of `f196db4c7`,
profiler off, Codex thread index present. Runs `base2-claude` and
`base2-codex` (labels in the harness's results directory, each with its
arguments); the idle attributions come from shorter runs named below.

| Measure | Target | Claude | Codex |
|---|---|---|---|
| Main-thread CPU per write¹ | ≤ 5 ms | 991 ms | 970 ms |
| Process CPU per write¹ | ≤ 15 ms | 1,456 ms (146% of a core) | 1,314 ms (131%) |
| One incremental detail request, alone² | | 3.2 s (read 2.1 s, normalize 1.0 s) | 2.1 s (read 1.4 s, normalize 0.6 s) |
| Event-loop delay p99 (max), active | ≤ 50 ms | 2,067 ms (2.9 s) | 236 ms (0.9 s) |
| Idle phase | about 0 | 2.0% of a core | 1.1% |
| List reloads per write per tab | none | 1.4 (252 in 180 writes) | 3.7 (672) |
| Tab task time per write | ≤ 5 ms | 24.6 ms | 52.6 ms |
| Write to visible, p50 / p95 | p95 ≤ 250 ms | 5.0 s / 6.8 s | 3.4 s / 4.9 s |
| Cold open after restart, to the last turn shown | ≤ 300 ms | 5.1 s, 13.1 s CPU | 2.2 s, 6.2 s CPU |
| A list page or Inbox, alone | ≤ 10 ms | 170–215 ms | 167–214 ms |
| Server memory, idle | ≤ ~300 MB | 724 MB heap, 1.2 GB RSS | 760 MB heap, 1.3 GB RSS |
| Server memory, active | the long session never held whole | 1.3 GB heap, 5.8 GB RSS | 1.9 GB heap, 3.5 GB RSS |
| Restart: lists usable | ≤ ~1 s, nothing rescanned | 1.8 s; 9.0 s CPU to 30 s after | 1.4 s; 8.7 s CPU |

¹ The server was saturated at one write a second for both providers, so the
per-write figures are a ceiling set by the write rate (a busy main thread is
about 1,000 ms per second), not the cost of a write; work queued behind
earlier writes. Each write's own cost is better read from the request
timings in the next row and the list timings below.
² Medians of the `SESSION_DETAIL` timings in the server log over the active
phase (61 Claude and 87 Codex requests).

- **Claude: the 192 MB cliff is confirmed.** The 465 MB transcript is never
  cached (`claude_transcript_cache_uncached`, `retainedFiles: 0`), so every
  incremental detail request (`afterMessageId`) rereads the whole file
  (2.1 s) and normalizes all of it (about 100,000 messages, 1.0 s) before
  slicing; under contention one took 5.3 s. A cold open's tail-window
  request does the same before windowing (4.3 s).
- **Codex: a tab's updates are not windowed either.** The tab's incremental
  requests carry the default `tailCompactions` and a summary hint
  (`bound-session-reader.ts`), yet each one read the whole rollout (1.4 s)
  and normalized all of it (about 59,000 messages, 0.6 s): the windowed
  incremental read (`readIncrementalSnapshot`, `codex-reader.ts`) fell back.
  The baseline attribution was incomplete: stage 3 subsequently found route
  dispatch stripped the Codex cursor/window in Claude-default projects,
  before the window helper could be selected. The generated rollouts follow
  the current format and compact only between turns. The cold open's tail-window request read
  the window only, but the open also issued a whole-file incremental request
  and a preview refresh (about 1.5 s each). So Codex needs step 2 as well.
- **Lists.** A list page or Inbox costs 167–215 ms of server time alone at
  50,000 sessions (a walk over every row), and each write still reloads the
  six list routes for the tab.
- **Idle.** With Codex's thread index, a quiet server spends 1–2% of a core.
  Most of it is the server's own stall recorder
  (`logging/stall-recording.ts`, started by the resource sampler): it keeps
  a 10 ms CPU profiler running and stops and restarts it every 30 s. With
  the sampler off (`YEP_RESOURCE_SAMPLE_SECONDS=0`, which also stops its
  100 ms tick) idle fell from 2.9 s to 0.9 s per two minutes (runs
  `idle-stallon`, `idle-stalloff`), and the 220–235 ms idle event-loop
  maximum, once per rotation, went away (12 ms). A 1 ms CPU profile of an
  idle server (`base-idle-profile`) put about 240 ms of main thread on each
  rotation's `Profiler.stop`. Without the thread index the periodic Codex
  rescan stats all 25,000 rollouts every five seconds and never backs off
  (110–195 ms a pass, under its slow threshold): 14.9 s per three minutes,
  8.3% of a core (run `base-claude`); with the index it is a full rescan
  every ten minutes.
- **Memory.** 50,000 idle sessions hold 720–760 MB of heap; an active long
  session takes the heap to 1.3–1.9 GB and RSS to 3.5–5.8 GB.
- **Restart.** With no tab open, lists answer 1.4–1.8 s after start, and the
  server spends about 9 s of CPU from start to 30 s after that, with nothing
  changed; not yet attributed.

## Steps

### 1 — the scenario and a baseline

- Extend the repro's synthetic world to the scenario: Codex rollouts (date
  directories, `session_meta` with `cwd`, `compacted` items), the 50/50 mix,
  the long session per provider with 200 compactions, the write rate and
  compactions during the run, the idle phase, cold open and restart, and a
  profiler-off mode.
- Record per-write metrics: main-thread and process CPU, event-loop delay
  (p50/p99/max), requests and bytes per write per tab, tab task time per
  write, write-to-visible latency, server and tab memory.
- Record the baseline here for both providers. Gate: the numbers above are
  measured, not scaled, and the 192 MB cliff is confirmed or refuted.

Done 2026-11-10: the harness runs the scenario (phases `idle`, `active`,
`lists`, `restart`, `open`; `--cpu-profile` opt-in; `--env` for server
settings; `--codex-index false`), and the baseline is in
[Where it stands](#where-it-stands). The cliff is confirmed, and a Codex
tab's updates were found to read the whole rollout too, so step 2 covers
both providers. Costs the plan had not listed get step 8: the stall
recorder's rotations, the Codex rescan without a thread index, and the CPU
after a restart.

### 2 — read a long session incrementally

Agreed as required. Shared acquisition, Codex dispatch and indexed Claude warm windows are
implemented, including durable SQL facts and bounded unchanged-source windows.
SQL-owned ordinary append state is also implemented. First construction,
exceptional metadata projection and full-host qualification remain open.
The original measured baseline below remains historical evidence:


- Keep an index of compaction boundaries per transcript, so a cold open and
  the first detail read start at the requested tail window, never at byte 0.
- Parse only appended bytes, extending the active branch, the visible
  entries and the normalized messages as lines arrive, so an incremental
  detail request costs what was appended. Sharing one summary per parse
  version removes the second rebuild per write.
- Hold only the tail window and the incremental state in memory; a
  transcript larger than the parse budget is no longer reread whole.
- Keep the existing guarantees: branch selection and rewinds, dead-branch
  rendering (`topics/claude.md`), provisional tails, incremental anchors not
  found (full catch-up), and the session-detail response shape.
- Codex: first establish why `readIncrementalSnapshot` falls back for a
  tab's updates (baseline); then an incremental request reads from the last
  served position (or the window's start) instead of the whole rollout, and
  the open's preview refresh does not reread it either.

### 3 — send changes to tabs

Bounded session/Inbox implementation is complete for the new
`collection-query-updates` capability, with exact memberships/counts and bounded
replacement catch-up. See the [outcome](../research/190-collection-query-updates.md).
Projects and ProjectQueue are now implemented under the separate extension
capability. Incremental transcript rendering remains open.


Plan 189 step 8: a write sends the changed row, and the feeds, Inbox and
their counts update from it. Needs a capability; full reload kept for older
clients.

### 4 — answer lists and counts from SQL

Unread state and the list fields in tables
([SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md) items 8 and 11), so
list pages and stats are indexed queries, and then stop holding the whole
catalog in memory (item 12). The retained query consumer is now implemented
with keyed updates and derived SQL counts. Canonical seen-state and bounded
metadata reads are implemented. Native catalog rows now remain in SQL with a
bounded parsed point cache. Compatible completed query checkpoints restore
without cold JS normalization; invalidated checkpoints rebuild. SQL import /
indexing and remaining complete consumers still have population work. Native
Claude/Codex project facts now have a compact SQL owner and indexed points;
structural discovery and other-provider SQL aggregates remain explicit. See the
implementation outcomes.

### 5 — update the catalog from the changed file

A publication reads and writes only the changed file's row, instead of
adapters yielding every row
([remaining catalog costs](../../gaps/session-catalog-rewrites-whole-generation-per-change.md)).
Known changed files now use indexed lookups and explicit upserts/removals.
Unrecognized new-file membership still falls back to discovery. Known
Claude/Codex file modifications now update only their accepted project activity,
avoiding native regrouping around detail reads. Structural/ambiguous binding,
replacements/truncation and path elections retain full discovery. No full
watcher-to-tab target is certified by these slices.

### 6 — render the open session incrementally in the tab

A write renders the new rows only.

### 7 — a ratcheted perf-suite scenario

2026-11-11 outcome: the separate repro now retains host/build/harness evidence,
open-stream byte accounting, numeric target checks, sequential typing and an
extra-tab phase. Its fast evidence-integrity tests run in the root test command.
The [combined fixture and controls](../research/190-combined-scale-qualification.md)
are recorded; failing ceilings are not loosened. This is a numeric-subset guard,
not completion of suite integration, repeated same-capacity ratchets or the
qualitative gates. Stage 5/full acceptance remains open.

Move the scenario into the [performance regression
suite](../../topics/performance-regression-suite.md) with ratchets on main-
thread and process CPU per write, p99 event-loop delay, requests and bytes
per write per tab, tab time per write and cold open. Per-write ratchets keep
the gate independent of the host's speed; each step above should bring one
metric under its target and tighten its ratchet.

### 8 — a quiet host costs nothing

Found by the baseline; independent of steps 2–7.

- The stall recorder (`logging/stall-recording.ts`) keeps its evidence
  without paying about 240 ms of main thread, and a 220–235 ms event-loop
  delay, every 30 s: for example a sampling interval and rotation whose cost
  does not grow with the heap, or no rotation while nothing stalls. It must
  still hold the stacks from before a stall
  ([server performance observability](../../topics/server-performance-observability.md)).
- Without Codex's thread index, the periodic Codex rescan backs off while
  nothing changes, instead of statting every rollout every five seconds.
  The tradeoff: after a quiet spell such a host notices a Codex write later,
  up to the backed-off interval, unless a file event arrives first.
- Restart with nothing changed: attribute the 9 s of CPU from start to 30 s
  after the lists are usable (no tab open), and keep it from growing with
  session count or history length.

## Review gates

- Step 1: the baseline recorded here, with the scenario reviewed for
  realism against real Claude and Codex transcripts.
- Step 2: the session-page parity checks above, on the repro and on copies of
  real long sessions, and per-write cost flat between a 20- and a
  200-compaction session.
- Steps 3–6: each measured against its target on the scenario before and
  after.

## Risks

- **Correctness of incremental branch selection.** The active tip is chosen
  timestamp-first over the whole forest, and late writes can re-parent
  (`topics/claude.md`, falsely dead segments). An incremental structure must
  give the same answer as a full rebuild; test against full rebuilds on real
  transcripts.
- **Generated transcripts are not provider output.** The synthetic sessions
  follow the formats YA reads, not everything providers write; step 1's
  review compares them with real ones.
- **Host noise.** Figures move with load from other work on the host; compare
  builds interleaved on fresh worlds, and gate on per-write ratios.

## Open questions

- Whether the Codex window's normalization per request already meets the
  target once measured, or needs the same incremental treatment. Answered by
  the baseline initially showed whole-rollout updates. The stage 3 slice
  fixes actual-provider dispatch and measures bounded Codex catch-up; full
  active-tab CPU qualification and complete-fallback costs remain open.
- How many compactions a tail window should hold by default once opening is
  flat in history length.
