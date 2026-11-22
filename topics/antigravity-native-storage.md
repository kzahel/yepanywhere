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
inference the one `agy` continues from. In every snapshot taken around an
ACP `session/load` or `session/resume` of a stopped conversation, this
database's content and the brain log matched their state before launch.
While `agy` ran, an empty WAL and a shared-memory file sat beside the
database, and `agy` wrote store-wide files (see
[what load and resume write](#what-load-and-resume-write)). Snapshots show
the files at those moments, not that nothing was written between them. What
a second process does to a conversation that a live owner is writing is not
measured, which is why YA still never runs a load beside a live owner.
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
  stopped, an hour before the user's next "Continue". In the
  [census](#step_index-gaps-and-undo), every step the log omitted was either
  an interrupted step (database `status` 6) or an `ERROR_MESSAGE`.
- **Tools.** A `tool_calls` entry is `{name, args}` with no call ID, and the
  ACP tool call ID does not name the step either (see
  [tool call IDs](#tool-call-ids)). A `PLANNER_RESPONSE` with *k* calls and
  the `GENERIC` records after it form a *group*. In the saved session all 297
  groups (778 calls) were complete: *k* results, one per call, in call order.
  Not every group is complete; see [reading a tool group](#reading-a-tool-group).
  Argument values are strings, integers and booleans.
- **Results.** A finished result is rendered text that starts with
  `Created At:` and `Completed At:` lines; its `status` is `DONE` or `ERROR`.
  The 55 `RUNNING` records are launches of background tasks. They have a
  `Created At:` line and "Tool is running as a background task with task id:
  `<conversation>/task-<n>`", and no `Completed At:` line. The log does not
  rewrite them. When the task ends, `agy` appends a `SYSTEM_MESSAGE` whose
  text is a `[Message]` naming that task id with "finished with result:" (or
  "was canceled with result:"), then the wake's `PLANNER_RESPONSE`.
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

#### Reading a tool group

Seen on this host: the 297 complete groups above, 200 more complete groups
across eleven other conversations, and one group that is cut short. In
`918445a8`, step 555 has ten `edit_file` calls. Steps 556–563 are eight
results, and step 566 is the next turn's `USER_INPUT`. Database steps 564 and
565 are `GENERIC` steps with `status` 6 and are not logged. The eight results
all name the file the calls edit, at ascending line numbers and ascending
`Created At` times. That is consistent with the first eight calls' results
in order, but nothing in the log proves which call each result answers.

A reader that projects groups should therefore:

- Treat a group as complete when *k* `GENERIC` records follow the planner
  record, and pair results with calls in order.
- Treat a group as interrupted when a record of any other type follows after
  *m* < *k* results. Assign the *m* results, in order, to the first *m*
  calls. The other *k* − *m* calls have no result: show them as interrupted
  calls with no output, neither pending nor failed with invented text.
- Never look past the next non-`GENERIC` record for a result. A `GENERIC`
  record with no open group is unknown; none was found on this host.
- Treat a group still open at the end of the file as in progress while the
  conversation has a live owner (results are appended as tools finish, see
  [measurements](#how-far-a-record-trails-its-acp-event)), and as interrupted
  once it is stopped. None was found at the end of a stopped log here.

The database can confirm an interrupted group (the missing results are
`step_type` 132 with `status` 6), but the rule needs only the log.

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

Recorded 2026-11-22 on one macOS arm64 host. The probe runs real `agy`
against the scripted GenAI model on an owned profile and drives ACP
directly. Run it from `packages/server`:

```bash
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs measure [--agy <path>]
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs resume-large [--agy <path>] --turns 1005 --compact-every 40 --file-kb 16
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-native-probe.mjs coverage [--store <antigravity-cli>]
```

Each figure below comes from one `measure` run and one `resume-large` run on
each of `agy` 1.5.13 (the pin) and 1.5.14, unless a version is named.
Single runs on one host show what happened, not a distribution.

### How far a record trails its ACP event

The probe polls both logs every millisecond and keeps each record's bytes.
It pairs a record with the event it reports by identity: the prompt text
for `USER_INPUT`, a scripted marker for model output and checkpoints, and,
for a tool result, the ACP tool call whose input equals the record's call
arguments. The delays are differences between first observations, so they
include the poll interval and ACP dispatch to the probe. They are not
`agy`'s write latency.

On both versions a record appeared once, when its step had ended. While a
model response streams, or a foreground tool runs, ACP has reported it and
the log has nothing. A response held for 400 ms appeared 403–411 ms after
its first chunk. A two-second foreground command's result appeared 3–4 ms
after ACP reported it complete. After the step ends:

| Record | Paired with | Observed delay |
| --- | --- | --- |
| `USER_INPUT` | `session/prompt` sent | 8–34 ms, before the first model request |
| `PLANNER_RESPONSE` | The scripted response's end | 1–9 ms; 1–6 ms after its last ACP chunk |
| `PLANNER_RESPONSE` with calls | ACP's first `tool_call` for those calls | Seen 0–5 ms *before* it |
| `GENERIC` | The same call ID reported completed | 1–4 ms; in an earlier 1.5.14 run, 2 ms before it |
| `GENERIC` `RUNNING` | The call's launch | 507–516 ms, about 1 s before ACP reported the task complete |
| `SYSTEM_MESSAGE`, task end | The background call reported completed | 21–31 ms |
| `SYSTEM_MESSAGE`, reminder | Its turn's `USER_INPUT` record | 3–4 ms |
| `CHECKPOINT` | The summary response's end | 1 ms, before the continuation request |
| `PLANNER_RESPONSE`, cancelled | `session/cancel` sent | 10–11 ms |
| `ERROR_MESSAGE` | `session/cancel` sent | 16–17 ms |

Also observed:

- `transcript.jsonl` gained each record within 2.5 ms of
  `transcript_full.jsonl`, joined by `step_index`.
- After the run, each record's bytes in both logs, including the `RUNNING`
  record after its wake, matched the bytes first observed. Earlier
  in-between states were not checked.
- A cancelled response keeps its partial text: 1.5.13 logs it `DONE`, 1.5.14
  logs it `ERROR` with `error: "context canceled by user"`.
- When the owner is stopped mid-response the way YA stops it (SIGTERM to the
  process group), 1.5.13 logs the partial response `DONE`, and the next model
  request includes it. 1.5.14 leaves that step in the database with
  `status` 6 and writes no record, and the next request omits it.

### What load and resume write

Each leg restores an identical copy of the stopped store, then snapshots the
size, modification time and SHA-256 of every file under it before launch,
after `initialize`, after the reopen's stream has been quiet for 500 ms, and
after `agy` exits. No prompt is sent in that leg; a separate leg on another
fresh copy checks the next model request. The same set appeared on both
versions, for `session/load` and `session/resume`, on the 28-step `measure`
conversation and the 7,261-step one:

| Between | Changes |
| --- | --- |
| Before launch → after `initialize` | A new `log/acp-server-<time>-<pid>.log` |
| After `initialize` → after the reopen | Beside the conversation database, a 0-byte WAL and a 32 KiB shared-memory file appear. Beside `conversation_summaries.db`, a 16 KiB WAL and a shared-memory file appear. An empty `crashes/crash_<pid>_<uuid>.log` appears. `cache/onboarding.json` and `jetbox_summaries_proto.pb` get new modification times; in one 1.5.13 leg the latter got new content of the same size. |
| After the reopen → after exit | Every sidecar and the crash log are gone. `conversation_summaries.db` has the same content and a new modification time. |
| Before launch → after exit | The conversation database's content, the brain log, its chunks and every other `brain/<id>/` file match. |

Matching snapshots show the files matched at those four moments. They do not
show that nothing was written in between. YA's provider-root watcher observes
`conversation_summaries.db` and its WAL, so a cold read produces a change
notification.

### Resume on a large compacted conversation

Real `agy` built a conversation of 1,005 turns on each version. Each turn
read four 16 KiB files and replied, and every 40th turn compacted. Each
build had 7,261 steps, 25 checkpoints, a 62.2 MB full log and an 18.7 MB
short log; the database was 143.0 MB on 1.5.13 and 142.5 MB on 1.5.14. A
build took 396–405 s: the first turn took about 21 ms, the median 435–441 ms.
At that rate real `agy` cannot reach the 500 MB scale target, so the
[generator](#scale-target-generator) builds that file from record shapes.

| 7,261 steps | `session/resume` 1.5.13 | 1.5.14 | `session/load` 1.5.13 | 1.5.14 |
| --- | ---: | ---: | ---: | ---: |
| Response | 37 ms | 37 ms | 227 ms | 235 ms |
| Last update | 129 ms | 132 ms | 298 ms | 312 ms |
| Updates streamed | 2 | 2 | 3,529 | 3,528 |
| Bytes streamed | 2.4 KB | 2.4 KB | 1.38 MB | 1.38 MB |
| `agy` group RSS, idle → peak | 128 → 307 MB | 126 → 295 MB | 125 → 362 MB | 126 → 331 MB |

Resume's two updates were the command list and session info. In each case
the next model request was 354 KB, and its conversation `contents` held the
newest reply and the latest summary marker, and neither the previous
summary's marker nor the first turn's prompt. Load and resume requests
differed by 2 bytes. The memory figures are `agy`'s own, sampled every
25 ms, not YA's.

On the 28-step conversation, after load or resume, and in the live owner's
request right after compaction, the `contents` held the summary, the
earlier user prompts and the newest reply, but not earlier assistant
replies.

### Tool call IDs

Every ACP `toolCallId` observed was a version-4 UUID, on both versions: two
auto-approved `read_file` calls, three calls that asked permission
(`write_file` and two `run_command`; the permission request carried the same
ID), and one call under `--dangerously-skip-permissions`. None had the form
`<sessionId>:<plannerStep>`. A live tool call can be tied to its log record
only through its arguments or its position in the group.

`agy` sends `session/request_permission` with a string JSON-RPC ID (three per
run here), which YA's transport refuses; see the
[permission gap](../gaps/antigravity-permission-requests-with-string-ids-are-refused.md).

### `step_index`, gaps and undo

In the probe runs `step_index` strictly increased across a cancel, a
background wake, a compaction, `session/resume` and an owner stopped
mid-response, and always equalled the database `idx`. It is not contiguous.

The census streams each log once, keeping step indexes and counts, and reads
a private copy of the database's plain columns. A conversation whose
database, WAL or log changes while it is read is reported inconclusive. On
this host's store it read 15 databases: 12 with a log and three never
prompted. None was inconclusive. All 12 logs strictly increase. Eight
database steps have no record:

| `step_type` | `status` | Steps | Reproduced |
| ---: | ---: | ---: | --- |
| 15 (`PLANNER_RESPONSE`) | 6 | 4 | Yes: a 1.5.14 owner stopped mid-response |
| 132 (`GENERIC`) | 6 | 2 | No; they are the two missing results of the cut-short group in `918445a8` |
| 17 (`ERROR_MESSAGE`) | 3 | 2 | No: a cancel's `ERROR_MESSAGE` was logged on both versions |

The census also found 497 complete tool groups, one cut-short group (see
[reading a tool group](#reading-a-tool-group)), no group open at the end of
a log, and no result outside a group. The saved repro's unlogged step is one
of the two `ERROR_MESSAGE` steps. Why those two were not logged is unknown.

`agy` 1.5.13 and 1.5.14 advertise no undo or rewind command over ACP, and YA
offers no rewind for Antigravity, so a conversation YA owns is never undone.
Fallback for one rewound by another program: a reader treats a
`step_index` that does not increase as an unknown log, as for any unexpected
record, and falls back to ACP.

### Live session retention

[`native-live-retention.test.ts`](../packages/server/test/native-provider/native-live-retention.test.ts)
runs 600 turns of the same work on each provider: a short prompt and a
4 KiB reply. It samples YA's heap after a full GC at turns 1, 150, 300, 450
and 600. Before each sample it empties three things: the Process replay
window (time-bounded and common to every provider), the fixture's event log
and the scripted model's request log. It reads the heap before copying
Antigravity's projection to count it, so the copy is not charged. Growth is
taken from the warm sample at turn 150 to turn 600. These runs used Node
24.22.1 on this host. Codex 0.171.0 ran three times and Antigravity 1.5.13
twice:

| Turns 150 → 600 | Heap after GC | Growth | Antigravity projection |
| --- | --- | ---: | --- |
| Codex, three runs | 76.1 → 73.6 MB, every run | −2.5 MB | None |
| Antigravity, two runs | 73.1 → 76.2 MB, every run | +3.1 MB | 301 → 1,201 messages; 695,480 → 2,775,380 bytes of JSON |

Codex's samples moved within 73.1–76.3 MB with no upward trend. Its highest
sample after turn 150 was 0.16 MB above the warm one, and its largest swing
between samples was 3 MB. Antigravity's heap rose at every sample. Its
projection grew by exactly 4,622 bytes of JSON per turn in both runs. At that
rate it would reach the 8 MiB cap after about 1,800 such turns, and the
session would then be stopped mid-turn. The controlled-peer test "today: a
live session that passes 8 MiB across turns is torn down mid-turn" records
that.

The bar for
[step 6](../docs/tactical/195-antigravity-native-history.md#6--bound-live-session-memory),
on this harness, has two parts:

- **Structural, free of heap noise.** The projection's message count and
  serialized bytes at turn 600 do not exceed a bound fixed independently of
  turn count. Today they grow linearly.
- **Heap.** In each of at least two runs, the turn-600 sample is no more
  than 1 MB above the turn-150 sample, as with every Codex run here.
  Antigravity is 3.1 MB above today. A single heap sample on one host is not
  evidence by itself.

### Scale target generator

[`antigravity-scale-log.ts`](../packages/server/test/utils/antigravity-scale-log.ts)
writes a conversation of any size, and
`scripts/perf-repro/antigravity-scale-log.mjs --out <dir> --verify` runs it
from `packages/server` with `pnpm exec tsx --conditions source`. It copies
the observed record shapes: key order, complete tool groups, `ERROR`
results, background launches without a completion line followed by their
`[Message]` wake and its reply, reminders, checkpoints, the shortened log's
markers, and planner steps the log skips. The text is filler. The file
always ends on a complete group. `--interrupted-group-every <steps>` adds
groups cut short as in `918445a8`: the last results are database-only steps
with `status` 6, and the next record is the next turn's `USER_INPUT`.
`--verify` checks strictly increasing `step_index` and that each group is
complete, except the interrupted groups requested.

Its database holds only the plain step columns, so real `agy` cannot load
it. With `--interrupted-group-every 30000`, the default target took 1.4 s to
write on this host: 99,992 records, a 499.7 MB full log, a 336 MB short log,
49 checkpoints, 1,190 wakes, three skipped planner steps and three
interrupted groups. A census of it read all of it in 1.0 s at a 290 MB peak
resident size.

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

- How real `agy` behaves past the 62 MB log it built here. Its median turn
  was about 440 ms, so the 500 MB target is generated.
- Whether a cut-short group's results always answer its first calls in
  order. The one example found is consistent with that, but does not prove
  it.
- What `agy` writes between the snapshot moments of a load or resume.
- Why two `ERROR_MESSAGE` steps on this host were not logged, when a cancel's
  is.
- Whether a load beside a live owner writes the conversation's files.
- What `presence/<id>.lock` means. The one file observed was empty and
  dated 2026-11-03, although conversations had run since.
- What the full-text index's step byte offsets address.

The [large-history gap](../gaps/antigravity-large-history-and-replay-ownership.md)
is the reason these matter: it asks whether the log can serve a bounded,
read-only view of a root conversation.
