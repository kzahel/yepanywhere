# No cleanup pass followed making SQLite required

SQLite became required storage on 2026-10-11
([required SQLite](../topics/required-sqlite.md)). Session metadata and
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

1. Fixed 2026-11-09 by plan 189 step 3: a scan that changes nothing
   writes nothing and advances no generation. **Session catalog
   republishes without changes.** Moved to
   [session catalog rewrites](session-catalog-rewrites-whole-generation-per-change.md),
   with 2026-11-09 measurements: 7,470 rows and 14.3 MB per generation,
   every 3.8–7.6 s. "Update only the manifest when only source versions
   move" cannot work as written, because file adapters stamp
   `reconciliation:<generation>` as their source version on every
   publication.
2. Fixed 2026-11-09 by plan 189 step 2: `server.log`, `sdk-raw.jsonl` and
   `codex-correlation-debug.jsonl` rotate at 100 MiB and keep two archives
   (`logging/rotating-file-stream.ts`). The Codex scan line already logs
   only on cache misses (`abd8cd45e`). Original finding:
   **Server log has no rotation.** `logging/logger.ts:112` appends to
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
   - Fixed 2026-11-09 by plan 189 step 2: `SessionIndexService` requires
     the database; its JSON writer, write locks, legacy JSON read and the
     `SESSION_INDEX_WRITE_LOCK_*` settings are gone, and its tests run on a
     scratch database.
   - Speech-vocabulary legacy adoption (`VocabularyStore.ts:565-689`,
     `legacy-vocabulary-directories.ts`) probes four directories every
     start. Those layouts existed on `main` only 2026-09-09..10 and in no
     tagged release.
   - `speech_vocabulary_state` (migration 002-003) is unused; drop it in a
     new migration.
   - No-driver branches in `vocabulary-database.ts:61`,
     `codex-spawn-index.ts:57`, `opencode-db-reader.ts:150`.
   - Stale text: `topics/required-sqlite.md:97` and `:179`;
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
13. Done 2026-11-09 by plan 189 step 3. **Catalog rows in SQLite.** Now owned by
    [session catalog rewrites](session-catalog-rewrites-whole-generation-per-change.md),
    which gives the table shape and the defects to fix first.
14. Fixed 2026-11-09 by plan 189 step 2, with one deviation: the
    `session-metadata.json` import code stays, because 0.9.2 (the last
    release before the import) is still a direct upgrade source and the file
    is not rebuildable. Each leftover file is deleted by a later start that
    finds its import marker (metadata and public shares); legacy `indexes/*.json` scopes are deleted on start once they
    parse as summary scopes, and their import code is gone. Original
    finding:
    **Delete the one-time import leftovers.**
    - `session-metadata.json` (2.8 MB) is never read after import
      (`SessionMetadataService.ts:331`, guarded by the
      `session_metadata_import` marker).
    - The legacy `indexes/*.json` summary scopes are rebuildable from
      provider files, so un-imported scopes lose nothing.
    - `public-shares.legacy-backup.json` is item 19.

    The only argument for keeping them is a downgrade to a build that
    predates the import. The
    [backward compatibility](../topics/backward-compat.md) entry for
    2026-10-11 already says downgrading is not supported. So delete them
    once the import marker is confirmed, and drop the import code with them. Keep
    `indexes/git-untracked/`, `session-discovery/` and the project scanner
    cache; they are live.

## Second sweep, 2026-11-09

Re-read at `807b297af` against the maintainer's macOS data dir. Items 3, 4,
5, 6, 8, 9, 10, 11, 12 and 14 still hold; line numbers moved, sizes grew.
Current figures:
- `session_metadata`: 4,672 rows, 4.16 MB.
- `notifications.json`: 7,343 entries, 727 KB.
- `dirty-file-editors.json`: 186 KB, written within the last minute.
- `user-usage.jsonl`: 12,908 lines, 81 bytes each on average.
- legacy `indexes/*.json`: 763 files, 14.1 MB. About 234 scopes were never
  imported (assuming one file per scope).

