# Remaining active-session cost after the sidebar foundation

Status: measurement and proposal, 2026-11-12. Runtime `288b67493`. No production
optimization or new protocol is implemented by this checkpoint.

The maintainer asked to measure the current architecture, regroup and identify
promising next approaches. [Plan 190](../tactical/190-active-session-cost-at-scale.md),
[active-session costs](../../gaps/active-session-tab-background-cost.md),
[the previous full qualification](190-combined-scale-qualification.md) and
[the sidebar outcome](190-sidebar-snapshot.md) own the targets and preceding work.
[Evidence](190-current-cost-regroup.evidence.json) records results, provenance,
instrumentation and attribution separately.

## What the measurements establish

Warm bounded SQL reads are healthy; the entire live update pipeline is not yet
cheap. Reducing idle population 125-fold or transcript history tenfold leaves
most update CPU/browser work. The most concrete shared costs are repeated
navigation enrichment, unchanged collection metadata, and React/projection work
on the bounded loaded views. Initial acquisition and preview consumers remain
separate history-dependent problems.

A new finding changes how to interpret the earlier approximately two detail
requests/write: the macOS repro's `/tmp` alias differs from the focused watcher's
canonical `/private/tmp` spelling. Both notifications carry the same size and
mtime, but `useSession` includes the raw path in its deduplication key. The alias
runs therefore perform an extra empty read. A fresh canonical-root control
suppresses the duplicate with the existing deduper; this is not a production fix.
Do not describe two detail requests as universal behavior on ordinary roots.
Other symlinked roots remain an application correctness/performance follow-up.

## Current scorecard

The canonical-root, profiler-off active/typing observations below use 50,000 idle
sessions, 200 projects and one 200-compaction session, 180 active writes and a
separate 60-write typing phase. Each phase crosses one compaction. They are one
repetition per provider, not a statistical ratchet or complete plan acceptance.

| Measure | Target | Claude | Codex |
|---|---|---:|---:|
| Server main CPU/write | ≤5 ms | 72.3 ms | 92.8 ms |
| Server process CPU/write | ≤15 ms | 87.4 ms | 135.5 ms |
| Browser task/write | ≤5 ms | 57.3 ms | 57.2 ms |
| Browser task/write while typing | ≤5 ms | 65.1 ms | 67.7 ms |
| Event-loop p99, active | ≤50 ms | 18.2 ms | 18.2 ms |
| Write → DOM marker p95, active | ≤250 ms | 50 ms | 39 ms |
| Write → DOM marker p95, typing | ≤250 ms | 52 ms | 41 ms |
| Worst sequential-key acknowledgement | ≤100 ms, exact prefixes | 27.9 ms; 78/78 | 30.0 ms; 78/78 |
| Detail fetches/write | ≤1 small fetch | 1 | 1 |
| List reloads/write | 0 | 0 | 0 |
| Collection decoded traffic/write | a few KB | about 124 KiB | about 125 KiB |

All expected markers arrive. CPU, browser work and collection bytes still miss.
The longer canonical fixture roots lengthen encoded project IDs, so its larger
byte totals do not indicate a code regression versus the older 99 KiB fixture.


The original `/tmp` full runs also cover idle, two tabs, isolated lists, restart
without tabs, and a post-restart cold open. Their cold/startup clocks remain
observations in that environment, not a canonical-root requalification:

| Lifecycle observation | Claude | Codex |
|---|---:|---:|
| No-write server CPU over 180 seconds, long tab already opened | 2.1 s | 2.2 s |
| No-write RSS after initial long-session construction | 731 MiB | 785 MiB |
| Restart lists complete | 1,393 ms | 1,425 ms |
| CPU from restart through 30 seconds after lists complete | 5.15 s | 5.25 s |
| Restart RSS before reopening long tab | 280 MiB | 292 MiB |
| First post-restart detail server clock | 717.1 ms | 1,500.4 ms |
| Cold navigation to latest DOM marker | 1,198 ms | 2,244 ms |

