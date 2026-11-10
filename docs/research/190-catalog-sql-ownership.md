# SQL catalog ownership and safe query restoration

Plan 190's fourth architecture slice follows
[cold canonical state](190-cold-state-sql.md). It moves the remaining native
catalog corpus out of retained JavaScript ownership, publishes known file
changes without constructing a whole generation, and restores completed list /
Inbox query projections safely. This is a foundation across providers, not a
provider-specific transcript optimization.

## Ownership and correctness

- SQLite owns accepted catalog rows, counts, coverage and change history.
  `SessionCatalogService` retains its generation descriptor and a 256-entry /
  8 MiB estimated-payload point cache. Complete reads are caller-owned results.
- Indexed file/native/project lookups serve targeted publication, creation
  confirmation and activity. Direct-file store/project counters classify a new
  Claude file only when existing membership is unambiguous. Unknown membership
  still discovers. Explicit partial scans carry upserts/removals; whole-store
  scans replace only named stores. Full discovery remains a complete scan.
- Only explicitly marked scoped factories receive partial previous input;
  unmarked legacy factories keep complete previous rows. Concurrent partial
  scans queue instead of coalescing different deltas from one store.
- Production project views retain project-sized SQL aggregate results, not
  per-session membership maps. SQL aggregation still visits eligible rows.
- The disposable query checkpoint stores derived SQL rows/source links/projects,
  ordering counters and the catalog token. Canonical metadata, seen, identity
  and creation writes increment its revision in the same transaction. A changed
  revision during query absence conservatively rebuilds; there is no separate
  canonical authority or response cache.
- Incremental working mutations invalidate and mirror changed rows atomically.
  Full construction invalidates first, then bulk-copies the completed working
  tables transactionally. Owner nonces fence superseded working owners.
- Certification rejects canonical or working-overlay revision changes, observed pending metadata,
  pending dirty IDs and dirty-recording overflow. Working-overlay mutations
  publish keyed invalidations before any durable commit. An optimistic edit/revert
  during a yielded build cannot certify stale facts even without a durable
  metadata write. Restored live IDs, names and archive state are rederived;
  selected ownership/children and Inbox queue/time remain current.