The debug metadata count moved to `routes/session-metadata-routes.ts:126`
and the mark-unread route to `routes/session-metadata-routes.ts:94`.

The catalog findings (cache budget below the catalog's size, pathless
invalidation from the issue indexer, double publication) are recorded in
[session catalog rewrites](session-catalog-rewrites-whole-generation-per-change.md).

15. **Whole-catalog reads answer point questions.**
    - Content search reads the full catalog per 128-record batch, and again
      in `isCurrent`, to find one row by linear search
      (`routes/session-content-search.ts:109-111`, `:152-157`).
    - Recents projects all 7,470 identities to enrich at most 100 visits
      (`routes/recents.ts:67-75`).
    - The projects inventory projects the whole catalog for one project card
      when creation projections exist (`app.ts:3242-3260`). Clients refetch
      projects on `process-state-changed`.
    - The experimental conversation source does a full read to resolve one
      session (`app.ts:3573`).
    - `GET /api/issues` and `GET /api/issues/sessions` project the whole
      catalog per request (`app.ts:3794-3799`, `routes/issues.ts:262`,
      `:290`).

    These should be per-project or SQL point reads.
16. **Inbox and the sidebar feeds each walk the whole catalog.** Each tab
    runs three retained sidebar feeds and Inbox. Each walk projects and
    overlays all rows before slicing a page, with no shared result between
    them (`global-sessions.ts:594-628`, `inbox.ts:355-357`). Inbox also
    refetches on `session-updated`, `process-state-changed`, `session-seen`
    and `session-metadata-changed`. Item 11's list projection table is the
    structural fix. Until then, one projected list per combined clock
    (catalog token, identity revision, metadata revision, process and
    notification clocks) could serve all of them.
17. **Session summaries are kept twice.** The same summaries live in
    `session_summary_index` (13.1 MB), in `SessionIndexService`'s
    in-memory scope cache (limit 10,000 scopes) and in the catalog (14.3 MB).
    Two freshness mechanisms keep them current: dirty tracking plus a 30 s
    directory check (`SessionIndexService.ts:1261`, `:1549-1589`), and
    catalog invalidation. The project page still uses the older per-project
    walk (`projects.ts:1052`). Fold the catalog's list columns into the
    summary table and serve the project page from it.
18. **`gemini-project-map.json` records every Claude/Codex project path.**
    It holds 3.64 MB and 20,053 entries; 19,914 are temp-directory paths and
    69 still exist. The cause is that every project scan registers all seen
    paths (`scanner.ts:1206` → `gemini-scanner.ts:111` →
    `gemini-project-map.ts:221`). Any new path copies the whole map and
    rewrites the whole pretty-printed file (`gemini-project-map.ts:91-118`).
    `clean()` (`:200`) has no production caller. Persist only hashes that
    match an existing Gemini directory, then purge. A table would fix the
    write cost but keep the junk.
19. Fixed 2026-11-09 by plan 189 step 2: a later start or enable that finds
    the migration marker already complete deletes the backup. Original finding:
    **`public-shares.legacy-backup.json` (2.1 MB) has no cleanup.** The
    migration completed on 2026-10-02, but the store still probes the file
    (`PublicShareStore.ts:404`, `:413`, `:468`). It would re-migrate from
    it if `migration.json` went missing (`:422-425`). Fold it into item 14.
20. **The Codex discovery cache rewrites a whole day per change.** It keeps
    one pretty-printed JSON file per day: about 220 files, 3.4 MB
    (`SessionDiscoveryIndex.ts:316-335`). Loaded days are never evicted
    (`:121`, `:225-245`). Low priority; the
    [Codex thread index research](../docs/research/codex-native-thread-index.md)
    step 2 is the alternative.

