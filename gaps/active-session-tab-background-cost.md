# Active session updates still do unnecessary work

The [isolated frontend calibration](../docs/research/190-frontend-renderer-calibration.md)
now separates real store/renderer/composer responsiveness from provider/backend
and aggregate browser CPU costs. Completed-turn appends compare transcript-only
and full-page views at three history sizes; exact native key prefixes, frame
gaps, long tasks and visible markers have independent observations and a stall
negative control. This is measurement infrastructure. Production optimization,
streaming/burst/scroll controls and end-to-end qualification remain open.
Final normal runs observe all 216 appends / 1,292 exact key prefixes (max 19.6 ms),
frame p95 10.3 ms / max 29.3 ms and no 50 ms long tasks. The 1,000-turn full-page
first append can still take 271.6–278.1 ms to become visible; trace that scheduling
boundary before interpreting aggregate browser CPU as a frame problem.

Original finding, 2026-11-10: a browser tab showing a session whose transcript is being written costs the
server about 15–19% of one core and the tab itself 5–12%, for as long as the
session runs (measured with the inspector and a 1 ms CPU profiler attached,
which add a little). Every transcript write publishes a catalog generation,
and each generation makes the tab refetch six whole-catalog lists and the
session detail, which rereads the whole transcript. The fixes made on
2026-11-10 (a draft-index request storm, shared list walks, per-row lookups
after each publication) are in that day's commit; this file lists what
remains.

[Plan 190](../docs/tactical/190-active-session-cost-at-scale.md) sets the
target state for this at 50,000 sessions and a 200-compaction session, and
orders the work below into steps.

Priority update, 2026-11-10: the maintainer selected architecture-led stages
in plan 190, focusing first on the SQL-owned catalog and bounded session
working set. The [source audit](../docs/research/190-cold-session-ownership.md)
connects list/Inbox queries, metadata retention, changed-file publication and
secondary projections. Isolated diagnostics now find project-scoped Codex
reader maps are the dominant tested cold owner: 200 readers each mirror all
25,000 Codex sessions in two maps; their destructive release freed 502.6 MiB
at 50,000 mixed sessions, versus 91.2 MiB for catalog release. Shared
root-scope discovery ownership is implemented first: project readers now
share one root locator index. Functioning-server before/after memory evidence
and review are recorded in the research outcome. This removes the measured
project × session multiplier; the catalog, Inbox/list and transcript costs
below remain open, and no full active-tab target is closed. A second slice now
replaces retained list/Inbox projection walks with a shared SQL query owner;
[query evidence](../docs/research/190-sql-collection-queries.md) records warm
query gains and the remaining first-build/legacy costs. Polling and catalog
publication still occur; client deltas remain separate work. Canonical seen
state and metadata are now SQL-owned with bounded residency;
[cold-state evidence](../docs/research/190-cold-state-sql.md) records this third
slice. The derived list projection still rebuilds after restart.

## Transcript fact follow-up — 2026-11-12

The [transcript outcome](../docs/research/190-transcript-fact-reuse.md) narrows
the earlier compiler hypothesis: sampled compiler work is about 5.55 ms/append
for Claude and 0.37 ms for Codex. The canonical web adapter now reuses intrinsic
tool-result decoding and lazy output facts across immutable snapshots and its
activity/display projections. Weak keys hold no row windows or history; pairing,
status, ordering and folds still rebuild from the complete current window,
preserving fresh-rebuild parity through rewind, compaction and replacement.

Active browser work falls 56.9→51.7 ms/append for Claude (9.1%), while Codex
59.2→58.7 is effectively unchanged; typing is 66.6→64.8 / 68.8→67.7. These are
single pairs, not statistical qualification. All 312 exact keys pass 100 ms and
all 716 sampled markers arrive. After visible p95 is 41–47 ms, with compaction
maxima 324/319 ms. Server and wire are held fixed; their targets remain open.
A separate final Claude profile cuts compiler work 5.56→0.62 ms/append
(88.9%); sampled React/app work barely changes. The 5 ms browser target remains
far away. Most common cost is React/app-shell/
store/layout; the next proposal is to attribute repeated notifications/commits
and narrow the existing shared publication/subscription boundary, preserving
server-authoritative membership and freshness/recovery fences. This is partial
step 6, not complete incremental rendering.

## Collection display follow-up — 2026-11-12

The [display outcome](../docs/research/190-collection-display-publication.md)
keeps every raw query revision/freshness fence while suppressing ordinary
bookkeeping publications that do not affect the selected display. Sidebar and
Inbox explicitly select initial-loading/error status; raw consumers preserve
background-refresh notifications. Consumer requirements share one conservative
union, with replacement on changes. No server protocol or session cache is added.

