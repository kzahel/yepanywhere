# Retained session collection queries

Retained `/api/sessions?summaryMode=retained` and `/api/inbox?summaryMode=retained`
share one query owner per `RetainedSessionCollections` and dependency set.
`retained-session-query.ts` owns synchronization and lifecycle;
`session-collection-sql.ts` owns its portable SQLite working tables. The
unretained compatibility path and standalone `/api/sessions/stats` retain
their existing behavior. This does not change the public API.

## Authority and lifetime

Provider/catalog rows remain native facts. Identity projection, metadata,
creation control, notifications and live processes remain their existing
canonical authorities. The query index is disposable derived state, never a
second durable authority. Its TEMP tables live on the profile's portable
SQLite connection and disappear on owner retirement or process exit. Default
TEMP storage is unchanged (file-backed defaults in the checked Node 25/Bun 1.3.14
builds). A derived durable checkpoint can restore the working tables; it has
no authority over canonical facts.

A WeakMap shares the owner across lists, Inbox and tabs. Replacing dependencies
retires it. Collection abort removes subscriptions, finalizes its bounded
8-statement LRU and drops its tables. Reads serialize through one promise
chain; a failed partial synchronization forces a full replacement next time.
Rebuild chunks yield so unrelated work can run. Row indexes and grouped
counters are constructed after initial insertion; subsequent changes maintain
them through triggers in the row-update transaction.

## Writers and query boundary

- Accepted catalog changes identify added/changed/deleted native keys. SQL
  records native-to-public source links. The first source in accepted catalog
  source order (family/store, then stable SQL row order) wins when aliases share a public ID.
- Metadata working-overlay changes and row writes/removals publish keyed
  invalidations. An overlay revision fences edit/revert races during builds. Dirty unsaved
  metadata overlays remain visible, including failed commits and cancellation
  back to an already committed value. Observers do not decide durability.
- Creation changes publish keyed invalidations; point queries read compact
  control projections without decoding saved prompts or retry requests.
- Notification mark-seen and clear invalidate that session's unread projection.
  Seen persistence is now canonical per-row SQL; events follow commit.
- Previous/current live process IDs refresh their runtime overlay. This work
  scales with the live set; cold external ownership is hydrated on page.
- Project display options are project-sized. Changes to a resolved project name
  invalidate that project's indexed members. Legacy unscoped, pending/conflicting
  identity rows and OpenCode alias overrides retain conservative revalidation.

Filters, principal project grants, archive state and time cursors apply in SQL
before page or tier limits. Page JSON is decoded only after selection. Child
relationships are attached only to authorized selected parents. Grouped
project/provider/executor counters answer statistics without a session walk.
Starred counts include archived rows as before; other population/unread counts
exclude archived rows. Search normalizes each changed row with JavaScript's
Unicode lowercase rules and searches the four existing fields in SQL.

Inbox queries current time and current queue IDs on every request. Exclusive
attention, active/queued, recent, unread8h and unread24h tiers each return at
most 20 rows. Active and queued selections use separate bounded queries before
merging. Archive expiry visits indexed rows crossing the cutoff, in chunks without decoding response JSON, including
clock reversal or disabling automatic archive; explicit metadata wins.
Recaps advance display time, never provider unread time.

## Restart restoration

A completed query checkpoints its derived rows, native/public source links,
project facts, catalog token and ordering counters in profile SQLite. Changed
working rows mirror transactionally; a partially applied query invalidates the
checkpoint before it changes durable derived data. Metadata, seen, identity and
creation mutations advance a canonical revision in their own transaction.
Only a checkpoint at that exact revision, with a compatible format/dependency
signature and no observed pending metadata, may restore. Otherwise it rebuilds
from canonical facts. This deliberately rebuilds after a canonical change while
the owner was absent; keyed catch-up across absence is not implemented.

Each working owner remains isolated. A replacement claims the single checkpoint;
a superseded owner cannot overwrite or certify it. Real metadata/notification
services must name the same profile database before checkpoint reuse is enabled.
Fake or differently stored services retain normal full reconstruction. Restored
previous/current live IDs, project display names, archive cutoffs and selected
ownership/children are refreshed under the normal query rules. Inbox always
reads current queue IDs/time. A checkpoint never makes a saved process live.

Restoration copies and indexes SQL rows without decoding the cold catalog or
normalizing every metadata row in JavaScript. This is still population-sized
SQL work, not a page-sized restart guarantee. The first-ever build is also
population-sized. Stable checkpoint restores avoid repeating that JS build;
failed/partial builds and incompatible checkpoints use the same complete path.

## Costs still open

Other catalog consumers and client delta delivery remain plan 190 work.
Canonical metadata is now loaded on demand, with pinned dirty overlays and
bounded batch snapshots. The projection consumes those snapshots directly;
large or pinned batches do not depend on fitting in the clean LRU. Legacy
metadata acquisition during identity adoption is batched only for candidates
that need it; bound identities do not acquire metadata for repeat projection.
[Cold-state ownership evidence](../docs/research/190-cold-state-sql.md) records
restart/seen-write and retained-memory observations. First-ever or invalidated projection construction remains population-sized.

Optional substring search scans normalized SQL text. To preserve existing
`localeCompare` ordering across Node/Bun, a page expands keys at its boundary
timestamp, sorts those keys in JavaScript and hydrates only the selected page.
A large equal-timestamp group therefore still costs proportional key work.
Legacy unstable identity revalidation is another explicit bound exception.
Do not claim that every possible query or restart is proportional to page size.

[Plan190](../docs/tactical/190-active-session-cost-at-scale.md) and
[query evidence](../docs/research/190-sql-collection-queries.md) own qualification.
