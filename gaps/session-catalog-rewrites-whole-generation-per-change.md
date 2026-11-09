# The session catalog rewrites and rereads every row to record one change

The retained session catalog
(`packages/server/src/services/SessionCatalogService.ts`) persists each
publication as a complete immutable generation of JSONL shard files plus a
manifest. It was built on 2026-08-05 (`dee048f37`), before YA had a database:
SQLite arrived as optional storage on 2026-09-08 and became required on
2026-10-11 ([required SQLite](../topics/required-sqlite.md)). Whole-generation
files were the file-only way to get crash-safe publication and consistent
readers. Every one of those properties is now available from one SQLite
transaction, and the file design costs O(catalog) work for every change.

This supersedes the former `retained-catalog-identity-resolution-cpu.md` gap
and expands items 1 and 13 of
[SQLite cleanup and wins](sqlite-cleanup-and-wins.md).

## Measured, 2026-11-09

The maintainer's macOS server (`~/.yep-anywhere/session-catalog`, server
running since 2026-11-06) is at generation 866,648 with 7,470 rows. Each
generation writes 14.3 MB of row JSON across 64 shard files plus a 675 KB
manifest. The deltas retained in the manifest show a generation every
3.8–7.6 s (three samples, 05:30–05:48 UTC). Each changed at most one row,
and 24–36% changed none. That is roughly 2–4 MB/s of writes while a session is
active. There is no fsync, so most of it lands in the page cache first. On
2026-11-06 the same host had 1,526 rows and published every ~2 s, with 211 of
463 generations empty.

Stall profiles from 2026-11-08 attribute 8–11 s of every 30 s to
`readRetainedSessionItems`, with 1.5–2.3 s event-loop stalls. About 6–9 s of
that was public identity projection, which `c519559c2` cut from 115 ms to
29 ms per full read (`benchmark:catalog-identity`). The rest is per-row
overlays.

## Why it publishes so often

With issue associations enabled at `recent` scope (as on this host), every
`session-updated` event and every `process-state-changed` that leaves
`in-turn` calls `catalog.invalidate()` with no path (`app.ts:3730-3742`).
A pathless invalidation sets `discover`, so each one is a full rediscovery of
every provider store plus a new generation. Vocabulary learning does the same
(`app.ts:3842-3848`). Other full-rediscovery triggers:
- every `session-created` event, whose payload is ignored
  (`RetainedSessionCollections.ts:80-81`);
- `SessionIndexService`'s 30 s check, which emits `session-created` for
  sessions it sees become non-empty (`SessionIndexService.ts:2121-2131`);
- more than 1,024 changed paths;
- any refresh failure.

File-family adapters stamp `sourceVersion: reconciliation:<generation>`
(`collection-catalog-adapters.ts:392`). So the provider source versions
change on every publication, even when no row did.

## What one changed session costs today

1. The watcher reports the file and `RetainedSessionCollections.invalidate`
   schedules a refresh (300 ms debounce).