Active browser CPU falls 62.9→57.1 ms/append for Claude and 63.6→58.7 for Codex
(9.2% / 7.7%, one pair each), typing 73.2→65.8 / 72.2→67.5. All 312 keys pass
100 ms and all 716 sampled markers arrive. After visible p95 is 41–59 ms, with
compaction maxima 322/324 ms. Server/wire behavior is unchanged. A separate
30-append Claude diagnostic reduces message-list commit effects 202→172, while
transcript preprocessing remains once per append. “Catalog-only” frames include
refresh status, not merely a counter: the rejected counter-only trial did not
produce useful gains. The original 5 ms browser target and full acceptance stay
open. Next: attribute remaining shared transcript projection/preprocessing and
choose a bounded incremental slice with full-rebuild parity.

## Bounded navigation follow-up — 2026-11-12

The [navigation outcome](../docs/research/190-bounded-navigation-projection.md)
implements indexed known-ID selection, batched child enrichment, grouped queue
counts and capability-gated metadata field changes. On a fresh exact-current
baseline, Claude active process CPU drops 89.6→79.1 ms/append (two samples/build),
Codex 138.3→129.0 (one pair). Collection traffic drops about 97%, to 3.43/4.23 KiB
per append. Separate Claude diagnostics reduce SQL calls 651→257 and child
reads 404→12 per append; no per-session result cache is added.

Browser work does not improve: observed means are 55.9→58.6 / 59.1→61.7 ms.
Eight query frames still arrive per append; six carry catalog-only metadata
(including refresh status, clarified in the display follow-up above).
Both diagnostic builds record 202 message-list commit effects per 30 appends.
The subsequent display follow-up above implements this shared publication
boundary. The server remains authoritative for filters,
order and membership. Input and p95 visible/loop checks pass; CPU/render/full
wire acceptance and idle/restart/cold/memory/additional-tab targets stay open.
The statement ceiling remains unchanged; lazy relationship reads avoid unused
allocation and pass the existing native-publication integration.

## Current measurement checkpoint — 2026-11-12

[Current-cost regroup](../docs/research/190-current-cost-regroup.md) measures
`288b67493` with full fixtures, controls and separate attribution. Canonical-root
active CPU remains 87.4/135.5 ms/write and browser work 57.3/57.2 for Claude/Codex.
The old `/tmp` fixture's extra empty detail read comes from path-alias mismatch
against `/private/tmp`; canonical-root traces already suppress it. A portable
file-fact identity fix and fixture control remain appropriate, but two reads
are not universal behavior.

The shared navigation boundary has concrete remaining work: sparse queued-ID
selection chooses a timeline scan, selected-row child relationships still use
per-parent SQL, project-list queue counts repeat the same list/reconciliation,
and catalog-token changes resend unchanged project dictionaries (about 96% of
collection bytes). Profiles also identify closed navigation consumers and
transcript projection work. The recommendation is one bounded SQL projection
slice first, followed by display/freshness separation; no new optimization is
implemented or full target certified. The linked report owns current numbers,
Node/Bun access-plan probes, qualifications and proposed order.

## Previous combined checkpoint — 2026-11-11

[Combined qualification](../docs/research/190-combined-scale-qualification.md)
now records the full 50,000-session/200-compaction fixture on `be7b474c3`,
plus controls and separate profiles. The older figures below are historical.
List reload GETs are now zero; live collection streams still carry about
99–100 KiB/write and session detail is fetched 1.97 times/write. Main CPU is
127.7/169.7 ms/write and process CPU 298.4/351.5 for Claude/Codex, far above
5/15 ms targets. Browser task work is 65.8/68.1 ms/write. Loop p99, warm list
medians and sequential typing pass their observed ceilings.

Claude/Codex project discovery and point lookups now share source-owned compact
SQL facts. Ordinary known-file modifications update only affected project
activity; indexed points no longer regroup the native population or serialize
the code-name registry. The [project outcome](../docs/research/190-project-discovery-facts.md)
records native parity, watcher/registration freshness, scale measurements and
remaining structural/ambiguous discovery. This does not close all-write flatness.
Collection metadata replacement, duplicate detail requests and transcript
rendering remain broad shared consumers. A separate
[Codex preview defect](codex-preview-refresh-parses-whole-rollout.md) parses
roughly 495 MB on cold open despite bounded ordinary detail updates. Quiet-host,
restart, memory attribution and full acceptance remain open.

## How it was measured

`scripts/perf-repro/active-session.mjs` builds an isolated world, starts a
passive production server on it with the inspector, opens headless Chromium
on the session and appends to the transcript at a provider-like pace. It
records process and per-thread CPU, a main-thread CPU profile, every API
request the tab made and its WebSocket frames (header comment for usage).

- **Clone world:** copy-on-write clones of the maintainer's Claude and Codex
  stores (7,500 catalog rows) and profile; this session's own 30 MB
  transcript held back 15% and replayed at its recorded pace (85 writes in
  three minutes).
