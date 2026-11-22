# Antigravity native storage

Topic: antigravity-native-storage

Status: observations, recorded 2026-11-22. This describes what `agy` writes to
disk for a conversation, which of those files YA reads, and which of them T3
Code reads. Google documents none of it. The [provider contract](antigravity.md)
owns YA's behavior; this document owns the description of the files.

## Evidence and limits

Everything below was observed on one macOS arm64 host with `agy` 1.5.14, in
that host's `antigravity-cli` store (fifteen conversations). Counts come from the
[saved long-session repro](native-provider-testing.md#checking-an-antigravity-upgrade-candidate):
1,272 steps, a 41 MiB conversation database and three completed compactions.
One long session and a handful of short ones are not a format specification.
Recheck this document when qualifying a new `agy`.

[Plan 195 step 2](#measurements--plan-195-step-2) added measurements with real
`agy` 1.5.13 and 1.5.14 against a scripted model, on owned profiles, and a
read-only census of the same host's store. Those numbers come from one macOS
arm64 host too.

Nothing here was learned by decoding protobuf. Statements about protobuf
content are taken from T3's source and marked as such.

## The layers

The store root is `antigravity-cli` under the `--gemini-dir` YA passes to
`agy acp`, else under `~/.gemini`. YA no longer reads the standalone runtime's
`antigravity-acp` store or its `<id>.meta` files.

| Path under the store root | Format | Holds |
| --- | --- | --- |
| `conversations/<id>.db`, with `-wal` and `-shm` | SQLite, protobuf blobs | The conversation itself: one row per step. |
| `conversation_summaries.db`, with sidecars | SQLite, plain columns | An index across conversations: title, workspace, lineage, activity. |
| `annotations/<id>.pbtxt` | Text protobuf | A title was the only field observed. |
| `brain/<id>/.system_generated/logs/` | JSON Lines | A text log of the conversation's steps. |
| `brain/<id>/.system_generated/steps/<n>/output.txt` | Text | The rendered result of step `n`, for some steps. |
| `brain/<id>/.system_generated/messages/` | JSON, one file each | The conversation's inbox, with `read.json` receipts. |
| `brain/<id>/.system_generated/subagents/<childId>.json` | JSON | One record per child the conversation launched. |
| `brain/<id>/.system_generated/tasks/task-<n>.log` | Text | Output of a background shell task. |
| `brain/<id>/scratch/`, `brain/<id>/.user_uploaded/` | Files | The agent's working files and user uploads. |
| `presence/<id>.lock` | Empty file | Unknown. See [open questions](#open-questions). |

Not examined: `implicit/`, `daemon/`, `persistent_terminals/`, `cache/`,
`jetski_state.pbtxt` and `jetbox_summaries_proto.pb`.

### Conversation database

`conversations/<id>.db` is the only complete record of a conversation, and by
inference the one `agy` continues from. On a stopped conversation, ACP
`session/load` and `session/resume` left this database, its WAL and the brain
log unchanged, but they do write store-wide files (see
[what reopening writes](#what-load-and-resume-write)). What a second process
does to a conversation that a live owner is writing is not measured, which is
why YA still never runs a load beside a live owner.
Its tables:

```text
steps(idx, step_type, status, has_subtrajectory, metadata, error_details,
      permissions, task_details, render_info, step_payload, step_format)
trajectory_meta, trajectory_metadata_blob, gen_metadata, executor_metadata,
parent_references, battle_mode_infos
```

`idx`, `step_type`, `status` and `step_format` are integers. The content
columns are blobs. T3 decodes `step_payload` as protobuf from the runtime's
`exa.cortex_pb` package, using field numbers it hard-codes.

A conversation that was created and never prompted has a database with zero
steps and no log.

### Summaries index

`conversation_summaries.db` has one `conversation_summaries` row per
conversation with ordinary columns, including `title`, `workspace_uris`,
`step_count`, `status`, `parent_conversation_id`, `agent_name`,
`nesting_depth`, `not_fully_idle`, `killed`, `last_modified_time` and
`last_user_input_step_index`. A `raw_summary` blob sits beside them.

The same file holds a `conversation_parents` table and a full-text index,
`conversations_fts`, whose rows carry `chunk_first_step`, `chunk_last_step`,
`user_step_byte_offsets` and `agent_step_byte_offsets`. The index was not
queried; what its byte offsets address is unknown.

### Brain log

`logs/transcript_full.jsonl` and `logs/transcript.jsonl` hold one JSON object
per step. The two files have the same records. `transcript.jsonl` shortens
long fields, lists them in `truncated_fields` and leaves a
`<truncated N bytes>` marker in the text; `transcript_full.jsonl` does not.
On the saved session they are 5.2 MB and 3.0 MB, and 311 of 1,271 records
are shortened.

Every record has `step_index`, `type`, `source`, `status` and `created_at`.

| `type` | `source` | Other fields | Records | `step_type` in the database |
| --- | --- | --- | ---: | ---: |
| `USER_INPUT` | `USER_EXPLICIT` | `content` | 9 | 14 |
| `PLANNER_RESPONSE` | `MODEL` | `model`, token counts, and any of `content`, `thinking`, `tool_calls` | 348 | 15 |
| `GENERIC` | `MODEL` | `content`, sometimes `error` | 778 | 132 |
| `SYSTEM_MESSAGE` | `SYSTEM` | `content` | 133 | 101 |
| `CHECKPOINT` | `SYSTEM` | `content`, token counts | 3 | 23 |
| `ERROR_MESSAGE` | `SYSTEM` | `error`, sometimes `content` | 0 | 17 |

The `step_type` column is inferred from equal counts and matching positions,
not from decoding. The probes confirmed the pairing step by step on owned
conversations, including `ERROR_MESSAGE` and 17.

- **Order.** `step_index` equals the database `idx` and strictly increases
  through the file. It is not contiguous: the log can skip a step.
- **Coverage.** The database has 1,272 steps and the log has 1,271 records.
  The missing step, 1144, is an `ERROR_MESSAGE` (17) that sits where a turn
  stopped, an hour before the user's next "Continue". The census below found
  the log skipping only error and interrupted steps.
- **Tools.** A `tool_calls` entry is `{name, args}` with no call ID, and the
  ACP tool call ID does not name the step either (see
  [tool call IDs](#tool-call-ids)). The
  records after a `PLANNER_RESPONSE` with *k* tool calls are *k* `GENERIC`
  records, one result per call in order. This held for all 297 such planner
  records, 778 calls in total. Argument values are strings, integers and
  booleans.
- **Results.** A result is rendered text that starts with `Created At:` and
  `Completed At:` lines. Its `status` is `DONE`, `ERROR` or `RUNNING`. The 55
  `RUNNING` records are launches of background tasks; the log does not
  rewrite them when the task ends. In the probes the end arrived as a new
  `SYSTEM_MESSAGE` about 20 ms after ACP's completed `tool_call_update`,
  followed by the wake's `PLANNER_RESPONSE`.
- **Compaction.** A `CHECKPOINT` record carries the summary the model resumes
  from. Records from before all three checkpoints are still in the file.
- **Children.** A child's log starts with a `SYSTEM_MESSAGE` at step 0. The
  parent's `invoke_subagent` result names the child's ID and gives the path
  of the child's `transcript.jsonl` as `logAbsoluteUri`. `agy` tells its own
  agents to read that file.
- **Chunks.** `logs/chunks/transcript_full/` and `logs/chunks/transcript/`
  hold numbered files of 102,400 bytes. Concatenated in order they equal the
  log byte for byte. The split is by bytes and falls inside records.

The same record keys appear on a conversation created 2026-11-03 and on those
created with 1.5.14. Only first records were compared across versions.

### What the log has and lacks against ACP replay

| | Brain log | ACP `session/load` replay |
| --- | --- | --- |
| Supported interface | No | Yes |
| Read without side effects | Yes | No: it starts `agy`, which writes store-wide files |
| Cost of the latest page | The tail of a file | The whole conversation |
| Compaction boundaries | `CHECKPOINT` records | Omitted |
| Per-step time, model, token counts | Yes | Not compared |
| Tool call ID, ACP kind, locations | No | Yes; the ID is random |
| Tool results | Rendered text | ACP content blocks |
| A step still in progress | Absent until it ends | Not measured |

## Measurements — plan 195 step 2

Recorded 2026-11-22 on macOS arm64. The probe runs real `agy` against the
scripted GenAI model on an owned profile, drives ACP directly and polls the
log every millisecond. Run it from `packages/server`:

```bash
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs measure [--agy <path>]
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs resume-large --turns 1005 --compact-every 40 --file-kb 16
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs coverage [--store <antigravity-cli>]
```

`measure` ran twice on each of `agy` 1.5.13 (the pin) and 1.5.14, with the
same results except where noted. `coverage` reads a store without changing
it: it copies each database and reads only `idx`, `step_type` and `status`.

### How far a record trails its ACP event

A record is written once, when its step ends, and appears in
`transcript_full.jsonl` and `transcript.jsonl` within the same 2 ms. While a
step runs, ACP has streamed it and the log has nothing. The log therefore
trails the live stream by the length of the step in progress, without bound
for a long model response or a long foreground tool, and then by a few
milliseconds.

| Record | Written | After its anchor |
| --- | --- | --- |
| `USER_INPUT` | Before the first model request | 6–33 ms after `session/prompt` is sent |
| `PLANNER_RESPONSE` | When the model response ends | 1–8 ms after the last chunk; 400 ms after the first chunk of a response held for 400 ms. A response with tool calls is logged about 2 ms *before* ACP's `tool_call`. |
| `GENERIC` | When the tool ends | 1–2 ms after the terminal `tool_call_update` |
| `GENERIC` `RUNNING` | When a command goes to the background | About 500 ms after launch and before ACP reports it complete; never rewritten |
| `SYSTEM_MESSAGE` | A background task's end, or a reminder before a turn | 10–23 ms after the completed `tool_call_update`; a reminder 3 ms after its `USER_INPUT` |
| `CHECKPOINT` | When the summary response ends | 0–2 ms, before the continuation request |
| `ERROR_MESSAGE` | On `session/cancel`, with the cancelled response | 2–8 ms after the cancel |

A cancelled response keeps its partial text: 1.5.13 logs it `DONE`, 1.5.14
logs it `ERROR` with `error: "context canceled by user"`. When the owner is
stopped mid-response the way YA stops it (SIGTERM to the process group),
1.5.13 logs the partial response `DONE` and the next model request includes
it. 1.5.14 leaves that step in the database with `status` 6, writes no
record, and omits it from the next request.

### What load and resume write

`session/load` and `session/resume` were each run on a stopped conversation,
with the size, modification time and SHA-256 of every file under the store
taken before and after. On both versions, at 24 steps and at 7,261 steps:

- **Unchanged:** the conversation database's content, the brain log, its
  chunks and every other `brain/<id>/` file.
- **Written while `agy` runs:** an empty WAL and a shared-memory file beside
  the conversation database, and a 16 KB WAL beside
  `conversation_summaries.db`. After `agy` exits, the index's content is
  unchanged but its modification time is new.
- **Store-wide files:** `jetbox_summaries_proto.pb` is rewritten, sometimes
  with new content of the same size. `cache/onboarding.json` gets a new
  modification time. Each launch adds `log/acp-server-<time>-<pid>.log`, and
  1.5.13 sometimes adds an empty `crashes/crash_<pid>_<uuid>.log`.

A repeated load writes the same set. YA's provider-root watcher observes
`conversation_summaries.db` and its WAL, so a cold read still produces a
change notification.

### Resume on a large compacted conversation

Real `agy` built a conversation of 1,005 turns: each turn read four 16 KiB
files and replied, and every 40th turn compacted. The result was 7,261 steps,
25 checkpoints, a 62 MB full log, an 18.7 MB short log and a 143 MB database.
Building took 418 s; a turn took about 70 ms at the start and 460 ms (median)
across the run. At that rate real `agy` cannot reach the 500 MB scale target,
so the [generator](#scale-target-generator) builds that file from record
shapes.

| On 1.5.13 | `session/resume` | `session/load` |
| --- | --- | --- |
| Response | 41 ms | 238 ms |
| Stream quiet | 137 ms | 316 ms |
| Updates streamed | 2 (commands, session info) | 3,531, 1.38 MB |
| `agy` resident memory, idle → peak | 128 → 314 MB | 125 → 353 MB |
| Conversation files changed | None | None |
| Next model request | 355 KB, with the newest reply and the latest summary, without the compacted first turn | The same |

A first run of 1,000 turns, whose last turn was a compaction, measured
146 ms and 329 ms to respond and peaks of 299 and 380 MB. On the short
`measure` conversation, the request after resume carried the same prior
context as the live owner's request after compaction: the summary, earlier
user prompts and the newest reply. The memory figures are `agy`'s own, not
YA's. Not measured: 1.5.14 at this size.

### Tool call IDs

Every ACP `toolCallId` observed was a random UUID: auto-approved `read_file`
calls, `write_file` and `run_command` calls that asked permission (the
permission request carries the same ID), and calls under
`--dangerously-skip-permissions`, on both versions. None had the form
`<sessionId>:<plannerStep>`. A live tool call can be tied to its log record
only by order: the *k* results after a planner record with *k* calls.

`agy` sends `session/request_permission` with a string JSON-RPC ID, which
YA's transport refuses; see the
[permission gap](../gaps/antigravity-permission-requests-with-string-ids-are-refused.md).

### `step_index`, gaps and undo

`step_index` strictly increased across a cancel, a background wake, a
compaction, `session/resume`, and an owner stopped mid-response, and always
equalled the database `idx`. It is not contiguous. The census of this host's
store found 15 conversations with a log (three more were never prompted),
all strictly increasing, and eight database steps with no record:

| `step_type` | `status` | Steps | Reproduced |
| ---: | ---: | ---: | --- |
| 15 (`PLANNER_RESPONSE`) | 6 | 4 | Yes: a 1.5.14 owner stopped mid-response |
| 132 (`GENERIC`) | 6 | 2 | No |
| 17 (`ERROR_MESSAGE`) | 3 | 2 | No: a cancel's `ERROR_MESSAGE` was logged on both versions |

The saved repro's unlogged step is one of the two `ERROR_MESSAGE` steps. Why
those two were not logged is unknown.

`agy` 1.5.13 and 1.5.14 advertise no undo or rewind command over ACP, and YA
offers no rewind for Antigravity, so a conversation YA owns is never undone.
Fallback for one rewound by another program: a reader treats a
`step_index` that does not increase as an unknown log, as for any unexpected
record, and falls back to ACP.

### Live session retention

[`native-live-retention.test.ts`](../packages/server/test/native-provider/native-live-retention.test.ts)
runs 600 turns of the same work on each provider, a short prompt and a
4 KiB reply, and samples YA's heap after a full GC. The Process replay
window, which is time-bounded and common to every provider, and the
fixture's own logs are emptied before each sample.

| 600 turns | Heap at turn 1 | Heap at turn 600 | Growth per turn | Retained history |
| --- | ---: | ---: | ---: | --- |
| Codex 0.171.0 | 73.7 MB | 73.0 MB | none (−1 KB) | None outside the replay window |
| Antigravity 1.5.13 | 73.5 MB | 79.1 MB | 9.4 KB | 1,201 messages, 2.78 MB of JSON, plus a cloned copy per message |

The bar for [step 6](../docs/tactical/195-antigravity-native-history.md#6--bound-live-session-memory)
is Codex's: retained memory that does not grow with turn count. Antigravity
grows about 4.6 KB of history per such turn. It would reach the 8 MiB cap
after roughly 1,800 of them, and at that point the session is stopped
mid-turn. The controlled-peer test "today: a live session that passes 8 MiB
across turns is torn down mid-turn" records that.

### Scale target generator

[`antigravity-scale-log.ts`](../packages/server/test/utils/antigravity-scale-log.ts)
writes a conversation of any size, and
`scripts/perf-repro/antigravity-scale-log.mjs --out <dir> --verify` runs it
from `packages/server` with `pnpm exec tsx --conditions source`. It copies
real record shapes, including key order, tool pairing, `RUNNING` and `ERROR`
results, checkpoints, the shortened log's markers and steps the log skips;
the text is filler. Its database holds only the plain step columns, so real
`agy` cannot load it. The default target took 1.3 s to write on this host:
100,000 steps, a 500 MB full log, a 330 MB short log, 49 checkpoints and
three skipped steps.

## Runtime identity

ACP `initialize` reports `agentInfo.version` equal to `agy --version`:
`1.5.13` from the pinned Linux arm64 build and `1.5.14` on macOS arm64, both
observed 2026-11-22. YA's [version floor](antigravity.md#supported-runtime)
reads it. Both versions also advertise `loadSession` and the session
capabilities `resume`, `close`, `load` and `list`. The same 1.5.13 build, on
Ubuntu 24.04 with no `nobody` group,
answered `initialize` and `session/new` and created its conversation database;
that group was a requirement of the standalone 1.4.5 bootstrap only.

## What YA reads today

YA opens native files read-only, resolves them against the physical store
root, and refuses a symlink that leaves it. It decodes no protobuf.

| Reader | File | Purpose |
| --- | --- | --- |
| [Catalog adapter and metadata](../packages/server/src/sessions/antigravity-metadata.ts) | `conversations/<id>.db` and `-wal` file facts | Discovery and source versions. The database is never opened. |
| [Summaries reader](../packages/server/src/sessions/antigravity-summaries.ts) | `conversation_summaries.db` | Project binding from the workspace, title, lineage and child settlement from bounded columns. A conversation with no workspace row is not listed. |
| `readAntigravityReplayTail` | `transcript_full.jsonl`, else `transcript.jsonl` | The saved text a cold replay must reach. |
| `readAntigravityTurnBoundary`, `readAntigravityTranscriptPosition` | `transcript.jsonl` | The step and file position before a prompt. |
| `readAntigravitySubagentLaunches`, `readAntigravityTurnSubagentLaunches` | `transcript.jsonl` | Pairing `invoke_subagent` calls with child IDs. |
| `readAntigravityReadOnlyTranscript` | `transcript.jsonl` | The transcript of a running child: text and thinking only. |
| [Compaction check](../packages/server/src/sdk/providers/antigravity-compaction.ts) | `transcript.jsonl` | A new completed `CHECKPOINT` confirms `/compact`. |

The log readers are in
[`antigravity-subagent-links.ts`](../packages/server/src/sessions/antigravity-subagent-links.ts)
and each read is bounded to 4 MiB. Root history, cold or live, does not come
from the log: it comes from ACP `session/load` or the live owner's in-memory
projection, as [identity and history](antigravity.md#identity-and-history)
describes. [Provider history facts](provider-history-facts.md#consumers) lists
these readers among YA's history consumers.

## What T3 Code reads

From T3 `main` at [`122d3bf853`][t3-revision], in one file,
[`AntigravityChildWork.ts`][t3-child-work]. T3 runs `agy acp` with a managed
profile and reads that profile's `antigravity-acp` store. This review did not
establish where T3's main conversation history comes from.

| T3 reads | How | For |
| --- | --- | --- |
| `transcript.jsonl` | A tail of at most 256 KiB, parsed with a schema of `step_index`, `type`, `status`, `content`, `error` and `tool_calls` | A child's steps in the subagent view. |
| `transcript.jsonl` | The last record only | A pending wake: a trailing `SYSTEM_MESSAGE` with no reply after it. |
| `messages/*.json` and `read.json` | Whole files, at most 256 | An unread high-priority inbox message, also a pending wake. |
| `subagents/<childId>.json` and the child's inbox | Whole files | Matching a detached child to the tool call that launched it. |
| `conversations/<id>.db` | Read-only SQLite, with a hand-written protobuf field reader | Matching an `invoke_subagent` record to its planner tool call. |

T3 therefore depends on the JSON files as YA does, and goes further by
decoding the database. Its constants (payload fields 20 for a planner response
and 143 for `invoke_subagent`, tool calls in field 7, and step type 127) are
tied to one runtime's protobuf schema.

Two statements in T3's source differ from or extend what YA has checked:

- T3 notes that an auto-approved tool call's ACP ID is
  `<sessionId>:<plannerStep>`, and a permission prompt's ID is random. With
  `agy` 1.5.13 and 1.5.14 in YA's launch mode, every ID was random,
  auto-approved or not ([tool call IDs](#tool-call-ids)).
- T3 treats each tool argument value as JSON text. In YA's store the values
  were mixed JSON types.

[t3-revision]: https://github.com/pingdotgg/t3code/commit/122d3bf853da716652d5066b54d05d7654c46e36
[t3-child-work]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/provider/acp/AntigravityChildWork.ts

## Depending on these files

The log is undocumented and a later `agy` can change it or stop writing it.
A log already on disk does not change when `agy` is upgraded, so the exposure
is a new shape for new records, not the loss of old conversations.

The existing readers follow these constraints, and a new reader should too:

- Read-only, bounded, and anchored to the physical store.
- A record that does not parse as expected yields "unknown", never a guess.
  [Provider history facts](provider-history-facts.md#how-to-fix-a-reader)
  owns that rule.
- ACP remains the fallback for anything the log cannot answer.
- No protobuf decoding. The [provider contract](antigravity.md#identity-and-history)
  rules it out, and field numbers would tie YA to one runtime's schema.

## Open questions

- How real `agy` behaves past the 62 MB log it built here. It slowed to
  about 460 ms a turn, so the 500 MB target is generated.
- Why two `ERROR_MESSAGE` steps on this host were not logged, when a cancel's
  is.
- Whether a load beside a live owner writes the conversation's files.
- What `presence/<id>.lock` means. The one file observed was empty and
  dated 2026-11-03, although conversations had run since.
- What the full-text index's step byte offsets address.

The [large-history gap](../gaps/antigravity-large-history-and-replay-ownership.md)
is the reason these matter: it asks whether the log can serve a bounded,
read-only view of a root conversation.
