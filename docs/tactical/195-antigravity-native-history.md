# Antigravity history from the native log

Status: proposed 2026-11-22. The goal and the decisions below are agreed with
the maintainer. Steps 1, 2, 2b, 3 and 4 are done; the
[progress table](#progress) tracks the rest.

This plan resolves the
[large-history and replay-ownership gap](../../gaps/antigravity-large-history-and-replay-ownership.md).
[Antigravity native storage](../../topics/antigravity-native-storage.md)
describes the files it relies on, and the
[provider contract](../../topics/antigravity.md) owns the behavior it changes.

## Goal

Antigravity is a dedicated provider whose cost does not grow with history
length. Every YA behavior it supports today keeps working, and the code ends
smaller than it started.

- **No history limit.** A conversation of any length opens, pages and
  resumes. The history-limit error is removed.
- **Cost follows the answer.** The latest page or an older page reads about
  that page's bytes. This is the
  [provider history rule](../../topics/provider-history-facts.md#the-rule).
- **Bounded memory.** A live session retains a fixed amount however long it
  runs, and no more than a live Codex session does. An idle session retains
  nothing. Viewing history starts no `agy` process, and nothing adds a
  per-session timer.
- **No regressions.** Everything in the
  [support table](../../topics/antigravity.md#support-status--2026-11-22)
  keeps working: steering, deferred and patient delivery, detached work and
  wakes, verified queued compaction, scheduled reload, model and effort
  controls, permissions, child sessions, the v0 API and typing latency.
- **Reads are harmless.** Viewing never changes a native file and never
  starts a load beside a live owner.

Scale target: a generated conversation log of about 500 MB and 100,000 steps,
the size of the largest Codex rollout YA already measures against.

## Decisions

| Decision | Choice |
| --- | --- |
| History source | The brain log, read-only. ACP is the control channel and the live stream. |
| Standalone 1.4.x runtime | Dropped. Support starts at `agy` 1.5.13, the CI pin. |
| Compatibility | A clean break inside Antigravity: message IDs and history shape may change. The wire stays unchanged, so no route, field or event is added. |
| ACP replay | Kept as the fallback while it is cheap. [Step 8](#8--decide-the-acp-replay-fallback) decides whether to delete it. |
| ACP sharing | None. Antigravity keeps its own transport. This sets aside the [ACP consolidation proposal](../../topics/acp.md) for this provider. |
| Another program on the same conversation | Not designed for. YA shows the existing external-session banner. |
| Protobuf | Never decoded. |

Out of scope: inline images and documents, rewind, fork, and Windows.

## Why the current design cannot meet the goal

- Opening a stopped conversation runs ACP `session/load`, which replays the
  whole conversation and can rewrite its files. YA retains the result and
  rejects more than 8 MiB or 10,000 messages.
- A live session keeps its full history in memory under the same cap. Past
  the cap, recording a message throws. What the session then does is not
  traced; step 2 reproduces it.
- Each project reader caches up to four cold reads, and each detail read
  clones the full history.
- Because a read rewrites files, reads take an ownership guard that lives in
  one process's memory. That guard is why Antigravity is excluded from the
  Provider Host
  ([`providers/index.ts`](../../packages/server/src/sdk/providers/index.ts))
  and why a backend restart interrupts an Antigravity turn.

The brain log removes the cause. It is an append-only text file with one
record per step, a strictly increasing `step_index`, tool calls paired with
their results, and the compaction checkpoints that ACP replay omits.

## The regression fence

These run at every step, on the pinned `agy` and on any candidate in use:

- The native commands in
  [checking an Antigravity upgrade candidate](../../topics/native-provider-testing.md#checking-an-antigravity-upgrade-candidate).
  They cover steering, cancellation, tools, compaction, cold resume, retained
  wakes, patient delivery, idle reap and reload.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test`.

A step that deliberately changes what one of these asserts says so in its
commit and updates the owning contract in the same commit.

Three sources of evidence serve the steps below:

- **Real `agy` with the scripted model.** It writes a real log and database
  at any size with no inference cost. ACP replay of the same conversation is
  the oracle for the log projection.
- **The controlled ACP peer.** It produces oversized replays, truncated
  streams and chosen interleavings.
- **A census script** under `scripts/perf-repro/`. It compares the log
  projection with ACP replay across a local store. It is run by hand and
  reports bytes read and records decoded.

## Steps

### 1 — remove the standalone runtime

Delete everything that exists only for the standalone 1.4.x server: the
`.par` launch variant, the `antigravity-acp` store, `.meta` files, the flat
model catalog, the `auto_edit` and `yolo` modes, the `session/set_model`
fallback, and the Linux `nobody` group prerequisite.

- Refuse an `agy` older than 1.5.13. Provider status and the refused start
  both name the installed version, the required version and the update
  path, as [dropping an older version](../../topics/provider-version-support.md#dropping-support-for-an-older-version)
  requires.
- Conversations in the standalone store stop being listed.
- Done when the fence passes and no source or test mentions the standalone
  layout.

### 2 — reproduce the limits and measure the unknowns

The gap requires this before a fix is chosen. Nothing ships from this step
except tests and recorded evidence.

Failing repros with the controlled peer:

- A replay over 8 MiB fails on open and on resume.
- A live session passes the cap. Record what it does.

Measurements, recorded in the native storage topic:

- How far a log record trails its ACP event, by record type.
- Whether `session/load` or `session/resume` rewrites the log or database.
- `session/resume` on a large compacted conversation: time, memory, files
  touched, and prior context in the next model request.
- Whether an ACP tool call ID names its planner step, as T3's source says.
- Whether `step_index` stays increasing across compaction and undo, and what
  the unlogged step type is.
- What a live Codex session retains in memory over a long run. This is the
  bar for [step 6](#6--bound-live-session-memory).

Also build the generator for the scale target. If real `agy` is too slow to
write 500 MB, generate the large file from real record shapes and use real
`agy` for a mid-sized conversation.

Done when each question has an answer or a stated fallback.

### 2b — accept agy's permission requests

Added after step 2: the [regression fence](#the-regression-fence) names
permissions, and step 2 found them broken. `agy` sends
`session/request_permission` with a string JSON-RPC ID, which YA answered
with "Unsupported client method" without asking the user, so `agy` denied
every tool that asks permission in a session not launched with bypass.

- Recognize a client-bound request whatever its ID type, and echo the ID
  unchanged. Responses to YA's own requests still match only YA's IDs.
- A request belongs to its tool call. Terminal evidence for the call
  withdraws it. Stop withdraws every waiting request on the connection and
  marks the running tool calls cancelled, so a delayed request for one of
  them is answered cancelled without a prompt. A turn's or command's
  result withdraws the requests raised during it, and a request arriving
  between the last prompt's answer and the result is held until YA
  reports it is idle. The foreground turn and queued commands share that
  release point.
- From Stop until the cancelled prompt returns, input is queued rather
  than steered.
- One owner gives each request exactly one answer, caps pending requests,
  releases each approval's listeners, and closes intake when the connection
  ends. Envelopes and response bodies are validated before dispatch.
- Tests: real `agy` in default mode asks for a `write_file`; Allow writes
  the file, Deny does not, and the session continues after each. Accept-edits
  writes without asking and asks for a command, bypass asks for nothing, and
  YA's Plan mode is refused, and Stop withdraws a waiting write while input
  sent right after it is delivered. A controlled peer sends string IDs, as
  `agy` does, and covers Stop with a request open or arriving late, for
  foreground and detached work. It also covers: a later wake that still
  asks; a wake's request in the same write as a prompt's response; a late
  answer while deferred input waits; root and child requests; duplicate and
  reused IDs; approval retention; malformed frames and response bodies;
  connection loss and a frame sent during shutdown.

### 3 — project the log into YA messages

A new module turns log records into normalized messages. It is not wired to
any reader yet.

- User text, assistant text, thinking, tool calls with their results, system
  messages, and checkpoints as compaction boundaries.
- Message IDs come from `step_index`, so a page has the same IDs however it
  was reached.
- A record that does not match the expected shape makes the result unknown.
- Tests: a small table of record shapes, including a bad line, a shortened
  field, a skipped step and a running background task. One native case
  compares the projection with ACP replay of the same conversation. The
  census script runs over the local store.

### 4 — serve cold history from the log

The reader answers from the log and falls back to ACP replay only when the
log is missing or unknown.

- The latest page is bounded by compaction boundaries and a byte budget,
  through the existing `tailCompactions` and `beforeMessageId` options. An
  older page finds its start by bisecting on `step_index`.
- Requirements from step 3's review, detailed in the
  [projection's windows](../../topics/antigravity-native-storage.md#windows):
  - A page must hold each tool call with its results, because the shared
    client projection drops a result whose call is not loaded; keep a group
    in one page or carry pairing context on the existing wire.
  - A `:result` anchor is the record at step P+1+*i* of its planner step
    P and call *i*.
  - Context before a page is at most *k* records, or *k*+1 after a group's
    results; read it and the lookahead under a byte budget, and treat a
    spent budget as a fallback, never as the end of the log.
  - A window checks only the records it reads.
  - `invoke_subagent` results need the reader's verified child mapping
    before they render as expandable `spawn_agent` rows with Open.
- Root conversations and all child conversations use the same path.
- The hovercard excerpt becomes a tail read. The v0 conversation source uses
  the same window.
- The ACP fallback becomes a named complete read in the
  [consumer list](../../topics/provider-history-facts.md#consumers).
- Tests: bytes read for a latest page on the scale target; paging backward
  through every page equals one forward projection; a file replaced or
  truncated during a read; zero `session/load` calls and unchanged native
  file sizes and times after a view. One browser check loads older pages on
  a long conversation, with the sequential typing check at that volume.
- Visible changes: checkpoints appear in cold history, and cold message IDs
  change. Step 3 found more: ordinary tool results (YA's cold transcript has none, although replay sends edit and command output),
  system messages, errors, timestamps and models appear; tools show `agy`'s
  name instead of ACP's title; and `invoke_subagent` results still need the
  reader's verified child enrichment. Update the provider contract.

### 5 — resume without replaying history

Resume stops retaining replayed history.

- Use `session/resume` if step 2 qualified it. Otherwise call
  `session/load`, discard the stream, and keep only the saved-tail check.
- The live session no longer starts from a replayed copy. History before the
  resume point comes from the log.
- Tests: the controlled peer sends an oversized replay and resume succeeds
  with bounded retained bytes. The native cold-resume case still finds prior
  context in the next model request, and still reapplies the selected model
  and effort.

### 6 — bound live session memory

A live session's history comes from the log plus the part the log has not
written yet.

- The in-memory projection holds only that unwritten part. A message leaves
  it once the log contains its step.
- A hard cap evicts the oldest message instead of throwing.
- Remove the 8 MiB and 10,000-message limit and its error.
- Tests: a scripted run of many turns shows retained bytes staying flat and
  at or below the Codex figure from step 2. Live and cold views of the same
  conversation agree, including across the moment a turn ends.
- If step 2 shows the log trails too far, keep the projection as a bounded
  recent window and serve everything older from the log.

### 7 — warn on an external writer

Feed native file changes for a conversation that YA does not own into the
existing [external-session tracking](../../topics/session-ownership.md), so
the amber banner appears. YA's own resume and fallback load count as its own
writes. This becomes possible after step 4, because until then YA's own reads
rewrite the files.

- Tests: an outside append marks the session external; YA's own resume does
  not.

### 8 — decide the ACP replay fallback

Count how often the fallback fired in the census and the native runs.

- **Delete** if it is rare and its upkeep is not: remove the replay loader,
  the cold-read cache, the read-ownership guard and the saved-tail check,
  and close the
  [replay completion gap](../../gaps/antigravity-acp-replay-completion-signal.md).
  A log YA cannot read then shows as unavailable history.
- **Keep** otherwise, and record why.

### 9 — move the owner into the Provider Host

With reads independent of the owner's memory, ownership is one writer per
conversation and the host can hold it.

- Remove Antigravity's exclusion from the hosted path.
- Earn the validation claim in
  [shared worker providers](../../topics/reload-safe-provider-runtimes.md#shared-worker-providers):
  the turn continues with the server absent, current state and pending input
  are rebuilt, control is single-writer after reconnect, output is neither
  lost nor duplicated, and idle teardown leaves no process behind.
- A reader in the backend never starts a load beside an owner in the host.
- Update the backend-reload row of the support table.

## Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1 — remove the standalone runtime | Done 2026-11-22 | `agy` 1.5.13 floor read from ACP `initialize`, with an `agy --version` fallback when `acp` is missing. Status, CLI installations and refused starts name both versions and `agy update`. The Linux `nobody` alias was confirmed unneeded on Ubuntu 24.04 before removal. Review round 1 added the owned, credential-filtered version probe, the saved and v0 creation refusal, and Auto/launch agreement. [Contract](../../topics/antigravity.md#supported-runtime). |
| 2 — reproduce the limits and measure the unknowns | Done 2026-11-22 | Repros are controlled-peer tests named "today: …" for steps 4 to 6 to flip. Answers are in [native storage measurements](../../topics/antigravity-native-storage.md#measurements--plan-195-step-2): a record appears once its step ends, so the log trails by the step in progress; snapshots around load and resume found the conversation's database content and log unchanged, with temporary sidecars and store-wide writes; `session/resume` qualified at 7,261 compacted steps on 1.5.13 and 1.5.14 (33–37 ms, no replay, compacted context kept); tool call IDs are random; `step_index` increases but skips interrupted and error steps (type 17 is `ERROR_MESSAGE`); [tool results pair with calls by step index](../../topics/antigravity-native-storage.md#reading-a-tool-group) (P+1+*i* is call *i*; a missing step is an interrupted result; any other shape makes the log unknown); Codex's heap shows no upward trend over 600 turns, Antigravity's projection grows 4.6 KB a turn. Real `agy` reached a 440 ms median turn, so the 500 MB target is generated from record shapes. Review rounds made the reopen legs identical, streamed the census, fixed the retention sampling, moved group pairing to step indexes and recorded that a reopen can change the summaries index's content. Found the permission defect that step 2b fixes. |
| 2b — accept agy's permission requests | Done 2026-11-22 | One owner handles inbound permission requests (`antigravity-permission-requests.ts`): any JSON-RPC ID type, echoed once; identity-checked replies; a 32-request cap; intake closed when the connection ends. A request belongs to its tool call: terminal evidence withdraws it, Stop withdraws every waiting request on the connection and cancels delayed requests for calls running at Stop, and a turn's or command's result withdraws requests raised during it, while later ones are held until YA reports it is idle (one release point for turns and queued commands such as `/compact`). Steer is closed from Stop until the cancelled prompt returns. Responses need exactly one valid body. Real `agy` 1.5.13 and 1.5.14: default mode asks, Allow writes, Deny ends the turn without writing, Stop withdraws a waiting write and input sent right after is delivered, accept-edits asks only for the tested command, bypass never asks, Plan is refused. Child permission routing is unqualified ([gap](../../gaps/antigravity-child-permission-routing-unqualified.md)). [Contract](../../topics/antigravity.md#vanilla-execution). |
| 3 — project the log into YA messages | Done 2026-11-22 | `antigravity-log-projection.ts`, not wired: a line iterator, a strict record parser and a projection with step-derived IDs (`<id>:step-<n>[:thinking\|:text\|:error]`, tools `<id>:step-<P>:tool-<i>`). Interrupted calls carry `orphanedToolUseIds`, checkpoints are `compact_boundary`, system messages `informational`, `ERROR_MESSAGE` an `error`. Windows observe the records from the last non-`GENERIC` record before them and read ahead while a group they projected is open; windows reproduce the whole projection at every boundary of a generated log. The native case matches ACP replay on 1.5.13 and 1.5.14 apart from the listed differences. The census of this host's store projected all 12 logs; the remaining differences are database-only steps and one conversation's `status` 5 steps, whose thinking and calls replay omits. YA's cold transcript holds no ordinary tool results, and its replay check rejects 4 of the 12 conversations ([gap](../../gaps/antigravity-acp-replay-completion-signal.md)). 500 MB projects in 0.55 s. Review round 1: the census stages independent regular files with source identity checks and refuses links; record content can no longer make the projection throw, and its entry points are total; invalid UTF-8, `tool_calls: null` and unobserved user or system wrappers are unknown; the census counts replay's raw tool frames (1,093 ordinary calls, 705 with `rawOutput`, no `tool_call_update`) and YA's normalized results (none); step 4's integration requirements are listed in its section. [Findings](../../topics/antigravity-native-storage.md#projection--plan-195-step-3). |
| 4 — serve cold history from the log | Done 2026-11-22 | `antigravity-log-window.ts` reads pages of `transcript_full.jsonl`: back to the requested checkpoint or 4 MiB, backed off to a record that is not a tool result, with the group context before and the lookahead after; a cursor's record is found by halving on the `step_index` prefix and the page is cut before the cursor, so every ID form (a `:result` at P+1+*i*) ends a page exactly and stale IDs miss. 32 MiB per read; a spent budget is unknown. The Claude/Codex append fence rereads a replaced or truncated file. The reader serves detail pages (`readWindow` `log-page`, cursor = first message ID), catch-up, complete reads, children (running ones too), agent mappings and the hover excerpt from the log; the v0 source uses the same pages. Verified direct children become `{agent_id}` results by step pairing. ACP replay is the fallback for a missing or unknown log, never beside a live owner. Display choices: reminders hidden, inbox wakes collapsed, result time lines dropped, one error for a 1.5.14 cancel. Summaries now take titles from the summaries index (the metadata route had started `agy` for `session/list`). 500 MB target: a latest page reads 5.3 MB in about 10 ms. All 12 host logs page back to their whole projection, including the 4 replay refused. A view of a real-`agy` store starts no `agy` and changes no file except the SQLite sidecars YA's summaries read already created ([gap](../../gaps/antigravity-summaries-read-creates-sqlite-sidecars.md)). [Contract](../../topics/antigravity.md#cold-history-from-the-log) · [findings](../../topics/antigravity-native-storage.md#serving-cold-history--plan-195-step-4). |
| 5 — resume without replaying history | Not started | |
| 6 — bound live session memory | Not started | |
| 7 — warn on an external writer | Not started | |
| 8 — decide the ACP replay fallback | Not started | |
| 9 — move the owner into the Provider Host | Not started | |

Steps 1 to 3 are independent of each other, and step 2b of all others. Step 4 needs step 3. Steps 5 and
6 need steps 2 and 4. Step 7 needs step 4, step 8 needs step 5, and step 9
needs step 6.

The large-history gap closes when steps 6 and 9 land; delete its file in the
later of those commits.
