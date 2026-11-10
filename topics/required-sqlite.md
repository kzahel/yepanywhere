# Built-in SQLite storage

> SQLite is required YA storage infrastructure. It holds session metadata, keeps
> cold data out of RAM and avoids startup-blocking JSON loads. It uses the
> runtime builtin, without a native package build. A server that cannot open it
> does not start. Product features keep their own enablement and retention
> policies; opening storage does not enable learning, search, or indexing.

Topic: required-sqlite (commits before 2026-11-09 used `optional-sqlite`)

Verified: 2026-10-11

See also: [YA environment variables](ya-env-vars.md) for `YEP_DATA_DIR`.

## Startup policy

The server opens `{dataDir}/discovery.sqlite` once at startup, before any
service that stores state in it. If it cannot, the server logs one actionable
`[Startup]` line and exits with a non-zero status. Every failure is fatal:

- the runtime has no SQLite builtin;
- the data directory cannot be created or sits on a network filesystem;
- the file is foreign, malformed, newer than this build, locked past the
  250 ms wait, or fails a migration.

There is no setting to disable storage or to open it anyway. The operator
corrects the cause, typically by moving the data directory with
`YEP_DATA_DIR`, and restarts. `YEP_SQLITE` was removed on 2026-10-11; the server
and desktop launcher no longer read or pass it.

## Designs that predate required storage

Several stores and caches were built before YA had a database and still
assume it has none:
- whole-file JSON rewrites of growing state;
- immutable whole-catalog generations on disk;
- full in-memory mirrors scanned to answer point questions.

New growing or frequently written state belongs in a table, written per
changed row in one transaction per batch and read by bounded, indexed
queries. Small, capped, rarely written or human-edited files (settings,
secrets, recents, client lists) stay files.
[SQLite cleanup and wins](../gaps/sqlite-cleanup-and-wins.md) and
[session catalog rewrites](../gaps/session-catalog-rewrites-whole-generation-per-change.md)
track the existing designs still to move.

## Data directory placement

The discovery database is only as fast as the filesystem holding the data
directory. Both adapters are synchronous and SQLite takes a file lock per
transaction, so a data directory on a network filesystem puts a network round
trip on the event loop for every transaction. Measured on an NFSv4 home with an
effectively empty database, the main thread spent 95% of samples in
uninterruptible sleep on `fcntl`, event-loop delay reached 6.5–10.7 s per
one-minute sample, and `GET /health` took 4–13 s while the dev frontend proxy
returned 502. The same database on local NVMe answered the same read
transactions in 0.008 ms.

So startup identifies the data directory's filesystem before opening anything.
On a network filesystem the server refuses to start, naming the filesystem and
recommending `YEP_DATA_DIR` on local disk. A server that will not start is
explicit; one that starts and stops answering is not. There is no override.

Classification is positive evidence only. `packages/server/src/lib/filesystemKind.ts`
owns the one table of filesystem identities and names a category — network,
memory-backed or a userspace FUSE driver. The placement check is the only
caller that reads the category; speech vocabulary uses the same probe for free
space alone, since both its files now live in the data directory and inherit
this decision rather than making their own. Only the network category
refuses SQLite: a FUSE mount names who implements the filesystem rather than
where the bytes live, and a memory-backed one takes locks locally. A filesystem
the table does not name, an uninspectable directory, and every platform whose
`statfs` numbers this table does not carry, currently macOS and Windows, are all
treated as local disk, so the check can cost a working install nothing.

Callers must not turn a large corpus into one transaction per item. Even on
local disk that is a lock per item; on a share it is the failure above. The
[issue/session association](issue-session-associations.md) catalog sweep is the
worked example: it reads the set of sessions a write could affect once, rather
than opening a write transaction per catalog row.

### When YA may choose the directory for the user

YA may offer to place the data directory only when both hold: no explicit
`YEP_DATA_DIR` or named `YEP_PROFILE`, and the default `~/.yep-anywhere` does
not exist yet. Either condition alone is the wrong trigger. An absent variable
fires on every start for the majority who never set one and are already on
local disk, and an absent directory alone would offer to relocate a directory
the user pinned deliberately, which
[hard development rules](hard-development-rules.md) § User Configuration Is
Authoritative forbids. When the directory already exists the question is no
longer selection but migration, with existing session metadata to preserve.

