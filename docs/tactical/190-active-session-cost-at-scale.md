# Active session cost at scale

Topic: catalog-identity-projection-cost

Status: proposed 2026-11-10. The maintainer agreed the scenario, the targets
and that step 2 (reading a long session incrementally) must happen. Nothing
below has landed. What was fixed the same day (a draft-index request storm,
shared list walks, per-row lookups after each catalog update) is in
`77e1feba4` and `f196db4c7`; the costs that remain are in
[active session tab cost](../../gaps/active-session-tab-background-cost.md).

## Goal

Work per transcript write depends only on what changed: never on how many
sessions the host has, nor on how long the written session's history is.
Then 50,000 sessions and a 200-compaction session cost the same per write as
50 sessions and a short one, and a quiet host costs nothing.

Non-goals:

- No change to provider readers' transcript formats or to what a session
  page shows.
- Older clients keep working: anything sent differently to tabs goes behind
  a capability, with today's full reload kept as the fallback.
- Not a general memory plan. Memory targets here cover only what this
  scenario holds.

## Scenario

One host, one YA server, one browser tab open on the active session. It is
built by `scripts/perf-repro/active-session.mjs` (synthetic world), which
today generates Claude sessions only; step 1 extends it.

- **50,000 idle sessions, half Claude and half Codex.** 25,000 Claude
  transcripts and 25,000 Codex rollouts (date directories, as Codex writes
  them), spread over 200 projects, each 2–6 turns of a few KB. Codex rollouts
  map to the same projects through their `cwd`. Nothing writes to them during
  a run.
- **One very long, active session**, run once as Claude and once as Codex:
  200 compactions of history. On the maintainer's host a Claude session holds
  about 2.3 MB of transcript per compaction (this session: 30 MB, 13
  compactions), so the generated session is about 470 MB and 170,000 lines.
  Turns are agent-shaped: prompt, tool call, tool result, Markdown answer.
- **Writes:** one write a second to the long session (a few rows each, as a
  provider appends during a turn), and a compaction every 300 writes, so the
  run crosses compaction boundaries.
- **Runs:** an idle phase (nothing written) and an active phase, three
  minutes each after warm-up; plus a cold open of the long session and a
  server restart with nothing changed.

## Targets

Measured on an Apple Silicon laptop, one tab, one write a second. Per-write
figures are a phase's total divided by its writes.

| Measure | Target |
|---|---|
| Server main-thread CPU per write | ≤ 5 ms, flat in session count and history length |
| Server process CPU per write (GC and workers included) | ≤ 15 ms, so ≤ 1.5% of a core |
| Each further open tab | ≤ 1 ms more per write |
| Event-loop delay, p99 | ≤ 50 ms |
| Idle phase | about 0 CPU; no periodic work that grows with session count |
| Requests per write per tab | no list reloads; one pushed change of a few KB, or one small incremental fetch |
| Tab work per write | ≤ 5 ms of rendering, ≤ 1% of a core |
| Write to visible in the open tab | ≤ 250 ms p95; typing unaffected (each keystroke within 100 ms, `AGENTS.md`) |
| Cold open of the long session | ≤ 300 ms of server time to first paint, flat in history length |
| A list page or Inbox | ≤ 10 ms of server time, paged |
| Server memory, 50,000 idle sessions | ≤ about 300 MB; the long session never held whole |
| Restart with nothing changed | lists usable within about 1 s; nothing rescanned |

The repro attaches the inspector and a 1 ms CPU profiler, which adds a
little to every figure; targets are checked with the profiler off.

## Where it stands

Measured 2026-11-10 with the repro on the maintainer's host, after
`f196db4c7`, at today's scale (7,500 catalog rows, a 30 MB Claude session),
then scaled by row count and history length. The scaled column is an
estimate until step 1 measures it.

| Work per write | Measured | Scaled to the scenario |
|---|---|---|
| Long Claude session's detail and summary rebuilt | about 20 ms | about 300 ms, plus rereading the file (below) |
| One list walk, per tab | about 25 ms | about 170 ms |
| Catalog publication diffing every row | about 20 ms | about 130 ms |
| Server process CPU, one tab | 15–19% of a core | well past one core |

- **Claude.** An incremental detail request (`afterMessageId`) still loads
  every entry: the route passes no anchor to the Claude reader, normalizes
  the whole session and then slices
  (`routes/session-detail-routes.ts`, `primaryReaderAfterMessageId`). The
  summary's active branch is rebuilt from the whole parse state twice per
  write (`reader.getSession` and `getSessionSummaryFromDir`). The parsed
  transcript cache keeps no file larger than its 192 MB budget
  (`claude-transcript-cache.ts`, `YEP_CLAUDE_PARSE_CACHE_MB`), so a 470 MB
  session would be reread and reparsed whole on every request: a cliff, not
  a slope.
