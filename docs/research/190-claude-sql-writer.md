# SQL-owned Claude incremental writer state

Topic: catalog-identity-projection-cost

Plan 190 stage 3, 2026-11-10. This follows the
[durable cold-window slice](190-claude-durable-index.md). Ordinary reads and
appends now share the profile's SQL-owned source/projection state. The cache
retains a small accepted header and selected payload, rather than reconstructing
and retaining the complete historical graph on the first changed read.

## Ownership and update boundary

Migration 036 adds rebuildable node/tool ownership, source-offset positions,
pending queue facts and a semantic task checkpoint to the existing database.
It is empty at startup: detail acquisition populates it. Native transcript bytes
remain authoritative. There is no new watcher, connection, provider-store write,
per-session timer or public protocol. Existing writerless checkpoints still serve
cold windows and bootstrap writer facts once, lazily on a changed read.

`claude-linear-writer.ts` stages a delta through a narrow SQL facts interface.
The original source decoder, converter, summary witnesses and task reducer own
semantics. It validates unique UUIDs, the winning parent, nondecreasing timestamps
and compatible tool ownership before publishing. Node/tool facts, source records,
changed logical rows, orphan flags, queue changes, task state and the accepted
source header commit atomically under generation/revision, source and cache
ownership fences. Summary computation remains memoized per accepted projection.
The previous durable graph journal is removed; the SQL delta is the sole
incremental durable owner. Explicit nonpersistent tools/tests retain their
existing in-memory reader.

Task-related rows load only the semantic reducer checkpoint, with an 8,388,608-character SQL
read cap. Pending task inputs reconnect to the original projected call by source
offset, so late results update both the historical task snapshot and the new row.
Semantic task state may itself grow with tasks; this is not a claim of constant
cost for arbitrary outstanding task populations. Ordinary non-task appends do not
load that checkpoint. Recent unambiguous queue delivery shifts an indexed suffix
of at most 256 rows, preserving global positions and compaction ordinals.

Provisional rows use a noncommitted overlay on the same SQL window selector.
Complete prefix lines can commit while a final unterminated row remains an
overlay; invalid continuation retracts it without touching historical metadata.
A rewind-context change restores the valid unfinished tail under accepted-byte
fences before applying the original selector. Summary-only `peek()` releases a
completed graph using the prepared rewind context rather than an absent caller
option. No provisional source bytes are committed before their newline.

Branch changes, missing/open rewind bounds, ambiguous/historical queue delivery,
unsupported facts and oversized task checkpoints decline the incremental guard.
The original complete metadata selector handles them, then publishes a fresh
leased generation and releases the graph. Full publication always replaces all
writer facts; it cannot retain tool/node facts from an invalidated provisional
branch. Staging and retirement use the existing leases and accepted-header
protection. Batches contain at most 256 facts. One native prepared statement is
reused within a batch and released before asynchronous work, return or failure;
the profile's statement ceiling is unchanged.

An unseen source still streams history to construct its index. Exceptional
metadata selection is also history-dependent; a provisional tail combined with
a context-changing fallback can temporarily retain its graph until complete
publication. Complete/oversized catch-up and eventual source-deletion/disk
retention remain separate boundaries. This implementation closes ordinary
post-restart writer restoration, not every plan 190 target.

## Correctness and review

Seven behavioral integration cases compare exact summaries, normalized/task messages,
global turns, total message/user-turn counts and cursor windows against a fresh
full rebuild. They forbid historical materialization on ordinary appends,
compactions, pending task results, recent queued delivery and provisional
replay/retraction, including restart. Other cases cover a rewind whose missing
bound arrives later, invalidated provisional tool facts, and unchanged-file
rewind changes followed by summary-only completion and graph release.

An eighth case inspects the actual compaction lookup query plan and requires an
ordinal seek. The first comparison exposed SQLite choosing a generation-only
primary-key scan despite an existing partial index; pinning that ordinal lookup
to the existing compaction index removes the remaining per-read history walk.
The plan regression fails before the fix. A separate CPU profile and per-query
trace attributed the scan; profiled figures are not used as performance results.

The ordinary-writer test fails against the previous cache with forbidden
historical restoration. Disabling complete tool-fact publication reproduces the
reviewer's stale-task failure. The rewind/provisional regression also fails
before its fix. Files were copied aside and restored; no stash was used.

