# Large JSON stores delay server readiness and retain cold data in RAM

Progress, 2026-11-05 — Contributing-model: 6-astra

The built-client reload path now reuses an unchanged, intact build within its
own wrapper. It checks source/configuration/install inputs and emitted content;
changed inputs rebuild before stopping Hono, and failed or concurrently edited
builds keep the incumbent backend. See
[built-client reload](../topics/reload-safe-provider-runtimes.md#built-client-for-everyday-source-checkout-use).
The wrapper itself needs a restart to adopt this code; ordinary Hono reload
does not update it. Fresh wrapper startup still builds once.

An isolated real Vite build on Linux/Node 24.22.1 took 16,500 ms including
fingerprinting and preparation; three subsequent unchanged checks took
210/193/198 ms and launched no builder. The same reuse assertion rejects the
previous implementation, which launched a second build. Wrapper integration
checks cover same-directory reuse, replacement, failed-build preservation and
cleanup; filesystem checks cover same-size/preserved-mtime edits, additions,
deletions, environment changes, missing/corrupt output and edits during build.
The host had 16 logical CPUs, 85.9% available RAM, load about 7–9, and existing
YA/provider workloads; a short sample showed 62% CPU idle and some swap-in.
These are diagnostic build-phase measurements, not full restart or browser
readiness measurements. No production restart was performed. No probe process
or generated build remained after cleanup. macOS/Windows execution was not
available locally.

Still open: eager session-metadata loading/retention, discovery enumeration and
retained-provider reattachment, first-wrapper build cost, and end-to-end initial
view/memory qualification. The change above addresses measured reload work,
not the cold-storage migration/query-scope contract below.

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

Inspect the awaited initialization chain in `packages/server/src/server-main.ts`
before selecting migrations. Session metadata and provider summary persistence
have moved to SQLite, but `SessionMetadataService.initialize()` still selects
and parses every metadata row into retained state. Measure query scope and
retention as well as storage format; a database migration alone does not make
cold data lazy. `SessionIndexService` now supports selected-summary row reads;
complete scope consumers still load a bounded in-memory scope.

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
broader startup/storage ownership problem. The remaining work is not implemented
by this investigation.

## Measured plain reload, 2026-11-04

Contributing-model: 6.1-Sol

The maintainer requested one port-3400 `~/local.sh reyep`, preserving providers,
and an investigation of the recent 30+ second startup. Measured source revision:
`c92872819`, clean worktree, Node 24.22.1, existing production app data and
existing discovery caches. This is one diagnostic run on a contended host,
not a regression threshold or an isolated attribution experiment.

- Launch at 22:03:39.307 UTC; first observed replacement health and HTML success
  at 22:04:26.270: about 47 seconds overall. Old backend still answered at
  22:04:10.093; replacement bound at 22:04:25.537. The unavailable interval
  was about 15 seconds, rather than the entire command duration.
- Lockfile install reported 1.1 seconds. The wrapper rebuilt the production
  client before stopping the old backend; Vite reported **22.21 seconds**.
  `scripts/dev.js` `requestServerReload()` / `buildClient()` owns this cost.
  The remaining overall time includes shell/setup, build wrapper overhead,
  shutdown, source-module loading, and polling; those were not separately timed.
- The backend's internal startup clock reported **10,355 ms**, excluding
  pre-`startServer()` module evaluation. Session metadata took **2,776 ms**;
  retained-provider reattachment took **6,311 ms**, including discovery work;
  app creation took 504 ms. These phases must not be added to nested scan times.
- Wrapper PID 2670756 and provider-host PID 2671451 retained their original
  start times. Backend changed from 1568899 to 1824805; eight retained Claude
  runtimes logged successful reattachment. Providers were not rebooted.
- Codex scanner: **1,403 files**, **182 directories**, **1,403 stats**, **1,403
  discovery-index hits**, zero misses/suspects and **zero first-line reads**;
  2,612 ms. The reader separately walked/statted the same corpus in 2,608 ms.
  A concurrent reader joined that in-flight scan (2,086 ms wait, zero file work).
  Later scanner/reader walks took 568/520 ms, again entirely cache-backed.
  `sessionsParsed` in these metrics does not mean transcripts were reparsed.
- `session_metadata` contains **1,608 rows / 37,338,228 JSON characters**
  (`sum(length(metadata))`, not database file bytes). Initialization does
  `SELECT session_id, metadata FROM session_metadata`, parses every row, and
  retains both objects and serialized strings. It logged all 1,608 loaded.
- Host preflight: 74.9% RAM available; load around 22–23 on 16 logical CPUs;
  sampled CPU idle about 5%, with active competing Python workloads and some
  swap-in. CPU pressure was material; later I/O pressure increased. This does
  not establish uncontended phase costs. Automatic stall recording observed
  2,696 ms during metadata initialization and 2,331 ms during early recovery.
- After bind, health/HTML generally answered in milliseconds through the
  observation window. The maintenance snapshot at 21 seconds uptime reported
  about 1.1 GB RSS / 607 MB heap, with all three eligible watcher baselines
  complete. At 109 seconds uptime, RSS was about 1.9 GB and heap 986 MB;
  these samples do not establish quiescence or a leak. The 100-probe observer
  finished at 22:05:43.994 with health and HTML still successful. Browser
  sidebar hydration was not measured.

### Follow-up supported by this run

1. Attribute/reuse the client build before optimizing rollout parsing: it is
   the largest measured component of this plain reload. Preserve the existing
   build-before-stop and failed-build-keeps-old-backend guarantees in
   [reload-safe provider runtimes](../topics/reload-safe-provider-runtimes.md).
2. Make cold metadata queries bounded in the existing SQLite owner, while
   preserving restart recovery for pending display objects and accepted input.
   The remaining metadata problem is eager loading, not absence of SQLite.
3. Coalesce scanner/reader enumeration and measure watcher baseline versus
   reattachment consumers. Persisted discovery already avoids immutable header
   reads; consider a shared durable catalog/date-bucket index only where it
   reduces measured enumeration/stat work. SQLite fits the existing runtime;
   DuckDB is an alternative to evaluate, not a demonstrated requirement.
4. A persisted mtime/size record alone cannot detect offline changes without
   checking the source. Preserve replacement/truncation, deletion, new-file,
   compressed-representation and missed-watch recovery semantics from
   [Codex metadata scanner](../topics/codex-metadata-scanner.md) and
   [session index validation](../topics/session-index-validation.md). Do not
   hide old sessions to make discovery faster.

No runtime change was requested or made. Local raw evidence: timestamped HTTP
probes and process identities in `/tmp/ya-startup-observe.log`, restart output
in `/tmp/ya-startup-reyep.log`, wrapper capture in
`/tmp/ya-startup-after-pane.log`, and appended structured server events in
`/tmp/ya-startup-server.jsonl`. These scratch files are not portable evidence;
the relevant counters and limits are recorded above.

Found 2026-09-08 while implementing persistent speech vocabulary; captured at
the maintainer's explicit request to preserve the now-authorized SQLite path.
