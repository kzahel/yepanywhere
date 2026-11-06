# No cleanup pass followed making SQLite required

SQLite became required storage on 2026-10-11
([optional SQLite](../topics/optional-sqlite.md)). Session metadata and
provider summaries moved into it, but nothing swept the server afterwards for
code written around optional storage, whole-file JSON stores, or in-memory
whole-corpus scans that SQLite now makes avoidable. This entry is the
inventory from that sweep, ranked by cost. It is a work list, not an approved
migration; each item still needs its own measurement and qualification.
[Cold-storage startup](sqlite-backed-cold-storage-startup.md) keeps owning
the eager metadata load and discovery startup cost; items 11–13 here are its
prerequisites and should be recorded there as they land.

The sweep started from a product question: hiding agent-created worktree
projects from project pickers needs a per-project rollup of
`creationProvenance.surface`. That rollup belongs in item 11, not in another
in-memory index.

Evidence below was read on 2026-11-06 at `12ff9ef4f`. Measurements come from
the maintainer's macOS data dir (1,445 metadata rows, 2.95 MB of JSON) unless
labelled as the 2026-11-04 Linux host (1,608 rows, 37 MB). The macOS server
was running the older `9dc9183b5` with database `user_version` 16, before
summary migration 25.

## Easy wins

1. **Session catalog republishes without changes.**
   `SessionCatalogService.ts:806-926` (`buildGeneration`), triggered from
   `RetainedSessionCollections.ts:240` (300 ms debounce), writes every row
   (1,526 rows, 2.4 MB, up to 64 shard files) into a new generation directory
   and rewrites an 852 KB `manifest.json`. Generations advanced about every
   2 s; 211 of the last 463 had an empty delta. Cheap fix: publish nothing
   for an empty delta, update only the manifest when only source versions
   move, and hard-link shards whose digest is unchanged. Preserve the
   epoch/generation/shard-digest token contract in
   [session catalog observation](../topics/session-catalog-observation.md).
2. **Server log has no rotation.** `logging/logger.ts:112` appends to
   `{dataDir}/logs/server.log` (8.0 GB here, opt-in via `LOG_TO_FILE`).
   File level was debug; volume is dominated by
   `CODEX_READER: scan complete` (`sessions/codex-reader.ts:2435`, about
   1 KB per line) and
   `FILE_WATCHER: rescan complete` (`watcher/FileWatcher.ts:927`). Add
   size-based rotation and demote or sample those two lines. Not a SQLite
   change, but the largest disk cost found.
3. **Whole-table metadata scans answer point questions.** Replace with SQL:
   - `app.ts:732` scans every session for `provider === "claude-ollama"` on
     each `getAllProviders()` call (per request via `routes/providers.ts:93`);
     `server-main.ts:994` repeats it at startup. Use
     `SELECT EXISTS(... WHERE json_extract(metadata,'$.provider') = ?)`
     with an expression index on that path.
   - `app.ts:1252` (Claude) memoizes sandbox session dirs on
     `getRevision()`, which advances on every metadata write; `app.ts:2058`
     (Codex) does not memoize and runs on every `readerFactory` call. Query
     `WHERE json_extract(metadata,'$.sandboxLevel') = 'project-write'`
     with a partial index (0 matching rows locally).
   - `routes/sessions.ts:9043` (`GET /api/debug/metadata`) copies the map to
     count starred/archived sessions; one aggregate query.
   - `getRecordedProviders` (`SessionMetadataService.ts:496`) becomes
     `SELECT DISTINCT`.
   - Queries must repeat the indexed expression exactly.
4. **Summary scopes are rewritten after every load.**
   `SessionIndexService.ts:473` calls `summaryStore.save` after each cold
   load, including reloads after eviction (`:382`). That runs
   `BEGIN IMMEDIATE`, rereads and re-stringifies every row
   (`SqliteSessionSummaryIndex.ts:87-104`). Save only for legacy-JSON
   imports, version bumps or summaries dropped for refresh (`:516-523`).
   Whole-scope saves at `:1770`, `:1929`, `:1975` should write changed rows
   only, as session metadata already does (listing-path callers inferred,
   not traced).
