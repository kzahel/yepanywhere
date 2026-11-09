# Session catalog in SQLite

Topic: catalog-identity-projection-cost

Status: proposed 2026-11-09. Not started.

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
[SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md) items 1, 11–17 and
22–35).

Non-goals:

- No API change in steps 1–7. Responses, events and capabilities stay as
  they are. Only step 8 (deltas to clients) needs a capability.
- Not yet removing whole-corpus memory residency. The schema is shaped so
  lists, projects and change queries need no resident corpus, and later
  work can then stop keeping one (item 12), toward an unbounded number of
  sessions.
- No change to provider readers or transcript formats.

## Schema

Everything lives in `discovery.sqlite`, through the existing numbered
migrations (`storage/migrations/`, `PRAGMA user_version`, currently 27).

| Table | Change | Holds |
|---|---|---|
| `session_catalog` | new | One row per native provider session: list columns, file fingerprint, `changed_gen`, tombstone |
| `session_catalog_text` | new | The full first prompt or title, keyed like `session_catalog` |
| `catalog_state` | new | One row: epoch, generation, tombstone horizon |
| `catalog_sources` | new | Provider source version per (family, store) |
| `session_metadata` | reshaped | Queried fields become columns; the rest stays in an `extra` JSON column |
| `issue_index_jobs` | reshaped | Points at a catalog row with a fingerprint instead of copying it |
| `session_summary_index`, `session_summary_scopes` | removed | Merged into `session_catalog` |
| `session_identities` and all others | unchanged | |

`session_catalog`:
- **Key:** `(family, store_key, native_id)`. It stays native, because
  rows exist before a session has a public identity. Public ids come from
  `session_identities` through the native reference that
  `nativeCatalogSessionRef` builds today (`sessions/catalog-identity.ts:19`).
- **Project and location:** `project_key` (indexed), `project_id`,
  `project_path`, `location_kind`, `location_path`, `native_storage_scope`.
- **Freshness:** `file_mtime` and `file_size`. They decide whether a file
  must be reread; this is what the summary cache does today.
- **List facts:**
  - `provider`, `model`, `title` (display length);
  - `created_at`, `updated_at` (indexed), `last_human_turn_at`;
  - `message_count`, `last_agent_text` (short);
  - `context_usage` and `async_questions` (small JSON).
- **Bookkeeping:**
  - `fidelity`, `source_version`, `row_format`;
  - `row_hash`, so an unchanged row is never rewritten;
  - `changed_gen` (indexed) and `deleted`.

Long text lives in `session_catalog_text`, not in a last column. SQLite reads
a large column only when it is selected, but `ALTER TABLE ADD COLUMN`
appends after it, so a later small column would sit behind the overflow
chain.

`session_metadata` gains these columns:
- `provider` (what YA ran; not a copy of `session_identities.provider`);
- `working_project_id` (indexed);
- `is_archived`, `is_starred`, `custom_title`, `sidebar_category`;
- `initial_prompt`, kept only when it differs from the full title.

Everything else (launch settings, router binding, sandbox, recap and about
25 more keys) stays in `extra`. `SessionMetadataService` keeps its
in-memory object shape.

## How a change flows

1. A watcher reports transcript X.
2. The refresh compares X's fingerprint and rereads X alone.
3. One transaction upserts X's row only if its `row_hash` changed. That
   sets `changed_gen` to N+1 and advances `catalog_state.generation` to
   N+1.
4. `session-catalog-updated` goes out with generation N+1, as today.
5. Server consumers (the issue indexer, the project view, vocabulary)
   read `WHERE changed_gen > their last generation`.

A refresh that changes nothing publishes nothing, so a quiet server does
no work.

## Compatibility

Steps 1–7 are server bookkeeping.

The wire state `{catalogEpoch, catalogGeneration, complete, refreshing}`
keeps its meaning: generations still increase within an epoch, and clients
treat them as opaque. They now advance only when a row changes, which the
client's duplicate-announcement filter
(`client/src/lib/clientQueryRevalidation.ts`) already tolerates.

