# Retained session collection queries

Retained `/api/sessions?summaryMode=retained` and `/api/inbox?summaryMode=retained`
share one query owner per `RetainedSessionCollections` and dependency set.
`retained-session-query.ts` owns synchronization and lifecycle;
`session-collection-sql.ts` owns its portable SQLite working tables. The
unretained compatibility path and standalone `/api/sessions/stats` retain
their existing behavior. The retained REST response shapes are unchanged.

Localhost tabs use finite retained REST reads, refreshed by WebSocket activity
events. They do not acquire endless HTTP collection responses: tabs share the
browser's per-origin HTTP/1 connection pool, so several live responses can
prevent even an initial session list from loading. Secure/relay transports
continue to use multiplexed collection updates. This choice preserves list
availability across tabs at the cost of repeated bounded reads after changes;
it does not restore the complete provider-corpus walk.

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
- Inbox's optional model settings share each changed row's metadata projection.
  Repeated cold-row polls do not reread launch settings. The private settings
  projection is omitted from ordinary global-session responses.
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
most 20 rows. Attention is reserved for pending questions and tool approvals;
cross-session delivery receipts remain row data without changing selection.
Checkpoints from before this attention rule rebuild from canonical facts.
Active and queued selections use separate bounded queries before merging. Archive expiry visits indexed rows crossing the cutoff, in chunks without decoding response JSON, including
clock reversal or disabling automatic archive; explicit metadata wins.
Recaps advance display time, never provider unread time.

## Bounded navigation enrichment

Known queued/selected session IDs drive primary-key seeks through `json_each`,
then the same grants, archive/search filters and locale cursor ordering apply.
An empty set returns immediately. The timeline index no longer scans unrelated
sessions to prove a queued ID absent. Normal timeline pages keep their existing
access path and equal-timestamp exception.

Selected parents join the profile-owned relationship store in chunks of 64,
with independently limited 32-edge pages per parent and two-parent ambiguity
lookahead per child. Existing relationship projection policy remains authoritative;
partial, unpublished, withheld and accepted-empty results remain distinct.
No provider storage is acquired or per-session result cache retained. Internal
complete reads also enrich only their selected parents through this boundary.
Project responses group visible queue counts from one `listAll()` result,
preserving the existing canonical project-path identity rules.

Collection streams can opt into `metadata=fields` only after the exact optional
`collection-metadata-fields` bit (159) is advertised. It adds `metaFields.set`
and `metaFields.removed` for changed top-level metadata fields. A catalog token
change no longer resends an unchanged project dictionary; the client preserves
that dictionary's reference. The server still supplies authoritative rows,
ordering and membership. Legacy and opt-in listeners share one acquisition and
revision. Initial/reconnect/backpressure replacements carry complete metadata,
and malformed or missed revisions use existing recovery. Older stable servers
and source builds without the bit keep complete metadata frames; no aggregate
sidebar client cutover or new refresh owner is introduced.

The client accepts every valid stream revision into its existing decoded query
view and advances the existing request/coverage fence, including counter-only
updates. A same-lineage nondecreasing catalog counter alone does not republish
the unchanged display snapshot or reobserve its rows. Row upserts/removals,
authoritative membership, other metadata (including loading/error state and
deadlines), lineage changes and complete replacements still publish. No row
membership is inferred on the client. Older metadata-replacement frames use
the same conservative comparison; unsupported servers keep existing fallback.

Sidebar and Inbox explicitly select initial-loading/error presentation. Once
both catalog observations are complete, a boolean background-refresh toggle alone
also leaves their display unchanged; raw status stays in the decoded query.
Cold/loading/error/complete transitions, unknown metadata and all row/membership
changes remain live. Consumers needing raw background-refresh state keep the
default presentation; the shared entry uses the union of its consumers' needs.
Changing that union reacquires an authoritative replacement, so a new raw-status
consumer cannot inherit a suppressed loading-only snapshot.

A scalar display version belongs to the retained query entry. Consumers mark a
version published only inside successful request-fence acceptance. If a later
counter update overtakes a pending row update, its complete decoded body still
publishes the outstanding display version. Reconnect/visibility/pagination
replacements advance it and heal local state even when their rows are identical.
No second row snapshot, per-session cache, timer or server contract is added.
[Display-publication outcome](../docs/research/190-collection-display-publication.md)
owns qualification and measurements.

[Navigation outcome](../docs/research/190-bounded-navigation-projection.md) owns
measurements and qualification. This reduces selected-row/project work; it does
not close restart, all-consumer memory or transcript-rendering targets.

## Sidebar snapshots

`GET /api/sessions/sidebar` returns bounded recent, starred and categorized
windows from the same retained SQL owner. Each limit defaults to 50 and accepts
integers 1–500. One synchronization precedes all three canonical selections;
project grants and archive filters apply before limits. Rows are hydrated only
after selection in batches of at most 256 and deduplicated across windows.
The response has `rows`, `windows` (IDs and `hasMore` per feed), `catalog`, and an
optional `nextTransitionAt` archive deadline. It omits project dictionaries and
global stats. The limited-user middleware treats this as a collection and
projects authorized/visible rows and window IDs together.

The exact optional `sidebar-session-snapshot` bit names the aggregate endpoint
and retained timestamp/identity cursor contract. Absent or unknown support keeps
date cursors; source builds reporting 0.12.0 without the bit do not imply it.
Old clients and existing collection stream contracts continue to work.

The production sidebar retains its existing three feed/collection-update owners.
A whole-snapshot client cutover was measured and rejected: cheap server reads
did not make repeated full browser replacement cheaper. The aggregate GET is a
qualified API and a proposal for later adoption, not a new default polling path.
Its future adoption requires a browser CPU/data-movement win as well as fast SQL.
The existing stream still computes canonical membership on the server; no new
client membership engine or refresh queue was added.

On capable servers, starred/category rendering uses accepted query-window IDs,
including deep pages, so cached entities cannot restore an omitted session.
Pointer/focus does not hold membership. Hidden/closed navigation releases feed
acquisition. Windows retain existing independent pagination. Retained
`/api/sessions` reads accept an `after` JSON tuple `[updatedAt,id]`; continuation
compares identities with the canonical locale tie order, then fills from strictly
older timestamps. This prevents skipped rows without hydrating a whole tie group.
Older servers keep their existing selectors and date cursors. Expanded reads
cost their requested coverage; the default sidebar adds no whole-catalog mirror.

Compact session rows compare their rendered scalar/DTO props independently of
record freshness clocks. Their non-human delivery decoration subscribes to its
three value fields, not the whole session record. New callback references, React
content, changed DTO values, context and local input state remain live. Detailed
cards retain their existing relative-age refresh behavior; compact hover ages
recalculate on opening. There is no second row cache or provider-specific path.

The snapshot route exposes `Server-Timing` phases for synchronization, selection,
hydration, serialization and total route time. See
[sidebar investigation and evidence](../docs/research/190-sidebar-snapshot.md).
First projection construction/restoration and exceptional tie-key selection can
still depend on population size; this endpoint does not claim page-sized startup.

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
