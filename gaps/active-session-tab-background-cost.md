# A tab open on a long, active session costs a sixth of a core

A browser tab showing a session whose transcript is being written costs the
server about 15–19% of one core and the tab itself 5–12%, for as long as the
session runs (measured with the inspector and a 1 ms CPU profiler attached,
which add a little). Every transcript write publishes a catalog generation,
and each generation makes the tab refetch six whole-catalog lists and the
session detail, which rereads the whole transcript. The fixes made on
2026-11-10 (a draft-index request storm, shared list walks, per-row lookups
after each publication) are in that day's commit; this file lists what
remains.

[Plan 190](../docs/tactical/190-active-session-cost-at-scale.md) sets the
target state for this at 50,000 sessions and a 200-compaction session, and
orders the work below into steps.

Priority update, 2026-11-10: the maintainer selected architecture-led stages
in plan 190, focusing first on the SQL-owned catalog and bounded session
working set. The [source audit](../docs/research/190-cold-session-ownership.md)
connects list/Inbox queries, metadata retention, changed-file publication and
secondary projections. Isolated diagnostics now find project-scoped Codex
reader maps are the dominant tested cold owner: 200 readers each mirror all
25,000 Codex sessions in two maps; their destructive release freed 502.6 MiB
at 50,000 mixed sessions, versus 91.2 MiB for catalog release. Shared
root-scope discovery ownership is implemented first: project readers now
share one root locator index. Functioning-server before/after memory evidence
and review are recorded in the research outcome. This removes the measured
project × session multiplier; the catalog, Inbox/list and transcript costs
below remain open, and no full active-tab target is closed. A second slice now
replaces retained list/Inbox projection walks with a shared SQL query owner;
[query evidence](../docs/research/190-sql-collection-queries.md) records warm
query gains and the remaining first-build/legacy costs. Polling and catalog
publication still occur; client deltas remain separate work. Canonical seen
state and metadata are now SQL-owned with bounded residency;
[cold-state evidence](../docs/research/190-cold-state-sql.md) records this third
slice. The derived list projection still rebuilds after restart.

## How it was measured

`scripts/perf-repro/active-session.mjs` builds an isolated world, starts a
passive production server on it with the inspector, opens headless Chromium
on the session and appends to the transcript at a provider-like pace. It
records process and per-thread CPU, a main-thread CPU profile, every API
request the tab made and its WebSocket frames (header comment for usage).

- **Clone world:** copy-on-write clones of the maintainer's Claude and Codex
  stores (7,500 catalog rows) and profile; this session's own 30 MB
  transcript held back 15% and replayed at its recorded pace (85 writes in
  three minutes).
- **Synthetic world:** plan 190's scenario (the default): 50,000 idle
  sessions, half Claude and half Codex, and one 200-compaction session of
  about 470 MB written once a second, run as each provider. At that scale
  both providers saturate the server; the measured baseline is in the
  plan's "Where it stands". The figures below are from smaller worlds (3,000
  short Claude sessions and a 12,000-row session) unless stated.

## What it spends, largest first

1. **The detail of a long Claude session is rebuilt whole on every write.**
   For Claude the reader returns every entry and the route normalizes all of
   them (DAG, visible entries, task snapshots) before slicing after the
   client's anchor (`routes/session-detail-routes.ts`, `primaryReaderAfterMessageId`
   is undefined for Claude). The summary's active branch is also rebuilt from
   the whole parse state twice per write: once for the detail
   (`reader.getSession`) and once for the catalog row
   (`getSessionSummaryFromDir`). Synthetic world: normalization 4.9 s and
   summaries 4.9 s of about 22 s of main-thread CPU in two minutes; it grows
   with the session's length. Past the 192 MB parse budget the file is also
   reread whole per request (3.2 s per request at 465 MB). Codex is no
   better for a tab's updates: its windowed incremental read falls back
   (cause not yet established), so each update reads and normalizes the
   whole rollout (2.1 s at 488 MB). Fix: keep the normalized messages and the active branch
   incremental over appends, or at least share one summary per parse-state
   version (plan 190 step 2).
2. **Each write makes every tab refetch six whole-catalog lists:** the three
   feeds, Inbox, `/api/projects` and `/api/project-queue`. Sharing leaves
   about one walk per write per tab in the recorded baseline. The retained
   path now shares one SQL working index across tabs and hydrates selected
   rows, removing that population projection walk. Poll/request fan-out
   remains. The next client-side fix is sending
   changed rows to clients
   (plan 189 step 8) or the list projection table
   ([SQLite cleanup](sqlite-cleanup-and-wins.md) items 11 and 16).
3. **Known changed-file publication is now scoped.** The former complete
   generation walk and retained native catalog mirror are removed. Unknown
   new-file membership, complete consumers and project SQL aggregation still
   have population work ([remaining catalog costs](session-catalog-rewrites-whole-generation-per-change.md)).
4. **Other threads take a third or more of the server's CPU** (12–14 s per
   three minutes of 27–41 s in total, unchanged by those fixes),
   probably V8's garbage-collection and compiler helpers (not attributed
   yet): the walks and the whole-transcript rebuilds above allocate per write.
5. **The tab itself** spends 5% of a core (clone world) to 12% (synthetic) in
   React rendering on each write.
6. **Opening a long session** takes 0.8–1.5 s, nearly all waiting on the
   Markdown/highlight worker (`augmentMs`); the main thread is idle meanwhile.

7. **A quiet server still profiles itself.** The stall recorder
   (`logging/stall-recording.ts`) runs a 10 ms CPU profiler and stops and
   restarts it every 30 s: about 240 ms of main thread and a 220–235 ms
   event-loop delay per rotation; with the resource sampler off an idle
   server's CPU fell by two thirds (plan 190 step 8).
8. **Without Codex's thread index, every Codex rollout is statted every five
   seconds.** 25,000 rollouts take 120–150 ms per pass, under the backoff's
   slow threshold, so it never backs off: 8% of a core idle (plan 190
   step 8).
9. **A restart with nothing changed costs about 9 s of CPU** from start to
   30 s after the lists are usable, with no tab open, at 50,000 sessions;
   not yet attributed (plan 190 step 8).

Found 2026-11-10 while profiling, at the maintainer's request, the cost of
keeping a browser open on a long active session after plan 189.


2026-11-10 catalog ownership follow-up: the native parsed corpus and production
project membership mirrors are removed. Known changed files publish indexed
row/removal deltas; question enrichment and creation/activity lookups are scoped.
Safe derived query checkpoints avoid cold JS reconstruction when canonical state
has not changed. See [catalog evidence](../docs/research/190-catalog-sql-ownership.md).
Unrecognized new files still rediscover; full SQL restore, project aggregation,
remaining complete consumers and the long-transcript/client costs remain open.
