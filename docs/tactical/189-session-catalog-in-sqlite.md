# Session catalog in SQLite

Topic: catalog-identity-projection-cost

Status: proposed 2026-11-09. Not started. Checked against the code at
`db161ab3c` and the maintainer's profile the same day.

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
  - `created_at`, `updated_at` (indexed), `last_human_turn_at`;
  - `async_questions` (small JSON).

  Catalog rows do not carry `model`, `messageCount`, `lastAgentText` or
  `contextUsage` today (`catalog-types.ts:24-56`). Those are summary fields
  and belong to step 5.
- **Bookkeeping:**
  - `fidelity`, `row_format`;
  - `row_hash`, so an unchanged row is never rewritten;
  - `changed_gen` (indexed) and `deleted`.

Long text lives in `session_catalog_text`, not in a last column. SQLite reads
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
  - 64 attachments per operation and 64 MiB per file
    (`creation-attachments.ts:52`, `:171`).
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

### 2 — cleanup with no schema change

- `git-untracked` snapshots: persist the HEAD sha and an index digest, not
  the tracked path lists (item 25).
- Delete the August review and palette fixtures under `projects/`
  (item 27).
- Rotate `sdk-raw.jsonl` and the client logs (item 34).
- Delete the one-time import leftovers, and the JSON summary writer that
  only tests reach (items 5, 14, 19). Those tests move to an in-memory
  database. This touches `SessionIndexService`, which step 5 changes.

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
- On startup, when `catalog_state` is empty, `initialize` copies the
  current manifest's epoch, generation and rows in one transaction.

The second commit writes both and compares:
- Each publication goes to the files and to SQLite.
- A mismatch counter compares the rows SQLite returns with the published
  rows.

The third commit switches reads and deletes the folder:
- A publication upserts changed rows and tombstones removed ones in one
  transaction. It advances the generation only when something changed.
- The Codex async-question pass (`RetainedSessionCollections.ts:431-472`)
  becomes row upserts instead of a second generation.
- After the first successful SQLite publication, delete `session-catalog/`.
- The in-memory published rows (`ef2914085`) stay for now.

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

### 7 — list pages as queries

Depends on steps 3 and 6, and on step 5 for the project page.

- All Sessions, Inbox, project pages and the sidebar feeds become indexed,
  bounded queries joining `session_catalog`, `session_identities` and
  `session_metadata`, sorted and paged in SQL (items 11, 15, 16).
- Point reads (content search, recents, host processes, the conversation
  source) look up by key.
- Response shapes do not change.

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
- **A response-comparison script**, to be written; none exists yet. It
  fetches All Sessions, Inbox, project pages, the sidebar feeds and recents
  from two servers, normalizes volatile fields, and diffs them.
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
  triggers full rediscovery.
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
  This only matters once step 8 sends deltas.
- Whether the display `title` length stays at today's 16,384 characters
  until full-prompt search moves into SQL.
- Whether to key `session_catalog` by public id once every row has an
  identity. Grok and pi rows have no native scope today.
- Whether a refresh that changes nothing still announces
  `refreshing: false`:
  - A response served mid-refresh reports `refreshing: true`
    (`RetainedSessionCollections.ts:145`).
  - `useRecentSessions` and `useSessionRelationships` act on the
    announcement.
  - The issue indexer and vocabulary wait for it (`app.ts:3737`, `:3836`).
- Step 5: merge the summary cache into catalog rows, or only do item 22.
- Step 4: how project lists learn `lastActivity` once it leaves the project
  view version.
- Step 6: a pruning rule for metadata with no identity that keeps user
  curation and remote-executor sessions. Also where item 11 gets the
  creation surface and the latest recap time; no server code reads
  `creationProvenance.surface` today.
- Whether a second server on a copied profile can stay passive. It must
  not run queues, restart recovery, wake turns, recaps or pushes against
  live sessions. Check before using it for the gates.
- Whether to trim `payload_json` after consumption, given its readers
  listed in step 1.