Warm session-list loopback medians are at most 3.4/2.4 ms for Claude/Codex;
Inbox medians are 2.5/2.4 ms and project-list medians 2.9/2.9 ms. These wall times bound server time; they are not pure server clocks.
Sequential extra-tab process differences are +0.2/-11.9 ms/write. Negative or
near-zero sequential differences do not certify the 1 ms target. Collection
traffic roughly doubles with two tabs. No-write memory after construction and
fresh-restart memory are different lifecycle states, not memory-flatness proof.

Claude's cold detail splits into 256.5 ms project resolution, 33.4 ms reading and
425.7 ms augmentation. Codex spends 239.6/1,105.8/148.4 ms in those phases. Logs
again show a complete Codex rollout read during opening/preview, including
488,416,881 bytes and 151,979 entries on initial open. The
[bounded preview gap](../../gaps/codex-preview-refresh-parses-whole-rollout.md)
remains real even though ordinary appends are bounded.

## Population and history controls

These profiler-off controls retain the original `/tmp` fixture spelling, the
same build, 200 projects, one tab, 180 writes, one compaction and all 134 expected
visible markers. Compare within this table; canonical-root observations differ
in path spelling/length and seed and are not substituted into its controls.

| Provider | Idle sessions | Compactions | Main CPU/write | Process CPU/write | Browser task/write |
|---|---:|---:|---:|---:|---:|
| Claude | 50,000 | 200 | 74.3 ms | 89.7 ms | 59.9 ms |
| Claude | 400 | 200 | 66.5 ms | 81.5 ms | 59.5 ms |
| Claude | 50,000 | 20 | 69.3 ms | 83.7 ms | 55.2 ms |
| Codex | 50,000 | 200 | 102.3 ms | 167.9 ms | 59.4 ms |
| Codex | 400 | 200 | 87.8 ms | 156.7 ms | 60.6 ms |
| Codex | 50,000 | 20 | 98.3 ms | 163.8 ms | 61.4 ms |

Most observed cost survives both reductions. This selects bounded view/update
processing for investigation; it does not certify flatness, allocate every
remaining millisecond, or establish a before/after regression magnitude.

## Attribution, excluded from target figures

Four separate 30-write runs use optional CPU/browser profiles and browser event
and collection-frame probes. Two retain the alias; two use a fresh canonical
root and add SQLite execution counts. A native three-second sample accompanies
the canonical Codex profile. These are diagnostic-only, without compactions.
The probe records existing reload-performance marks and consumes a clone of the
collection stream; it does not alter responses. Its own work is overhead.

### Collection freshness resends unchanged project dictionaries

The alias diagnostics carry about 99–100 KiB/write. Unchanged `projects`
metadata in the three session feeds accounts for 95.7% of Claude collection
bytes and 95.0% of Codex collection bytes (including its project stream). Each feed emits 60 frames for 30
writes, including the empty starred/categorized windows. Exact serialized-field
comparisons show the project dictionary unchanged in all 60 measured frames of
each feed. Stable stats and `hasMore` values also travel again because a changed
catalog token replaces the complete `meta` object.

Canonical-root probes reproduce the mechanism: unchanged project dictionaries
are 96.5%/95.9% of collection bytes. Their longer path-derived project IDs make
absolute payloads larger, so those byte totals are not an optimization comparison.
Raw field sizes, equality observations and per-query frame counts are retained.
This is a shared collection-response boundary, not evidence that the client
should infer list membership from one session edit.

### Sparse Inbox selection can still walk the population

The most expensive counted statement is the queued-session key selection:
`attention=0 AND id IN (SELECT value FROM json_each(?))`, ordered by timestamp
and ID. Both fresh diagnostic queues are empty. It executes 60 times per 30
writes and takes 278/218 ms of cumulative native statement wall time; these are
attribution clocks, not whole-server CPU savings.