Sol 6.1 high, bypass permissions, reviewed through the maintainer's Yep Anywhere
API on port 3400 (session `c77d7733-38fe-46c0-a071-0e6d07270400`). A verified
must-fix concerned stale writer facts after fallback publication. Complete fresh
generations and a failing-before regression resolve it. Subsequent review,
including the provisional/context and final graph-release fixes, reports no
findings. Review was read-only, without workloads or server lifecycle operations.

The final external build also matches fresh full rebuilds on a read-only,
task-owned 81,477,404-byte real Claude transcript copy at committed prefixes
64,833,204 / 72,849,151 / 81,477,404 bytes. Warm and SQL-reopened results agree
exactly on summary, task state and canonical message digests (1,617 / 1,220 /
1,482 selected messages). Node 25 and pinned Bun 1.3.14 SQLite contracts pass;
Bun also completes real file/index build, reopen and three append phases.

## Measurements and qualification

| Measure | 20 before | 20 after | 200 before | 200 after |
|---|---:|---:|---:|---:|
| First append after restart (ms) | 103.80 | 3.44 | 2,217.23 | 3.52 |
| Remaining seven appends, median (ms) | 1.38 | 1.52 | 1.40 | 1.58 |
| Unchanged reopen (ms) | 24.35 | 19.91 | 70.75 | 20.58 |
| Active post-GC heap (MiB) | 34.11 | 15.28 | 199.99 | 15.29 |
| Active RSS (MiB) | 173.25 | 102.00 | 428.16 | 102.58 |
| First unseen-source construction (ms) | 360.02 | 404.30 | 4,692.76 | 5,557.73 |

The 20/200-compaction sources contain 46,593,096 / 465,055,370 bytes. After the
change, the first append is 3.44 / 3.52 ms and remaining-seven medians are 1.52 /
1.58 ms, while active heap stays about 15.3 MiB. The retained index estimate is
5,968 / 5,985 bytes instead of 15.5 / 154.1 MiB. The tradeoff is a small warm
append increase and more initial indexing work: at 200 compactions first
construction rises from 4.69 to 5.56 seconds. That initial stream/publication
remains an explicit open cost; post-build heap falls from 198.7 to 15.7 MiB.
Raw host busy percentages were 22.23 / 20.62 / 18.86 / 21.38 in run order,
minimum available memory was 25.7 GiB, and swap use stayed at 249.75 MiB.

Both builds use durable SQL mode. Each build/reopen/append phase is a fresh
process. Eight appended updates follow the initial tail read; the first append
is reported separately from the remaining seven. Source generation, SQL/module
initialization and forced GC are outside reader clocks. The measured operation
includes reader acquisition and normalization; it excludes API augmentation,
watchers, browser rendering and the 50,000-session catalog.

The comparison interleaves before-20 / after-20 / after-200 / before-200 on fresh
worlds, with equal-length run names and identical generator parameters. The
baseline is `a6ac5ab5d`; the final server-only external build's source hashes,
raw phase results, runtime, host counters and harness hashes are in
[the evidence](190-claude-sql-writer.evidence.json). No CPU profiler was enabled.
Darwin's automatic suite CPU/swap eligibility is incomplete; raw host counters
supplement it. This shared-host, single-phase comparison is diagnostic evidence,
not full active-tab latency, per-write CPU or memory target certification.

Final lint, formatting, typecheck and source budgets pass (one existing unrelated
client informational lint diagnostic). Final foreground server tests exit zero:
7,334 passed / 94 skipped across 642 files. Client tests exit zero: 7,350 passed
across 685 files; client code was unchanged. Other non-Android workspace tests
and all 16 root Node tests pass. The SQL runtime checks, Bun functional scenario
and real-copy parity use the final server-only external build; all seven changed
runtime sources match its copied source hashes exactly.

The next architectural opportunity is authoritative list/transcript change
propagation and reconnect catch-up: SQL has removed whole-catalog projection
walks, but each write still makes tabs refetch and reconcile whole collections.
Full combined-scenario qualification should then expose remaining idle observation,
first-construction and browser costs before additional narrow optimizations.