21. **The Codex tree watcher is probably redundant for listing.** Codex's
    `state_5.sqlite` already reports changed threads; the periodic rescan is
    hinted by it (`codex-thread-index.ts`). Tree-wide file-change events
    still feed three consumers:
    - the catalog and summary index;
    - external session tracking (`ExternalSessionTracker.ts:337`);
    - live transcript updates for an open, externally run session.

    The index updates a thread's row at most every ~5 s for ordinary appends
    and cannot see deleted files. So the likely shape is the index as the
    list's change source, plus per-file watches only for sessions being
    viewed or tracked as running, plus a rare walk for deletions and for
    Codex homes without an index. This needs measurement of live-view
    latency before the tree watch is removed.

Not candidates: the small capped stores
also stay files: security clients, recents, project metadata and queues,
review comments, browser profiles, and remote sessions. Line numbers for
the fixed-`.tmp` writers in
[atomic file writes](atomic-file-writes-have-many-private-copies.md) are
stale. SecurityClientService is now `:1741`, ProjectQueueService `:1311`
and DirtyFileEditorService `:598`.

## Third sweep, 2026-11-09: by pattern

Read at `036500d47` against the same data dir: every server-side store,
every table in `discovery.sqlite`, whole-corpus memory, and client storage.
It confirms item 14's diagnosis of `indexes/*.json`: 356 files written after
the import came from the older `9dc9183b5` build, which still wrote JSON
(244 of them in one minute on 2026-11-05). Since 2026-11-06 only
`project-scanner-cache.json` changes there. The holdover shows up in five
patterns.

**JSON-blob tables.** Two tables ported from JSON files keep one blob per
key in `WITHOUT ROWID` tables. Rows over about 1 KB overflow, and the
overflow pages are about half empty: 10.1 MB of 19.7 MB for summaries,
3.5 MB of 6.5 MB for metadata (`dbstat`).

22. **`session_summary_index` should be a rowid table with `full_title` in
    a column.** `fullTitle` is 8.57 MB of the 13.15 MB of summary JSON,
    uncapped (max 28,525 characters; the catalog caps at 16,384).
    `read()` parses a whole scope (`SqliteSessionSummaryIndex.ts:51-56`);
    the largest scope is 2.5 MB. Callers look up by scope or
    (scope, session) only, so no new indexes are needed.
23. **`session_metadata` should be a rowid table with `initial_prompt`
    and `working_project_id` columns.**
    - `initialPrompt` is 2.53 MB of 4.19 MB of metadata JSON.
    - `goalCommand` stores 1,103 copies of 15 distinct descriptors
      (449 KB).
    - 1,578 rows hold nothing but `provider`. It does not duplicate
      `session_identities.provider`: metadata records providers YA ran,
      identities also cover natively discovered sessions. Here identities
      hold 6 `claude-ollama` sessions metadata never recorded, so item 3's
      Ollama check (`app.ts:723-733`) and `getRecordedProviders`
      (`SessionMetadataService.ts:495`) cannot switch to identities. Give
      `provider` its own column instead.
    - 379 rows (405 KB) have neither an identity nor a summary and are
      never pruned.
    - Relationship visibility parses the whole blob for
      `$.workingProjectId` (`authorized-relationship-source.ts:32-37`).
24. Fixed 2026-11-09 by plan 189 step 4: jobs keep a `catalog_key`
    (migration 029), the worker reads the current row, a removed catalog row
    deletes its jobs; the table went from 8.5 MB to 1.9 MB here. Original
    finding:
    **`issue_index_jobs.source_json` is a whole catalog row.** 6.14 MB for
    2,043 jobs, 72% of it titles (`IssueIndexer.ts:188`). Every catalog
    generation loads all of them (`IssueStore.ts:306-320`) and compares
    full JSON strings to detect change (`IssueIndexer.ts:188-198`). Store a
    digest and the locator fields only. No path deletes a job: 371
    describe sessions idle since before 2026-10-10 and 64 `/tmp` projects.
    Issue indexing is off by default (`shared/src/issues.ts:26-30`); this
    host enables it at `recent` scope.