A separate in-memory probe uses the actual `SessionCollectionSql` schema and
indexes with 500/50,000 minimal rows. On Node, `EXPLAIN QUERY PLAN` chooses the
covering attention/timeline index, with a membership subquery/bloom filter,
rather than identity seeks. The unchanged query takes median 0.021 → 1.465 ms
for an empty ID set and 0.032 → 2.417 ms for one old ID. A prototype driven from
`json_each` into primary-key lookups takes about 0.007/0.010 ms at 50,000 rows.
The prototype sorts selected candidates rather than walking the timeline. This
is not a shipped query or response-parity qualification; grants, archive policy,
timestamp ties and multiple candidate sets still require implementation tests.
Bun 1.3.14 reproduces the access plans: at 50,000 rows the current empty/one-ID
queries take about 1.320/2.287 ms versus 0.010/0.012 ms for the prototype. These
are isolated minimal-row diagnostics, not end-to-end performance gains. The
result identifies an access-path defect, not a need for another row cache.

### Row batching does not yet batch every enrichment

The earlier 20-call sidebar number is an isolated aggregate-API fixture, with no
provider-child relationship service. It counts that boundary, not the complete
production pipeline.

Across 30 canonical diagnostic writes, Node SQLite executes 19,552/25,387
`get`/`all`/`run` calls (about 652/846 per write). These counts exclude `prepare`
and `exec`, include background work, and are not network-request counts.
For each provider, 12,120 calls (404/write) check relationship edges/checkpoints.
All 6,030 measured outgoing-edge queries return no rows in this fixture.

`RetainedSessionQuery.hydrate` invokes `ProviderChildRelationshipService.accepted`
for each selected native parent. That method projects the parent's relationship
page and, for empty results, checks its publication checkpoint. SQL payload
hydration is batched, but relationship enrichment remains per parent and repeats
across fresh reads. The query owner also synchronizes eight times/write in
these diagnostics. A bulk selected-parent projection and one shared acquisition
boundary are stronger architectural candidates than another session cache.

Codex additionally reads the creation generation 6,300 times versus Claude's
270. The sampled caller chain is `ProjectQueueService.listAll` →
`getProjectQueueCountForProject` inside the project-list map. Each project asks
for the same queue list and reconciliation check. Grouping queue counts once
per project-list acquisition would remove that repeated work without a protocol
change. Statement time alone understates surrounding preparation, transaction,
serialization and allocation costs; these findings are not additive CPU savings.

### Browser work has several consumers

A hidden-sourcemap rebuild produces all 248 JavaScript chunks byte-identical to
the measured client; it is used only to map profile locations. Application costs
include transcript compilation/shell-tool-result scanning for Claude, shared
summary/query publication and project-record updates for Codex, and navigation
consumers for both. React reconciliation is prominent in both profiles.

The closed `RecentSessionsDropdown` still acquires its feed and eagerly constructs
its row children before passing them to a closed Popover. It repeatedly formats
old session dates; source-mapped samples attribute roughly 52–69 ms self time
per 30 writes to its formatter. This is a useful inactive-consumer cleanup, not
an explanation for all 50–60 ms/write of browser work.

Claude's transcript compiler appears at about 156–165 ms inclusive per 30 writes,
with shell-result scans among the largest application self stacks. Preserve
unchanged projection work and derive display metadata once per changed item;
do not start with a new renderer or broad transcript rewrite. Inclusive stacks
overlap and must not be summed. Profiles do not yet isolate a single owner for
all React scheduling/reconciliation work.

### Memory: live heap differs from RSS and footprint

After one explicit inspector GC in the alias diagnostic, server heap used is
147.5/188.7 MiB, while RSS is 740.1/797.2 MiB. Before that GC RSS is
1,045.5/1,124.0 MiB. macOS `vmmap` separately reports footprint 322.5/370.2 MiB
with much larger resident regions, including allocator regions with reusable or
clean pages. These are adjacent, non-atomic diagnostic clocks, not interchangeable
memory measures. They narrow the problem: RSS is not all live session objects,
but the existing RSS ceiling is not silently replaced with footprint. This is
one GC sample rather than the performance suite's seven-sample memory ratchet.
Initial allocation/retention and complete-consumer attribution remain open.

## Recommended next approaches

