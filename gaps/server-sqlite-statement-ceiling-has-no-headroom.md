# The server's test statement ceiling has no headroom, and a breach drops list rows silently

`packages/server/vitest.config.ts` sets `YEP_SQLITE_STATEMENT_CEILING=64`
(`topics/required-sqlite.md`). The server's fixed, one-per-SQL prepared
statements on one discovery database now reach exactly 64 in
`test/sessions/session-native-allocation.test.ts`. 963c062d9 added the 65th
(the viewer-path lookup in `SessionIdentityStore`). The breach is not the
repeated-prepare defect the ceiling exists to catch: every statement was live
once.

The breach was also invisible. The ceiling threw inside
`SessionCatalogSqliteStore.writeGeneration` (via `SessionCatalogService
.commitRows`), the catalog generation was lost, and the test saw only a saved
session missing from `/api/sessions?summaryMode=retained`. No error reached
the test output.

Not fixed in place: the fix moved the new statement to first use, which
restores 64 but leaves no margin, and `topics/required-sqlite.md` says not to
raise a package's ceiling to make a failing test pass. Candidate fixes, for
the maintainer to choose between: make the ceiling fire on a repeated SQL or
on growth past the fixed set, not on the fixed set's size alone; or record
the server's fixed count beside the ceiling and raise both together. Either
way, a ceiling breach during a catalog write should fail loudly in tests.

Found 2026-11-11 while diagnosing the CI failure of
session-native-allocation.test.ts on 8e0e5e279.