The same prompt text is now stored about five times: catalog titles
(8.6 MB), summary `fullTitle` (8.57 MB), issue job titles (4.42 MB),
metadata `initialPrompt` (2.53 MB) and creation payloads (620 KB). Items
22–24 remove most of it without a new design.

**Whole-file stores.**

25. Fixed 2026-11-09 by plan 189 step 2: snapshots persist the HEAD sha
    and an index digest (cache version 2); tilefun's file went from 4.6 MB
    to 584 bytes. Original finding:
    **`indexes/git-untracked/` persists the tracked tree.** The tilefun
    file is 4.6 MB with zero untracked files: 33,267 `headPaths` plus the
    same 33,267 `indexPaths`. It is rewritten on HEAD or index changes,
    on the first query after an hour, and when a queried path is due its
    recheck
    (`GitUntrackedCacheService.ts:270-290`, `:359`, `:397-409`). Persist
    the HEAD sha and an index digest instead; this needs no table.
26. **`agent-auth-router/private.json` never deletes an allocation.**
    325 allocations, 120 KB, rewritten with fsync on each change
    (`AgentAuthRouter.ts:409-422`); `retire` only marks `cancelled`
    (`:994-1003`), and only 9 are. Records also back the
    `refusedBeforeCommit` retry check (`:1203-1207`), so pruning needs a
    router-side cancel for sessions that are gone and a retention rule for
    that check; it is not a plain deletion. Entries hold tokens, so a
    table needs the same 0600 protection.
27. Fixed 2026-11-09 on the maintainer's profile (a data cleanup, no
    code): 1,227 fixture `review-comments.json`, 444 `source-review/` trees
    and 369 `@example.com` palettes were archived to
    `~/yep-anywhere-cleanup-backup-2026-11-09.tar.gz` and deleted; 47 of
    1,644 project directories remain (140 MB, real attachments and
    palettes). Original finding:
    **`projects/` holds August test fixtures.** By bytes it is 152 MB, of
    which 146 MB is real attachments. But every one of the 1,227
    `review-comments.json` files is a fixture (`src/a.ts`,
    `src/missing.ts`, `src/present.ts` anchors), none changed after
    2026-08-27, and about 369 author palettes hold the `t@example.com`
    author of `test/git/blame.test.ts`. The source was
    `test/routes/review-submissions.test.ts`, which built services without
    a data dir; `7cbf87e34` made test homes hermetic. Delete the fixtures.
28. **`indexes/project-scanner-cache.json` is rewritten per scan.** See
    item 31.

**Whole-corpus work per catalog generation.** These run every 3.8–7.6 s
on an active host and go away with a `changed_generation` delta from the
catalog table:

29. Fixed 2026-11-09 by plan 189 step 4 (sweeps read `changed_gen`
    changes: 1 ms for 1–2 rows against 118 ms in full). Original finding:
    The issue indexer sweep projects identities for all 7,470 rows and
    stringifies every recent row on each generation (`app.ts:3704-3739`,
    `IssueIndexer.ts:99-168`).
30. Fixed 2026-11-09 by plan 189 step 4: the project view folds only the
    projects a change touches, and `projects-changed` names only projects
    whose facts changed. On this host the all-ids events came from item 31's
    retained refresh, which now names only changed projects too. Original
    finding:
    The project view walks every row each generation
    (`RetainedSessionCollections.ts:234-260`, `catalog-projects.ts:33-80`).
    Its version includes `lastActivity`, so a `projects-changed` carrying
    every project id goes out whenever any session advances, and every
    mounted project page refetches the whole-catalog inventory
    (item 15). Inferred: those refetches mostly coalesce with the
    catalog event's.
31. The legacy `ProjectScanner` still rescans on every session file change
    (`scanner.ts:506-550`): one `readdir` of the changed Claude directory
    (1,253 entries for this repository), the Gemini path registration of
    item 18, a rewrite of its cache file, and its own `projects-changed`
    with every project id (`scanner.ts:473-484`). Changes are coalesced
    over 300 ms. It duplicates the catalog's project view; serving
    projects from the catalog instead touches about 90 call sites.
