# Codex's native thread index and cold session data

Research and proposal, 2026-11-06. Nothing here is a current contract or is
implemented. Current behavior is owned by
[Codex metadata scanner](../../topics/codex-metadata-scanner.md),
[session catalog observation](../../topics/session-catalog-observation.md),
[provider child sessions](../../topics/provider-child-sessions.md) and
[built-in SQLite storage](../../topics/optional-sqlite.md#session-metadata).
The open defect is
[sqlite-backed-cold-storage-startup](../../gaps/sqlite-backed-cold-storage-startup.md).

## Summary

- Codex already maintains an index of its threads: the `threads` table in
  `~/.codex/state_5.sqlite`. It holds every fact YA's Codex enumeration
  derives from the filesystem, and more. On the measured host it matched the
  rollout files exactly.
- It is not authoritative. Codex itself treats rollouts as the source of
  truth and repairs the table from the filesystem when it lists threads. YA
  could list from the index first and still reconcile against the
  filesystem, but much less often and much more cheaply than today.
- Most of the Codex scan activity measured on this host was not filesystem
  cost. It was list-route fan-out over every project, plus a five-second
  cache expiry the running server predated. An index does not remove the
  fan-out; that needs fixing on YA's side regardless.
- Session metadata residency is small locally (about 3 MB of JSON in a heap
  of about 900 MB). Making cold metadata lazy is worthwhile for startup and
  for multi-year growth, but needs SQL replacements for the whole-corpus
  readers first.
- `server.log` grows without a cap and is the fastest-growing cost found.

## Measurements on the maintainer's macOS host

Taken 2026-11-06 against the running server (PID 10380, started 2026-11-02
09:52, before `28f7d6021`), its `~/.yep-anywhere` and `~/.codex`.
Single-host diagnostic evidence, not a benchmark.

### Session metadata

- `session_metadata`: 1,443 rows, 2,947,494 JSON characters, average about
  2 KB, largest 206 KB.
- `initialPrompt` is 1,362,329 characters (46%). Four rows with pasted
  prompts of 160–206 KB account for about 23%. Next are `goalCommand`
  (396 K), `routerBinding` (265 K) and `effectiveLaunchSettings` (258 K).
- Growth: startup logs report 882 rows on 2026-10-12 and 1,347 on
  2026-11-02, about 22 rows a day, or roughly 8,000 rows and 16 MB of JSON
  a year at this host's pace.
- The Linux host measured in the gap had 1,608 rows totalling 37,338,228
  characters (about 23 KB a row) and took 2,776 ms to load under heavy
  contention. Its field breakdown was not measured.

### Server memory

- `server_resource_sample` heap: 111 MB at 61 s uptime, about 600 MB after
  4 hours, 850–1,000 MB after about 4 days, against a 4,288 MB limit. RSS
  is 0.9–1.4 GB.
- Metadata is perhaps 1–2% of that heap. What holds the rest, and whether
  the slow climb is cache fill or a leak, was not determined. A heap
  snapshot would answer both.

### Logs

- `~/.yep-anywhere/logs/server.log` is 8,018,898,916 bytes, written since
  2026-09-20, with no rotation or cap.
- The last 50 MB covered about 151 minutes (about 480 MB a day at that
  rate). `codex_reader_scan` debug lines were 40,005 of those lines and 83%
  of the bytes; the next largest sources were `[ActivitySubscription]`
  (11,621 lines) and `[FileWatcher]` (3,474).
- [Disk-full degraded mode](../../topics/disk-full-degraded-mode.md) already
  proposes caps and rotation.

### Codex scan activity

During those 151 minutes no Codex thread was updated (the newest
`updated_at` was 2026-11-05 08:39):

- 40,702 `codex_reader_scan` events: 866 for each of 47 projects, arriving in
  bursts that touch every project, one to six seconds apart. 38,668 were
  shared-cache hits taking 0 ms; each still copied the cached list of about
  419 sessions and logged a line.
- 376 were misses, about five seconds apart: full walks of
  `~/.codex/sessions` (454 `stat` calls, about 10 ms). This is the
  five-second TTL fallback. `28f7d6021` (2026-11-04, "Stop re-walking idle
  Codex history while its watcher observes it") keeps the cache trusted
  while the watcher is healthy; the running server predates it.
- `file_watcher_rescan` for Codex ran every 5 s (1,570 times), visiting 49
  directories and 454 files in about 5 ms, with `periodicRescanBackoffReason`
  `unchanged`. The backoff lengthens the interval only for slow or
  overlapping rescans, never for an unchanged tree. The scanner topic already
  lists gating this on a live Codex process.

The bursts come from callers that list every project through
`listSessionsAcrossProviders`: the complete paths in
`routes/global-sessions.ts` (the session list and `computeGlobalStats`) and
`routes/projects.ts`. Clients revalidate on `session-catalog-updated`. The
retained collections described in
[session catalog observation](../../topics/session-catalog-observation.md#retained-global-sessions-and-inbox)
should not fan out this way, so some caller is still on a complete path.
Which route and client was not attributed; adding a caller label to the
scan metric would settle it.

## `~/.codex` layout

- `sessions/YYYY/MM/DD/rollout-<local-time>-<thread-id>.jsonl` — one
  append-only rollout per thread, filed by creation date. Rollouts cold for
  seven days may be compressed to `.jsonl.zst`. Measured: 454 files (109
  plain, 345 compressed), 1.1 GB.
- `archived_sessions/` — archived rollouts, flat. Absent on this host.
- `state_5.sqlite` — the thread index (below). 2.8 MB, WAL mode.
- `thread_history_1.sqlite` — per-thread turns and items projected from
  rollouts. 929 MB.
- `logs_2.sqlite` (Codex's own logs), `goals_1.sqlite`, `queue_1.sqlite`,
  `memories_1.sqlite`, `sqlite/codex-dev.db`.
- `config.toml`, `auth*.json`, `AGENTS.md`, `models_cache.json`,
  `.codex-global-state.json`.
- `history.jsonl` (prompt history) and `session_index.jsonl` (two rows of
  thread names here). Neither is a usable thread index.
- Runtime state: `app-server-daemon/`, `app-server-control/` (the daemon's
  control socket), `ipc/`, `thread-writer-locks/`, `.tmp/` (compression and
  maintenance locks).
- `plugins/` (404 MB), `cache/`, `skills/`, `computer-use/`, `browser/`,
  `packages/`, `shell_snapshots/`.

## The `threads` table

Columns used or useful to YA: `id`, `rollout_path`, `created_at(_ms)`,
`updated_at(_ms)`, `recency_at(_ms)`, `cwd`, `title`, `name`, `preview`,
`first_user_message`, `archived`, `archived_at`, `source`, `thread_source`,
`model`, `model_provider`, `reasoning_effort`, `agent_nickname`,
`agent_role`, `agent_path`, `history_mode`, `is_pinned`, `project_id`,
`attached_thread_parent_id`. Indexes cover `created_at`, `updated_at`,
`archived`, `source` and `model_provider`; there is none on `cwd`.
`thread_spawn_edges` maps parent to child.

On this host: 454 rows for 454 files and no file without a row; 47 distinct
`cwd` values; 416 rows with a title; all 454 `history_mode = 'paginated'`.
The newest rows' `updated_at` equalled the rollout mtime. `rollout_path`
named the `.jsonl` file for all 345 compressed rollouts.

YA's `CodexSessionFile` (`packages/server/src/sessions/codex-reader.ts`)
carries id, file path, cwd, start timestamp, mtime, size, subagent flag,
parent id, nickname, role and spawn depth. All but `size` are in the table;
title and preview are extra. YA already reads this database read-only for
child-session lookup (`codex-spawn-index.ts`), pinned to rust-v0.166.0's
schema.

## Codex semantics

From `~/github/codex` at `ddd1812a51` (2026-11-06); paths are relative to
`codex-rs/`. Much of this was gathered by a delegated source read and
spot-checked: the commit identities and the append ordering in
`LiveThread::append_items` were confirmed directly.

**Writes.** A thread's row is deferred until it has persisted history
(`thread-store/src/thread_metadata_sync.rs:99-102`). Each append flushes the
rollout first, then writes the row in the same task
(`thread-store/src/live_thread.rs:229-253`). The flush does not fsync, so the
row can lag the rollout but should not lead it. Metadata-bearing items
(`SessionMeta`, `TurnContext`, `UserMessage`, `TokenCount`, goal and settings
updates; `state/src/extract.rs:54-70`) patch the row. Other items only touch
`updated_at`, throttled to once per 5 s
(`thread_metadata_sync.rs:28,200-211`). `TurnStarted` advances `recency_at`.
Title, preview and first message come once from the first user message;
renames and archive state change only through explicit operations. Most
observed-metadata write failures are logged and swallowed
(`update_thread_metadata.rs:627-635,744-758`). A crash can leave the row about
5 s or one patch behind the rollout.

**Coverage.** App-server (including the daemon) and the embedded TUI require
the database; app-server replaces a corrupt one with a fresh file
(`app-server/src/lib.rs:675-683,1435-1478`). `codex exec` treats it as
best-effort and keeps writing rollouts without it (`exec/src/lib.rs:722`,
`rollout/src/state_db.rs:45-54`). The `sqlite` feature has been always-on
since it was removed as a flag; before `eace7c6610` (2026-02-23) it was off by
default, so older binaries wrote no rows. Location precedence is the
`sqlite_home` config value, then `CODEX_SQLITE_HOME`, then `CODEX_HOME`, and a
managed requirement can override both (`core/src/config/mod.rs:284-293,
4405-4423`).

**Backfill and repair.** Backfill walks `sessions/` and `archived_sessions/`
once, until `backfill_state.status` is complete, and never again
(`rollout/src/state_db.rs:130-192`, `rollout/src/metadata.rs:271-381`).
Ongoing repair happens inside Codex's own default `thread/list`, which scans
about twice the page size of newest files and upserts rows before querying
(`rollout/src/recorder.rs:582-670`). Listing skips rows whose file is missing
but nothing prunes them (`state_db.rs:455-469`).

**Compression and archiving.** Compression is the
`local_thread_store_compression` feature (off by default upstream; enabled
by some means on this host, not determined). It compresses rollouts cold for
seven days, writes `.zst` beside the original and deletes the original
(`rollout/src/compression.rs:369-411,947-972`). It never updates
`rollout_path`; readers try `.jsonl` and then `.zst`. Resuming a compressed
thread decompresses it. Archiving moves the file flat into
`archived_sessions/` and updates `rollout_path`, `archived_at` and
`updated_at` (`thread-store/src/local/archive_thread.rs:80-148`).

**Versioning.** `95ca276373` ("sqlite: no more destructive version bumps")
fixed the filename at `state_5.sqlite`. Schema changes are additive sqlx
migrations (62 so far). Journal mode is WAL with `synchronous=NORMAL`; on NFS
it is DELETE. Codex opens read-only connections itself. Long read
transactions would stall WAL checkpoints. No documentation either invites or
forbids external readers.

**Change signals.** There is no revision column and no tombstones;
`updated_at_ms` is monotonic only within one Codex process, backfill can write
older values, and deletes are hard. `PRAGMA data_version` on a persistent
read connection changes on any commit by another connection, including the
frequent `TokenCount` patches. The app-server's global notifications
(`thread/started`, `thread/archived`, `thread/name/updated`,
`thread/status/changed`, …) cover only threads that server process hosts, and
there is no `thread/updated`. `thread/list` supports cursor pagination,
`created_at`/`updated_at`/`recency_at` sort keys, and `cwd`, `archived`,
source, provider and title-search filters; `useStateDbOnly` skips its
filesystem repair.

**`thread_history_1.sqlite`.** `thread_turns` and `thread_items` hold
per-turn status, timing and rollout byte offsets, and per-item JSON in the
app-server v2 item shape. `thread_history_projection_state` records the next
byte offset and ordinal. It is projected incrementally after durable writes
for paginated threads only (`thread-store/src/local/live_writer.rs:436-452`).
Codex calls it a rebuildable view that may lag the rollout. Rows are keyed by
rollout id, which can differ from the thread id after revert or fork; the
mapping was not confirmed.

## Proposed direction

The steps are ordered by measured value; each stands on its own.

### 1 — remove list fan-out

Identify the remaining callers that enumerate every project on each
`session-catalog-updated` and move them to the retained collection, or list
once per request grouped by project instead of once per project. Stop logging
every shared-cache hit (sample it, or log only misses and slow scans). Restart
long-lived servers so they run `28f7d6021`. This needs no Codex index.

### 2 — list Codex sessions from `threads`

Select explicit columns, filtered by `cwd` and an `updated_at` window, through
the existing `updated_at` index. Old history is then read only when a query
asks for it, which is the cold-storage idea applied to the catalog. Title and
preview come without reading rollout heads. Resolve `.jsonl` then `.zst` as
Codex does. Resolve the database location the way Codex does, per native
scope, and never borrow an ambient `CODEX_SQLITE_HOME` for a different scope,
matching the existing child-index rule.

### 3 — detect changes with `data_version`

Hold one read-only connection with no open transaction and poll
`PRAGMA data_version` every one to two seconds; when it changes, query
`WHERE updated_at_ms > ?` with some overlap, since timestamps are not a
strict sequence. Keep the file watcher for live appends to open sessions, and
drop the five-second full-tree periodic rescan.

### 4 — reconcile by directory, not by file

Rollout filenames carry the thread id and creation time. A directory's mtime
changes when an entry is added, removed or renamed, including compression;
appends do not change it. So reconciliation can `stat` about 70 date
directories, re-list only those whose mtime changed, and diff names against
row ids. Files with no row go through the existing head read and discovery
index. Rows whose files are gone are dropped. Run it at startup and
infrequently, and fall back to today's enumeration when the database is
missing, replaced (file identity changes), unreadable or has an unexpected
schema.

### 5 — consider `thread_history_1` for transcript pages

For paginated threads it could serve turn and item pages, and its byte
offsets allow tailing the rollout from a known position. It uses a different
item shape from the rollout parser, lags the rollout and excludes legacy
threads, so it is a larger change. Evaluate after the list side.

### Cold session metadata

Independently of Codex: `SessionMetadataService` keeps every row parsed in
memory. A plain LRU cache would thrash on list routes that call `getMetadata`
for every listed session on each refetch, and about nine whole-corpus readers
(recorded providers, running clearloops, cache-miss billing events,
display-object recovery, Ollama checks, sandbox directory scans, the stats
route) would reload everything. The workable shape:

- replace those whole-corpus readers with SQL queries;
- store list fields (provider, starred, archived, title, project) as columns,
  so lists never parse whole rows;
- keep a resident hot set — sessions with a live process, a running
  clearloop, pending recovery state, recent use — and load the rest on demand
  (SQLite reads are synchronous, so `getMetadata` can stay synchronous);
- return copies or read-only views, since an in-place mutation of an evicted
  object would be lost silently.

The cheapest first slice is keeping `initialPrompt` out of the resident
object.

## Constraints to preserve

- Rollouts remain the source of truth; the index is an accelerator, and
  every recovery case in
  [Codex metadata scanner](../../topics/codex-metadata-scanner.md) —
  replacement, truncation, deletion, new files, compressed representations,
  missed watcher events — must still converge.
- No hidden sessions: complete default lists stay complete (that topic's
  non-goals).
- [Provider child sessions](../../topics/provider-child-sessions.md#freshness-and-resource-use)
  currently limits `state_5.sqlite` to a locator. Promoting it to a listing
  source changes that policy and needs the maintainer's decision.
- Codex compatibility edits follow
  [provider development](../development/providers.md): pin the upstream
  version and select explicit columns.
- Native SQLite access stays read-only with short transactions and finite
  connection leases, as `codex-spawn-index.ts` does.

## Open questions

- Which route and client produce the per-project scan bursts.
- What holds the ~900 MB heap, and whether it keeps growing.
- What makes the Linux host's metadata rows ten times larger.
- How YA-launched `codex exec` sessions behave when the database cannot be
  opened, and how often that happens in practice.
- How compression came to be enabled on this host.
- The rollout-id to thread-id mapping in `thread_history_1` after revert or
  fork.
