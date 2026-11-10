# Active session cost at scale

Topic: catalog-identity-projection-cost

Status: in progress. Proposed 2026-11-10; the maintainer agreed the
scenario, the targets and that step 2 (reading a long session incrementally)
must happen. Step 1 (the scenario and a measured baseline) is done; at the
scenario's scale both providers saturate the server (below). What was fixed
before the plan (a draft-index request storm, shared list walks, per-row
lookups after each catalog update) is in `77e1feba4` and `f196db4c7`; the
costs that remain are in
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
built by `scripts/perf-repro/active-session.mjs` (synthetic world, the
default) with the transcript shapes in
`scripts/perf-repro/scenario-transcripts.mjs`.

- **50,000 idle sessions, half Claude and half Codex.** 25,000 Claude
  transcripts and 25,000 Codex rollouts (date directories, as Codex writes
  them), spread over 200 projects and the past year, each 2–6 turns of a few
  KB. Codex rollouts map to the same projects through their `cwd`. Beside
  them sits Codex's thread index (`state_5.sqlite`, reduced to the columns YA
  reads), as on a host where Codex runs; `--codex-index false` models a host
  without one. Nothing writes to them during a run.
- **One very long, active session**, run once as Claude and once as Codex:
  200 compactions of history. On the maintainer's host a Claude session holds
  about 2.3 MB of transcript per compaction (this session: 30 MB, 13
  compactions), so the generated session is about 470 MB and 170,000 lines.
  Turns are agent-shaped: prompt, tool call, tool result, Markdown answer.
  The generators follow current provider output (Claude Code 2.1.3xx:
  assistant messages split over rows with thinking blocks, metadata rows and
  attachments; Codex 0.16x: `item_completed` items beside response items,
  `custom_tool_call`, token records, `compacted` items with window ids).
  Generated: Claude 465 MB and 176,832 lines (55 turns per compaction);
  Codex 488 MB and 151,979 lines (42 turns per compaction). Real sessions on
  the maintainer's host hold more per compaction (Claude: 81 MB over 8
  compactions; Codex: 512 MB and 53,000 lines over 66), so the scenario is
  conservative in bytes per compaction; its rows are smaller than Codex's
  real ones (about 3 KB against 10 KB), so per-row costs weigh a little more.
- **Writes:** one write a second to the long session (a few rows each, as a
  provider appends during a turn), and a compaction every 300 writes, taken
  between turns; the first is due half way, so the active phase crosses one.
  The history ends part way between compactions. For Codex the thread index
  row is bumped at most every five seconds, as Codex does.
- **Runs:** an idle phase (nothing written) and an active phase, three
  minutes each after 20 s of warm-up writes; then each list route timed
  alone; a server restart with nothing changed and no tab open; and a cold
  open of the long session in a new tab on the restarted server. The harness
  waits for the server to settle between phases.

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

The repro attaches the inspector for CPU, memory and event-loop probes; its
1 ms CPU profiler is opt-in (`--cpu-profile`) and off when targets are
checked. Write-to-visible is measured from the append to the moment the
write's marker appears in the tab's DOM.

## Where it stands

Baseline measured 2026-11-10 with the repro on the maintainer's host (Apple
Silicon): production builds of server and client code as of `f196db4c7`,
profiler off, Codex thread index present. Runs `base2-claude` and
`base2-codex` (labels in the harness's results directory, each with its
arguments); the idle attributions come from shorter runs named below.

| Measure | Target | Claude | Codex |
|---|---|---|---|
| Main-thread CPU per write¹ | ≤ 5 ms | 991 ms | 970 ms |
| Process CPU per write¹ | ≤ 15 ms | 1,456 ms (146% of a core) | 1,314 ms (131%) |
| One incremental detail request, alone² | | 3.2 s (read 2.1 s, normalize 1.0 s) | 2.1 s (read 1.4 s, normalize 0.6 s) |
| Event-loop delay p99 (max), active | ≤ 50 ms | 2,067 ms (2.9 s) | 236 ms (0.9 s) |
| Idle phase | about 0 | 2.0% of a core | 1.1% |
| List reloads per write per tab | none | 1.4 (252 in 180 writes) | 3.7 (672) |
| Tab task time per write | ≤ 5 ms | 24.6 ms | 52.6 ms |
| Write to visible, p50 / p95 | p95 ≤ 250 ms | 5.0 s / 6.8 s | 3.4 s / 4.9 s |
| Cold open after restart, to the last turn shown | ≤ 300 ms | 5.1 s, 13.1 s CPU | 2.2 s, 6.2 s CPU |
| A list page or Inbox, alone | ≤ 10 ms | 170–215 ms | 167–214 ms |
| Server memory, idle | ≤ ~300 MB | 724 MB heap, 1.2 GB RSS | 760 MB heap, 1.3 GB RSS |
| Server memory, active | the long session never held whole | 1.3 GB heap, 5.8 GB RSS | 1.9 GB heap, 3.5 GB RSS |
| Restart: lists usable | ≤ ~1 s, nothing rescanned | 1.8 s; 9.0 s CPU to 30 s after | 1.4 s; 8.7 s CPU |

