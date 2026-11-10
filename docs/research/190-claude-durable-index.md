# Durable Claude source facts and cold window queries

Topic: catalog-identity-projection-cost

Plan 190 stage 3, 2026-11-10. This follows the
[bounded warm reader](190-claude-source-index.md). The selected architectural
boundary is profile-owned source facts and logical positions, with native
transcript payload remaining the authority. This slice implements bounded
unchanged-source restoration. It deliberately leaves the first post-restart
write's complete compact-metadata restoration as the next writer migration.

The subsequent [SQL writer slice](190-claude-sql-writer.md) removes that ordinary
changed-read restoration and active graph residency. Figures in this document
remain the historical measurements of this earlier implementation.

## Ownership and acquisition

Migration 035 adds rebuildable source headers, compact source records, logical
visible rows, orphan tool facts and staging manifests to the existing profile's
`discovery.sqlite`. It performs no source reads or backfill at startup. The
existing accepted transcript acquisition populates these rows on detail reads;
there is no new watcher, periodic scan or per-session timer. Nothing is written
inside a project or provider store. Complete text, images, thinking and tool
output stay in the provider file. Task inputs/results and recognized harness
commands remain the same compact evidence retained by the previous reader.

The app owns one transcript cache and durable writer per profile. Bound and
project Claude readers share it; separately constructed readers may still use
the existing nonpersistent cache for explicit tests/tools. The profile owner
joins pending acquisition before disposing statements and closing its database.
Maintenance diagnostics report the actual profile cache. The private reader-LRU
admission closure moves unchanged into its domain module as a preparation commit;
its cache, limit and retirement callback become explicit dependencies.

An accepted SQL header carries the decoder/selector version, committed row/byte
counts, exact source identity/timestamps, head/end byte evidence, summary
witnesses and counts, and the rewind context. After eviction or process restart,
matching identity and timestamps plus bounded byte probes permit window queries
without source parsing or historical metadata hydration. Logical ranks, message
IDs, compaction ordinals, group starts and late queue delivery have SQL indexes.
Selected records use the same payload hydrator and converter as the warm reader.
Full counts, global turn indices, task snapshots, orphan flags and rewind overlays
are preserved. SQL keys encode strings as JSON so NUL and lone surrogate values
do not change through SQLite text bindings.

Unknown anchors and oversized/unsupported selections keep complete catch-up.
Provisional unterminated data is never committed to SQL; the existing reader
replays it before a later newline commits it. Source replacement, truncation or
same-size edits reject saved evidence. Prefix validation retains the existing
append-only assumption between observed rewrites, rather than hashing history.

## Publication and recovery

Ordinary warm writes journal appended compact records, changed projected rows and
affected orphan facts. They commit with their new header in one transaction.
Unchanged reads do not rewrite a checkpoint. Initial construction, branch changes,
rewinds and queue position shifts can replace the logical projection. New rows
are staged under a distinct generation in transactions of at most 256 records,
256 visible rows and 256 orphan facts, yielding between batches. The accepted
header changes only after all rows exist and source/projection/cache ownership
and the prior SQL revision still match. An interrupted/failed writer cannot
expose half a generation. Published provider messages and source formats do not
change.

Every staging writer owns a renewable 60-second lease, refreshed by its bounded
batches. Expired stages cannot resume or publish. Cleanup targets explicitly
superseded generations or owned failed builds; each deletion transaction checks
that the generation is not currently accepted and does not have a live peer
lease. Unchanged acquisitions also perform one bounded recovery batch for an
expired nonaccepted generation. No background cleanup timer is added. A crash
leftover for an unviewed source waits for that source's next acquisition.

SQL snapshots are pinned by generation and revision before selection and after
hydration. Stale cache hits refresh the exact saved SQL source. Metadata
materialization checks its cache token, map membership and original source after
awaiting before installing or charging it. SQL hydration owns request-local
orphan/decoded state, preventing overlapping selections from mixing projections.

The store retains one native prepared statement at a time. Consecutive batch
operations reuse it; changing SQL finalizes it, and it is released before async
yields and on return. This preserves the shared profile's existing statement
ceiling and Bun ownership without adding a connection or widening the adapter.

Historical harness extraction consumes already acquired compact evidence through
a row-ordinal source. Existing 256-record/block and command-byte budgets,
copy/admission/native/version fences, durable extraction cursors and generation
checks remain. It does not mistake a selected tail for complete history or load
all historical evidence into RAM to hand off a view.

## Remaining costs

An unseen source still requires one streaming index build. The first write after
restart reconstructs the selector from complete compact SQL metadata, then parses
only appended source bytes. That restored warm graph remains under the existing
128-file/192 MiB estimated cache bound; it is still proportional to active
history. SQL-owned bounded incremental branch/task state is the next migration,
not a completed claim in this slice. Exceptional rewind/branch selection can
also revisit compact metadata, and complete catch-up can read payload history.

