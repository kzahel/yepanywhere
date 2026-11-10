# SQL-owned retained collection queries

Plan: [190](../tactical/190-active-session-cost-at-scale.md), architectural
stage 2 / original step 4. This slice moves retained list/Inbox consumers to one
provider-independent query boundary and removes their former complete
projection walk. [Owning contract](../../topics/session-collection-queries.md)
records authorities, writers, lifetime and remaining bound exceptions.

Follow-up: [canonical cold-state ownership](190-cold-state-sql.md) removes the
metadata/seen corpus mirrors and adds bounded metadata snapshots. This note's
before/after figures describe the earlier query-consumer slice; its TEMP
projection still rebuilds after restart.

## Architecture and scope

The existing native catalog, public identity bindings, metadata, creation
control, notification and live-process authorities are preserved. One TEMP SQL
working index per retained collection stores derived selection/search fields,
response JSON, native source links, project options and grouped counters.
Catalog changes and keyed metadata/creation/seen notifications update affected
rows. Unsaved metadata is a pinned overlay; reverting or failing a save cannot
hide it. Live runtime state is refreshed from the finite process set.

SQL applies grants and filters before page/tier limits, then selected JSON is
decoded. Child relationships are enriched after authorization and selection.
Inbox's clock and queue remain per request. Native duplicate-source precedence,
Unicode/NUL search and JavaScript locale tie ordering preserve existing
semantics. The old retained 20 ms full-walk implementation and its obsolete
shared-walk test are removed; actual SQL route/mutation coverage replaces it.
Fake retained test facades now seed real catalog/profile fixtures.

There is no main schema migration, public capability change, client edit or
new durable authority. The query statement LRU is capped at 8, with compact
creation point statements lazy and finalized at store close. The existing
application statement-ceiling 64 test remains unchanged. Node 25.8.2 and the
repository-pinned Bun 1.3.14 both report TEMP_STORE=1; no temp-store pragma is
changed. Canonical eager catalog/metadata objects and notification JSON remain.

## Diagnostic protocol

`scripts/perf-repro/session-collection-query.mjs` runs real Hono list/Inbox
routes, catalog/profile SQL, metadata and notifications in a temporary home.
The isolated synthetic catalog contains 50,000 rows, half Claude/half Codex,
200 projects, empty initial metadata, unique decreasing five-minute timestamps
and no live provider processes. Scanner/reader stubs throw if a retained query
enters provider discovery/history. No server, browser or real provider store
is touched. Each request includes serialization; list limit 50, Inbox 20/tier.

Before: runtime source a63f683a3 (shared discovery ownership). After: the SQL
query source in this change (final reviewed implementation). Builds live outside
the shared checkout; no client build. Fresh worlds run before/after/before/after, profiler off, twelve warm
samples per route. Seven forced-GC memory samples and a keyed star update are
recorded. The final evidence JSON stores all raw results, runtime/source hashes,
capacity key, baseline/end host observations and native Darwin CPU/swap samples.
No figures from the separate attribution CPU profile enter this comparison.

This is an in-process query diagnostic, not the 50k-transcript active-tab world.
Darwin suite CPU/swap eligibility is incomplete and the host has concurrent
work. These are observations, not ratchets or proof that a full plan target is
met. Harness memory includes synthetic inputs/canonical mirrors and cannot be
compared with previous full-server memory results.

## Outcome

[Raw interleaved evidence](190-sql-collection-queries.evidence.json):

| Fresh run | First list ms | Warm list median / p95 ms | Warm Inbox median / p95 ms | Cold metadata touches list / Inbox |
|---|---:|---:|---:|---:|
| reviewed-before1 | 657 | 95.10 / 102.30 | 140.00 / 222.09 | 100,000 / 150,288 |
| reviewed-after1 | 2472 | 1.03 / 1.28 | 2.59 / 3.43 | 0 / 0 |
| reviewed-before2 | 667 | 98.41 / 100.80 | 143.13 / 216.82 | 100,000 / 150,288 |
| reviewed-after2 | 2486 | 1.02 / 1.31 | 2.43 / 3.12 | 0 / 0 |

The after runs retain 125.5/125.4 MiB heap versus 151.8/151.8 MiB in the
before harness;
RSS is 582.1/581.5 MiB after versus 779.9/937.9 MiB before. These are harness
observations with forced GC, not full-server memory acceptance. All four runs
assert response counts, bounded page sizes and the keyed star update.
The measured warm-only route observations are below the plan's 10 ms aim;
the cold construction and full active-tab acceptance remain open.

The prototype exposed a first-read regression (~6.4 s). Attribution found TEMP
source-row autocommits dominating construction. Chunked transactions and bulk
index/counter construction reduce it to about 2.4 s in the pilot, versus 640 ms
for the old first walk. Subsequent polls share the index rather than rebuilding
all response rows; warm pilot medians fall from 93 to 1 ms (list) and 137 to 2.4 ms
(Inbox), with zero cold metadata getter calls versus 100,000/150,288.
This one-time cold cost remains open, rather than being moved into startup and
reported as a query saving. Initial source synchronization/projection remains
population-sized. Optional substring search, large boundary timestamp ties and
legacy unstable identity revalidation retain additional costs (owning contract).

## Verification and review

Six real SQL regression scenarios cover warm keyed work, unsaved/reverted/failed
metadata, seen/clear plus recap unread semantics, archive expiry/clock reversal,
Unicode/NUL search and locale ties, and native source alias precedence.
Copying those tests to the old source produces one meaningful failure: repeated
warm polls touch metadata 1,024 times versus the new bound below 8. Other scenarios preserve
existing behavior. No stash or shared source swapping is used.

Full client: 7,331 passing. Full server: 7,269 passing, 94 skipped and 11 failures
from the pre-existing Claude native executable-version guard (fixture 2.1.322,
installed 2.1.321). Version pins/executables are unchanged. Root typecheck passed.
Root lint, format, source budgets and typecheck pass. Lint retains one unrelated
info-level client regex diagnostic. Metadata's frozen budget ratchets 1534→1533;
app.ts changes only disposal order with no line growth. Five focused route/state
files pass 75 tests before the review corrections. Both review regressions pass
on the corrected source. The final full server run exits 1 solely for the 11
previously observed version guards (6 failed, 617 passed, 13 skipped files). Node 25.8.2 and repository-pinned Bun 1.3.14 pass the portable SQLite
contract on the final compiled source. Separate 400-row Node/Bun route checks
also round-trip automatic archive flags/counters through clock advance/reversal.
Their timings are functional smoke evidence, not performance comparisons.

YA API review session `c0a90675-4131-4c01-b0b4-200defc0ed8a` ran Codex
`gpt-6.1-sol`, effort high, bypass permissions, review-only. It found one
must-fix: app-owned SQLite closed before collection/query retirement; and one
should-fix: archive expiry hydrated/rewrote cold JSON in one synchronous loop.
Both were verified and fixed. Disposal now precedes database close. Expiry
updates only archive flags and grouped counters in <=256-key transactions,
yielding between batches. A real-app disposal regression and the archive
no-cold-JSON assertion both fail on the pre-fix isolated source and pass on the
fixed source. The follow-up review reports no remaining must-fix, should-fix
or nit findings, while explicitly preserving the cold-build qualification.
No user server was stopped/restarted and no real provider/profile store was
written directly.