¹ The server was saturated at one write a second for both providers, so the
per-write figures are a ceiling set by the write rate (a busy main thread is
about 1,000 ms per second), not the cost of a write; work queued behind
earlier writes. Each write's own cost is better read from the request
timings in the next row and the list timings below.
² Medians of the `SESSION_DETAIL` timings in the server log over the active
phase (61 Claude and 87 Codex requests).

- **Claude: the 192 MB cliff is confirmed.** The 465 MB transcript is never
  cached (`claude_transcript_cache_uncached`, `retainedFiles: 0`), so every
  incremental detail request (`afterMessageId`) rereads the whole file
  (2.1 s) and normalizes all of it (about 100,000 messages, 1.0 s) before
  slicing; under contention one took 5.3 s. A cold open's tail-window
  request does the same before windowing (4.3 s).
- **Codex: a tab's updates are not windowed either.** The tab's incremental
  requests carry the default `tailCompactions` and a summary hint
  (`bound-session-reader.ts`), yet each one read the whole rollout (1.4 s)
  and normalized all of it (about 59,000 messages, 0.6 s): the windowed
  incremental read (`readIncrementalSnapshot`, `codex-reader.ts`) fell back.
  Which of its exits fires is not yet established; the generated rollouts
  follow the current format and compact only between turns, so it is not an
  artifact of orphaned tool results. The cold open's tail-window request read
  the window only, but the open also issued a whole-file incremental request
  and a preview refresh (about 1.5 s each). So Codex needs step 2 as well.
- **Lists.** A list page or Inbox costs 167–215 ms of server time alone at
  50,000 sessions (a walk over every row), and each write still reloads the
  six list routes for the tab.
- **Idle.** With Codex's thread index, a quiet server spends 1–2% of a core.
  Most of it is the server's own stall recorder
  (`logging/stall-recording.ts`, started by the resource sampler): it keeps
  a 10 ms CPU profiler running and stops and restarts it every 30 s. With
  the sampler off (`YEP_RESOURCE_SAMPLE_SECONDS=0`, which also stops its
  100 ms tick) idle fell from 2.9 s to 0.9 s per two minutes (runs
  `idle-stallon`, `idle-stalloff`), and the 220–235 ms idle event-loop
  maximum, once per rotation, went away (12 ms). A 1 ms CPU profile of an
  idle server (`base-idle-profile`) put about 240 ms of main thread on each
  rotation's `Profiler.stop`. Without the thread index the periodic Codex
  rescan stats all 25,000 rollouts every five seconds and never backs off
  (110–195 ms a pass, under its slow threshold): 14.9 s per three minutes,
  8.3% of a core (run `base-claude`); with the index it is a full rescan
  every ten minutes.
- **Memory.** 50,000 idle sessions hold 720–760 MB of heap; an active long
  session takes the heap to 1.3–1.9 GB and RSS to 3.5–5.8 GB.
- **Restart.** With no tab open, lists answer 1.4–1.8 s after start, and the
  server spends about 9 s of CPU from start to 30 s after that, with nothing
  changed; not yet attributed.

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

Done 2026-11-10: the harness runs the scenario (phases `idle`, `active`,
`lists`, `restart`, `open`; `--cpu-profile` opt-in; `--env` for server
settings; `--codex-index false`), and the baseline is in
[Where it stands](#where-it-stands). The cliff is confirmed, and a Codex
tab's updates were found to read the whole rollout too, so step 2 covers
both providers. Costs the plan had not listed get step 8: the stall
recorder's rotations, the Codex rescan without a thread index, and the CPU
after a restart.

### 2 — read a long session incrementally

Agreed as required. For Claude first, then Codex, whose incremental
requests are not windowed today (baseline):

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
- Codex: first establish why `readIncrementalSnapshot` falls back for a
  tab's updates (baseline); then an incremental request reads from the last
  served position (or the window's start) instead of the whole rollout, and
  the open's preview refresh does not reread it either.

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

### 8 — a quiet host costs nothing

Found by the baseline; independent of steps 2–7.

- The stall recorder (`logging/stall-recording.ts`) keeps its evidence
  without paying about 240 ms of main thread, and a 220–235 ms event-loop
  delay, every 30 s: for example a sampling interval and rotation whose cost
  does not grow with the heap, or no rotation while nothing stalls. It must
  still hold the stacks from before a stall
  ([server performance observability](../../topics/server-performance-observability.md)).
- Without Codex's thread index, the periodic Codex rescan backs off while
  nothing changes, instead of statting every rollout every five seconds.
  The tradeoff: after a quiet spell such a host notices a Codex write later,
  up to the backed-off interval, unless a file event arrives first.
- Restart with nothing changed: attribute the 9 s of CPU from start to 30 s
  after the lists are usable (no tab open), and keep it from growing with
  session count or history length.

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
  target once measured, or needs the same incremental treatment. Answered by
  the baseline: a tab's updates fall back to reading and normalizing the
  whole rollout, so it needs step 2.
- How many compactions a tail window should hold by default once opening is
  flat in history length.
