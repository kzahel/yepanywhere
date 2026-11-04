# Codex Metadata Scanner

> The Codex metadata scanner is the YA subsystem that maps date-bucketed Codex
> rollout files to projects and session summaries by reading rollout head
> metadata; its current shortcut caches and durable discovery index help common
> navigation, but date-bucket scheduling, dirty-scope precision, and
> same-identity overwrite validation still have known scale gaps.

Topic: codex-metadata-scanner

Related topics: [codex-sessions](codex-sessions.md),
[provider-refresh](provider-refresh.md),
[session-liveness](session-liveness.md),
[architecture-mandates](architecture-mandates.md).

Implementation plan:
[`docs/tactical/019-codex-metadata-scanner-index.md`](../docs/tactical/019-codex-metadata-scanner-index.md).

## Why It Exists

Codex stores local rollouts by time, not by project:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

YA's project and session lists are project-oriented. To build those lists,
the server must learn each rollout's cwd from `session_meta`. The metadata
scanner exists to bridge that mismatch without spawning a Codex runtime.

The important invariant: `session_meta` is head metadata. After the first
successful parse for a rollout, its id/cwd/timestamp should be treated as
stable unless there is evidence the file was replaced or corrupted. Ordinary
append activity should not force repeated metadata reads.

## Current Implementation Shape

Current Codex discovery uses layered caches plus a provider-neutral discovery
index:

- `CodexSessionScanner` recursively finds rollout files, reads first-line
  `session_meta`, groups by cwd, and caches the result; see
  [Watcher-trusted enumeration](#watcher-trusted-enumeration) for how long.
- `CodexSessionReader` has a shared scan cache keyed by sessions
  directory and active-window scope. Reader scans now record cache status,
  duration, directories walked, rollout counts, plain/zstd precedence
  filtering, discovery-index behavior, first-line reads by representation,
  skipped metadata files, and subagent sessions filtered from ordinary lists.
- `.jsonl.zst` support is a runtime capability. The active runtime must expose native
  `node:zlib` zstd APIs; unavailable implementations skip compressed rollouts
  cleanly and count them as unsupported. The main server runtime floor is
  documented in [server runtimes](server-runtime.md).
- `SessionDiscoveryIndex` persists normalized provider head metadata under
  `{dataDir}/indexes/session-discovery/<provider>/<source-root-hash>/...`.
  Codex uses date-bucket shards such as `2026/06/25.json` and stores a small
  source fingerprint to distinguish ordinary append growth from common
  same-path replacement cases. Startup supplies one process-local registry to
  scanners, readers, and watcher-side resolution, so one logical durable index
  has one mutable owner. Concurrent misses for the same cold shard join one
  load before any caller mutates it.
- `CodexSessionScanner` records per-scan metrics for duration, directories
  walked, rollout counts, plain/zstd precedence filtering, discovery-index
  hits/misses/suspect records, first-line reads by representation, and
  cache-backed compressed discovery. Normal scans log these metrics at debug;
  slow scans warn.
- `ProjectScanner` keeps a short-lived project snapshot and coalesces
  concurrent scans. Invalidation advances a change revision; a scan that
  overlaps a newer file event may satisfy its original caller but cannot mark
  that old result fresh. Snapshot-file writes are serialized, coalesce one
  latest trailing result, and atomically replace the disposable cache file.
- `SessionIndexService` persists normalized session summaries and avoids
  reparsing unchanged sessions, but full validation still enumerates files
  through the reader and stats discovered paths.
- `FileWatcher` marks Codex scopes dirty when rollout files change; because a
  raw file event does not identify the owning project scope cheaply, loaded
  Codex scopes are marked dirty broadly. Full-tree rescans now record duration,
  files scanned, emitted create/modify/delete counts, and overlap skips.

These layers are useful for normal navigation and request bursts. The discovery
index now avoids rereading `session_meta` for observed known rollouts, including
ordinary append/mtime/size changes. It does not change the underlying
enumeration cost: discovering an uncached or invalidated Codex tree still walks
provider-owned rollout files.

Cached Codex metadata is treated as suspect and reread when the file identity
changes for the same representation, when a plain file shrinks below the
cached observation, or when compressed size changes for an indexed compressed
rollout. A same-path overwrite that preserves file identity and non-shrinking
size remains a known gap because stat metadata alone cannot prove line 1
changed.

The discovery index is derived and non-authoritative. YA must enumerate
provider files first and then consult the cache only for those observed files.
A missing provider file is hidden immediately even if its discovery record
still exists on disk.

## Watcher-trusted enumeration

While the server's Codex `FileWatcher` observes the sessions tree, an
enumeration of that tree stays current until the watcher reports a change.
With no Codex activity, list, Inbox, and project reads perform no directory
walks and no rollout `stat`s, however much history exists. Without that
observation, a cached enumeration expires after 5 seconds, which bounds
duplicate walks within one request burst and nothing more.

- **Observation epoch.** `FileWatcher.getObservationEpoch()` names one
  uninterrupted observation: it is null until the watcher's initial baseline
  completes, and becomes null again after a watcher error or stop. An
  enumeration is trusted only under the epoch read before its walk began, so
  changes made before the watcher started, or across a failure, can never be
  hidden by a trusted cache.
- **Reported changes.** A reported rollout path is re-read on the next read of
  the cache (the scanner via `ProjectScanner`'s file events, the reader's
  shared cache via `observeCodexRolloutTree`), not by a new walk. A reported
  deletion that removes a cached session forces one fresh enumeration, since
  another file may still carry that session.
- **Platforms.** On Linux, Node's recursive watch registers new date
  directories and reports files created in them immediately. On macOS and
  Windows the watcher's periodic rescan reports what native events miss, and
  trusted caches see those reports like any other.

Inactive rollouts stay in the enumeration because the session lists show all
Codex history (no hidden sessions by default; see Non-Goals). The cost
removed is re-proving that unchanged history is unchanged.

## Compression Gate

Codex may compress older rollouts to `.jsonl.zst`. YA should support those
files eventually, but compressed discovery has a stricter performance bar than
plain JSONL.

Plain `.jsonl` first-line reads can use a partial file read and stop once a
newline is found. A naive `.jsonl.zst` implementation that reads and
decompresses the whole file just to find the first line is not acceptable for
default scanner paths.

Default `.jsonl.zst` discovery is gated on native runtime zstd support plus at
least one of:

- a durable metadata cache hit from the earlier plain `.jsonl`
  representation;
- a streaming zstd first-line reader that stops after decoding the first JSONL
  record;
- an explicit opt-in slow path for users who accept whole-file decompression
  during discovery.

As of 2026-06-25, YA satisfies this gate with a streaming zstd first-line
reader in `readFirstLine()` when Node exposes native zstd APIs. On runtimes
without native zstd, YA skips `.jsonl.zst` rollouts rather than crashing or
falling back to whole-file decompression. Keep that separation intact: full
compressed session detail loads may read the full transcript on supported
runtimes, but scanner metadata discovery must not depend on whole-file zstd
decompression.

## Watcher And Scheduling Gaps

There is not yet a date-bucket-aware Codex scanner scheduler.

The server creates a `FileWatcher` for the Codex sessions directory. On
Windows and macOS, the Codex watcher currently enables a periodic full-tree
rescan by default because recursive `fs.watch` can miss deep file writes.
`CODEX_WATCH_PERIODIC_RESCAN_MS` is the minimum interval: periodic rescans use
self-scheduled timeouts, never overlap, back off when scans are slow or overlap
with another rescan, and recover toward the configured minimum after cheap
scans.

Known gaps:

- the macOS/Windows periodic rescan runs whether or not any Codex process
  could be writing rollouts; gating it on a live Codex process would stop the
  remaining idle walks there;
- `CodexSessionReader.findRolloutPathById` still walks the tree when a lineage
  ancestor's rollout id is not yet cached;
- no scan budget or time slicing;
- no date-bucket high-water mark for routine active-list discovery;
- no per-scope dirty precision for Codex project lists;
- no high-water-mark scheduler using discovery shards to scan recent date
  buckets more often than cold buckets.

This is acceptable only under YA's current single-user/small-team assumption.
It is not a design for millions of rollout files.

## Performance Failure Modes

The main costs are filesystem and metadata costs, not full transcript parsing:

- recursive `readdir` over the sessions tree;
- `stat` calls during validation and watcher rescans;
- first-line reads for new, suspect, or unindexed rollouts;
- replacement validation gaps for same-path files whose first line changes
  without changing source identity or shrinking below the cached observation;
- full decompression if compressed files are read without streaming
  first-line support;
- compressed sessions being hidden on Node runtimes without native zstd
  support;
- route fan-out that asks for global, project, inbox, and provider-catalog
  views close together.

Turning `SESSION_AUTO_ARCHIVE_DAYS` off makes default lists complete, which is
the correct user-visible default, but it also removes the old active-window
shortcut that skipped old Codex files during default scans. Completeness and
scanner cost need to be reconciled through better indexing, not hidden
session filtering.

## Required Near-Term Fixes

Before broadening Codex history discovery further, especially around compressed
transitions and very large trees, the scanner should gain:

1. An explicit validation strategy for same-identity, non-shrinking header
   overwrites; current source-fingerprint and shrink checks cover common
   replacement/truncation cases without rereading ordinary appends.
2. Add dirty-scope metrics so broad Codex invalidation is visible before
   changing the dirty-marking strategy.
3. Keep streaming zstd first-line reads covered by tests so scanner discovery
   does not regress to full compressed transcript decompression.
4. Date-bucket/high-water metrics once routine scans stop walking the whole
   tree.
5. Date-bucket or high-water missed-event recovery that avoids full-tree
   probing for routine cold history.

## Non-Goals

- Do not spawn Codex just to list local sessions.
- Do not forge or rewrite rollout files to make scanning easier.
- Do not hide old sessions by default as a substitute for a bounded scanner.
- Do not make `.jsonl.zst` default discovery depend on whole-file
  decompression.
- Do not silently replace YA-visible session ids with provider-native ids while
  refactoring the scanner.
