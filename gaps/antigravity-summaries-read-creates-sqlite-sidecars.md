# Reading Antigravity's summaries index creates SQLite sidecars in the store

`AntigravitySummariesReader` opens `agy`'s `conversation_summaries.db` with
the shared adapter's read-only mode
([`antigravity-summaries.ts`](../packages/server/src/sessions/antigravity-summaries.ts#L382)).
The index is a WAL database, and SQLite creates an empty `-wal` and a 32 KiB
`-shm` beside it when they are absent, even for a read-only connection. When
no `agy` runs, `agy` has removed both, so any YA read of the index (catalog
discovery, project binding in `readAntigravityMetadata`, lineage checks)
leaves the two files in the native store, where they stay. The index itself
is not changed.

Plan 195 step 4's native case found this: viewing a stopped conversation
starts no `agy` and changes no file in its store except these two sidecars,
which appeared. The test records the exception. It predates step 4, which
reads history from the brain log and adds no new summaries read to a view.

Not fixed in place: opening without sidecars needs SQLite's `immutable` or
URI options, which widens the
[runtime-portable SQLite boundary](../topics/required-sqlite.md#runtime-portable-sqlite)
and needs maintainer agreement. `immutable` is also wrong while `agy` holds
the index open with uncheckpointed WAL content, so the open would have to
choose by whether a `-wal` exists, which races `agy` starting. Whether a
leftover empty WAL ever affects `agy` is not known; none was observed.

Found 2026-11-22 while serving Antigravity cold history from the log (plan 195
step 4).
