# Session catalog in SQLite

Topic: catalog-identity-projection-cost

Status: in progress. Proposed 2026-11-09 and checked against the code at
`db161ab3c` and the maintainer's profile the same day. Steps 1–6 done
2026-11-09: the catalog lives in `discovery.sqlite`, the `session-catalog/`
files are imported once and deleted, its server consumers read what
changed, summary rows keep the full title in a column, and session metadata
keeps its queried fields in columns. Step 7 done in part the same day: list
reads keep bound identity projections and cost about a third of what they
did; paging lists in SQL waits for items 8 and 11 (see step 7).

## Goal

Keep each per-session fact in one place, in the profile database, and make
a change to one session cost one row write. Today one session's facts live
in four places:
- the catalog's whole-generation shard files;
- the summary parse cache;
- the session metadata JSON blob;
- the copy of its catalog row in its issue job.

Each change rewrites 14.3 MB of shard files and is followed by whole-catalog
walks on the server and in every tab
([session catalog rewrites](../../gaps/session-catalog-rewrites-whole-generation-per-change.md),
[SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md) items 1, 3, 11–17
and 22–35).

Non-goals:

- No API change in steps 1–7. Responses, events and capabilities stay as
  they are. Only step 8 (deltas to clients) needs a capability.
- Not yet removing whole-corpus memory residency. The schema is shaped so
  lists, projects and change queries need no resident corpus, and later
  work can then stop keeping one (item 12), toward an unbounded number of
  sessions.