- **Synthetic world:** plan 190's scenario (the default): 50,000 idle
  sessions, half Claude and half Codex, and one 200-compaction session of
  about 470 MB written once a second, run as each provider. At that scale
  both providers saturate the server; the measured baseline is in the
  plan's "Where it stands". The figures below are from smaller worlds (3,000
  short Claude sessions and a 12,000-row session) unless stated.

## What it spends, largest first

1. **Claude ordinary reads/writes are SQL-owned; first construction and exceptional work remain.**
   Bounded windows and ordinary appends, including the first write after restart,
   use SQL facts without retaining the historical source graph. Native bytes
   remain authoritative, and the original selector/converter/task reducer preserve
   global IDs, turns, task state, rewinds and harness evidence.
   [SQL writer evidence](../docs/research/190-claude-sql-writer.md) follows the
   earlier [warm index](../docs/research/190-claude-source-index.md) and
   [durable cold windows](../docs/research/190-claude-durable-index.md).
   Unseen-source construction, old-checkpoint writer bootstrap, branch/open-rewind
   fallback, ambiguous/historical queue delivery and complete/oversized catch-up
   can still revisit history. Semantic task state can grow with tasks, with an
   8,388,608-character SQL read cap. Full cold-open/memory qualification remains open. Codex's
   former whole-rollout updates in Claude-default projects were fixed by
   resolved-provider dispatch; [shared ingestion evidence](../docs/research/190-transcript-ingestion.md)
   records that earlier slice. No full active-tab target is closed here.
2. **Bounded views have authoritative SQL ownership.** The sidebar now favors
   cheap SQL-backed reads of its recent/starred/categorized windows. A single
   aggregate GET is implemented, but browser cutover is deferred after a CPU
   regression; current transport remains, and pointer/focus holds are removed;
   [sidebar evidence](../docs/research/190-sidebar-snapshot.md) records this slice.
   Inbox and other session feeds retain the source-owned capability-gated stream,
   carrying changed rows and exact membership/count updates.
   Real browser coverage proves native Inbox changes and zero list/Inbox GETs
   during sequential typing on Node and Bun. [Evidence](../docs/research/190-collection-query-updates.md)
   records that first slice. Bounded `/api/projects` and `/api/project-queue`
   now share the same update owner under a separate capability, including live
   queue deadlines; [project extension evidence](../docs/research/190-project-collection-updates.md)
   records that follow-up. Complete search and oversized collections keep
   existing reads. Native project aggregation and full combined scenario
   qualification remain open.
3. **Known changed-file publication is now scoped.** The former complete
   generation walk and retained native catalog mirror are removed. Unknown
   new-file membership, complete consumers and project SQL aggregation still
   have population work ([remaining catalog costs](session-catalog-rewrites-whole-generation-per-change.md)).
4. **Other threads take a third or more of the server's CPU** (12–14 s per
   three minutes of 27–41 s in total, unchanged by those fixes),
   probably V8's garbage-collection and compiler helpers (not attributed
   yet): the walks and the whole-transcript rebuilds above allocate per write.
5. **The tab itself** spends 5% of a core (clone world) to 12% (synthetic) in
   React rendering on each write.
6. **Opening a long session** takes 0.8–1.5 s, nearly all waiting on the
   Markdown/highlight worker (`augmentMs`); the main thread is idle meanwhile.

7. **A quiet server still profiles itself.** The stall recorder
   (`logging/stall-recording.ts`) runs a 10 ms CPU profiler and stops and
   restarts it every 30 s: about 240 ms of main thread and a 220–235 ms
   event-loop delay per rotation; with the resource sampler off an idle
   server's CPU fell by two thirds (plan 190 step 8).
8. **Without Codex's thread index, every Codex rollout is statted every five
   seconds.** 25,000 rollouts take 120–150 ms per pass, under the backoff's
   slow threshold, so it never backs off: 8% of a core idle (plan 190
   step 8).
9. **A restart with nothing changed costs about 9 s of CPU** from start to
   30 s after the lists are usable, with no tab open, at 50,000 sessions;
   not yet attributed (plan 190 step 8).

Found 2026-11-10 while profiling, at the maintainer's request, the cost of
keeping a browser open on a long active session after plan 189.


2026-11-10 catalog ownership follow-up: the native parsed corpus and production
project membership mirrors are removed. Known changed files publish indexed
row/removal deltas; question enrichment and creation/activity lookups are scoped.
Safe derived query checkpoints avoid cold JS reconstruction when canonical state
has not changed. See [catalog evidence](../docs/research/190-catalog-sql-ownership.md).
Unrecognized new files still rediscover; full SQL restore, project aggregation,
remaining complete consumers and the long-transcript/client costs remain open.