The contracts live in [catalog observation](../../topics/session-catalog-observation.md#sql-catalog-ownership-and-partial-publication)
and [collection queries](../../topics/session-collection-queries.md#restart-restoration).
No provider schema/protocol or client capability changed.

## Isolated 50,000-session diagnostics

Before: `b7221c411`; after: external WORKTREE server build. No working-tree
client build or production server changes. Run order was before → after →
after → before on fresh profiles, profiler off, Node 25.8.2, macOS arm64.
The catalog probe seeds in a separate process, then measures service reopen,
forced-GC retained memory and twelve point publications. It is not a complete
server. The mixed-provider route probe uses 50,000 native rows across 200
projects, twelve warm list/Inbox samples and a replacement query owner on the
same canonical connection. Restoration includes constructor SQL copy and index
construction, but is not a complete server/process restart. It asserts counts
and tracks metadata batch rows touched. Fixtures are deleted after each run.

| Observation | Before (two runs) | After (two runs) |
| --- | --- | --- |
| Catalog-only retained JS heap | 56.86 MiB | 5.51 MiB |
| Catalog-only median RSS | 332.91–333.17 MiB | 58.77–58.95 MiB |
| Catalog service initialize | 201.3–207.4 ms | 0.69–0.72 ms |
| Point-publication median | 6.63–7.47 ms | 0.70–0.76 ms |
| Recreated query first page | 2176–2206 ms | 478–500 ms |
| Metadata batch rows on recreation | 50,000 | 0 |
| First-ever list projection | 2806–2898 ms | 3926–4061 ms |
| Warm list median | 1.02–1.03 ms | 1.26–1.29 ms |
| Warm Inbox median | 2.47–2.51 ms | 2.55–2.58 ms |

The first-ever build regresses: it now persists a recoverable projection. Bulk
checkpointing reduced the initial per-row-mirroring prototype from about five
seconds to about four seconds, but does not erase that cost. Invalidated checkpoints
pay complete construction again. Further reduction should address durable
keyed catch-up / SQL ownership, rather than add another full-population cache.

Capacity key: `host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`.
Available memory stayed above 24 GiB; raw Darwin swap stayed 249.75 MiB.
Raw CPU samples indicate 19.6–33.5% whole-host busy over the individual windows.
Shared-host load ranged up to 2.46 per logical CPU; automatic eligibility is
**diagnostic**, with unavailable Darwin baseline CPU/swap fields and early
load failures. Raw CPU/swap samples and file hashes are retained alongside the
results. These are reproducible ownership diagnostics, not regression ratchets
or certified plan targets. They do not measure a browser, active 470 MB session,
watcher-to-publication latency, or the complete 50k-session server.

Commands (external build paths; run via the safe-home wrapper):

```sh
node --expose-gc scripts/perf-repro/session-catalog-ownership.mjs \
  --server-dist <build>/packages/server/dist --work <scratch> \
  --label <unique> --sessions 50000
node --expose-gc scripts/perf-repro/session-collection-query.mjs \
  --server-dist <build>/packages/server/dist --work <scratch> \
  --label <unique> --sessions 50000
```

Local raw results: `/tmp/p190/catalog/measure/final-*-catalog-ownership/result.json`
and `/tmp/p190/catalog/measure/qualified-*-collection-query/result.json`.
The latter labels name the final reviewed build; eligibility remains diagnostic. No full plan target is newly
met by these diagnostics.

## Checks and review

Regression evidence against previous code: the new bounded-start test fails
when old startup reads the complete catalog; query recreation reads 600 cold
metadata rows in three batches on old code, versus none now. Source copies
were restored without stash. Removing certification fences fails the optimistic
revert case with dirty-insert failure. Stronger mid-build regressions exposed
the missing optimistic invalidation; revision fencing and keyed notifications
now cover edit/revert with no durable write.
Retained tests also cover same-store concurrent deltas, unrelated-row retention,
legacy factories, source-version guards, tombstone horizon, rollback, duplicate
aliases and malformed stored questions.

YA review session `14ea3685-f031-46fd-81b6-6332ce2166d8`, via localhost 3400:
`gpt-6.1-sol`, high effort, bypass permissions, review-only. Verified/fixed the
optimistic-revert must-fix, legacy-input should-fix and overflow follow-up.
The final static review reports no remaining must-fix, should-fix or nit.

Node 25.8.2 and checksum-verified Bun 1.3.14 pass the packaged SQLite contract.
Bun's 400-session functional route run also restores its checkpoint and checks
archive clock reversal and a changed metadata write. The purge contract caught
Bun counting trigger writes in `.changes`; returned deleted native keys now
provide the portable logical count.

Final checks: lint (zero warnings; one existing unrelated informational regex
diagnostic), format, full workspace typecheck and source budgets pass. Full
server: 7265 passed / 94 skipped, with only the eleven existing Claude executable
version guards failing. All other workspace/root tests pass. Client: 7331
passed / 684 files. The first
full run had the known eleven Claude version guards (expected 2.1.322,
installed 2.1.321), plus a liveness timeout that passes in isolation. The client
first run's browser close hook timed out at ten seconds; its unchanged rerun
passes all 7331 assertions / 684 files. Existing jsdom navigation diagnostics
remain owned by their existing gap; no suppression or timeout increase was
introduced. The app wiring shrinks four lines and ratchets its source budget
from 4594 to 4590.

## Remaining architectural work

The SQL catalog boundary is implemented, but stage 2 is not universally bounded:
complete consumers, unknown-file discovery, eligible-project SQL aggregation,
first-ever / invalidated construction and SQL checkpoint import/indexing still
have population work. Polling fan-out remains; server-side SQL pages make it
cheaper, not absent. Long Claude/Codex transcript ingestion is still required
and remains independent of this slice. Client delta delivery/rendering follows
its capability and parity gates. Full scenario qualification remains open.
