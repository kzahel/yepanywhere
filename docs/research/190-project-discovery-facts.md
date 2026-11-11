# Source-owned project discovery facts

Plan 190's next slice, after [combined qualification](190-combined-scale-qualification.md).
The measured dependency is ordinary Claude/Codex file activity causing complete
project regrouping and directory/cwd reads. This slice changes the owner and
consumer boundary, not provider formats or project display policy.

`ProjectDiscoveryFacts` stores one compact accepted native-discovery row per
project in the profile SQLite connection. The scanner's existing identity/maps
remain a read projection; production no longer writes the JSON project cache.
Point reads use the SQL identity key and an indexed native-project join. Native
counts, merged directories, provider precedence and path selection are still
established by the existing discovery algorithms, rather than inferred from
session-list membership (which has different filtering and activity semantics).

A bounded native-file batch observes known Claude/Codex modifications. Catalog
file-location lookup proves accepted membership; unchanged file identity,
nondecreasing size/mtime, bounded native metadata and a stable final stat qualify
an ordinary update. Claude retains directory activity; Codex uses its native
rollout activity. Only affected project activity rows change, in one transaction
per batch. Public counts and path elections are unchanged by an ordinary append.
No accepted session rows are mirrored in memory or a new inventory table.

The location proof explicitly uses the existing live-file path index. Attribution
on the intermediate candidate exposed SQLite choosing the family-leading index
without statistics, despite the path predicate. That scanned a provider's rows
for one changed file. A regression captures the actual append SQL and verifies
`EXPLAIN QUERY PLAN` searches by `location_path=?`; it fails before the fix.
No new index or statistics-maintenance loop is added. Node/Bun contracts execute
the real observation path and verify unmapped membership revokes complete proof
while preserving accepted retained rows.

Creation, deletion, replacement/truncation, absent/multiple location evidence,
changed/nonpreferred cwd and ambiguous path variants invalidate the observation
and re-enter existing complete discovery. Ambiguous cases also invalidate the
session catalog so it cannot keep the old project binding indefinitely. This
conservative path can still have population cost, including worktree/cross-host
cwd variants; it is an explicit remaining ingestion boundary, not a closed
all-write target. Codex's existing inventory is invalidated for each observed
file so a later structural refresh cannot restore stale activity.

SQL retention is scoped to native roots, enabled provider discovery and metadata
store. Restoration may seed retained display; each new process still performs
native reconciliation before complete reads are certified. The scope key reads
current metadata configuration, including late service attachment. The profile
has one project discovery owner. Structural discovery atomically replaces its
compact rows; known updates are fenced by the accepted revision. Disposal drains
work and prevents later publication. The pending file set is capped at 1,024;
each transaction processes at most 256 observations/affected projects. Statements
are scoped to an operation, reused within write batches and finalized afterward;
idle retains none. The existing SQLite statement ceiling is unchanged.

Freshness follows the inputs used by native discovery. At most three exact-root
watcher epochs are captured before enumeration; a gap or handover revokes reuse
of earlier native inventories. Unwatched nonempty roots retain the previous TTL
fallback. Empty/absent roots have negative evidence rechecked at that TTL. There
is no new polling loop. Registered-only directories outside those roots retain
live existence checks: one requested registration on point reads, bounded batches
for complete reads. Native points neither walk nor copy unrelated registrations.
Metadata membership mutations/reload advance a local discovery revision; that
revision is deliberately excluded from the persisted source-scope key.

Project metadata remains authoritative for display names, hidden membership and
ownership. Owner identity lookup is indexed within the registered/hidden metadata
state and reset on mutations/reload. A no-op code-name reconciliation certifies
the owned registry until mutation; matching point/subset reads reuse assignments
without serializing or reconciling the entire registry. Changed names, membership,
manual edits and reload preserve normal reconciliation and collision semantics.

## Correctness and review

Real file/SQLite tests compare ordinary updates and structural changes with an
independent full native rebuild, assert no provider regroup/directory discovery
on appends, and check cold restoration, metadata ownership/hiding and disposal.
Existing native namespace-allocation coverage catches statement pressure.
The standalone legacy JSON writer test remains scoped to a standalone scanner.
Eight copied-source negative controls fail at their intended assertions:
legacy scanner regrouping, delayed retained refresh, alternating registry subsets,
late publication after disposal, native eligibility, home-fallback parity,
observer handover and registered-directory existence. Every copy is restored
exactly; the working tree is never stashed or swapped. The additional file-path
query-plan regression fails before its access-path fix, giving nine negative
controls in total.

Sol 6.1 high with bypass permissions reviewed through YA port 3400, session
`6467e381-3751-4b4c-86bd-6d6e26a452a9`. Verified fixes cover indexed native-store
eligibility and empty-home parity, the production point fixture, registered-only
existence, observer epoch handover across structural invalidation and the async
proof-capture boundary. The final static verdict has no must-fix, should-fix or
nit findings. Review performs no edits, tests, builds, restarts or store access.

Final lint, formatting, type checking and source budgets pass. The final full
server run passes 7,373 tests with 94 skipped. An earlier full run hit the existing
[Antigravity startup-window failure](../../gaps/antigravity-admission-test-startup-window.md);
its eight-test file passed immediately in isolation, and the final full run
passes without it. The broader workspace run passes 7,387 client, 986 shared
and 22 root assertions. No client source changes. Node 25.8.2 and pinned Bun
1.3.14 packaged SQLite contracts pass, including Unicode parameters, atomic
replacement rollback, retained recovery, unknown file membership and disposal.
Frozen hubs shrink against the predecessor: app 4,565 → 4,560, scanner
1,570 → 1,567, server-main 1,820 → 1,817; the statement ceiling stays unchanged.