Step 3 starts one new epoch. Clients already treat an epoch change as a
replacement and refetch. The new epoch is seeded from the last published
generation, so lists never show empty while it fills.

Downgrade is unsupported, as for every migration since required SQLite
([backward compatibility](../../topics/backward-compat.md)).

## Steps

### 1 — remove the session-creation lifetime limit

- Drop the lifetime totals in `session_creation_capacity`: 10,000
  operations, 512 MiB saved payload, 64 MiB attempt bytes, and attachment
  bytes (`SessionCreationStore.ts:189-193`, `:808-829`).
- Keep the per-item checks: 256 KiB per request, 8 KiB per attempt
  record, 64 attempts per creation.
- Keep the `generation` counter. It fences late launch callbacks and
  versions the creation list; it may move to its own table.
- Clear `payload_json` once a creation is consumed, since that is what
  actually grows.
- Update the bounds paragraph of
  [session identity](../../topics/session-identity.md).

Independent of the catalog; can land first.

### 2 — cleanup with no schema change

- `git-untracked` snapshots: persist the HEAD sha and an index digest, not
  the tracked path lists (item 25).
- Delete the August review and palette fixtures under `projects/`
  (item 27).
- Rotate `sdk-raw.jsonl` and the client logs (item 34).
- Delete the one-time import leftovers, and the JSON summary writer that
  only tests reach (items 5, 14, 19).

### 3 — catalog storage in SQLite

- Add the four catalog tables.
- Replace generation directories inside `SessionCatalogService`, keeping
  its interface (`reconcile`, `readRows`, `readProjectRows`, `getToken`)
  so callers do not change.
- A publication upserts changed rows and tombstones removed ones in one
  transaction, and does nothing when nothing changed.
- Seed the new epoch from the last published generation's rows. After the
  first successful publication, delete `session-catalog/`.
- The in-memory published rows (`ef2914085`) stay for now.

Measure:
- bytes written per changed session (14.3 MB today);
- publications per idle minute (zero expected);
- full and project read latency against the 7,470-row synthetic catalog.

### 4 — catalog consumers read changes

- The issue indexer, project view and vocabulary learning read
  `changed_gen` deltas instead of walking every row each generation
  (items 29–30).
- `issue_index_jobs` keeps the catalog key and a fingerprint, not
  `source_json` (item 24). The migration derives both from the copied row,
  then drops it.
- Jobs whose session is gone are deleted.
- Leave `lastActivity` out of the project view version, so
  `projects-changed` goes out only when membership or names change.

### 5 — merge the summary cache into catalog rows

- `SessionIndexService` reads and writes `session_catalog` and
  `session_catalog_text` instead of `session_summary_index`. Fingerprints
  and list facts carry over, so no transcript is reparsed.
- Drop `session_summary_index` and `session_summary_scopes`.
- The complete-mode list and project page read the same rows (item 17).

### 6 — session metadata columns

- Rebuild `session_metadata` as a rowid table with the columns above.
  Values come from `json_extract`; `extra` is the blob without them.
- Load all rows at startup as today.
- Item 3's point questions become indexed queries on the new columns.
- Prune metadata rows that have neither an identity nor a catalog row
  (379 here).

This is user data, so the migration is tested against a copy of a real
profile database.

### 7 — list pages as queries

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

## Testing

- Migration tests run against a scratch copy of a real profile database:
  seed, epoch change, metadata column extraction and `extra` round trip,
  and issue job conversion.
- The existing catalog contract tests (`retained-session-collections`,
  catalog adapter and identity tests) run unchanged against the new
  storage.
- New tests:
  - an unchanged refresh publishes nothing;
  - one changed file writes one row;
  - tombstones and the horizon;
  - `changed_gen` queries for consumers.
- Measurements recorded per step in this plan.

## Open questions

- How long to keep tombstones before an older token gets a replacement.
  This only matters once step 8 sends deltas.
- Whether the display `title` length stays at today's 16,384 characters
  until full-prompt search moves into SQL.
- Whether to key `session_catalog` by public id once every row has an
  identity.