- No change to provider readers or transcript formats.
- No change of journal mode. `discovery.sqlite` keeps its rollback journal
  ([required SQLite](../../topics/required-sqlite.md#database-ownership-and-migration)).

## Schema

Everything lives in `discovery.sqlite`, through the existing numbered
migrations (`storage/migrations/`, `PRAGMA user_version`, currently 27).
A migration is plain SQL run inside the one startup transaction
(`storage/discovery-sqlite.ts:102-138`). Reading provider or catalog files
and large backfills must be post-startup application code, never a
migration (`topics/required-sqlite.md:247-250`).

| Table | Change | Holds |
|---|---|---|
| `session_catalog` | new | One row per catalog row: list columns, source version, `changed_gen`, tombstone |
| `session_catalog_text` | new | The full title, keyed like `session_catalog` |
| `catalog_state` | new | One row: epoch, generation, tombstone horizon |
| `catalog_sources` | new | Store coverage per (family, store) |
| `session_metadata` | reshaped | Queried fields become columns; the rest stays in an `extra` JSON column |
| `issue_index_jobs` | reshaped | Points at a catalog row instead of copying it |
| `session_summary_index`, `session_summary_scopes` | open (step 5) | Merge or keep; see step 5 |
| `session_identities` and all others | unchanged | |

`session_catalog`:
- **Key:** `(family, store_key, native_id)`, the adapter's row key
  (`sessionCatalogRowKey`, `sessions/catalog-types.ts`). `store_key` is the
  adapter's store: a Claude project directory, or the Codex, Gemini, Grok,
  pi or OpenCode root. It is not the identity scope.
- **Identity join:** on `(family, native_storage_scope, native_id)`, which
  is what `nativeCatalogSessionRef` builds
  (`sessions/catalog-identity.ts:19-27`). It meets `session_identities`'
  unique `session_native_binding` index. `session_catalog` needs its own
  index on that triple for identity-to-row lookups
  (`catalog-session-lookup.ts:74`).
  - On this host every row's scope equals its store key. A Codex merged
    reader over sandbox roots is where they differ.
  - Rows without a scope get no join. Grok and pi never set one, and
    OpenCode sets it only when it has a scope. Their public id stays the
    native id, and they are excluded while their family has pending
    allocations (`catalog-identity.ts:88-93`).
  - Adoption of unbound rows (`adoptDiscoveredBatch`) is a write. The gap
    moves it to publication time. The OpenCode project override
    (`catalog-identity.ts:121-143`) needs `native_directory_project_id`.
- **Project and location:**
  - `project_key` (indexed), `project_id`, `project_path`, `project_name`;
  - `native_storage_scope`, `native_directory_project_id`;
  - `location_kind`, `location_path`, `location_record_id`. Database and
    provider locations carry a record id (`catalog-types.ts:7-10`).
- **Freshness:** `source_version`, stored verbatim. There are no separate
  `file_mtime` and `file_size` columns. The value depends on the family:
  - file rows: `dev:ino:size:mtimeMs:ctimeMs` (`catalog-adapters/row.ts:91-93`),
    or `unsettled:…` for a file that changed mid-read;
  - Grok and pi: `mtime:size`;
  - OpenCode: `db:<updatedAt>`.

  Four places compare it exactly:
  - row reuse (`collection-catalog-adapters.ts:84-89`);
  - Codex question enrichment (`RetainedSessionCollections.ts:446-457`);
  - vocabulary checkpoints (`voice/vocabulary-sessions.ts:36`);
  - content-search cursors (`routes/session-content-search.ts:119`, `:153-156`).
- **List facts:**
  - `provider`, `title` (display length);
  - `created_at`, `updated_at`, `last_human_turn_at` (sort indexes come
    with step 7's queries);
  - `async_questions` (small JSON).

  Catalog rows do not carry `model`, `messageCount`, `lastAgentText` or
  `contextUsage` today (`catalog-types.ts:24-56`). Those are summary fields
  and belong to step 5.
- **Bookkeeping:**
  - `fidelity`, `row_format`;
  - `row_hash`, so an unchanged row is never rewritten;
  - `changed_gen` (indexed) and `deleted`.

Long text lives in `session_catalog_text`, not in a last column. As built
(migration 028): the row keeps the first 512 characters of the title
(`CATALOG_TITLE_PREFIX_LENGTH`, enough for the shared display title's
sanitizer prefix), and `session_catalog_text` holds the whole title, keyed
by the row's `id`, only when it is longer. `title_null` distinguishes an
adapter's `title: null` from an absent title, so rows read back exactly. SQLite reads
a large column only when it is selected, but `ALTER TABLE ADD COLUMN`
appends after it, so a later small column would sit behind the overflow
chain. The full title stays capped at 16,384 characters
(`SESSION_CATALOG_TITLE_MAX_LENGTH`).

`catalog_sources` records which `(family, store_key)` pairs a scan covered.
That is all its readers use (`projects/catalog-projects.ts:23-40`,
`catalog-adapters/row.ts:111-117`). File adapters stamp
`reconciliation:<generation>` as the store source version
(`collection-catalog-adapters.ts:435`). Persist a stable value or none, or
every publication rewrites these rows.

`session_metadata` gains these columns:
- `provider` (what YA ran; not a copy of `session_identities.provider`);
- `working_project_id` (indexed);
- `is_archived`, `is_starred`, `custom_title`, `sidebar_category`;
- `parent_session_id`, `parent_session_kind`, `forked_from_session_id`.
  Relationship reconciliation reads these with `json_extract`
  (`sessions/session-relationship-reconciliation.ts:18`, `:39-42`).
- `executor` and `sandbox_level`, for item 3's sandbox queries
  (`app.ts:1230-1281`, `:2054-2075`) and item 11's projection.
- `initial_prompt`, always kept. Metadata is user data keyed by public id.
  The catalog is a rebuildable cache keyed natively and capped at 16,384
  characters, while `initialPrompt` is uncapped. Deduplicate on the wire
  (item 6), not in storage.

Everything else (launch settings, router binding, sandbox details, recaps
and about 30 more keys; `SessionMetadata` has 50,
`SessionMetadataService.ts:56-182`) stays in `extra`.
`SessionMetadataService` keeps its in-memory object shape.

## How a change flows

1. A watcher reports transcript X.
2. The refresh compares X's source version and rereads X alone.
3. One synchronous transaction upserts X's row only if its `row_hash`
   changed. The adapter only accepts synchronous transaction callbacks
   (`shared/src/sqlite.ts:129-140`), so rows are read first and written
   after. The upsert sets `changed_gen` to N+1 and advances
   `catalog_state.generation` to N+1.
4. `session-catalog-updated` goes out with generation N+1, as today.
5. Server consumers (the issue indexer, the project view, vocabulary)
   read `WHERE changed_gen > their last generation`.

A refresh that changes nothing advances no generation. Whether it still
sends the `refreshing: false` announcement is an open question.

## Compatibility

Steps 1–7 are server bookkeeping.

Wire state:
- The state `{catalogEpoch, catalogGeneration, complete, refreshing}`
  (`shared/src/retained-session-collections.ts:11-17`) keeps its meaning.
- `complete` is `catalogGeneration > 0` (`RetainedSessionCollections.ts:139-148`),
  not scan completeness.
- Generations now advance only when a row changes. The client's
  duplicate-announcement filter (`client/src/lib/clientQueryRevalidation.ts:146-168`)
  keys on `[epoch, generation, complete, refreshError]`, so it tolerates
  that.

Epoch:
- Clients have no epoch-specific handling. `catalogEpoch` appears only in
  that filter key, and every retained list response is a full replacement.
  Any new key refetches.
- So step 3 keeps the manifest's epoch and generation. It seeds rows from
  the current generation and continues numbering, and clients see nothing.
- A fresh epoch at generation 0 happens only when the manifest is
  unreadable, as today. Clients then keep the rows they hold while
  `complete` is false (`clientSummaryState.ts:454`, `:1063`, `:1552`).

Other consumers:
- `getVersion()` (`epoch:generation`, `RetainedSessionCollections.ts:151-155`)
  keys session-access caches (`app.ts:1007` into `auth/sessionAccess.ts`).
  Fewer generations means fewer misses.
- No endpoint exposes fidelity, row format, provider sources, shards,
  deltas or `recentRows`. A row's `sourceVersion` reaches clients only
  inside encrypted content-search cursors.
- `GET /api/sessions` has its own collection generation
  (`sessions/sessionCollectionGeneration.ts`), which this plan does not
  touch.

Downgrade is unsupported, as for every migration since required SQLite
([backward compatibility](../../topics/backward-compat.md)).

## Steps

### 1 — remove the session-creation lifetime limit

- Stop counting and checking the lifetime totals in
  `SessionCreationStore.ts`:
  - 10,000 operations, 512 MiB saved payload and 64 MiB attempt bytes
    (`:189-193`);
  - 2 GiB of attachments (literal at `:806`, `:826`);
  - `assertAttachmentCapacity` and `reserve` (`:801-830`), and the
    increment SQL (`:556-557`).
- The four columns and their CHECK constraints (migrations 018 `:5-7`,
  022 `:3`) can stay at their last values. Nothing reads them once
  `reserve` stops, and dropping them means rebuilding the table.
- Keep the per-item checks:
  - 256 KiB per request (`:191`, `:843`);
  - 8 KiB per attempt record (`:1056`);
  - 64 attempts per creation (`:192`, `:1355`);
  - 16 outstanding admissions (`supervisor/Supervisor.ts:1585-1586`);
  - 64 attachments per operation (`creation-attachments.ts:52`) and
    64 MiB per legacy raw file (`:171`); see the outcome below for the
    per-operation byte bound added in review.
- Keep the table's `generation` counter. It is the creation list's change
  stamp: `getCatalogVersion` (`app.ts:1007`), the status `revision`
  (`:681`) and the project queue (`ProjectQueueService.ts:619`) read it. The
  per-attempt `generation` that fences late launch callbacks is a separate
  column and is untouched.
- `SessionCreationCapacityError` stays for the per-item checks. No route
  catches it by type: every refusal becomes 400 `creation-not-accepted`
  (`routes/session-creation-requests.ts:173-197`), which the client treats
  as final (`client/src/lib/sessionCreation.ts:132`). So there is no wire
  change.
- Update the tests that fill the totals
  (`session-creation-store.test.ts:560-590`, `:850-864`;
  `session-native-allocation.test.ts:95-110`).
- Do not clear `payload_json` at consumption. It is still read after a
  creation is consumed:
  - receipts and replays (`session-creation-acceptance.ts:25-38`,
    `routes/session-creation-requests.ts:101-183`);
  - hosted resume and reattach (`Supervisor.ts:1229-1320`);
  - the limited-user policy (`auth/limitedLaunchPolicy.ts:293`);
  - the queue (`ProjectQueueScheduler.ts:1203`, `:1237`);
  - native session commands (`core-api/native-session-commands.ts:155-161`).

  Trimming it is a separate question.
- Update [session identity](../../topics/session-identity.md): the bounds
  paragraph (`:1058-1074`, including "deleted tombstones still consume the
  10,000-operation budget") and the mentions at `:868-869`, `:1120-1128`,
  `:1289-1292` and `:1337`.

Independent of the catalog; can land first.

Done 2026-11-09. `reserve`, `assertAttachmentCapacity` and the counter SQL
are gone; the store reads only `generation` from the capacity row. The
regression tests set the old counters to their ceilings and still admit,
retry and claim past 2 GiB of attachments; both fail on the old code.
Deletion still clears `payload_json` for tombstones, as before.

Review found that the 2 GiB lifetime total had been the only bound on staged
attachment bytes: the 64 MiB check covers legacy raw paths only, and staged
files are bounded by the upload limit (100 MiB by default, none when 0).
Each operation now carries at most 2 GiB of attachments
(`MAX_OPERATION_ATTACHMENT_BYTES`, checked before copying and in the saved
snapshot). Follow-up, not done: every creation copies its staged files, so
one staged upload referenced by many creations is stored many times.

### 2 — cleanup with no schema change

- `git-untracked` snapshots: persist the HEAD sha and an index digest, not
  the tracked path lists (item 25).
- Delete the August review and palette fixtures under `projects/`
  (item 27).
- Rotate `sdk-raw.jsonl` and the client logs (item 34).
- Delete the one-time import leftovers, and the JSON summary writer that
  only tests reach (items 5, 14, 19). Those tests move to an in-memory
  database. This touches `SessionIndexService`, which step 5 changes.

Done 2026-11-09:
- Git-untracked snapshots persist the HEAD sha and a digest of
  `git ls-files -z --cached` (cache version 2). A reload whose digest
  differs reconciles fully, since the previous index is unknown. tilefun's
  file: 4.6 MB to 584 bytes.
- `server.log`, `sdk-raw.jsonl` and `codex-correlation-debug.jsonl` rotate
  at 100 MiB and keep two archives (gap item 2 as well). Client logs are
  appended asynchronously, kept 14 days and capped at 32 MiB per device
  per day.
- `SessionIndexService` requires the database. The JSON writer, its locks,
  the legacy JSON read and `SESSION_INDEX_WRITE_LOCK_*` are gone. Legacy
  `indexes/*.json` scopes (754 files, 26 MB here) are deleted on start
  once each parses as a summary scope.
- `session-metadata.json` and `public-shares.legacy-backup.json` are
  deleted, best effort, by a later start (for shares, also a later enable)
  that finds the import marker already present; a metadata marker that
  imported no file deletes nothing. Decision: the metadata import code stays, because
  0.9.2 (the last release before the import) can still upgrade directly
  and the file cannot be rebuilt.
- The August fixtures were removed from the maintainer's profile, after
  archiving to `~/yep-anywhere-cleanup-backup-2026-11-09.tar.gz`, which
  also holds the legacy files above. `projects/` went from 1,644
  directories to 47.

### 3 — catalog storage in SQLite

Production code reaches the catalog only through `RetainedSessionCollections`,
which builds it at `RetainedSessionCollections.ts:99`. Routes and services
keep using that wrapper unchanged (`read`, `readPublishedRows`,
`readPublishedProjectRows`, `getVersion`, `readProjects`, `refresh`,
`invalidate`).

Inside the wrapper, `SessionCatalogService` keeps:
- `initialize`, `getToken`, `readRows`, `readProjectRows`, `reconcile` and
  `stop`;
- `getSnapshot`, which production uses only for the epoch, the generation
  and `providerSources`.

What must change:
- The constructor takes the database instead of `dataDir`.
- `SessionCatalogSnapshot` drops `shards` and `recentRows`.
- Remove what has no production caller: `getConditional`,
  `getProjectToken`/`getProjectConditional`, `pinGeneration`, and the file
  counters in `getMetrics`.
- `onLineageReset` loses its trigger, since a missing or torn shard no
  longer exists. Define what resets a lineage (a missing or invalid
  `catalog_state`).
- The `providerSources` type import in `catalog-projects.ts:3`.
- Tests:
  - `SessionCatalogService.test.ts`: the manifest, staging, torn-shard,
    missing-shard, delta and hot-set tests are rewritten or dropped.
  - Torn-shard recovery tests: `routes/retained-session-collections.test.ts:1013-1015`
    and `routes/project-queue.test.ts:483-497`.
  - Seven test files seed through `new SessionCatalogService({dataDir})`
    and rely on a later instance reading the files back.
- `benchmark:session-catalog` (`scripts/benchmark-session-catalog.ts`)
  measures shards and deltas. Rewrite it for row writes or retire it.
  `benchmark:catalog-identity` is unaffected.
- [Session catalog observation](../../topics/session-catalog-observation.md):
  the disk/RAM hierarchy (`:458-471`), generations and the shard vector
  clock (`:586-628`), and the contract-test list (`:849-863`).

Land it in three reviewed commits.

The first commit adds the tables and the seed. Reads stay on files:
- Migration 028 creates the tables.
- On startup, when `catalog_state` does not hold the manifest's generation,
  `initialize` copies its epoch, generation and rows in one transaction.

Done 2026-11-09 (first commit):
- Migration 028 creates `catalog_state`, `catalog_sources` (only the
  `(family, store_key)` pairs, the only fields their readers use),
  `session_catalog` and `session_catalog_text`, with indexes on the row
  key, the native identity triple, `project_key` and `changed_gen`.
- `SessionCatalogSqliteStore.writeGeneration` stores one whole generation
  in a transaction: rows are diffed by `row_hash` (a digest of the
  normalized row JSON), unchanged rows are not written, changed rows take
  the generation as `changed_gen`, and missing rows become tombstones. A
  different epoch, or a generation behind the stored one, empties the table
  first.
- `SessionCatalogService.initialize` copies the published generation, with
  its epoch and generation, when the tables do not already hold it.
  Decision: not only when `catalog_state` is empty, as first written.
  Publications do not write the tables until the second commit, so every
  start would otherwise leave them at the first copy. A failed copy is
  logged and the files keep serving. The store's statements are prepared
  and finalized within the one synchronous write.
- Gate, on copies of the maintainer's profile (`VACUUM INTO` plus the
  catalog folder; generations 870,137 and 870,348, 7,487 and 7,488 rows):
  migration 027 to 028 in under 6 ms; the copy wrote every row in one
  transaction of 129 ms on a quiet host and 255–580 ms at load average 50
  (the shard read it reuses is the one the first list read makes anyway);
  every row read back byte-identical to its shard line; 58 sources;
  integrity and foreign-key checks clean. A start at the same generation
  does nothing; a start one changed row later wrote one row in 41 ms, most
  of it hashing every row. The database grew from 55.9 MB to 74.5 MB:
  7.4 MB of rows, 9.0 MB of long titles, 2.1 MB of indexes.
- Titles are made well-formed when rows are normalized and again before a
  row is hashed and stored. A title cut inside a surrogate pair would
  otherwise read back from SQLite with U+FFFD and never match.
- Review found that a transaction bigger than the page cache never failed
  with `SQLITE_BUSY` while an outside reader held a shared lock: each
  mid-transaction cache spill waited out the busy timeout and carried on,
  so the copy blocked the event loop for as long as the reader stayed
  (reproduced: still blocked at 20 s). The discovery connection now sets
  `cache_spill = OFF`, so such a transaction fails at COMMIT within about
  300 ms and holds its pages in memory meanwhile (about 20 MB for this
  copy). `scripts/test-discovery-sqlite.mjs` checks this on both drivers.
- For the second commit (from review): a publication must not run the
  whole-table diff (26–41 ms per call); pass the changed and removed keys
  the publication already knows. Once publications write, the startup copy
  must not wipe the table for a generation behind the stored one; only a
  different epoch starts over. Its comparison must ignore row order.
- `scripts/test-discovery-sqlite.mjs` runs the store's SQL on Node 25 and
  Bun 1.3.14.

The second commit writes both and compares:
- Each publication goes to the files and to SQLite.
- A mismatch counter compares the rows SQLite returns with the published
  rows.

Done 2026-11-09 (second commit):
- Each publication writes SQLite after the manifest is persisted
  (`SessionCatalogSqliteMirror`, `session-catalog-mirror.ts`). When the
  stored generation is the one the publication follows and its delta is
  complete, only the delta's upserts and deletes are written
  (`applyChanges`, one point lookup per changed row); otherwise, for a
  delta over its 1 MiB bound or a stored lineage that does not match (a
  failed earlier write, a lineage reset), the whole generation is diffed
  as in the first commit. The first commit's review notes are met: no
  whole-table diff per publication, no wipe of a later generation by the
  startup copy (rechecked synchronously after its read), and a keyed, not
  ordered, comparison.
- A lineage reset writes its empty generation to SQLite at once. A start
  that finds SQLite ahead of the files in the same epoch (files restored
  from an older copy) ends the lineage, as an unreadable manifest does,
  rather than numbering generations change readers have already seen.
- Checking: every change write checks its changed keys against their
  published hashes and the live row count (about 1.5 ms). A full read-back
  of every row and source, compared by key with the published rows, runs
  after copies, whole-generation writes and failed checks, and otherwise at
  most every 10 minutes (`YEP_CATALOG_SQLITE_COMPARE_MS`, 0 for every
  write). It costs 55–75 ms quiet and up to 300 ms at load average 20–25.
  A mismatch is counted, logged as a warning, and repaired by rewriting the
  differing keys from the published rows, so it does not persist into the
  reads the third commit moves to SQLite. Failures are counted and logged
  and the files keep serving.
- Review found that a session whose project changed to one in a
  lower-numbered bucket was tombstoned: the delta walks buckets in order,
  so it listed the row's upsert before its delete (reproduced as a missing
  row). The delta now drops a delete whose key it also upserts, and
  `applyChanges` lets an upsert win too; the delta clients would get had
  the same defect.
- Measured on a copy of the maintainer's profile (7,489 rows) through the
  real `reconcile` path: a change write took 0.4–0.7 ms for 0–1 changed
  rows, about 2 ms with its check (26–41 ms with the whole-table diff); a
  publication changing every row (a `rowFormat` bump, whose delta is over
  the bound) took 205–240 ms plus a 56 ms read-back. Integrity clean.
- Gate: a second server on a copy of the profile (port 3417), passive by
  recipe (below), comparing every write. Before the review fixes: 107
  change writes, generations 870,464 to 870,570, no mismatch or failure;
  writes 0.7 ms median (6.9 ms max), read-backs 72 ms median (297 ms max at
  load average 20–25). After them: 33 change writes over 44 minutes,
  870,571 to 870,603, no mismatch or failure, writes with their check
  2.4 ms median, read-backs 56 ms median; integrity and foreign-key checks
  clean. Live traffic never exercised the copy or whole-generation paths;
  the scripted run above did.
- Passive second server, by recipe rather than a mode: run the built
  `dist` with `env -i` (no inherited wake, provider-runtime or dev-wrapper
  variables), `NODE_ENV=production`, `YEP_PROVIDER_HOST_ENABLED=false`
  (from `dist` on macOS the provider host is off anyway),
  `YEP_PEER_API_ENABLED=false`, `HOST=127.0.0.1 CLI_HOST_OVERRIDE=true`,
  `AUTH_DISABLED=true`. In the copy: `settings` in `server-settings.json`
  (they are nested there) with `codexUpdatePolicy: "off"`,
  `hostAwakeMode: "off"`, issue associations and rendez disabled, wake
  turns, lifecycle webhooks and the gateway export off; the relay removed
  from `remote-access.json`; project queue items emptied;
  `push-subscriptions.json` deleted. Discovery only reads provider
  directories, and the gateway export, the one startup write into them, is
  a no-op with the export off and no services. No route switch stops
  launches, so the gate calls only read routes, with `summaryMode=retained`
  (the catalog refreshes only for retained reads). The first attempt had
  the settings at the top level, where they are ignored; it ran about two
  minutes with host-awake and issue associations on, spawned only
  `caffeinate`, and launched nothing.

The third commit switches reads and deletes the folder:
- A publication upserts changed rows and tombstones removed ones in one
  transaction. It advances the generation only when something changed.
- The Codex async-question pass (`RetainedSessionCollections.ts:431-472`)
  becomes row upserts instead of a second generation.
- After the first successful SQLite publication, delete `session-catalog/`.
- The in-memory published rows (`ef2914085`) stay for now.

Done 2026-11-09 (third commit):
- `SessionCatalogService` takes the database. A publication scans as
  before, diffs the rows against the published ones by row hash (a row equal
  to the published row of its key reuses it and its hash, which halved an
  unchanged scan's event-loop time), and writes the upserts and tombstones
  in one transaction that advances the generation. A scan that changes
  neither a row nor the store coverage writes nothing and advances nothing.
  A failed write leaves the generation and memory unchanged; the refresh
  retries. The published rows stay in memory, loaded from the tables at
  startup; project reads group them once per generation.
- Lineage: a missing `catalog_state`, a stored row that no longer
  reassembles, or damaged legacy files start a fresh epoch at generation 0.
  Nothing after startup resets one, so `onLineageReset` is gone.
- The Codex async-question pass upserts the rows it enriched
  (`upsertRows`), one generation carrying only them, instead of
  republishing every row. A row whose source version moved since it was
  read is skipped.
- Tombstones lose their text at once; their rows are purged once 10,000
  generations old, in steps of 1,000, and `tombstone_horizon` follows.
  Decision (open question on retention): count generations, not time, since
  change readers are in-process (step 4) and a reader behind the horizon
  reads in full.
- `session-catalog/` is imported on the first start (its epoch, generation
  and rows, validated as a publication would), unless the tables already
  hold that generation or a later one, and then deleted. It is deleted only
  after an import, when superseded, or when its files are proven damaged (a
  bad manifest, a bad row, a missing shard); any other read error keeps it
  and fails the start, which the next read retries
  (`session-catalog-legacy.ts`).
- Removed: the shard writer and readers, manifest, deltas, `recentRows`,
  `getConditional`, `getProjectToken`/`getProjectConditional`,
  `pinGeneration`, the hot set, the file counters, the dual-write mirror and
  its comparison and repair. `providerSources` carries only the family and
  store. Review leftovers from the second commit: a key yielded twice in one
  scan keeps the later row in memory and the table alike
  (`duplicateRows`), and the lineage race is gone with mid-run resets.
- Decision (open question): a refresh that changes nothing still announces
  `refreshing: false`, since the issue indexer, vocabulary and the client
  hooks wait for it; the client's duplicate filter drops it.
- Store statements are prepared on first use, since a store lives for one
  call and tests cap live statements at 64.
- Review (Opus) found that the collections wrapper kept a failed start
  forever, so a failed import on the upgrade restart would have left the
  lists failing until another restart; a failed start is now retried by the
  next read (the test fails without the fix). Also applied: only a stored row
  that does not reassemble resets the lineage (a busy or failing database
  fails the start instead), the import checks the manifest's row count,
  damaged files start a fresh lineage rather than continue older tables of
  the same epoch, the tombstone horizon is read back after each write, and
  a failed statement finalize no longer turns a committed write into an
  error.
- `benchmark:session-catalog` now measures the SQLite catalog.

Measured (step 3):
- Bytes written per changed session: 5 database pages (20 KB), plus the
  same pages' old content in the rollback journal, against 14.3 MB of
  shards before (synthetic catalog of 7,470 rows, 13.7 MB of row JSON).
- Event-loop time on a copy of the maintainer's profile (7,489 rows): the
  import 187 ms including reading the shards (the transaction alone about
  130 ms); restart load 32–70 ms; an unchanged scan 22 ms, nothing written;
  one changed row 23 ms, its transaction 3 ms; every row changed (a
  `rowFormat` bump) 200–222 ms of transaction.
- Reads come from memory: a full read returns the published array, and 100
  project reads took 13 ms including grouping the generation once.
- Live gate: a passive second server (the second commit's recipe) on a
  fresh copy of the profile, which was still at `user_version` 27, so this
  was the upgrade path the maintainer's server will take: migration 028,
  then the import of generation 870,778 (7,489 rows, 58 stores; every row
  byte-identical to its shard line except one session that a publication
  had changed since), the folder deleted, integrity and foreign-key checks
  clean. Live traffic for 14 minutes (generations 870,804 to
  870,912): 104 reconciliations, 98 publications of 1–2 rows each (writes
  1.1 ms median, 32 ms max), the other 6 wrote nothing; the startup full
  discovery took 389 ms and changed nothing. No publication was empty, where
  24–36% were before.
- Publications per idle minute: this host is never idle while agents run,
  so a truly idle minute was not observable. In a three-minute window with
  this session waiting, there were 6 publications (2 a minute), each for one
  of the two sessions whose transcripts were still being written, against
  8–16 a minute before. A scan with no changed row publishes nothing (tested,
  and seen at startup and on 6 live refreshes).

Measure:
- bytes written per changed session (14.3 MB today);
- publications per idle minute (zero expected);
- event-loop time of the seed transaction and of a full-rediscovery
  publication that changes every row (a `rowFormat` bump);
- full and project read latency against the 7,470-row synthetic catalog.

### 4 — catalog consumers read changes

Depends on step 3. Three consumers switch from walking every row each
generation to reading `changed_gen` deltas: the issue indexer, the project
view and vocabulary learning (items 29–30).

Issue jobs keep a catalog key instead of `source_json` (item 24):
- Nothing else reads `source_json`. The worker uses only `updatedAt`,
  `sessionId`, `projectId` and `provider` from it (`IssueIndexer.ts:343-401`,
  `app.ts:3714-3726`), and can join the catalog row for those.
- The SQL migration can derive the key and the fingerprint:
  - All 2,041 non-null jobs here carry `catalogFamily` and `storeKey`.
  - Their `sourceVersion` already equals the `source_version` column.
  - Only 1,276 carry `nativeSessionId`. For the rest, take `native_id`
    from `session_identities` by `session_id`.
  - The 6 viewed jobs hold `'null'` and stay keyed by session id.
- Change detection compares the whole row JSON today
  (`IssueIndexer.ts:191-200`). It becomes a `changed_gen` read.
- A job is deleted when its catalog row is tombstoned. Absence from a
  recent-mode or failed scan is not deletion.

Project view:
- The version includes `lastActivity` (`catalog-projects.ts:71`). When it
  changes, `ProjectScanner` emits `projects-changed` with every project id
  (`scanner.ts:231-246`).
- Dropping `lastActivity` stops that, but project lists would then learn
  recency some other way. Decide that before landing.

Done 2026-11-09:
- `SessionCatalogService.readChanges(since)` returns the live rows written
  and the keys removed after a token, from the `changed_gen` index, or every
  row (`full`) without a token, for another epoch, behind the tombstone
  horizon, or behind a generation stored whole over tables that had moved
  (a `changeFloor` kept beside the horizon). `readRow(key)` is the point
  lookup. Consumers keep their token in memory; each process starts with one
  full read.
- Issue indexer: a sweep reads the changes since the generation its last
  completed sweep reached, and per changed row asks for its job and owned
  projects instead of reading every job. Rows the identity projection leaves
  out are offered again by each later sweep until they project (the
  "sessions without identity" case), and so are rows the worker found
  unprojectable and paused (review must-fix). Settings changes and the first
  sweep read every row; a full sweep also re-keys moved non-recent jobs.
- Migration 029 rebuilds `issue_index_jobs` with `catalog_key` (the row's
  `sessionCatalogRowKey`, JSON functions on `source_json`, falling back to the
  identity's native id, then the job's id) and without `source_json`. The
  worker reads the current row by key; a job whose row is gone or not yet
  projectable is paused. Deletion cases (review gate): a tombstoned key
  deletes the jobs holding it, after the same sweep's changed rows, so a
  session whose row moved keys keeps its job and cursor (re-keyed); viewed
  windows have no key and are never deleted this way; leaving the recent
  window or a failed store scan deletes nothing; evidence stays. Decision: a
  full sweep deletes nothing, so jobs whose rows vanished before a process's
  first change read stay, as all did before.
- Project view: `CatalogProjectsProjection` keeps each project's rows and
  folds only the projects a change touches; `catalogProjects` is the same
  fold over every row. A random-change test checks it against the full fold.
- `projects-changed` (review gate): both scanner announcements, a catalog
  publication that changes the native project view and a retained refresh
  settling, name only the projects whose facts changed since the last
  announcement. Decision (open question): `lastActivity` stays in the
  version, since project lists sort by it and learn it only from this event.
  A settling refresh still announces with no ids when nothing moved (its
  `collectionRefresh` completion signal); project lists refetch on every
  announcement, project pages only when named.
- Vocabulary: an automatic scan reads sessions changed since the last
  completed scan with the same settings generation and a cutoff no earlier;
  retrospective scans, compaction, a wider window and failed scans read every
  session again.
- Gate, on a fresh copy of the maintainer's profile (passive second server
  on port 3417, `user_version` 27, so migrations 028 and 029 and the catalog
  import ran as the maintainer's restart will; issue associations as the
  profile has them: on, recent scope, no confirmation, no tracker
  credentials):
  - Migration 029 on 2,053 jobs (with 028, 12 ms): every other column
    unchanged, 2,047 keys equal to the copy-derived ones, 6 viewed jobs
    null, integrity clean. The table and its indexes went from 8.5 MB to
    1.9 MB; the freed pages are reused.
  - 15 minutes of live traffic, 112 publications: one full issue sweep at
    startup (7,490 rows, 118 ms, what every publication cost before), then
    112 sweeps of 1–2 rows (1 ms median, 5 ms max); project view updates
    0.075 ms median against 2.9 ms for the full fold. No error, no job lost
    (2,053), integrity and foreign keys clean.
  - Finding: on this host the catalog's project view is unused (no
    Antigravity, pi or OpenCode stores). The `projects-changed` naming all 122
    projects on every session file change came from the legacy scanner's
    retained refresh (item 31), whose Claude `lastActivity` does not move on
    appends. All 112 announcements in the run named no project; each named
    122 before, and every mounted project page refetched.
  - Vocabulary learning is off on this profile; its change reads are covered
    by tests only. No removal happened live; deletion is covered by tests.
- Review (Opus) found that a job the worker paused because its row was
  briefly unprojectable (a pending allocation in its family) never resumed:
  its key never reached the retry list, which only held rows a sweep left
  out. The worker now adds it, and a sweep keeps keys added while it ran
  (the test fails without the fix). Also applied: a change-log read that
  fails (a busy database) falls back to a full read from memory rather than
  failing the refresh it runs in; a catalog project view that only became
  complete still announces, with no ids; a full sweep re-keys moved jobs
  outside the recent window; an integration test pins the three spellings of
  a catalog key (the indexer's, the catalog's, migration 029's), and the SQL
  contract checks the JSON escaping on Node and Bun. Left as noted: a row that
  moves and is unprojectable in the same read loses its job and cursor (the
  session is re-read, evidence kept); a migrated job with no catalog key that
  was not a viewed window is treated as one; sandbox-only counts are not part
  of the compared project facts, so they no longer refetch a mounted project
  page.

### 5 — summary cache and catalog rows

Decide how this step lands before starting it. The merge as first written
does not fit.

Scopes do not map onto `(family, store_key)`:
- Claude's scope is its store key.
- Codex, Gemini, Grok, pi and OpenCode have one scope per project inside
  one store, for example `codex::<root>::<project key>`
  (`codex-reader.ts:2364-2366`).
- A Codex merged reader joins several roots with `|`
  (`merged-reader.ts:369-376`).
- Antigravity has one root scope shared by projects, which wipes and
  rebuilds itself on each project switch
  (`SqliteSessionSummaryIndex.ts:76-91`).

The fingerprints differ:
- The cache compares exact float `fileMtime` and `indexedBytes`
  (`SessionIndexService.ts:1661-1665`, `:2375-2384`).
- For OpenCode those two fields hold `time_updated` and a message count.
  Unknown shared-store sessions hold `-1/-1` (`:1649`), and Grok stats
  `summary.json`.
- A head read must never advance these markers
  (`topics/session-index-validation.md:130-134`). Catalog rows are often
  head or identity reads.
- So merged rows need `summary_mtime REAL`, `summary_bytes`, and a summary
  format separate from `source_version`. They stay null until a complete
  summary exists.

The cache holds fields the catalog lacks:
- `messageCount`, `model`, `contextUsage`, `lastAgentText`;
- the 120-character `title` beside an uncapped `fullTitle` (the catalog
  caps at 16,384);
- `isEmpty` negative entries, which lists skip (`:871`, `:1667`);
- `parentSessionId`, `parentSessionKind`, `forkedFromSessionId`.

Its consumers:
- the non-retained global walk and stats (`global-sessions.ts:434`,
  `:754-852`);
- the project page (`projects.ts:1031-1101`);
- the inbox's non-retained path;
- processes (`routes/processes.ts:160`);
- the detail metadata route;
- `routes/sessions.ts:1539`, `:3615`;
- the Codex compact-tail hint (`session-detail-routes.ts:409-428`);
- the catalog's own row reader (`collection-catalog-adapters.ts:97`).

Background validation also emits `session-created` and `session-updated`
(`SessionIndexService.ts:2112-2147`).

If the merge goes ahead, rows are keyed `(family, store_key, native_id)`
plus `project_key`, with the columns above. Fingerprints carry over
exactly, so no transcript is reparsed, and the complete-mode list and
project page read the same rows (item 17). Otherwise, do item 22 alone:
a rowid table with `full_title` in a column.

Decided 2026-11-09: item 22 alone, with item 4's cold-load save. The merge
needs new scope and fingerprint columns, a separate summary format, and
changes to all eight consumers above, and its payoff (one copy of each
title, the project page off the per-project walk) belongs with step 7's
queries. Item 17 stays open.

Done 2026-11-09:
- Migration 030 rebuilds `session_summary_index` as a rowid table:
  `id`, `scope`, `session_id`, `summary` (the JSON without `fullTitle`),
  `full_title` last, `UNIQUE (scope, session_id)`. It is plain SQL
  (`json_remove`, `json_extract`) inside the startup transaction.
  - A null `fullTitle` is NULL. A summary whose JSON escapes a lone
    surrogate or a NUL keeps its title in the JSON: SQLite's `json_extract`
    turns a lone-surrogate escape into U+FFFD (the SQL contract caught this
    on both drivers), and node:sqlite cuts text at a NUL, even a bound one
    (found in review). The writer keeps such titles in the JSON the same way.
  - Rows that are not JSON objects are dropped (invalid JSON and `null`
    discarded their whole scope before; arrays and scalars were junk
    entries), and so are rows whose scope is gone, which would fail the
    rebuild's foreign key and block startup.
  - The reader puts `fullTitle` back beside `title`. Summaries as YA writes
    them (`title` first, `fullTitle` a string or null) serialize exactly as
    before, so the first save rewrites nothing; a missing `fullTitle` reads
    back as null.
  - The gain is packing, not fewer reads: every reader still selects
    `full_title`.
- A cold scope load stores the scope again only when it repaired, upgraded
  or started it fresh (item 4, partly). Before, every load reread and
  reserialized every row.
- Measured on a copy of the real profile (7,494 summaries, 529 scopes):
  - all 7,494 summaries read back byte-identical to their old JSON text;
  - migration 030 alone 63 ms; 028–030 together 95 ms;
  - the table went from 24.7 MB (10.5 MB unused) to 16.6 MB plus a 0.95 MB
    key index (2.8 MB unused);
  - reading every scope 29.5 ms before, 25.8 ms after (median of 7); the
    largest scope (a Codex project) reads in 2.3 ms.
- Gate: two passive servers on identical copies of the real profile (still
  at `user_version` 27, so the real upgrade path), the old build on one and
  the new on the other, compared with `scripts/compare-list-responses.mjs`.
  It fetches 437 responses: All Sessions in each mode and filter, stats,
  Inbox (both modes, and per project), recents, processes, every project
  and its session list, and 60 sessions' metadata.
  - The first pass, 25 s after start, is discarded as warm-up. It differed
    in `providerChildren: []` on sessions of the server started 2 s later
    (the key is added only once the provider-child relationship service has
    resolved a native identity), and in one All Sessions position holding a
    different session on each side, after which that response hit the
    script's 40-difference cap (the script now reports a capped response).
    The next two passes were identical (437/437), with the two sessions at
    the same positions.
  - About 25 minutes in, while a new session was starting on the host,
    one pass differed in `/api/sessions` only: `lastHumanTurnAt` and
    provider children's `updatedAt` on live sessions, newer on either
    side. The next pass, 30 s later, was identical again.
  - The new server was then restarted on its own copy, so it read rows its
    writer had produced, and later the old one too. Every summary field
    still matched, and both caches held the same rows (7,496), decoded.
    Two kinds of difference remained, both history-dependent and outside
    the summary cache:
    - Retained All Sessions sorts its project options by name, and ties
      (several projects named `checkout` or `project`) keep the catalog's
      in-memory row order, which depends on each server's publication
      history. Step 7 must give the list a stable tiebreak (project id)
      before comparing.
    - `providerChildren: []` appears only on sessions whose provider-child
      relationships that server has already resolved, so one session of one
      project page carried it on one side only.
  - Request time summed over a pass: 7.0 s on both, and equal within noise
    in every later pass.

### 6 — session metadata columns

- Before migrating, take a consistent backup with `VACUUM INTO`, not a
  file copy (`topics/required-sqlite.md:250`).
- Rebuild `session_metadata` as a rowid table with the columns above.
  - Values come from `json_extract`, and `extra` is `json_remove` of them.
  - JSON `true` comes back as `1`, so the round trip must restore booleans.
  - It runs inside the startup migration lock. Measure on 4,686 rows and
    4.2 MB here, and on the Linux host's 37 MB.
- Load all rows at startup as today, reassembled into the same objects.
- What must change with the storage:
  - `doSave` compares `JSON.stringify` with the stored text
    (`SessionMetadataService.ts:1509-1544`). It must compare the
    reassembled object instead.
  - Raw SQL readers: `authorized-relationship-source.ts:32-37`,
    `session-relationship-reconciliation.ts:18`, `:39-42`, and
    `scripts/benchmark-provider-model-route.ts:154`, `:160`.
  - Tests that read or write the raw table, including
    `session-identity.test.ts`, `session-relationships.test.ts`,
    `session-relationship-writers.test.ts`,
    `session-creation-store.test.ts`, `authorized-relationship-source.test.ts`,
    `agent-auth-router.test.ts`, `metadata/service.test.ts`, and
    `providerModelRouteBenchmarkState.test.ts`.
- Item 3's point questions become indexed queries on the new columns. Each
  query repeats the indexed expression or column exactly.
- No pruning in this step. Here 379 rows have no identity: 14 of them hold
  a custom title, star, archive or category, and 20 name a remote executor.
  Nothing deletes metadata today (`clearSession` has no production
  caller), and archived sessions whose files are gone keep theirs. Report
  first and decide a rule separately.

Done 2026-11-09 (migration 031):
- **Table.** Rowid table, `session_id` unique; the twelve columns above, then
  `extra`, then `initial_prompt`. Partial indexes on `provider`,
  `working_project_id` and `sandbox_level = 'project-write'`.
- **What moves.** A key moves only when its value has the column's type and,
  for text, no lone surrogate or NUL (per-value GLOB on `metadata -> '$.key'`
  in the migration, `isWellFormed` and a NUL check in the writer); otherwise
  it stays in `extra`, which wins on read. `json_remove` with a NULL path
  returns NULL on both drivers, so a kept key passes `$[0]`, a no-op on an
  object. Non-object rows are carried over unchanged in `extra`, and invalid
  JSON still stops the loader as before.
- **Codec.** `metadata/session-metadata-rows.ts` encodes and decodes rows and
  owns the statements. `doSave` compares the encoded row (columns plus
  `extra`) with the stored one. Reassembled objects equal the originals; top
  level key order changes (column keys last), which no response exposes.
- **Item 3.** `getRecordedProviders`, `hasRecordedProvider` (the
  `claude-ollama` checks in `app.ts` and `server-main.ts`),
  `getProjectWriteSandboxSessions` (the Claude and Codex sandbox roots,
  sorted; the Claude memo and the metadata revision counter are gone) are
  indexed queries, and `getCounts` (debug route) scans the narrow columns.
  Sessions with uncommitted changes are left out of the SQL and answered
  from memory. The `working_project_id` index waits for step 7's project
  pages.
- **Raw readers.** Relationship reconciliation and authorized relationship
  visibility read the columns, falling back to `extra`
  (`coalesce(column, json_extract(extra, …))`; `coalesce` keeps the JSON
  subtype on both drivers). The prune script writes through the codec and
  requires version 31; the provider benchmark reads either layout.
- **Gate.** `VACUUM INTO` backup of the real `discovery.sqlite`
  (4,695 rows, 4.25 MB of JSON, version 27), migrated on a copy
  (`/tmp/plan189-scripts/roundtrip-031.mjs`):
  - every row deep-equal to its original JSON on Node 25.8.2 and on
    Bun 1.3.14 (2,156 byte-identical, 2,539 differing only in key order);
  - every row encodes back unchanged; marking all 4,695 dirty and saving
    writes 0 rows;
  - the old and new relationship and visibility projections are equal for
    every row;
  - integrity and foreign keys clean.
- **Measurements** (that copy): migration 031 68 ms (028–030 99 ms); load of
  all rows 19 ms; all-dirty compare 40 ms; the four point queries 1.7 ms
  together. Columns filled: provider 4,309, project 1,529, archived 374,
  starred 46, title 407, prompt 2,359 (2.57 M characters); `extra` is
  1.36 M characters and `{}` for 2,311 rows. No row here has a lone
  surrogate or NUL.
- **Live parity.** Old build (A) and new build (B) as passive servers on identical
  profile copies at version 27 (`/tmp/plan189-scripts/prep-gate8.sh`,
  `start-gate8.sh`; the old build compiled from `HEAD` outside the tree).
  After warm-up, 437 of 437 responses identical in two passes. The same four
  edits on both (an emoji title, a lone-surrogate title, star with category,
  archive) read back identically; the lone-surrogate title stayed in
  `extra`, the rest went to columns. After restarting both, the edits and
  debug counts (4,695 sessions, 47 starred, 375 archived) matched and two of
  four passes were 437/437; the others differed only in a live session's
  message count and in `providerChildren` while child resolution caught up.
  No errors; integrity and foreign keys clean.
- **Pruning** stays undecided (above); 379 rows still have no identity.

### 7 — list pages as queries

Depends on steps 3 and 6, and on step 5 for the project page.

- All Sessions, Inbox, project pages and the sidebar feeds become indexed,
  bounded queries joining `session_catalog`, `session_identities` and
  `session_metadata`, sorted and paged in SQL (items 11, 15, 16).
- Point reads (content search, recents, host processes, the conversation
  source) look up by key.
- Response shapes do not change.

Done 2026-11-09, in part. Decision: the list pages are not paged in SQL yet.
The page itself could be exact and bounded today: overlays move a row's time
only for sessions with a live process or a recap, so the top K by stored
`updated_at`, joined with that overlay set and re-sorted, is the exact page
(review). What needs the whole population is the rest of every retained
response, even a sidebar feed of 50 rows:
- `stats`, whose unread counts come from the notification service's JSON
  (item 8);
- the project options;
- `hasMore` under the auto-archive filter, which uses the overlaid time, and
  under search, which matches custom titles and initial prompts.

Those aggregates wait for item 11's projection table (and item 16's shared
result); paging only the rows would save little while they stay whole-catalog
walks. What landed instead removes the per-request costs that did not depend
on them:
- **Project options** sort by name and then id (`compareProjectOptions`),
  in the retained and the full walk, so equal names (23 of 121 options
  here) no longer follow catalog history.
- **Identity projection** (`projectCatalogIdentities`) keeps each bound
  row's projection per identity store and per published row object: a
  binding is never changed or removed, and an unchanged catalog row keeps
  its object. Rows without a native scope, unbound rows (until their next
  read after adoption), rows whose binding conflicts and OpenCode-overridden
  rows are projected per read. Every consumer gains: All Sessions, Inbox, the sidebar
  feeds, recents, the project inventory, issues and the conversation source.
- **The retained walk** parses each row's time once for the sort, truncates
  a row's display title once per row object, and names each project once
  instead of once per row.
- **Point reads** (item 15) are cheaper by a constant factor, not bounded:
  recents went from 27 ms to 1.5 ms and a project card from 37 ms to 10 ms,
  but they, the project inventory, the issue routes and the session-access
  catalog still walk every row (now cache hits). Content search and the
  conversation source find one row by scanning memory (about 0.1 ms); they
  were left as they are.

Gate: the old build (A) and the new (B) as passive servers on identical
copies of the real profile at version 27, compared with
`scripts/compare-list-responses.mjs`, which now sorts each run of equal-name
project options by id on both sides first. To repeat it: copy the profile
without `logs/`, taking each SQLite file with `VACUUM INTO` and the
`session-catalog/` folder with its manifest; apply the passive recipe (step 3,
second commit); build the old commit outside the tree (`git archive` of
`packages/server`, `tsconfig.base.json` and the scripts its build imports,
`tsc -p .`, then `scripts/copy-server-assets.mjs`); start each `dist` with the
recipe's environment on ports 3417 and 3418; wait out warm-up and compare.
- Responses: after warm-up, three passes of 437 of 437 identical (the first
  pass differed only in `providerChildren` while B resolved children). Later
  passes differed in one live session only: A's file watcher reported no
  event for that transcript's last append, so A's catalog kept the earlier
  row (B and A's own non-retained list had the new one). No errors;
  integrity and foreign keys clean.
- Request timings, median of 15 on the same copies, neither profiled:

  | Request | A | B |
  |---|---|---|
  | All Sessions feed, retained, 50 rows | 93.8 ms | 34.5 ms |
  | Starred feed | 90.7 ms | 30.0 ms |
  | Categorized feed | 86.0 ms | 26.2 ms |
  | Inbox, retained | 85.5 ms | 24.2 ms |
  | Recents, retained | 27.0 ms | 1.5 ms |
  | Projects, retained | 54.9 ms | 27.5 ms |
  | One project card | 37.4 ms | 10.0 ms |

  A tab refetches the three feeds and Inbox on each catalog generation:
  about 356 ms of event loop before, 115 ms after. Whole compare passes
  summed 6.8–10.0 s on A and 3.4–6.1 s on B.
- CPU profile of A under that load: of each retained walk's ~95 ms, the
  identity projection took about 39 ms (the batched identity read 27 ms),
  the sort comparator 13 ms, title truncation 11 ms. On B the projection is
  under 2 ms and the remaining walk is the per-row overlay pass (metadata,
  process, recap, unread) and the item objects.

Still open: SQL paging (needs items 8 and 11), one shared result for the
feeds that ask in the same generation (item 16), and the project page and
the non-retained walks, which still read the summary cache per project
(item 17).

### 8 — later

- **Deltas to clients:** lists send their generation and apply changed
  rows. This needs a capability, with the full refetch kept for older
  clients.
- **Metadata on demand** instead of resident (item 12).
- **Retire the legacy `ProjectScanner` cache** (item 31; about 90 call
  sites).
- **Codex's thread index** as its change source (item 21).
- **Full-prompt search in SQL** (FTS) instead of in the browser.

## Review gates

- **Plan review** before step 1.
- **Steps 1 and 2:** a review of each commit.
- **Step 3**, one gate per commit:
  1. Tables, migration and seed, with reads still on files. Tested on a
     copy of the real profile.
  2. Dual write with the mismatch counter, run on a second server against
     a copy of the real profile until the counter stays at zero.
  3. Switch reads and delete the folder, with the step 3 measurements
     recorded here.
- **Step 4:** reviewed for its deletion cases (tombstoned, missing from a
  scan, viewed jobs, sessions without identity) and for when
  `projects-changed` goes out.
- **Step 5:** list API responses identical before and after on real data.
- **Step 6:** a backup of `discovery.sqlite`, then a round-trip test over
  every real metadata row. The migration SQL gets its own review.
- **Step 7:** identical responses, and request timings before and after.

Two tools serve these gates:
- **A response-comparison script**, `scripts/compare-list-responses.mjs`
  (step 5). It fetches All Sessions, Inbox, project pages, the sidebar feeds
  and recents from two servers at once, normalizes volatile fields, diffs
  them including key order, and records request times.
- **A second server on a copied profile.** Copy the profile, taking
  `discovery.sqlite` with `VACUUM INTO`. Start the server with
  `YEP_DATA_DIR` set to the copy and a port other than 3400. Never restart
  the user's main server on 3400 without asking.

## Testing

- Migration tests run against a scratch copy of a real profile database:
  seed, metadata column extraction and `extra` round trip, and issue job
  conversion.
- `scripts/test-discovery-sqlite.mjs` runs the new SQL on both the
  `node:sqlite` and `bun:sqlite` drivers.
- The catalog contract tests that do not inspect files run unchanged:
  `retained-session-collections`, the catalog adapter tests and the
  identity tests.
- New tests:
  - an unchanged refresh advances no generation;
  - one changed file writes one row;
  - tombstones and the horizon;
  - `changed_gen` queries for consumers;
  - the epoch and generation survive the seed.
- Measurements recorded per step in this plan.

## Risks

- **Synchronous writes on the event loop.** Both drivers block. The seed
  (7,470 rows, 14 MB) and a publication after a `rowFormat` bump rewrite
  every row in one transaction. Chunking breaks atomicity unless readers
  keep serving the in-memory rows, which they do until step 7.
- **Rollback journal with a 250 ms busy timeout.** An outside reader
  holding a shared lock during a commit, such as a `sqlite3` shell or a
  backup, makes the publication fail with `SQLITE_BUSY`. A refresh failure
  triggers full rediscovery. That bound holds for large transactions only
  because the connection sets `cache_spill = OFF` (step 3, first commit).
- **A durable commit per changed generation.** The default synchronous
  setting syncs on every commit, and commits come every 4–8 s while a
  session is active. Measure commit latency.
- **Drivers.** On macOS, Bun may link the system SQLite rather than a
  bundled one. Any use of UPSERT, JSON functions, `RETURNING` or
  `DROP COLUMN` needs checking on both drivers.
- **Startup migrations.** Step 6's rebuild holds the startup lock. Lock
  contention refuses to start.

## Open questions

- How long to keep tombstones before an older token gets a replacement.
  Step 3 keeps 10,000 generations; revisit when step 8 sends deltas.
- Whether the display `title` length stays at today's 16,384 characters
  until full-prompt search moves into SQL.
- Whether to key `session_catalog` by public id once every row has an
  identity. Grok and pi rows have no native scope today.
- Whether a refresh that changes nothing still announces
  `refreshing: false`. Decided for step 3: yes, as before (see its third
  commit):
  - A response served mid-refresh reports `refreshing: true`
    (`RetainedSessionCollections.ts:145`).
  - `useRecentSessions` and `useSessionRelationships` act on the
    announcement.
  - The issue indexer and vocabulary wait for it (`app.ts:3737`, `:3836`).
- Step 5: merge the summary cache into catalog rows, or only do item 22.
  Decided: item 22 only; the merge (item 17) waits for step 7.
- Step 4: how project lists learn `lastActivity` once it leaves the project
  view version. Decided: it stays in the version; `projects-changed` names
  only the projects that changed (step 4).
- Step 6: a pruning rule for metadata with no identity that keeps user
  curation and remote-executor sessions. Still open after step 6, which
  prunes nothing. Also where item 11 gets the
  creation surface and the latest recap time; no server code reads
  `creationProvenance.surface` today.
- Whether a second server on a copied profile can stay passive. Answered
  for the step 3 gate (see the second commit): yes, by recipe, not by a
  mode. There is no switch for launches through HTTP routes, so the gate
  calls only read routes.
- Whether to trim `payload_json` after consumption, given its readers
  listed in step 1.