- **Codex.** The reader already serves a window from a compaction
  boundary (`findCompactTailStart`) and continues an incremental snapshot
  from its start byte (`readIncrementalSnapshot`, `codex-reader.ts`), within
  a 256 MB parse cache (`codex-entry-cache-budget.ts`). Its per-write cost
  has not been measured; normalization still covers the whole window on
  each request.
- **Lists.** Each write publishes a catalog generation, and each tab then
  reloads three sidebar feeds, Inbox, the project list and the project queue.
  One tab's feeds and Inbox share one walk since `f196db4c7`, but each walk
  still builds an item for every row.

## Steps

### 1 — the scenario and a baseline

- Extend the repro's synthetic world to the scenario: Codex rollouts (date
  directories, `session_meta` with `cwd`, `compacted` items), the 50/50 mix,
  the long session per provider with 200 compactions, the write rate and
  compactions during the run, the idle phase, cold open and restart, and a
  profiler-off mode.
- Record per-write metrics: main-thread and process CPU, event-loop delay
  (p50/p99/max), requests and bytes per write per tab, tab task time per
  write, write-to-visible latency, server and tab memory.
- Record the baseline here for both providers. Gate: the numbers above are
  measured, not scaled, and the 192 MB cliff is confirmed or refuted.

### 2 — read a long session incrementally

Agreed as required. For Claude first, then whatever Codex still lacks:

- Keep an index of compaction boundaries per transcript, so a cold open and
  the first detail read start at the requested tail window, never at byte 0.
- Parse only appended bytes, extending the active branch, the visible
  entries and the normalized messages as lines arrive, so an incremental
  detail request costs what was appended. Sharing one summary per parse
  version removes the second rebuild per write.
- Hold only the tail window and the incremental state in memory; a
  transcript larger than the parse budget is no longer reread whole.
- Keep the existing guarantees: branch selection and rewinds, dead-branch
  rendering (`topics/claude.md`), provisional tails, incremental anchors not
  found (full catch-up), and the session-detail response shape.

### 3 — send changes to tabs

Plan 189 step 8: a write sends the changed row, and the feeds, Inbox and
their counts update from it. Needs a capability; full reload kept for older
clients.

### 4 — answer lists and counts from SQL

Unread state and the list fields in tables
([SQLite cleanup](../../gaps/sqlite-cleanup-and-wins.md) items 8 and 11), so
list pages and stats are indexed queries, and then stop holding the whole
catalog in memory (item 12).

### 5 — update the catalog from the changed file

A publication reads and writes only the changed file's row, instead of
adapters yielding every row
([session catalog rewrites](../../gaps/session-catalog-rewrites-whole-generation-per-change.md)).

### 6 — render the open session incrementally in the tab

A write renders the new rows only.

### 7 — a ratcheted perf-suite scenario

Move the scenario into the [performance regression
suite](../../topics/performance-regression-suite.md) with ratchets on main-
thread and process CPU per write, p99 event-loop delay, requests and bytes
per write per tab, tab time per write and cold open. Per-write ratchets keep
the gate independent of the host's speed; each step above should bring one
metric under its target and tighten its ratchet.

## Review gates

- Step 1: the baseline recorded here, with the scenario reviewed for
  realism against real Claude and Codex transcripts.
- Step 2: the session-page parity checks above, on the repro and on copies of
  real long sessions, and per-write cost flat between a 20- and a
  200-compaction session.
- Steps 3–6: each measured against its target on the scenario before and
  after.

## Risks

- **Correctness of incremental branch selection.** The active tip is chosen
  timestamp-first over the whole forest, and late writes can re-parent
  (`topics/claude.md`, falsely dead segments). An incremental structure must
  give the same answer as a full rebuild; test against full rebuilds on real
  transcripts.
- **Generated transcripts are not provider output.** The synthetic sessions
  follow the formats YA reads, not everything providers write; step 1's
  review compares them with real ones.
- **Host noise.** Figures move with load from other work on the host; compare
  builds interleaved on fresh worlds, and gate on per-write ratios.

## Open questions

- Whether the Codex window's normalization per request already meets the
  target once measured, or needs the same incremental treatment.
- How many compactions a tail window should hold by default once opening is
  flat in history length.
