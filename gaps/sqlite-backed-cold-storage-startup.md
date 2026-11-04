# Large JSON stores delay server readiness and retain cold data in RAM

Progress, 2026-11-04: production provider summaries now persist in the required
SQLite database. Legacy per-scope JSON indexes import lazily and atomically;
selected-session summary reads query one row instead of loading the scope.
Append-only tail reads can reuse the durable indexed prefix while watcher
invalidation remains pending. See
[session index validation](../topics/session-index-validation.md).
This closes that selected-session storage path, not the broader cold catalog,
retained metadata, or startup/memory investigation below.

The maintainer reports that loading huge JSON stores into memory gates YA
startup before the server becomes usable. Kyle has approved requiring Node
22.16+, so built-in SQLite on supported Node and Bun is now an available
solution, without a third-party native database dependency.

Inspect the awaited initialization chain in `packages/server/src/index.ts`
before selecting migrations. A concrete candidate is
`packages/server/src/metadata/SessionMetadataService.ts`: initialization reads
and parses the complete metadata file into its retained state. Separately,
`packages/server/src/indexes/SessionIndexService.ts` loads complete per-project
JSON indexes on demand; measure its contribution to first usable views rather
than assuming all indexes are eagerly loaded at boot.

Replace suitable cold stores with indexed SQLite tables and bounded queries.
Less frequently queried, non-hot-path data should never need to be loaded
entirely into memory. Keep small configuration and demonstrated hot working
sets simple; do not migrate every JSON file indiscriminately. Reuse the
Node/Bun adapter in `packages/server/src/storage/sqlite.ts` and respect
[app-data ownership](../topics/project-directory-storage.md).

Before implementation, measure readiness time, initial view latency, retained
memory, and each candidate's file size/read/parse cost. Preserve public APIs,
atomic updates, and durable user metadata through resumable, failure-safe
migration. Distinguish disposable indexes from irreplaceable state. Verify
restart and interrupted migration, bounded cold queries, and Node/Bun behavior
across supported operating systems. Update the runtime floor and the stale
optional-storage assumptions in [optional SQLite](../topics/optional-sqlite.md)
as the approved policy is enacted.

Related: [slow sidebar after restart](sidebar-slow-after-server-restart.md)
tracks one visible symptom and its catalog-read path; this gap covers the
broader startup/storage ownership problem. No migration is implemented here.

Found 2026-09-08 while implementing persistent speech vocabulary; captured at
the maintainer's explicit request to preserve the now-authorized SQLite path.