The derived SQL projection occupies disk proportional to indexed history. It is
not a second canonical conversation store and must be invalidated by its format
version when selector/converter/task/summary semantics change. Native deletion
and bounded disk-retention policy for no-longer-viewed source indexes remain
separate lifecycle work; accepted facts are rebuildable from provider files.

## Verification and measurements

The final external server-only build matches all changed production-source hashes
in [the evidence JSON](190-claude-durable-index.evidence.json). Baseline is
`55017221d`; preparation `ada4e62b5` is move-only. The profiler is off. The
fresh-world order is before20 → after20 → after200 → before200; equal-length
labels keep source sizes identical in each pair. Every build, reopen and append
phase runs in a fresh Node 25.8.2 process. Source generation, module loading,
SQLite initialization and explicit GC are outside the reader clocks. The
clock includes `getSession` and normalization, without HTTP/augmentation, browser,
provider processes, watchers or a 50,000-row catalog.

| History | Source bytes | Unchanged reopen before | After | Post-GC heap before | After |
|---|---:|---:|---:|---:|---:|
| 20 compactions | 46,563,195 | 187.45 ms | 24.42 ms | 36.12 MiB | 14.81 MiB |
| 200 compactions | 464,757,089 | 2,861.73 ms | 71.09 ms | 198.44 MiB | 14.81 MiB |

At 200, reopen RSS falls 463.55 → 98.03 MiB; the retained index estimate is
5,824 bytes rather than about 156 MiB. This is the isolated reader process,
not whole-server memory acceptance.

The costs shifted into explicit index/writer boundaries remain material. First
construction at 200 regresses 2.86 → 5.03 seconds because it also writes SQL.
The first append after an SQL reopen costs 2.21 seconds to reconstruct compact
metadata; at 20 it costs 106.72 ms. The remaining seven append requests have
medians 1.33 ms at 200 and 1.21 ms at 20, versus 0.47/0.52 ms before: durable
changed-row commits add work. Active post-GC heap returns to about 200 MiB at
200 compactions. These are not flat first-write or active-memory results, and
are not hidden inside a warm median. SQL-owned incremental writer state remains
necessary.

Capacity is `host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`.
Raw native busy fractions are 23.32%, 21.76%, 21.42%, 20.96% in run order,
with at least 24.1 GiB available and swap stable at 249.75 MiB. Automatic Darwin
CPU/swap fields remain unavailable, so these shared-host, one-sample phase
figures are diagnostic-only. No unrelated task-owned tests/builds ran alongside
the final measurement interleave. Full active-tab, 50,000-session, watcher
fan-out, rendering, typing and per-write CPU targets remain open.

The read-only task-owned 81,477,404-byte real Claude copy passes fresh full-rebuild
comparison at three committed prefixes: 64,833,204 / 72,849,151 / 81,477,404
bytes (near 80/90/100%, cut before incomplete records). Warm and SQL-reopened
summaries, task snapshots and canonical message hashes match exactly: 1,617 /
1,220 / 1,482 selected messages. Native contents/paths are not published.
Existing provisional replay plus real-file unit/interleaving coverage complements
these committed-prefix checks.

Eleven new integration cases cover SQL restoration without historical capture,
changed-row publication/task continuity, replacements/branches/provisional replay,
original-ordinal harness evidence, transactional failure/cancelled builds,
nested rewinds/stale cached projections, bounded expired-stage/live-peer protection,
materialization invalidation, actual production reader injection, concurrent
profile writers, and fallback/retirement statement release. The production-reader
test fails against the old reader; nested-parent encoding, stale-owner,
materialization ownership and abandoned-stage regressions fail when their fixes
are removed. Files are copied aside and restored; no stash is used.

YA reviewer `96181883-50f1-4713-b978-064c32b0cf07`, Sol 6.1 high,
`bypassPermissions`, review-only, reported generation-cleanup ownership,
stale-checkpoint retry, nested-parent key encoding, materialization ownership,
abandoned-stage recovery, fallback statement release and retirement classification.
All verified findings are fixed; final review has no remaining must/should/nit
findings. The move-only admission closure is independently verified unchanged.

Final lint, formatting, typecheck and source budgets pass (one existing unrelated
informational client lint diagnostic). App stays at its preparation ratchet of
4,573 lines; server-main stays at 1,820. Full server: 7,311 pass / 94 skip /
11 existing Claude executable-version guards (expected 2.1.322, installed
2.1.321); native Codex passes. Client: 7,350 pass / 685 files, 126.74 seconds,
with existing [unattributed navigation diagnostics](../../gaps/client-unit-navigation-diagnostics.md).
Other non-Android workspaces and 16 root tests pass. An earlier full candidate
run also hit the existing [Rendez nested watch race](../../gaps/rendez-nested-watch-event-after-restart.md);
the focused file and final full run pass, without changing its source/assertion/
timeout. Node 25 and pinned Bun 1.3.14 pass the packaged SQLite contract. Bun
also passes real 20-compaction build, fresh-process SQL reopen and three append
requests. Local platform evidence is macOS; Linux/Windows remain CI qualification.
No client build, user-server restart or direct primary-store write occurred.