## Measurement method

Frozen external before revision `68f17b643` and reviewed after source based on
preparatory move-only `88abab37d`, Node 25.8.2, the same archived before client
for all runs. Both builds resolve shared JavaScript to their own pinned archived
shared dist; server/client/shared identities are recorded at start/end. The
manifest verifies after compiled source matches the working source. No working
client build occurs. The [machine-readable evidence](190-project-discovery-facts.evidence.json)
retains hashes, phase counters, host samples, server clocks and typing evidence.

All runs use 200 projects, 200 compactions, one active tab, 180 writes with one
compaction, 20 warm-up writes, 60 seconds quiet and 10 seconds settling, followed
by a separate 60-second sequential typing phase. Only idle population differs in
the 400-session controls. No CPU/browser profiler or competing tests, build or
review runs during timed phases. Same host/capacity as the preceding qualification.
The run order is before Claude, after Claude, after Codex, before Codex, then after
Claude/Codex population controls. The final-source matrix is repeated after
fixing the observed SQL access-path defect; earlier candidate runs remain temporary attribution material, not final
source measurements.
These single repetitions provide ceiling observations and population controls,
not statistical flatness ratchets or complete plan acceptance.

Reproduction uses the external dist paths with the existing driver:

```sh
node scripts/perf-repro/active-session.mjs --work /tmp/p190/w \
  --label <label> --long-provider claude --projects 200 --sessions 50000 \
  --compactions 200 --phases active --seconds 180 --warmup 20 \
  --quiet 60 --settle 10 --typing --typing-seconds 60 \
  --server-dist <build>/packages/server/dist \
  --client-dist <before>/packages/client/dist
```

Substitute Codex and the 400-session control as required. Each run owns fresh
stores/profile/HOME, uses 3420/4420 and reaps its server/browser. Worlds are deleted
afterward; the seed remains. The user server on 3400 is never restarted.

## Results

Full fixture, one repetition per before/after point. All CPU, loop, tab and
acknowledgement figures below are milliseconds; collection bytes are KiB/write.

| Measure | Target | Claude before → after | Codex before → after |
|---|---|---:|---:|
| Main CPU/write | ≤5 ms, flat | 118.7 → 68.6 | 163.3 → 91.2 |
| Process CPU/write | ≤15 ms, flat | 275.3 → 83.9 | 337.2 → 151.1 |
| Loop p99 | ≤50 ms | 17.7 → 13.8 | 24.4 → 14.9 |
| Tab task/write | ≤5 ms | 63.2 → 72.4 | 67.1 → 75.3 |
| Collection decoded KiB/write | a few KB | 99.03 → 99.03 | 99.74 → 99.74 |
| Visible update p95 | ≤250 ms | 246 → 243 | 242 → 237 |
| Sequential key acknowledgement max | ≤100 ms; exact prefixes | 36.18 → 26.44 | 21.86 → 23.03 |

Every active phase has 180 writes, one compaction and all 134 visible markers;
all 78 sequential keys have exact prefixes and remain within 100 ms. Each host
window passes eligibility and actual server/client/shared runtime fingerprints
remain unchanged. Capacity key:
`host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`.

Claude process CPU falls 70%, and main CPU falls 50.1 ms/write. Codex process
CPU falls 55%, and main CPU falls 72.1 ms/write. These remain above the
5/15 ms ceilings. Tab work is observed higher in the
after runs; it is not an improvement, and single repetitions do not establish a
regression magnitude. Collection bytes remain unchanged. Both before and after
Codex make 180 project point GETs, in addition to roughly two detail GETs/write.
Claude has no project point GETs. These costs are not hidden from the figures.

Population controls keep 200 projects, the same 200-compaction history, measured
duration, compaction and typing checks:

| Provider | Idle sessions | Main ms/write | Process ms/write | Tab ms/write |
|---|---:|---:|---:|---:|
| Claude | 400 | 62.9 | 77.8 | 74.6 |
| Claude | 50,000 | 68.6 | 83.9 | 72.4 |
| Codex | 400 | 88.8 | 155.7 | 79.6 |
| Codex | 50,000 | 91.2 | 151.1 | 75.3 |

Full application cost is not certified flat. The owner regressions prove no
ordinary native regrouping and a path-leading SQL lookup. Other query hydration,
relationship projections and complete consumers remain; bounded visible result
cardinality can also differ between the 400- and 50,000-session fixtures. These
single controls do not allocate the residual CPU gap to any one owner.

The separate intermediate-source profile identifies SQL selection/hydration,
relationship projection and stall-recorder rotation beyond the corrected file
lookup. Profiled timings are excluded from every target/comparison above. The
100 KiB collection stream and tab cost select completing the shared collection
change path as the next broad stage: keyed metadata/count changes, query updates
without rebuilding unchanged rows, and existing project-row reuse for point
consumers. That should be qualified independently, rather than added to this slice.

Other high-value choices are bounded Codex preview acquisition, incremental
transcript delivery/rendering, and quiet-host/restart work. Cold-open, restart,
idle CPU/RSS, additional-tab cost and history flatness are not requalified here.
The earlier combined checkpoint continues to own those observations and misses.
Structural/ambiguous discovery and other-provider SQL project aggregates remain
population-sized. No complete plan target acceptance is claimed.
