# Antigravity history from the native log

Status: proposed 2026-11-22. The goal and the decisions below are agreed with
the maintainer. Steps 1 and 2 are done; the [progress table](#progress)
tracks the rest.

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
  change. Update the provider contract.

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
| 2 — reproduce the limits and measure the unknowns | Done 2026-11-22 | Repros are controlled-peer tests named "today: …" for steps 4 to 6 to flip. Answers are in [native storage measurements](../../topics/antigravity-native-storage.md#measurements--plan-195-step-2): a record appears once its step ends, so the log trails by the step in progress; snapshots around load and resume found the conversation's database content and log unchanged, with temporary sidecars and store-wide writes; `session/resume` qualified at 7,261 compacted steps on 1.5.13 and 1.5.14 (37 ms, no replay, compacted context kept); tool call IDs are random; `step_index` increases but skips interrupted and error steps (type 17 is `ERROR_MESSAGE`); a tool group can be cut short, with a [conservative reading rule](../../topics/antigravity-native-storage.md#reading-a-tool-group); Codex's heap shows no upward trend over 600 turns, Antigravity's projection grows 4.6 KB a turn. Real `agy` reached a 440 ms median turn, so the 500 MB target is generated from record shapes. Review round 1 restated the group rule, made the reopen legs identical, streamed the census and fixed the retention sampling. Found the [permission-ID gap](../../gaps/antigravity-permission-requests-with-string-ids-are-refused.md). |
| 3 — project the log into YA messages | Not started | |
| 4 — serve cold history from the log | Not started | |
| 5 — resume without replaying history | Not started | |
| 6 — bound live session memory | Not started | |
| 7 — warn on an external writer | Not started | |
| 8 — decide the ACP replay fallback | Not started | |
| 9 — move the owner into the Provider Host | Not started | |

Steps 1 to 3 are independent of each other. Step 4 needs step 3. Steps 5 and
6 need steps 2 and 4. Step 7 needs step 4, step 8 needs step 5, and step 9
needs step 6.

The large-history gap closes when steps 6 and 9 land; delete its file in the
later of those commits.