2. `refresh` reads the whole previous generation, then asks the adapters for
   rows. A known file is re-read alone, but every other row is still yielded.
   An unknown file, or a `session-created` event, falls back to full discovery
   of every provider store (`refreshChangedRows` in
   `sessions/catalog-adapters/collection-catalog-adapters.ts` returns
   `undefined`: "A newly observed file needs discovery to establish its
   project membership").
3. `buildGeneration` serializes every row into a new staging directory,
   digests each shard, and renames it into place.
4. `computeDelta` reads the changed shards of both generations back to diff
   them, and the manifest (with its retained delta list) is rewritten.
5. Fixed 2026-11-09: `readRows` used to read the whole new generation back
   for every whole-catalog caller, because a full read counted against the
   8 MiB project hot budget evicted itself. The publishing process now keeps
   the rows it wrote and serves whole-catalog and project reads from them.
   A synthetic 7,470-row, 11.6 MB catalog went from a 14.7 ms median full
   read to 0.09 ms. The cost is resident heap of about the row JSON's
   size (13.4 MB for 12.9 MB of JSON, more with non-Latin-1 titles), and
   two generations at once while a publication builds, every few seconds
   on a busy host. The rows are still walked per request (step 7).
6. A Codex async-question pass walks every row, which can publish a second
   generation.
7. `session-catalog-updated` is emitted twice per refresh (once with
   `refreshing: true` from inside reconcile, then again at the end). The
   global feed, Inbox, recents and project queues refetch on both. Each tab
   runs three sidebar feeds, Inbox, and optionally the recents dropdown and
   All Sessions. Each is a full `readRetainedSessionItems` walk (identity
   projection, overlays on all 7,470 rows, sort) before slicing to a page.
   The retained branch has no single-flight between them, and the client
   deliberately sends no generation token in retained mode
   (`useGlobalSessionsFeed.ts:464-467`).

The delta and conditional machinery is unused. `getConditional` and the
manifest's `recentRows` have no caller outside `SessionCatalogService`, so
clients never receive deltas. The server computes and stores them anyway.

## Proposed shape

Rows in the profile database, keyed natively, written per changed row:

- `session_catalog_rows(catalog_family, store_key, session_id, …)` is keyed
  by the native row key. It also holds `project_identity_key`, the native
  scope and id, `updated_at`, the row JSON, `changed_generation`, and a
  `deleted` tombstone flag. Indexes cover `changed_generation` and
  `project_identity_key`.
- `session_catalog_state` holds the epoch, the generation, provider source
  versions, and the oldest generation for which tombstones are retained.
- A publication is one transaction. It upserts only changed rows (rows whose
  JSON is unchanged are skipped), tombstones removed rows, and advances the
  generation only when something changed.
- "Changes since generation N" is `WHERE changed_generation > ?`. A token
  older than the tombstone horizon, or from another epoch, gets a
  replacement. That keeps the existing token contract in
  [session catalog observation](../topics/session-catalog-observation.md#generations-and-coherent-projections)
  without shard digests or generation directories.
- Public identity becomes a `LEFT JOIN session_identities` on the native
  triple. Pending-allocation exclusion stays a query. Adoption of unbound
  rows moves to publication time, so reads stop projecting identities.
- The catalog stays a rebuildable cache. Migration starts a fresh epoch and
  rediscovers; the existing generation directories are deleted after a
  successful first publication.

Then a changed session costs one row read from its file, one upsert and one
event carrying the new generation. A quiet server costs nothing.

Titles are 8.6 MB of the 14.3 MB of row JSON. They are allowed up to 16,384
characters so the browser can search full titles, and the same text is also
stored in `session_summary_index` and `session_metadata.initialPrompt`.
Keep a display title and the full title in separate columns so page reads
never load full titles.

## Required alongside the table

Moving storage alone keeps step 7. These go with it:

- **New sessions without full discovery.** Classify the one new file.
  A Codex rollout head carries its `cwd`; the Claude project directory is in
  the path. Full discovery should be needed only on startup, a lineage
  reset, or a lost watcher.
- **Delta delivery to clients.** Lists ask with their generation and apply
  changed rows, or the event carries them. Full rebuilds happen only on
  replacement.
- **Overlays as their own deltas.** Metadata, recap, unread and process state
  change on their own events. Item 11 of the cleanup sweep (a list
  projection table) is the matching server-side shape.
- **Bounded synchronous reads.** SQLite calls block the event loop. Full-list
  reads of ~14 MB of row JSON must not stay on request paths; page, project
  and delta queries must be indexed and bounded.

## Fix now, independent of the table

These are defects, not design, and each is small:

1. Done 2026-11-09: one generation's parsed rows stay in memory outside the
   byte budget, seeded by the publication that wrote them.
2. Make the issue indexer and vocabulary learning invalidate the event's
   session path instead of forcing discovery. Use the `session-created`
   payload rather than rediscovering everything. A new Claude file in a
   known store can take its project from sibling rows.
3. Emit `session-catalog-updated` once per refresh, or have every client
   ignore `refreshing: true`.

## Not recommended now

The interim fixes (skip empty publications, hard-link unchanged shards) are
throwaway once rows move to SQLite. Do them only if the migration is
deferred for more than a few weeks.

Found 2026-11-08 while profiling Codex scanner fan-out on the maintainer's
host; measured and expanded 2026-11-09.