1. **Finish bounded navigation projection as one shared read boundary.** Start
   by making sparse identity selections drive indexed ID reads, then bulk child-
   relationship enrichment of selected parents and grouped queue counts. Preserve
   partial/unknown/accepted-empty semantics, grants, ordering and live overlays. Remove the per-row/per-project reads rather than cache their answers.
   This benefits sidebar, Inbox and other list consumers without a new wire
   contract. Stop and remeasure this first coherent slice before expanding it.
2. **Separate display data from collection freshness.** Preserve unchanged
   options/rows and inactive consumers; avoid carrying whole project dictionaries
   on a catalog-token change. Then retry the existing cheap aggregate sidebar API
   with authoritative replacement semantics. The API/capability already exists;
   the previous client cutover was removed, so adoption still needs a measured
   win and compatibility review for any changed stream semantics. This has the
   strongest measured wire-volume opportunity and broader browser potential,
   whose CPU benefit still needs a controlled experiment.
3. **Close bounded excerpt/preview acquisition.** Route every preview/summary
   consumer through the shared bounded reader. This directly addresses Codex cold
   opening and transient history allocation; it is not the main steady-state
   population cost in the controls.
4. **Quiet-host and restart lifecycle.** Revisit stall-recorder rotations,
   initial/restored projection construction and recurring observation separately.
   They remain useful, but do not explain all active-tab cost.

The path-alias deduplication defect should receive a small portable identity
fix and a permanent fixture control. It is not justification for a provider-
specific fast path or a literal `/tmp` rewrite. The current existing deduper
already handles canonical roots correctly. No optimization above is implemented
or approved as a larger rewrite by this measurement checkpoint.

## Provenance and validation

The frozen external server/client/shared sources match `288b67493`; both runtime
SDK links point into that frozen build. Every measured run fingerprints the
actual server, client and resolved shared runtime at both boundaries. The
primary and control runs have optional profiling off; the normal production
stall recorder remains enabled. Host/capacity, separate phase windows, typing
prefixes, compactions, missing markers and raw-result hashes are in evidence.
No claims depend on the stale pre-rebase baseline.

Reproduce the canonical active/typing point with an immutable external build
whose shared SDK is pinned inside that build:

```sh
node scripts/perf-repro/active-session.mjs \
  --work /private/tmp/p190/canonical --label <new-label> \
  --long-provider claude --phases active --seconds 180 \
  --typing --typing-seconds 60 --quiet 60 --settle 10 \
  --server-dist <frozen-build>/packages/server/dist \
  --client-dist <frozen-build>/packages/client/dist
```

Substitute Codex for the second point. The default fixture has 50,000 sessions, 200 projects
and 200 compactions; use a fresh world and canonical spelling before generating
its seed. Full lifecycle runs omit `--phases` and add `--additional-tab`.
Control/profile arguments, exact diagnostic patches and the standalone SQL-plan
probe source are embedded in evidence. Do not enable profiling for target figures.

All runs use isolated generated stores on 3420/4420. The user's 3400 server and
primary provider/profile stores are not stopped, restarted or directly written.
Worlds are reaped after runs; seeds and raw results remain outside the repository.
The working-tree client is never built. No production or active-session harness source changes are made. A separate
cleanup removes an unused redundant import from the previous sidebar API probe;
the frozen measured build and active-session driver stay unchanged. The scratch
diagnostic patch and SQL preload are retained in evidence.

Final lint is warning-free; formatting, typechecking and source budgets pass.
The cleanup's safe-home API smoke passes. The complete required workspace test
run passes: server 7,382 with 94 skips, client 7,389, shared 986 and root 22,
plus the other workspace suites. Five existing timer-only jsdom navigation
diagnostics recur and are recorded in the [existing gap](../../gaps/client-unit-navigation-diagnostics.md);
no client navigation code or suppression is changed.

Sol 6.1 high/bypass reviewed through YA 3400, session
`7fd3922e-3b39-46fe-bd74-7182ccadb19a`. Two numerical wording nits were verified
and corrected (Inbox median labels and provider-specific unchanged-metadata
percentages); final review has no must-fix, should-fix or nit findings. Review is
read-only, without tests/builds, probes, source changes or server operations.