"First run" is not a separate condition to test: onboarding state lives at
`{dataDir}/onboarding.json`, so it is read from the directory whose location is
being decided, and the desktop runtime reports onboarding complete by default
and never writes that file at all. Directory absence is what first run means
here.

The filesystem refusal above deliberately has the opposite trigger and applies
to every resolved data directory, including an explicit `YEP_DATA_DIR`. Setting
that variable is an authoritative choice of location; it is not a claim that
the location can take file locks, and the consequence of being wrong is a
server that stops answering rather than a preference YA disagrees with.

Initialization runs once per server process. Version requests do not probe
storage. Server logs retain initialization error details; wire status contains
no paths or raw exception messages.

## Runtime adapters

The server selects `bun:sqlite` when running under Bun and otherwise attempts
`node:sqlite`, once, at startup; a runtime without one fails startup as
described under [Startup policy](#startup-policy). No
SQLite package, native installer, sidecar, or compiler is added to the core
distribution. Desktop's pinned Bun is tested directly, independently of claims
about newer Bun versions' Node compatibility.

### Runtime-Portable SQLite

`@yep-anywhere/shared/sqlite` is deliberately the *intersection* of the SQLite
backends YA supports: `node:sqlite` on Node, `bun:sqlite` on Bun. Server, relay
and push broker all go through it. Keep backend-only capability behind that
boundary. `node:sqlite` also offers `columns()`, `iterate()`, `setReadBigInts()`,
`setReturnArrays()` and the named-parameter toggles; the adapter exposes none of
them, and no Bun equivalent either. Where the backends differ in type, the
contract takes the narrower common one: a BLOB is a `Uint8Array`, never a Node
`Buffer`.

`finalize()` is the one deliberate exception, because the concept itself is not
symmetric — Bun statements own native resources and Node's do not. The adapter
offers it to every caller and makes it a no-op where the runtime has no such
concept.

The failure this prevents is invisible on the runtime most people test. A caller
that prepares the same SQL on every call looks free on Node, where
`StatementSync` has no `finalize` and the collector reclaims each statement, and
retains every statement until close on Bun. So `pnpm test` sets
`YEP_SQLITE_STATEMENT_CEILING` in each package's vitest config, and that pattern
fails where it is written rather than in a Bun deployment nobody exercised. Reuse
one prepared statement per SQL. Do not raise a package's ceiling to make a
regression pass.

If complying carries a real performance cost, do not widen the interface
quietly. Measure the cost, state it in the commit message and in the discussion,
and get maintainer consensus across every deployment that uses the adapter —
standalone Node server, Bun server, Desktop's pinned Bun, relay, push broker —
before revising the boundary. The disclosure is the contract: an unexplained
backend-specific call is a defect even when it is faster.

`YEP_SQLITE_STATEMENT_CEILING` fails an open database once its live prepared
statements pass the given count, naming the most repeated SQL. It is unset in
production and set in each package's vitest config, because preparing per call
is free-looking on Node and unbounded on Bun. Reusing one statement per SQL
keeps the count flat regardless of request volume.

The adapter is `@yep-anywhere/shared/sqlite`. The server reaches it through
`packages/server/src/storage/sqlite.ts`, which re-exports it so packaged
`dist/storage/sqlite.js` keeps the path the runtime contract scripts load.
Relay and push broker import it directly; one implementation serves all three
rather than each carrying its own native addon.

The adapter exposes synchronous prepared statements with positional parameters,
SQL execution, transactions, and idempotent close. Values are strings, null,
byte arrays, and numbers; integer inputs/results must fit JavaScript's safe
integer range. A missing single row is `undefined` on both runtimes. `run`
returns the affected `changes` count, which both runtimes report as a number.
`get` and `all` take an optional row type that is the caller's assertion about
its own SELECT, exactly as a cast would be; SQLite supplies no column types.
BLOB columns come back as `Uint8Array` on both runtimes, never Node `Buffer`.
A caller that cannot degrade without storage uses `openSqliteOrThrow`, which
fails with a runtime-requirement message instead of returning undefined.
For foreign provider history, `open(path, { readOnly: true })` and the matching
`openSqliteOrThrow` option use an engine-enforced read-only file open. Missing
files fail instead of creating a database. This is common functionality on the
supported [Node floor](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html#new-databasesyncpath-options)
and [Bun](https://bun.sh/docs/runtime/sqlite); the adapter translates the option's
backend spelling and preserves normal opens by default. Native provider readers
must still reuse/finalize statements and close their handles; they do not gain
write, checkpoint or migration authority over a provider database. No backend-only
statement or result API is exposed.

Transaction callbacks must be synchronous; nested transactions and thenable
results are rejected. Callers must not begin or commit transactions manually
within a callback.
Future indexing consumers must bound their synchronous work rather than place
large scans on request paths.

Callers finalize statements when finished. Finalization drops the statement on
Node and explicitly releases its native resources on Bun. Closing the adapter
also finalizes outstanding Bun statements before closing the database; Bun
1.3.14's default close otherwise leaves them and the Windows file handle alive.
Using a finalized statement or one belonging to a closed adapter throws.

Node versions without an accessible SQLite builtin fail startup; there is no
mode that runs without storage. Node's experimental-module notice on applicable
versions is not suppressed by the service.

## Personal draft data

[Draft synchronization](draft-synchronization.md) stores current snapshots,
operation receipts, recovery copies and file ownership in migration 008 of the
existing database. These are durable personal data, not rebuildable discovery
indexes. Backups and migrations
must preserve them along with the other non-rebuildable tables.
Migration 009 adds the account/sequence index used for bounded draft metadata
catch-up. It preserves all draft rows, revisions, retry receipts and retention;
the existing schema migration transaction owns its creation.

## Database ownership and migration

The database is `{dataDir}/discovery.sqlite`, using the existing profile and
`YEP_DATA_DIR` resolution. No project or Git-metadata writes are introduced.
The server opens one connection at startup and shares it between session
metadata and the app; it closes when the process exits. An app created without
that connection, as tests do, opens and disposes its own. Separate profiles
have separate databases.

The initial schema reserves a YA application identity (`0x59414449`, ASCII
`YADI`). Historical version 2 added speech vocabulary tables; version 3 removed
its receipts/counts/staging tables. The remaining vocabulary state table is no
longer used: active learning settings and counts live in their separate JSON and
`speech-vocabulary.sqlite` files. See
[learned vocabulary](pluggable-speech-recognition.md#learned-vocabulary-contract).
Versions 4 through 7 add [issue/session associations](issue-session-associations.md):
durable issue/evidence tables, tracker confirmation, learned Jira prefix/site
mappings, and operational indexing/resolution/deletion state. Migration 7 only
schedules its URL-learning and candidate backfill; bounded post-startup worker
batches own the conversion.
Opening the database does not enable that experiment.
Version 10 adds [session metadata](#session-metadata). Version 11 adds durable
GitHub status facts and retry timestamps, keyed to existing issue identities.
It performs no network access or transcript acquisition; rows fill only when
viewed with the relevant feature enabled.

Version 25 adds provider session-summary scopes and per-session summary rows.
These cross-session indexes share the required database. Indexed
selected-session reads do not load the scope's other summaries. See
[session index validation](session-index-validation.md). Version 30 rebuilds
the summary rows as a rowid table with the uncapped `fullTitle` in its own
last column (`full_title`, NULL for a null title) and the rest of the summary
as JSON. A title holding a lone surrogate or a NUL stays in the JSON, because
a text column would replace the surrogate and node:sqlite cuts text at a NUL.
Rows that are not JSON objects, or whose scope is gone, are not carried
over; the cache rebuilds them from transcripts. Version 31 gives
[session metadata](#session-metadata) its queried columns. Version 32 adds
canonical session seen rows/import markers and guarded partial indexes for
metadata feature/recovery queries.

Version 35 adds rebuildable Claude transcript source headers, compact source
facts, visible row positions, orphan tool facts and leased staging manifests.
It performs no provider reads or backfill at migration/startup. Source payload
remains in the native file; profile-owned detail acquisition populates the index.
See [Claude acquisition](claude.md#transcript-acquisition-and-retention) and
[the implementation evidence](../docs/research/190-claude-durable-index.md).

Version 36 adds rebuildable Claude node/tool ownership, source-offset lookup,
pending queues and a semantic task-reducer checkpoint. The profile-owned writer
updates affected rows and its source header in one transaction; ordinary appends
no longer restore the complete source graph. Old checkpoints bootstrap these
facts lazily on a changed read, with no migration-time transcript reads/backfill.
See [SQL writer ownership/evidence](../docs/research/190-claude-sql-writer.md).

One statically registered, consecutive migration sequence owns `user_version`.
Historical SQL lives in frozen named modules; released migrations are append-only.
Do not edit, renumber or reuse them, or import mutable current feature schemas.
`discoveryMigrationPrefix(version)` builds historical fixtures with the actual
migration prefix. Resolve concurrent number collisions before landing.
Additive changes are preferred; data conversions need preservation/rollback
fixtures and a recovery plan. Provider reads and large backfills belong in bounded
resumable post-startup work, never migration initialization. A future destructive
conversion's backup must be a consistent SQLite backup, not a live file copy.

Pending migrations and version advancement run in one immediate transaction.
Foreign keys are enabled and lock waits are bounded to 250 ms, including the
migration lock. Cache spill is off, so a transaction larger than the page
cache also fails within that bound while an outside reader holds a shared
lock, instead of waiting out the timeout once per spill for as long as the
reader stays. The default rollback journal remains unchanged. Even a no-op
startup takes the immediate lock; concurrent mixed-version profile use is not
supported. Lock contention at startup refuses to start, without data loss.

An existing foreign database, malformed database, or newer schema is refused.
YA does not reset or delete it. A failed migration rolls back its statements
and schema version. Initialization closes a partially opened connection before
refusing startup. The database is not disposable: issue decisions, manual titles and historical
evidence must survive independently of rebuildable indexing checkpoints.
There are no automatic down migrations, and downgrading is not supported: an
older build cannot read session metadata from this database. Disabling a
feature does not roll back the schema. Recover by upgrading again or explicitly
restoring a consistent pre-upgrade backup.

Other JSON metadata/caches and OpenCode's independently owned database and
reader are unaffected.

Relay and push broker moved off `better-sqlite3` to this adapter on 2026-09-10,
so the repository ships no native SQLite addon and needs no compiler on any
host. Their `relay.db` and `push-broker.db` files are ordinary SQLite and were
not migrated or rewritten. Like the server's discovery store, both exist to
persist durable state, so a missing builtin is a startup failure rather than a
degraded state. That removes the Rocky Linux 8 prebuild floor that
previously broke both suites: the prebuilt binary required a newer glibc than
enterprise Linux 8 provides, and no library path could satisfy it.

## Session metadata

The [YA-owned session identity](session-identity.md) foundation adds migration
17: public identity/provider/original project/creation time and an optional
all-or-none native family/storage scope/id binding, unique within that scope.
Metadata keys and native transcripts are unchanged. The identity owner shares
the profile connection and uses three fixed prepared statements; discovery
adoption cannot claim an unbound managed id. A discovery publication adopts
its rows in one transaction with atomic conflict rollback, rather than opening
a write transaction for each row. Startup requests/attempts remain
pending: these identity rows alone do not provide durable creation.
The [creation proposal](session-creation.sketches.md) depends on that boundary;
future schema changes follow the migration and no-downgrade rules above.

Migration 10 adds `session_metadata`, one row per session keyed by session id,
holding that session's metadata object as JSON, and `session_metadata_import`,
a single row recording that the legacy file was handled.

Migration 31 rebuilds `session_metadata` as a rowid table with a unique
`session_id`. Queried keys are columns: `provider`, `working_project_id`,
`is_archived` and `is_starred` (0/1), `custom_title`, `sidebar_category`,
`parent_session_id`, `parent_session_kind`, `forked_from_session_id`,
`executor`, `sandbox_level`, and `initial_prompt` last. Everything else stays
JSON in `extra`.

- **Columns hold only what they store exactly.** A key moves to its column
  only when its value has the column's type (a string; `true`/`false` for the
  0/1 columns) and, for text, holds no lone surrogate or NUL, which SQLite
  would replace or node:sqlite would cut. Otherwise it stays in `extra`, and a
  key present in `extra` wins over its column on read. Rows that are not JSON
  objects are carried over in `extra` unchanged. Lazy initialization does not
  decode unrelated rows; invalid JSON still fails when read.
  `metadata/session-metadata-rows.ts` is the runtime codec; the migration
  freezes its own key list.
- **Same values.** Reading reassembles each object with equal values; only
  top-level key order changes (column keys come after `extra`'s), which no
  reader observes. Encoding is deterministic, so a loaded object compares equal
  to its row and is not rewritten. The exception is a string holding a
  literal backslash before `ud8…` or `u0000`: the migration's GLOB matches it
  and keeps it in `extra`, while the codec would give it its column, so the
  first save of that session writes the row once. This profile has none.
- **Point queries.** Recorded providers, the `claude-ollama` check and
  `project-write` sandbox sessions are indexed queries (partial indexes on
  `provider` and `sandbox_level = 'project-write'`; each query repeats the
  indexed condition); the debug counts scan the narrow columns. The partial
  index on `working_project_id` is for plan 189 step 7's project pages.
  Sessions with uncommitted changes are excluded from the SQL and answered from
  memory, so a pending or failed save never makes an answer stale. SQL readers
  of a column fall back to `extra` (`coalesce(column, json_extract(extra, …))`)
  so a value kept there reads as before.

- **One-time import.** On first start after the upgrade, YA imports
  `{dataDir}/session-metadata.json` in one transaction and records the import.
  Pre-version-3 lineage fields are converted on the way in. A missing file
  records an empty import.
- **Never read or written again.** After the import the JSON file is left on
  disk, unchanged, for manual recovery only. Later edits to it have no effect.
- **Unreadable file.** A legacy file that cannot be read or parsed stops
  startup and records no import, so a repaired file is imported on the next
  start. YA never replaces it.
- **Writes.** Saves visit only sessions mutated through the service, including
  startup recovery and deletions. Each candidate is compared with its indexed
  SQLite row; unchanged cold sessions are neither serialized nor queried. There
  is no retained second copy of the corpus as JSON strings. Changed rows and
  deletions commit in one transaction; failures retain the pending mutations
  for retry. Saves are synchronous, so requests arriving during a drain
  coalesce. Callers change metadata through service methods, not by mutating
  returned projections.
- **Bounded cold reads.** Ordinary startup reads only import state and indexed
  interrupted-display owners. Clean objects and absent results share a
  256-entry / 8 MiB estimated string-payload LRU. Dirty updates and deletion
  tombstones stay pinned until commit, even under pressure or failed saves.
  Returned objects are read-only projections; reference identity lasts while
  hot, and callers mutate through service methods. SQL batches contain at most
  256 keys and return a local snapshot independently of LRU admission. Oversized
  batches can exceed the clean cache's byte budget transiently; they are not
  repeatedly reread through the cache to construct their result.
- **Scoped views.** Running clearloop IDs, display-object owners, billing-event
  owners and restart recovery use guarded partial SQL indexes. Feature views
  omit the full prompt column and do not populate the clean cache. Explicit
  `getAllMetadata` exports remain complete snapshots for diagnostics; there is
  no resident full metadata map. Feature views may still visit all matching
  feature owners; this is not a claim of output-only billing-query cost.
- **Concurrent first start.** The import re-checks its marker inside its
  transaction, so two connections initializing together import once.
- **Maintenance scripts.** `scripts/prune-stale-index-entries.ts` edits rows
  directly through the codec and refuses until the server has imported and
  migrated them to version 31; stop the server before
  running it, because live hot/dirty entries and derived query state are not invalidated
  by an offline script.
- **Restart recovery.** Fork-summary jobs left `generating` and bang commands
  left `running` load as interrupted errors, as before.

## Session seen state

Version 32 stores `session_last_seen(session_id, entry_json)` and a single
`session_last_seen_import` marker. Each entry remains exact JSON (including
escaped message IDs), rather than a whole-profile serialized map. Ordinary
reads use indexed session keys; an explicit all-seen export is still available
for the existing HTTP response. The service retains no corpus or miss map.

The first initialization imports `{dataDir}/notifications.json` and its marker
in one transaction, rechecking the marker after acquiring the lock. A missing
file records an empty import. Unreadable, invalid or failed imports refuse
initialization, leave the source untouched and can be retried after repair.
The committed marker prevents later leftovers/edits from resurrecting cleared
rows; cleanup of the imported file is best-effort. The JSON writer is removed.

Mark-seen compares the provided timestamp, server time and existing row using
the previous lexical timestamp rule. The comparison and one-row upsert share
an immediate transaction, so another connection cannot replace newer state
with an older mark. Clear deletes only that key. Calls resolve after commit;
seen events and query invalidations are published afterward. A failed mutation
leaves the previous SQL value visible, publishes nothing, and rejects for retry.
`flush` has no deferred writer to drain. Statements have a fixed vocabulary and
are finalized with the service or profile connection. Metadata import marker
statements are startup-owned and finalized immediately after initialization.

The native catalog mirror and TEMP list-query construction remain separate
[plan 190](../docs/tactical/190-active-session-cost-at-scale.md) work.

## Availability and frontend compatibility

`GET /api/version` has an additive optional field:

```ts
sqlite?: {
  state: "disabled" | "unsupported" | "ready" | "error";
  networkFilesystem?: string;
};
```

Current servers always report `ready`, because they do not start otherwise.
`disabled`, `unsupported`, `error` and `networkFilesystem` come only from older
servers, which could run without storage; clients keep handling them for those
servers through the compatibility horizon. An absent field means that source
server does not report SQLite state. A frontend must not infer readiness from
its own runtime, desktop presence, or server semver. The field passes through the existing source-scoped version
snapshot, including legacy and negotiated capability encodings.

`networkFilesystem` is present only when placement was the reason for `error`,
and it carries a filesystem name such as `NFS`, never a path or an exception
message. Both the local and hosted clients render it as one dismissible banner
recommending `YEP_DATA_DIR` on local disk, dismissed per named filesystem so the
advice returns if a later data directory lands on a different share. A client
that cannot see the field, talking to a server that does not send it, shows no
banner, which is the behavior every released client already has.

No generic SQLite capability ID is allocated. Future session discovery routes
must receive their own exact optional capability, advertised only when their
implementation and required storage are available. Storage readiness alone
does not enable discovery UI. Old/disabled servers receive no new requests;
older clients can ignore the new field. Existing capability meanings and protocol
levels are unchanged; the separately approved server runtime floor is documented in
[server runtimes](server-runtime.md).

The approved optional-feature corpus is v0.8.0 (2026-08-31) and v0.8.1
(2026-09-05): the latest two stable server releases and all stable server
releases within the preceding 14 days on 2026-09-08. Both lack SQLite status.
This change adds no frontend consumer, endpoint, or unsupported fallback call.

## Verification

`scripts/test-discovery-sqlite.mjs` runs the same contract against packaged
modules across the supported Node boundaries and Desktop's pinned Bun. It
covers persistence, parameters, rollback, migrations, newer/corrupt files,
contention, teardown and refusal without a driver. Shared-file
checks verify Node/Bun interoperability.

`scripts/test-sqlite-startup.mjs` checks real packaged `/api/version` state and
runtime identity in disposable profiles. The Server Runtime And SQLite workflow
also verifies fresh npm installation rather than only attached workspace deps.
Linux, macOS and Windows run full Node/Bun startup with a usable database, and
check that an unusable one makes the server exit non-zero without publishing a
port. The [restored matrix](https://github.com/kzahel/yepanywhere/actions/runs/34485119811)
passed all twelve OS/Node combinations on 2026-09-10; Windows no longer excludes
full packaged startup.
Node 20 is no longer a supported main-server runtime; an old running server
remains compatible with the hosted frontend. See [server runtimes](server-runtime.md).

Related: [server capabilities](server-capabilities.md),
[YA environment variables](ya-env-vars.md),
[OpenCode storage](opencode-backend.md).