5. **Dead optional-storage code.**
   - `routes/version.ts:789` gates four capabilities on
     `getSqliteStatus?.().state === "ready"`; make it unconditional and
     drop the server-side four-state tests (`test/version.test.ts:104-148`,
     `test/storage/issue-routes.test.ts:205-210`,
     `test/storage/discovery-sqlite.test.ts:85`). Keep the wire `sqlite`
     field, the shared `SqliteStatus` union and client handling for older
     servers.
   - `SessionIndexService` (`:242` optional `database`, `:605-628`,
     `:648-700`) keeps a temp-file/lock-file JSON writer only tests reach;
     `SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS` / `_STALE_MS`
     (`config.ts:319-325`, `cli.ts:115-117`) are inert in production. Make
     the database required and run those tests on an in-memory database.
     Keep the legacy JSON read for import (item 14).
   - Speech-vocabulary legacy adoption (`VocabularyStore.ts:565-689`,
     `legacy-vocabulary-directories.ts`) probes four directories every
     start. Those layouts existed on `main` only 2026-09-09..10 and in no
     tagged release.
   - `speech_vocabulary_state` (migration 002-003) is unused; drop it in a
     new migration.
   - No-driver branches in `vocabulary-database.ts:61`,
     `codex-spawn-index.ts:57`, `opencode-db-reader.ts:150`.
   - Stale text: `topics/optional-sqlite.md:97` and `:179`;
     `gaps/vocabulary-scratch-placement-is-never-surfaced.md` names removed
     code and looks resolved;
     `gaps/sketches/network-filesystem-banner-offers-no-migration.md`
     describes current servers.
6. **List rows send the first prompt twice.**
   `retained-session-collections.ts:148` and `global-sessions.ts:790` send
   `initialPrompt` as `metadata.initialPrompt ?? fullTitle`. In a 500-row
   All Sessions response (1.26 MB) the two fields were 726 KB and equal in
   499 rows. Omit `initialPrompt` when absent or equal to `fullTitle`;
   current clients fall back (`Sidebar.tsx:137`, `SessionListItem.tsx:325`,
   `session-search/model.ts:105`, `SessionHoverCardTarget.tsx:71`). Check
   released clients inside the compatibility horizon before relying on it.
   `initialPrompt` is unbounded (largest 203 KB, from prompt-caching
   experiments) and is 1.36 MB of the 2.95 MB local metadata; it stays
   needed as the user's exact words
   ([Codex user-turn provenance](../topics/codex-user-turn-provenance.md)),
   and creation retry uses `session_creations.payload_json`, not it.
7. **`IssueStore` prepares per call.** `rows()`/`run()`
   (`IssueStore.ts:262-276`) prepare and finalize for 67 call sites, some in
   loops (`:148`, `:610-625`, `:712`, `:860-872`). Use a bounded statement
   cache like `DraftStore.ts:52`; some SQL is dynamic (`IN` lists, `:643`).

## Growing JSON stores to move into tables

Each needs a one-time import like `session_metadata`'s. Keep small, bounded
or human-edited files as JSON: recents (100), security clients, browser
profiles, remote sessions, project metadata/queues, settings and secrets.

8. **`notifications.json`** (1,441 entries). `NotificationService.ts:137`,
   `:208` rewrite the pretty-printed file on every mark-seen; entries are
   never removed on session deletion (`clearSession` only from mark-unread,
   `routes/sessions.ts:9011`). Use `session_last_seen(session_id PK, ...)`,
   kept out of `session_metadata`.
9. **`dirty-file-editors.json`** (104 KB). `DirtyFileEditorService.ts:586-606`
   rewrites the file per agent edit through a fixed `.tmp` name without
   fsync; pruning happens only when that project's git status is viewed
   (`:400-430`). Use one row per (project, path, session).
