# Cold session ownership and query boundaries

Source audit and isolated diagnostics, 2026-11-10, at `ed2535a42`.
No production behavior changed; measurements below are diagnostic, not target
acceptance or a performance improvement. This note supports the selected foundation in
[plan 190](../tactical/190-active-session-cost-at-scale.md#architectural-stages-and-priority);
that plan owns scope, order and acceptance targets.

## Finding and recommendation

Treat cold-session residency as an ownership/query problem spanning catalog
reads **and writes**, not as a standalone eviction task. SQL already stores
catalog and metadata rows, but the runtime still makes complete object
collections the interface between several owners. Removing one collection
without migrating its consumers would recreate population-sized work as
database reads, or leave other per-session mirrors resident.

Select the SQL-owned catalog and bounded session working set as the first
implementation workstream. The measured first slice is shared ownership of
Codex discovery maps, ahead of SQL list/seen-state migration. Its breadth is the
reason to prioritize it: Inbox, sidebar/global/project lists, catalog writes,
startup and cold metadata all depend on this boundary. The long-transcript
reader remains independently necessary; it is not fixed by this workstream.

Existing investigations already identify this direction:

- [SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md), items 8, 11 and 12:
  seen state in SQL, list projections, then on-demand metadata.
- [Catalog rewrites](../../gaps/session-catalog-rewrites-whole-generation-per-change.md):
  storage is row-oriented now, while publication and list consumers still
  visit the population.
- [Cold-storage startup](../../gaps/sqlite-backed-cold-storage-startup.md):
  query scope and startup retention remain open after the storage migration.
- [Codex/native-index research](codex-native-thread-index.md): local metadata
  was only a small fraction of measured heap. Do not assume lazy metadata
  alone removes most of the current process's memory.

## Confirmed ownership and dependencies

Paths below are source evidence, not retained-byte measurements.

| Owner | Current behavior | Consequence and migration dependency |
|---|---|---|
| [SessionMetadataService](../../packages/server/src/metadata/SessionMetadataService.ts) | `initialize` calls `rows.all()` and stores every decoded object in `state.sessions`; reads and updates use that object collection | Cold metadata is resident even though persistence is SQL. Move collection consumers and restart recovery before eviction. |
| [SessionMetadataRows](../../packages/server/src/metadata/session-metadata-rows.ts) | Queried fields and initial prompt already have columns; remaining data is `extra` JSON. Selected provider/sandbox queries overlay uncommitted changes | Reuse the existing storage owner. New list queries must preserve pending mutation visibility and exceptional values kept in `extra`. |
| [SessionCatalogService](../../packages/server/src/services/SessionCatalogService.ts) | `load` reads all rows/hashes into a published array and key index; project reads lazily group that array. `buildGeneration` constructs all rows again; `commit` compares all keys. Even `upsertRows` copies the array/index | Row-only SQL writes do not yet mean row-only runtime work. Readers and writers both need scoped interfaces. |
| [Catalog SQLite store](../../packages/server/src/services/session-catalog-sqlite.ts) | Durable per-row writes, generations and changed keys exist; `readRowsWithHashes` selects every row and joins full-title text | Useful foundation already exists. Normal list/point reads must avoid full-title joins and complete row hydration. |
| [Retained collections](../../packages/server/src/services/RetainedSessionCollections.ts) | Reconciliation passes all previous rows into adapters, reads all accepted rows and visits them for optional Codex questions. Created-session checks and internally observed-store lookup also use all rows | Replacing just the public list path leaves population work after each publication and during ordinary lifecycle events. |
| [Changed-file adapters](../../packages/server/src/sessions/catalog-adapters/collection-catalog-adapters.ts) | `refreshChangedRows` builds known paths from all previous rows, retains unchanged rows and yields a complete replacement collection | A known-file update reads only that transcript but still allocates/visits the catalog. Add indexed file-to-row/store resolution and explicit changed/deleted row results. |
| [Retained list construction](../../packages/server/src/routes/retained-session-collections.ts) | Projects identities, reads metadata/recaps/runtime state per row, computes global stats/options and sorts before routes select pages; a short sharing window joins requests | An LRU under `getMetadata` would turn this into a database lookup per session. Replace the collection algorithm first. |
| [NotificationService](../../packages/server/src/notifications/NotificationService.ts) | Loads all `notifications.json`; mark-seen rewrites it; unread is derived from last-seen and content time | SQL lists/counts need queryable seen facts with the same unread semantics. Migration preserves personal state, unlike a rebuildable catalog. |
| [Project projection](../../packages/server/src/projects/catalog-projects.ts) | `CatalogProjectsProjection` keeps a row-to-project map and compact member per eligible session; refolds the affected project's members | Delta consumption alone does not bound residency or make work independent of project size. Use SQL project aggregates/affected-project queries or justify measured compact retention. |
| Other readers | Project inventories, [host-process correlation](../../packages/server/src/services/host-process-catalog.ts), project/session lookup and optional issue/voice sources consume published rows/projects/changes | Migrate by actual request: keyed process matches, project pages, finite batches and change streams. Preserve scoped identity and ambiguity handling. |

The host-process reader matches native ids and roots across the corpus to
reject ambiguous matches. Replacing it with a convenient single-id lookup
must not silently drop that ambiguity check. Project inventories also merge
durable sessions that have no provider transcript yet.

## Query and update design to settle

Prefer the existing SQL tables and joins over a second authoritative session
store. A narrow maintained list projection is a candidate when it avoids
repeated derivation or supplies missing query fields, not a schema decision
already made by this audit. Record before coding:

- **Facts and writers:** native catalog facts, stable public identity,
  creation outcomes, YA metadata, last-seen state, recap time, live process
  state, external ownership and queue targets. Every duplicated derived
  field names its writer, invalidation trigger and rebuild procedure.
- **Atomicity:** related durable facts/projections change in their owning
  transaction; live runtime state has one explicit overlay/update boundary.
  Consumers see coherent generations and cannot publish stale computation
  over newer evidence. Pending metadata writes/deletions remain visible.
- **Page admission and ordering:** working-project overrides, archived/starred
  state, auto-archive deadlines, provider/executor/source filters, search,
  stable tie breaks and cursors. Applying a filter after SQL `LIMIT` can
  omit qualifying rows. Overlaying live rows must not lose or duplicate
  page membership.
- **Population results:** global stats, unread counts and project options are
  currently bundled with list responses. Moving only page rows saves little
  while these still walk every session. Inspect query plans and rows visited;
  a SQL `COUNT` or join is not automatically independent of population size.
  Compare indexed aggregates with maintained counters/rollups before choosing.
- **Inbox time:** preserve exclusive tier precedence, 20-row caps, queue and
  pending-input behavior, and 30-minute/8-hour/24-hour windows. Evaluate time
  boundaries at query time; later push delivery needs an owned next-deadline
  mechanism, not a timer per session or frozen tier membership.
- **Unread time:** preserve provider-content time versus recap/display time
  and active-process behavior from `session-runtime-overlay.ts` and
  `recap-overlays.ts`. A recap alone must not make content unread.
- **Failure/restart:** catalog remains rebuildable; metadata and seen state
  do not. Bounded recovery selects interrupted work rather than loading all
  JSON. Epoch changes, tombstone expiry and lost watcher events still need
  explicit reconciliation; normal startup must not wait for an entire corpus.

This work can preserve current HTTP response shapes. New client delta
semantics belong to the later capability-reviewed client stage. Internal
whole-generation reset consumers need finite batches/snapshot semantics;
explicit full-response APIs, such as all last-seen entries, must preserve
their contract without requiring a permanent in-memory mirror.

## Metadata-specific correctness work

Remaining population consumers include startup recovery of interrupted
display objects, running clearloop recovery, cross-session bang-command
display objects, and cache-miss billing history. `getAllMetadata` currently
has test callers but no production caller found in this source audit; the
named methods, direct `state.sessions` reads and update paths are the real
migration surface.

Every direct lookup and existence check must use the new storage boundary:
`commitNewSession`, `updateSessionMetadata`, `clearSession`, `getClearloop`,
and ordinary getters cannot interpret "not cached" as "not stored".
Dirty entries/deletion markers survive eviction until commit; failed writes
retain retries. `observeCommandInventory` has a reference-equality check;
either pin its in-flight value or change that logic with equivalent semantics.
Repeated absent lookups also need a bound. Hot objects should have a byte
bound as well as an entry bound because initial prompts and display objects
have very different sizes.

## Isolated ownership measurements

[Checked-in evidence](190-cold-session-ownership.evidence.json) holds the
seven heap/RSS samples per stage, owner counts, host evidence and SQL plans.
Built server `ed2535a42`, Node 25.8.2, Apple M4 Pro, 14 logical CPUs and
48 GiB physical memory. No browser or provider process was opened. The
scenario generator supplied equal Claude/Codex idle populations plus one tiny
Claude session (zero compactions, two turns per segment). Metadata and seen
state were absent initially and seeded only for the separate restart cases.
The resource sampler and CPU profiler were off.

| Idle sessions | Projects / Codex reader instances | Slots in each reader map family, summed | Heap after list reads, MiB | Heap freed by catalog release, MiB | Heap freed by reader-map release, MiB |
|---|---|---|---|---|---|
| 500 | 200 | 50,000 | 64.6 | 0.9 | 4.2 |
| 5,000 | 200 | 500,000 | 133.0 | 9.2 | 59.0 |
| 50,000 | 200 | 5,000,000 | 715.2 | 91.2 | 502.6 |
| 5,000 | 20 | 50,000 | 79.1 | 9.2 | 5.9 |

**Finding:** the dominant tested cold-session retention is duplicated
`CodexSessionReader.sessionFileCache` and `rolloutPathById`, not YA metadata.
Each project-scoped reader hydrates the whole Codex tree, even though the
existing shared enumeration already owns it. At 50,000 sessions, each of
200 readers has 25,000 slots in **each** map: ten million map slots total.
The corresponding session objects can be shared; these slot counts do not
mean ten million distinct session objects. Reducing only projects from 200
to 20 at 5,000 sessions reduces reader-map release from 59.0 to 5.9 MiB.
This demonstrates the project × Codex-session multiplier.

The app reader LRU has a 500-reader ceiling, which does not bound the bytes
held by each reader. `hydrateSessionFileCache` fills both maps before
`codexSessionsInProject` supplies the project view. Shared cache hits avoid
repeated hydration for the same version **after** each reader has made its
first complete mirror. A smaller LRU would mask that ownership problem and
increase reader reconstruction; it is not the selected fix.

The primary catalog and its associated indexes/projections also matter:
releasing `SessionCatalogService.published` after other empty owners freed
91.2 MiB at 50,000 sessions. The per-session `CatalogProjectsProjection`
identified in the source audit had **zero members in these Claude/Codex
fixtures**: its configured native-store eligibility does not include those
families. It remains a migration dependency for other providers, not an
attributed part of this scenario's heap.

### Metadata is an independent size dimension

Compare two unchanged-catalog restarts of the same world, first without
metadata, then with one metadata/seen record per catalog row. Initial prompts
are unique ASCII strings close to the requested size; source counts and total
prompt characters are in the evidence.

| Sessions / projects | Requested prompt bytes per row | Warm heap after lists, MiB | With metadata/seen state, MiB | Added retained heap, MiB |
|---|---|---|---|---|
| 5,000 / 200 | 1,024 | 133.3 | 139.5 | 6.2 |
| 50,000 / 200 | 1,024 | 721.6 | 788.3 | 66.7 |
| 5,000 / 20 | 16,384 | 79.4 | 159.0 | 79.6 |

Eager metadata is still a real growth problem. It is smaller than the reader
mirrors in the 1 KiB-per-row case, but dominates with sufficiently large
prompts. These fixtures do not predict an individual user's metadata sizes;
seen-state and metadata changes are combined in this experiment. Retain
on-demand metadata as part of the foundation, after its population consumers
have scoped queries.

### Method, reproduction and limits

The disposable runner reused `active-session.mjs`'s generator, passive server
settings and catalog-complete polling, stopping before browser launch. The
scale arguments were `--sessions 500|5000|50000 --projects 200` plus the
5,000/20-project control, `--compactions 0 --compaction-turns 2`, equal provider
shares, and `YEP_RESOURCE_SAMPLE_SECONDS=0`. HOME, native stores, XDG paths
and app data were isolated; ports were 3420/4420. Builds were outside the
working tree. No real provider/profile data was opened or changed.

After catalog readiness and 15 seconds settling, collect seven
`HeapProfiler.collectGarbage` / `Runtime.evaluate(process.memoryUsage())`
samples. Report the minimum heap and median RSS. Issue five sequential
requests to each of `/api/sessions?summaryMode=retained&limit=50` and
`/api/inbox?summaryMode=retained`, then repeat sampling. Warm and seeded
restarts settle for 10 seconds before the same checks. Request elapsed times
are not substituted for the plan's server-time targets.

For owner inspection, an ESM preload imported the already-used production
classes and exposed their **prototypes**, never instances. Use
`Runtime.queryObjects` with each prototype, inspect field sizes via
`Runtime.callFunctionOn`, then release the inspector object group. It found
200 Codex readers in every 200-project world and 20 in the 20-project world.
For example, sum each instance's `sessionFileCache.size` and
`rolloutPathById.size`, rather than assuming one global reader.

The release experiment is intentionally destructive: abort the isolated
retained-collection owner, then clear, in order, the project projection,
metadata state, seen state, published catalog, summary hot cache and reader
maps. The key operations were `catalog.published = null`, then later
`reader.sessionFileCache.clear()`, `reader.rolloutPathById.clear()`,
`reader.hydrated = undefined` and `reader.entryCache.clear()` on every reader.
Sample after each operation. The cold fixtures had no parsed transcript cache
entries. **No requests after release describe a working server.** These
order-dependent deltas are reachable-memory release evidence, not additive
exact object sizes or a safe production eviction algorithm. Retained-object
counts come from inspector queries; no heap snapshot/dominator analysis was
performed. The temporary runner was exploratory, not a new maintained suite.

One run per configuration; no interleaved implementation comparison. The
suite capacity key was
`host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`. Its CPU/swap sampler
uses `/proc`, so those Darwin fields were missing and **eligibility remained
diagnostic**. Supplementary native counters on the project-count control
showed 14% host CPU busy at baseline and unchanged 249.75 MiB swap usage;
those do not retroactively qualify the other runs. RSS is retained separately
from heap, and inspector queries/GC themselves raise transient RSS. Nothing
here passes or tightens a regression ratchet. Bun/other-OS qualification and
real-profile parity remain future implementation gates. All owned repro
servers were stopped and generated worlds removed; seeds/results remain local.

### SQL query-shape check

On copied generated databases, a narrow 51-row catalog page with scoped
identity and metadata joins still scanned/sorted the population under the
existing indexes. A candidate partial index on
`(updated_at DESC, native_id ASC) WHERE deleted = 0` removed the sort and
allowed the fixed-size page to stop early. Medians of 21 warm executions:

| Query prototype | 5,001 rows | 50,001 rows |
|---|---|---|
| Joined page, existing indexes | 4.64 ms | 47.62 ms |
| Joined page, candidate page index | 0.052 ms | 0.055 ms |
| Unread count, existing indexes | 4.58 ms | 57.25 ms |
| Unread count, with page index | 5.12 ms | 58.67 ms |

The evidence includes SQL and `EXPLAIN QUERY PLAN`. The unread prototype
joins an experimental seen-state table to compare content/seen times. These
queries intentionally omit application overlays, access filtering,
creation-only rows and exceptional metadata codecs. They establish a query
shape, **not** a production schema or response parity. Query execution here
used Node's builtin SQLite only. Counts still visit the population despite
the page index: the later SQL slice must address aggregates as well as rows.

## First implementation slice and exit evidence

The first implementation should remove the measured project × session
multiplier by moving discovered-file/path lookup ownership to the existing
Codex root-scope owner. This is an ownership correction inside the provider
adapter; no new provider protocol, transcript format, SQL migration, public
capability or alternative fast route is needed for this slice.

The boundary to implement and review:

- Root-scoped discovery owns the shared enumeration and rollout-id/path
  resolution. Project readers hold a reference/view and bounded exact-file
  observations, never complete copied maps of the root. Reuse the existing
  `codexSharedScanCache` / `CodexSessionMap` machinery where it fits; avoid a
  second competing registry or a universal provider framework for one case.
- Key ownership by the actual native store/observed root. Keep all-history
  and active-window scopes explicit. A filtered enumeration cannot certify
  absence from the unfiltered store. Project selection and authorization
  still use the existing scoped identity boundaries, not membership in a
  shared cache.
- Preserve newest-wins file precedence and exact fork/native-file hints when
  an older scan completes. Deletion, replacement, watcher epoch loss,
  compressed representations and archived ancestors retain current behavior.
- Closing/evicting one project reader releases its view and owned work without
  clearing discovery state needed by siblings. Invalidating the native root
  fences old in-flight completion for all readers. Declare bounds/lifecycle
  for root maps, archived paths, exact observations and negative lookups.
- Prove existing scanner/reader/lineage behavior plus a multi-project
  interleaving: concurrent scan and point observation, invalidation while a
  scan is pending, and one reader retiring while another continues. Use real
  synthetic files; do not retain shallow wiring tests for each map getter.
- Qualify at fixed Codex-session count and varied project/reader count.
  Discovery slots should be proportional to the corpus plus bounded views,
  rather than their product. Rerun isolated normal memory/startup/list phases
  before claiming a performance improvement; destructive release is only the
  attribution evidence for selecting this slice.

After that slice, build the SQL list/Inbox/seen-state foundation, including
statistics and project options; migrate changed-file publication and remaining
population consumers; then remove eager catalog/metadata mirrors. The full
query/writer design for that later SQL work is still open above. None of the
research here authorizes losing filters or stale/recovery semantics to obtain
a cheap page query.

Evidence must distinguish these outcomes:

- List/Inbox query and row hydration are bounded at fixed page size, including
  counts/options; cold prompts and recaps are not parsed across the population.
- A known-file write looks up and updates affected rows without copying or
  diffing the catalog. New-file classification and lost-watch repair are
  explicit, separately measured paths.
- Steady-state hot retention stays within declared bounds as the cold corpus
  grows; remaining compact per-session indexes are attributed and justified.
- Restart serves retained pages without hydrating all sessions; interrupted
  work recovers and missed/offline changes still reconcile correctly.
- Node/Bun parity and transaction/failed-save behavior pass before acceptance.

Large-transcript rereads, client list reloads and render costs remain separate
plan targets until their own stages land. This foundation must reduce shared
complexity and retire population interfaces, rather than adding an optimized
path alongside an indefinitely retained complete object model.

## Checkpoint validation

Documentation/evidence only; no application or test source changed. Local
link targets, JSON structure and whitespace are checked. `pnpm lint`,
`pnpm format:check`, `pnpm typecheck` and `pnpm source:budgets` pass on Node
25.8.2. Lint reports one existing informational regex-escape diagnostic in
`packages/client/scripts/design-buttons-check.ts:492`, not a warning/error.

Client suite: 684 files / 7,331 tests passed in 135 seconds. Server suite:
615 files / 7,244 tests passed, 13 files / 94 tests skipped; 11 tests in six
Claude-native files failed at the fixture version guard (expected 2.1.322,
installed executable reports 2.1.321), in 157 seconds overall. This is an
explicit native-qualification limit, not a green full server run. No provider
pin or global executable was changed to make the research checkpoint pass.
The next runtime slice must qualify the relevant native behavior with the
matching isolated test artifact before claiming acceptance.

Independent review through localhost:3400, session
`660fc429-9bea-472f-b394-ea81ec2f812f`: GPT-6.1-Sol, high effort, bypass
permissions; review-only. No must-fix, should-fix or nit findings. The review
checked source ownership, raw/evidence agreement, diagnostic limitations and
the proposed next boundary, and recommended committing this checkpoint. It
did not rerun the reported checks.