32. Smaller: while the Agents page polls, the host agent process lookup
    walks every row about once a minute per process, behind a 60 s
    correlation cache (`host-process-catalog.ts:40-55`,
    `HostAgentProcessService.ts:18`); `getRecordedProviders` runs about
    five times per `scanner.getProject` and
    `getAllMetadata()` copies the whole map per call (add both to item 3);
    limited-user grants expand every creation projection per request and
    per event (`app.ts:969-1031`, `:4570-4580`; off here).

**Missing retention.**

33. Fixed 2026-11-09 by [plan 189](../docs/tactical/189-session-catalog-in-sqlite.md)
    step 1: session creation no longer counts lifetime totals. Per-request,
    per-attempt and per-operation bounds remain, including 2 GiB of
    attachments per operation.
34. Partly fixed 2026-11-09 by plan 189 step 2: `sdk-raw.jsonl` rotates
    as in item 2; client logs are appended asynchronously, kept 14 days and
    capped at 32 MiB per device per day. Audit archives, tool-result media,
    empty staging directories and attachments remain. Original finding:
    Unbounded logs and caches: `logs/sdk-raw.jsonl` (747 MB, opt-in
    `LOG_SDK_MESSAGES`, about 37 MB/h, no rotation,
    `sdk/messageLogger.ts:28-41`); client logs written with
    `appendFileSync` on the request path (`routes/client-logs.ts:73`,
    mounted whenever a data dir is set; clients post only in developer
    mode);
    audit log archives never pruned (`security/auditLog.ts`); preserved
    tool-result media; 483 empty upload staging directories and 17 empty
    queue ones. Attachments themselves (`uploads/` 395 MB, mostly legacy,
    and 146 MB under `projects/*/attachments`) have no retention policy;
    transcripts refer to them, so that is a product decision.
35. `draft_receipts` holds 13,003 rows (8.1 MB). The 30-day / 20,000-receipt
    retention is a documented replay contract
    ([draft synchronization](../topics/draft-synchronization.md)), checked
    before the 10-minute write ticket (`DraftStore.ts:140-146`), so it
    stays. The per-write `count(*)` over the owner's receipts
    (`:181-184`) can become a maintained counter. 372 of 529
    `session_summary_scopes` are empty and never removed.

**Client storage.** No server corpus is cached in localStorage or
IndexedDB. Two paths parse more than they need:

36. Each draft keystroke parses the draft envelope about six times and
    serializes it once (`sessionDraftStorage.ts:137-178`,
    `draftSyncStorage.ts:701-737`). It is bounded by one draft, but a
    pasted prompt of a few hundred KB would pay that per keystroke;
    measure against the 100 ms rule, then parse once.
37. Scroll memory walks every localStorage key per read and three times
    per write, and never evicts (`sessionScrollMemoryStorage.ts:164-340`).

Outside the server: the relay parses every daily telemetry file per
`/stats` request and keeps them forever (`relay/src/stats.ts:131-158`),
though it already has SQLite.

### Recommended order

Planned in [plan 189](../docs/tactical/189-session-catalog-in-sqlite.md).

1. Remove the item 33 ceiling (done, plan 189 step 1).
2. Cheap deletions and caps with no schema work: items 2, 25, 27, 34, 14,
   19 and part of 5 (done, plan 189 step 2). Item 26 needs a retention rule
   first.
3. The catalog table
   ([session catalog rewrites](session-catalog-rewrites-whole-generation-per-change.md)),
   designed together with items 22–24 so titles and prompts are stored
   once and rows are keyed for joins. Its `changed_generation` delta then
   fixes items 29–31 and 15 by construction. The catalog's own 30 MB of
   generation directories go with it.
4. Items 11 and 12 (list projection and metadata on demand), which depend
   on item 23's columns.
5. Item 21 (Codex index as the change source) and the client items 36–37
   as measurement shows need.

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