10. **`user-usage.jsonl`** (18,692 lines). `UserUsageService.ts:177` parses
    the whole file to count lines on the first append after restart; reports
    parse everything (`:139`); trim and `forgetUser` rewrite it (`:147`,
    `:220`). Use an events table indexed on (user, time); the `~60 bytes`
    comment at `:37` is about 91 in practice.

## Structural work, in order

11. **Narrow list projection.** Retained All Sessions and Inbox build an item
    for every catalog row before filtering, sorting and slicing
    (`retained-session-collections.ts:77-190`, from `global-sessions.ts:606`
    and `inbox.ts:351`), calling `getMetadata` several times per row and
    copying up to 200 recaps for the latest timestamp. Maintain a
    `session_list_projection` table (working project, archived, starred,
    category, custom title, provider, executor, creation surface, latest
    recap time) in the metadata save transaction; serve page-only fields by
    point read and full-prompt search by SQL when `q` is present. This is
    also where a per-project creation-surface rollup lives.
12. **Load metadata on demand.** Make `getMetadata` read through a bounded
    cache and drop the startup `SELECT` of every row
    (`SessionMetadataService.ts:340`, `:369`; 2.8 s on the Linux host).
    Prerequisites: items 3 and 11, and SQL replacements for the remaining
    iterators — restart recovery (`:378-409`), running clearloops (`:661`),
    bang-command and cache-miss billing lists (`bang-commands.ts:142`,
    `:379`; `settings.ts:299`). Pin dirty entries until commit (`:1514`,
    `:1540`), distinguish absent from deleted (`:282`, `:1488`, `:1502`),
    and keep reference-equality callers (`:706`) correct. Consider moving
    `initialPrompt` to its own column so a cache miss does not parse it.
13. **Catalog rows in SQLite.** Replace generation directories with
    upserted rows plus a change table carrying the delta/generation token.
    The catalog is rebuildable, so it can start a fresh epoch instead of
    converting data. Do after item 1 and once 11–12 settle the query shape.
14. **Retirement policy for one-time imports.** `session-metadata.json` is
    never read after import (`SessionMetadataService.ts:416-470`, shipped
    v0.10.0) and summary JSON scopes are read only on a scope miss
    (`SessionIndexService.ts:502-508`, unreleased), but nothing deletes
    either (10 MB of `indexes/*.json` here; un-opened scopes never import).
    [Backward compatibility](../topics/backward-compat.md) covers the wire
    only. Decide how many releases import code stays, whether a bounded
    post-startup bulk import should finish the summary scopes, and when the
    files may be removed. Keep `indexes/git-untracked/`,
    `session-discovery/` and the project scanner cache; they are live.

## Not recommended

- Merging `speech-vocabulary.sqlite` into `discovery.sqlite`: the vocabulary
  file uses WAL with `synchronous=OFF` for relearnable counts
  (`vocabulary-database.ts:66-74`); the discovery file uses a rollback
  journal for durable data.

## Smaller findings

- `ModelInfoService.ts:197` writes `model-context-windows.json` non-atomically.
- `artifacts/` held 48 orphaned staging files from September, including
  32-byte `app-access.key.<uuid>` copies (`VhostAccess.ts:56-64`); sweep
  staging files on load.
- `peer_api_outbound` and `agent_api_receipts` have no delete path
  (intentional durable receipts not verified).
- `IssueStore.ts:916-960` aggregates all visible evidence per issue-list
  request with unanchored `LIKE`; experimental and gated, so lower priority.

## Unverified

- Linux-host costs for item 3 queries are extrapolated from the local
  2.95 MB (7 ms to extract seven fields from every row).
- Which fields make up the Linux host's 37 MB; display objects and recaps,
  absent locally, may dominate there.
- Bun's system SQLite on macOS supporting generated columns; expression
  indexes avoid needing them.

Found 2026-11-06 while advising on hiding agent-created worktree projects
from project pickers.
