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
  groups (778 calls) were complete: *k* results, one per call, at the steps
  right after the planner record. Not every group is complete; see
  [reading a tool group](#reading-a-tool-group).
  Argument values are strings, integers and booleans.
- **Results.** A finished result is rendered text that starts with
  `Created At:` and `Completed At:` lines; its `status` is `DONE` or `ERROR`.
  The 55 `RUNNING` records are launches of background tasks. They have a
  `Created At:` line and "Tool is running as a background task with task id:
  `<conversation>/task-<n>`", and no `Completed At:` line. In the probe's
  background launch, the `RUNNING` record's bytes were unchanged after the
  task ended (checked once, after the run). When the task ends, `agy` appends a `SYSTEM_MESSAGE` whose
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

The census reads groups by step index. On this host, every one of the 497
complete groups had its *k* results at exactly steps P+1..P+k after its
planner record at step P. The one group that is cut short is in `918445a8`:
step 555 has ten `edit_file` calls, its eight results are at P+1..P+8
(556–563), P+9 and P+10 (564, 565) are database-only `GENERIC` steps with
`status` 6, and the next record, the next turn's `USER_INPUT`, is at P+11.
The census found no other shape: no result outside its group's steps, no
other record inside them, and no group with more results than calls. The
two real-`agy` builds of 7,261 steps (see
[resume on a large compacted conversation](#resume-on-a-large-compacted-conversation))
had 980 complete groups each, every one at exactly P+1..P+4, and no other
shape.

In the probe, `agy` ran a response's calls one after another. Given a
one-second command and then a file read, it started the read only when the
command had ended. Each result appeared at P+1+*i* for call *i*, and each
result's text named its own call (the command's echoed marker, the file's
content). The positions observed here are consistent with result steps
being allocated in call order. Whether a missing step inside a group (not
at its end) occurs is not known: none was seen.

Rule for a reader that projects groups:

- A planner record at step P with *k* calls owns steps P+1..P+*k*. A
  `GENERIC` record at step P+1+*i* is call *i*'s result, *i* counting the
  calls from zero in `tool_calls` order. Arrival order alone is not used.
- A step in P+1..P+*k* with no record, once a non-`GENERIC` record after
  P+*k* has arrived, is that call's interrupted result. Show the call as
  interrupted with no output, neither pending nor failed with invented text.
  This was observed only for the last calls of a group.
- Anything else makes the group unknown, and the reader treats the log as
  unknown and falls back: a `GENERIC` record whose step no group owns
  (outside every range, or more results than calls), or a non-`GENERIC`
  record inside P+1..P+*k*.
- A group still open at the end of the file is in progress while the
  conversation has a live owner (results are appended as tools finish), and
  its missing steps are interrupted results once the conversation is
  stopped. No stopped log here ended inside a group.

The database can confirm an interrupted result (`step_type` 132,
`status` 6), but the rule needs only the log.

A reader that reads part of the log, such as one page, applies the rule
with records from outside its part:

- A part that starts with `GENERIC` records must first read backward to the
  last record before it that is not `GENERIC`. Only that record can own
  them; until it is found, no result in the part may be called orphaned.
- A part that ends inside a group must read forward until a record past
  P+*k* arrives or the log ends, because a call's interrupted state is known
  only then.

The forward read is at most *k* + 1 records and the backward read at most
*k*.

### What the log has and lacks against ACP replay

| | Brain log | ACP `session/load` replay |
| --- | --- | --- |
| Supported interface | No | Yes |
| Read without side effects | Yes | No: it starts `agy`, which writes store-wide files |
| Cost of the latest page | The tail of a file | The whole conversation |
| Compaction boundaries | `CHECKPOINT` records | Omitted |
| System messages and `ERROR_MESSAGE` records | Yes | Omitted when logged; see [step 3](#projection--plan-195-step-3) |
| Per-step time, model, token counts | Yes | Not compared |
| Tool name | `agy`'s (`read_file`) | ACP's title (`File notes.txt`, the command line) |
| Tool call ID, ACP kind, locations | No | Yes; the ID is random |
| Tool results | Rendered text | Each call once, as a `tool_call` with its final status; edits and commands carry `rawOutput`, file reads none; no `tool_call_update` |
| A step only in the database | Absent | Replayed |
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

Each figure below comes from two `measure` runs and two `resume-large` runs
on each of `agy` 1.5.13 (the pin) and 1.5.14, unless a version or run is
named. A few runs on one host show what happened, not a distribution.

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
| `USER_INPUT` | `session/prompt` sent | 8–36 ms, before the first model request |
| `PLANNER_RESPONSE` | The scripted response's end | 1–10 ms |
| `PLANNER_RESPONSE` with calls | ACP's first `tool_call` for those calls | Seen 0–6 ms *before* it |
| `GENERIC` | The same call ID reported completed | 1–4 ms; in an earlier 1.5.14 run, 2 ms before it |
| `GENERIC` `RUNNING` | The call's launch | 513–517 ms, about 1 s before ACP reported the task complete |
| `SYSTEM_MESSAGE`, task end | The background call reported completed | 29–34 ms |
| `SYSTEM_MESSAGE`, reminder | Its turn's `USER_INPUT` record | 3–4 ms |
| `CHECKPOINT` | The summary response's end | 1 ms, before the continuation request |
| `PLANNER_RESPONSE`, cancelled | `session/cancel` sent | 9–11 ms |
| `ERROR_MESSAGE` | `session/cancel` sent | 14–15 ms |

Also observed:

- A record and its response's last ACP chunk arrived within a few
  milliseconds of each other, in either order. In these runs the record came
  1–6 ms after the last chunk; in the reviewer's 1.5.14 run, the final
  reply's record was seen 2 ms before its last chunk. When text was followed
  by a tool call 400 ms later, the last text chunk preceded the record by
  about 400 ms.

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
fresh copy checks the next model request. These legs ran on both versions,
for `session/load` and `session/resume`, on the short `measure`
conversation of 28–34 steps (two implementer runs) and on the 7,261-step
one (two implementer runs and one reviewer run):

| Between | Changes |
| --- | --- |
| Before launch → after `initialize` | A new `log/acp-server-<time>-<pid>.log`. |
| After `initialize` → after the reopen | Beside the conversation database, a 0-byte WAL and a 32 KiB shared-memory file appear. Beside `conversation_summaries.db`, a WAL and a 32 KiB shared-memory file appear; the WAL was 16,512 bytes in most legs, 20,632 bytes in every 1.5.14 leg at 7,261 steps in the second implementer run and in the reviewer's, and 8,272 bytes in one reviewer leg on the short conversation. An empty `crashes/crash_<pid>_<uuid>.log` appears. `cache/onboarding.json` and `jetbox_summaries_proto.pb` get new modification times, and in some legs the latter got new content. |
| After the reopen → after exit | Every sidecar and the crash log are gone. `conversation_summaries.db` keeps its size (20,480 bytes) and gets a new modification time. Its **content changed** in every 1.5.14 leg at 7,261 steps in the second implementer run and in the reviewer's run. It stayed the same in the 1.5.13 legs, the short-conversation legs and the first implementer run's 1.5.14 legs at 7,261 steps. |
| Before launch → after exit | The conversation database's content, the brain log, its chunks and every other `brain/<id>/` file match. |

Matching snapshots show the files matched at those four moments. They do not
show that nothing was written in between. Whether the summaries index's
content changes varies between runs of the same version on the same
conversation. A watcher or cache that keys on the summaries index must
therefore expect a cold load or resume of any conversation to change it:
its modification time always, its WAL while `agy` runs, and sometimes its
content. YA's provider-root watcher observes that index and its WAL, so a
cold read produces a change notification. Starting a load because the index
changed would repeat. A cache for one conversation should not key on the
index. It also cannot assume the conversation database has no sidecars,
because `agy` creates them while the conversation is open.

### Resume on a large compacted conversation

Real `agy` built a conversation of 1,005 turns on each version, twice.
Each turn read four 16 KiB files and replied, and every 40th turn compacted. Each
build had 7,261 steps, 25 checkpoints, a 62.2 MB full log and an 18.7 MB
short log; the database was 143.0 MB on 1.5.13 and 142.5 MB on 1.5.14. A
build took 391–405 s: the first turn took about 21 ms, the median 429–441 ms.
At that rate real `agy` cannot reach the 500 MB scale target, so the
[generator](#scale-target-generator) builds that file from record shapes.

| 7,261 steps, two runs each | `session/resume` 1.5.13 | 1.5.14 | `session/load` 1.5.13 | 1.5.14 |
| --- | ---: | ---: | ---: | ---: |
| Response | 35–37 ms | 33–37 ms | 226–227 ms | 224–235 ms |
| Last update | 129–135 ms | 124–132 ms | 298–300 ms | 295–312 ms |
| Updates streamed | 2 | 2 | 3,529 | 3,528 |
| Update JSON length (characters, without JSON-RPC framing) | 2.4 K | 2.4 K | 1.38 M | 1.38 M |
| `agy` group RSS peak (idle 126–128 MB) | 295–307 MB | 295–306 MB | 341–362 MB | 331–364 MB |

Resume's two updates were the command list and session info. In each case
the next model request was 354 KB, and its conversation `contents` held the
newest reply and the latest summary marker, and neither the previous
summary's marker nor the first turn's prompt. Load and resume requests
differed by 2 bytes. The memory figures are `agy`'s own, sampled every
25 ms, not YA's.

On the short `measure` conversation, after load or resume, and in the live owner's
request right after compaction, the `contents` held the summary, the
earlier user prompts and the newest reply, but not earlier assistant
replies.

### Tool call IDs

Every ACP `toolCallId` observed was a version-4 UUID, on both versions. In
the second run on each version there were seven calls in `agy`'s default
mode, four of which asked permission (`write_file` and `run_command`; the
permission request carried the same ID), and one call under
`--dangerously-skip-permissions`. None had the form
`<sessionId>:<plannerStep>`. A live tool call can be tied to its log record
only through its arguments or its position in the group.

`agy` sends `session/request_permission` with a string JSON-RPC ID (four in
each second run). YA's transport accepts it since plan 195 step 2b; see
[vanilla execution](antigravity.md#vanilla-execution).

### `step_index`, gaps and undo

In the probe runs `step_index` strictly increased across a cancel, a
background wake, a compaction, `session/resume` and an owner stopped
mid-response, and always equalled the database `idx`. It is not contiguous.

The census streams each log once, keeping step indexes and counts, and reads
a private copy of the database's plain columns. Only records that end in a
newline count. A conversation is reported inconclusive when its database,
WAL or log changes while it is read (including during a read that fails),
or when its log ends in an unterminated record; a read that fails on files
that did not change is that conversation's error. On this host's store it
read 15 databases: 12 with a log and three never prompted. None was
inconclusive or an error. All 12 logs strictly increase. Eight database
steps have no record:

| `step_type` | `status` | Steps | Reproduced |
| ---: | ---: | ---: | --- |
| 15 (`PLANNER_RESPONSE`) | 6 | 4 | Yes: a 1.5.14 owner stopped mid-response |
| 132 (`GENERIC`) | 6 | 2 | No; they are the two missing results of the cut-short group in `918445a8` |
| 17 (`ERROR_MESSAGE`) | 3 | 2 | No: a cancel's `ERROR_MESSAGE` was logged on both versions |

By step index the census found 497 complete tool groups, one group missing
its last two results (see [reading a tool group](#reading-a-tool-group)), no
group with a missing step elsewhere, no unknown group, and no group open at
the end of a log. The saved repro's unlogged step is one
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

| Turns 150 → 600 | Heap samples after GC | Sampled growth | Antigravity projection |
| --- | --- | ---: | --- |
| Codex, three runs | 76.1 → 73.6 MB, every run | −2.5 MB | None |
| Antigravity, two runs | 73.1 → 76.2 MB, every run | +3.1 MB | 301 → 1,201 messages; 695,480 → 2,775,380 bytes of JSON |

The heap figures are point samples, each one heap reading after GC on one
host. Codex's samples moved within 73.1–76.3 MB with no upward trend; its
largest swing between samples was 3 MB. Antigravity's heap rose at every
sample. The reviewer's separate 600-turn run on the same Node sampled
+0.405 MB for Codex and +2.797 MB for Antigravity from turn 150 to turn 600.

The projection count is exact and repeated: it grew by exactly 4,622 bytes
of JSON per turn, from the same 301 to the same 1,201 messages, in all three
Antigravity runs. At that rate it would reach the 8 MiB cap after about
1,800 such turns, and the session would then be stopped mid-turn. The
controlled-peer test "today: a live session that passes 8 MiB across turns
is torn down mid-turn" recorded that until plan 195 step 6 flipped it
([live memory](#live-memory--plan-195-step-6)).

The bar for
[step 6](../docs/tactical/195-antigravity-native-history.md#6--bound-live-session-memory)
on this harness:

- **Primary: a fixed projection bound.** The projection's message count and
  serialized bytes at turn 600 do not exceed a bound fixed independently of
  turn count. This is exact, so one run decides it. Today both grow linearly.
- **Secondary: heap samples.** In each of at least two runs, the turn-600
  sample is no more than 1 MB above the turn-150 sample, as in every Codex
  sample above. Antigravity's samples are +2.8 to +3.1 MB today. A heap
  sample alone, or one run, is not evidence.

### Scale target generator

[`antigravity-scale-log.ts`](../packages/server/test/utils/antigravity-scale-log.ts)
writes a conversation of any size, and
`scripts/perf-repro/antigravity-scale-log.mjs --out <dir> --verify` runs it
from `packages/server` with `pnpm exec tsx --conditions source`. It copies
the observed record shapes: key order, complete tool groups at the steps
after their planner record, `ERROR` results, background launches without a
completion line followed by their `[Message]` wake and its reply,
reminders, checkpoints, the shortened log's markers, and planner steps the
log skips. The text is filler. The file always ends on a complete group.
Two options add groups with database-only (`status` 6) results:

- `--interrupted-group-every <steps>`: the last results are missing and the
  next record is the next turn's `USER_INPUT`, as in `918445a8`. A step is
  reserved for that `USER_INPUT`, so such a group never ends the file.
- `--interior-gap-group-every <steps>`: one result that is not the last is
  missing, and another group follows. This shape was not observed; it
  exercises readers that pair by step index.

`--verify` checks that `step_index` strictly increases and that the result
at P+1+*i* is the only thing at that step, for every group. A group may lack
results only where one was requested, its missing steps must be exactly the
requested ones, and its next record must be the shape's (`USER_INPUT`, or a
planner record with calls). Nothing may end the file inside a group.

Its database holds only the plain step columns, so real `agy` cannot load
it. With `--interrupted-group-every 30000 --interior-gap-group-every 40000`,
the default target took 1.1 s to write on this host: 99,990 records, a
500.1 MB full log, a 336 MB short log, 49 checkpoints, 1,198 wakes, three
skipped planner steps, three groups missing their last results and two
missing an interior result. `--verify` passed. The census of it took 0.9 s
at a 144 MB peak resident size and classified those five as three groups missing a
suffix and two with a gap, beside 23,481 complete groups.

## Projection — plan 195 step 3

[`antigravity-log-projection.ts`](../packages/server/src/sessions/antigravity-log-projection.ts)
turns `transcript_full.jsonl` records into the messages the Antigravity
reader returns. Since [step 4](#serving-cold-history--plan-195-step-4) it
serves cold history.

### What each record becomes

| Record | Messages, by ID |
| --- | --- |
| `USER_INPUT` | `<id>:step-<n>`: user text, the `<USER_REQUEST>` block's content without the newlines that wrap it. Literal tags inside the text are kept. The `<ADDITIONAL_METADATA>` and `<USER_SETTINGS_CHANGE>` blocks after it are dropped, as ACP replay drops them. |
| `PLANNER_RESPONSE` | `<id>:step-<n>:thinking`, then `<id>:step-<n>:text`, each present only when non-empty, both with the record's `model`. Then call *i*'s `tool_use`, ID `<id>:step-<n>:tool-<i>`, in message `<tool id>:call`, under `agy`'s tool name and its `args` as input; `invoke_subagent` becomes `spawn_agent` with the input YA already normalizes for it. An `error` field adds an `error` message `<id>:step-<n>:error`, unless the next record that is not a `GENERIC` is an `ERROR_MESSAGE`, which reports the same failure (a 1.5.14 cancel); a window ending at the planner reads that record to decide. |
| `GENERIC` | `<tool id>:result`: a `tool_result` for its call, with the record's `content` after its leading `Created At:` and `Completed At:` lines with `agy`'s RFC 3339 timestamps (step 4; often two pairs; other text starting with those words stays), and `is_error` for status `ERROR`. A `RUNNING` launch is a normal result. |
| Missing result step | No message. The call's `tool_use` message carries `orphanedToolUseIds` with its ID, which clients show as an incomplete call whose result is unavailable. |
| `SYSTEM_MESSAGE` | An inbox delivery, whose text inside `<SYSTEM_MESSAGE>` begins `[Message] ` (a task's wake, a notice): `<id>:step-<n>`, an `informational` system message labelled "System message" with that text as its detail. Any other system message, such as the reminder that accompanies most user turns, adds no message (step 4). |
| `CHECKPOINT` | `<id>:step-<n>`: a `compact_boundary` with the record's content as `compactSummaryText`, as Codex readers mark compaction. |
| `ERROR_MESSAGE` | `<id>:step-<n>`: an `error` message with the record's `error`. |

Every message has the record's `created_at` as its timestamp and the
conversation ID as `session_id`. IDs depend only on step indexes, which
skip steps, so a page has the same IDs however it was reached. They differ
from today's cold IDs, which count replayed messages and use ACP's random
tool call IDs.

The log is **unknown**, and the caller falls back, on:

- a complete line that is not valid UTF-8, is not JSON, or is empty. An
  unterminated final line is an append in progress, not a record, even
  when it ends inside a character;
- a `step_index` that does not increase;
- a type, source, status, field or field type outside the table in
  [brain log](#brain-log): an explicit `null` is not an absent field
  (`tool_calls: null` is unknown), and `truncated_fields` is unknown, so
  the shortened log is never projected;
- a wrapper outside the observed forms. A `USER_INPUT` is
  `<USER_REQUEST>\n…\n</USER_REQUEST>` followed by at most an
  `<ADDITIONAL_METADATA>` block and then a `<USER_SETTINGS_CHANGE>` block.
  A `SYSTEM_MESSAGE` is the fixed "The following is a <SYSTEM_MESSAGE> not
  actually sent by the user…" preamble, then `<SYSTEM_MESSAGE>\n…\n</SYSTEM_MESSAGE>`
  ending the content. All 39 user inputs and 202 system messages in this
  host's 12 logs, and those of the native case on both versions, have
  these forms;
- any tool-group shape the [group rule](#reading-a-tool-group) calls unknown.

No record content can make the projection throw: fields are read as own
keys with their types checked first, and diagnostics coerce no value. Its
entry points are also total: if the projection itself throws, the result
is unknown with the thrown `error` attached, which the unit tests require
to be absent.

A group the log ends inside is in progress when the caller says the owner is
live, and its missing results are interrupted otherwise.

### Windows

A window is a run of records the caller projects. Records outside it are
observed: they update the group state and checks, and produce no messages.
A caller that parses lines itself, for the window, for `observe` or for
the context read backward, must treat a line with `invalidUtf8` as an
unknown log before parsing it: `parseAntigravityLogRecord(line.text)`
cannot tell a real U+FFFD from a replaced byte. `addLine` does this.
Following the [group rule for parts](#reading-a-tool-group), a window that
does not start the file observes the records from the last non-`GENERIC`
record before it, and a window that ends inside a group it projected
observes the following records until the group resolves. With that context,
the windows of a log together produce exactly the whole log's messages; a
test checks this at every record boundary of a generated log with both
interrupted-group shapes.

What the reader must add, because a window's messages are rendered on their
own ([step 4](#serving-cold-history--plan-195-step-4) does each):

- **A call and its result must load together.** The shared client
  projection drops a `tool_result` whose `tool_use` is not in the loaded
  messages, so a page that starts with `GENERIC` records shows nothing for
  them. Keep a group in one page, or carry the pairing context on the
  existing wire.
- **Anchors map to records.** A `:result` ID names its planner step P and
  call *i*; its record is at step P+1+*i*. Other IDs name their record's
  step.
- **Context is bounded.** The look back is at most *k* records when the
  window starts with a `GENERIC`, and *k*+1 when it starts right after a
  group's *k* results, since the rule reads back to the planner whatever
  the first record is. Step 4 starts every page at a record that is not a
  `GENERIC`; such a page's messages do not depend on what precedes it, so
  it reads no context (and does not check what it does not read). A short
  read is never the end of the log: it must not turn a missing result into
  an interrupted one.
- **Checks cover only observed records.** A window sees only its own
  records and its context, so a rewind elsewhere in the file, such as a
  later step 1 after step 100, is not detected by a window that never
  reads it.
- **Child links need verification.** An `invoke_subagent` result is the
  raw text naming the child's `conversationId`. The cold renderer needs a
  verified `agent_id`, so the reader must apply its existing
  lineage-checked enrichment.

Memory for one window is its messages plus what the
[log window](#serving-cold-history--plan-195-step-4) holds.

### Comparison with ACP replay

The census
(`scripts/perf-repro/antigravity-log-census.mjs census`, run from
`packages/server` with `pnpm exec tsx --conditions source`) stages each
conversation into an owned profile as independent regular files: its
database with its WAL and its brain directory, and once the summaries
index with its WAL. Staging refuses any link in those parts of the
source, and the census refuses to start `agy` while anything in the
profile resolves outside it, so no `session/load` can open a source file.
The source's database, WAL and log identities (device, inode, size,
modification time) are compared before and after each copy. A copy that
changed is retried twice and then reported inconclusive. That includes a
file that vanished or was renamed between the check and the copy, such as
a WAL a SQLite checkpoint removed; a failed or changed copy is discarded
before a retry. A conversation whose database or full log is gone when an
attempt starts, or whose full log is not in the staged copy, is reported
inconclusive and the census continues. An error on an unchanged source,
such as a refused link, stops the census. For each
conversation it projects the copy's log and replays the copy through `agy
acp` `session/load` into YA's cold transcript, observing for 500 ms after
the load. It counts the replay's raw tool frames, recognizing a subagent's updates
by the ID its call announced, and YA's normalized results, then compares the projection and transcript after removing the expected differences that
[`antigravity-projection-compare.ts`](../packages/server/test/utils/antigravity-projection-compare.ts)
lists: IDs, tool names (ACP titles), the projection's results, system
messages, checkpoints, errors, timestamps and models, and replay's habit of
joining consecutive user inputs (with nothing between) or the text or
thinking of consecutive steps (with "\n\n") into one message. Its
alignment has a work budget of 25 million table cells after the equal
prefix and suffix; a larger middle is reported as "not compared". It
reports classes and steps, not content.

On 2026-11-22, with `agy` 1.5.13 and separately 1.5.14 replaying this
host's store (12 logs, written by 1.5.13 and 1.5.14) on Node 24.22.1, no
conversation was inconclusive and every log projected as known: 2,105
records and 8,037,744 bytes, each log read once in full, in 0.03 s. Both
binaries gave the same results. What remained:

| Class | Where | Cause |
| --- | --- | --- |
| Thinking and calls only in the projection, and text joined differently around them | `466c3170`, steps 0–299 (66 thinking blocks, 189 calls) | Replay sent those steps' user and assistant text but not their thinking or calls. In the database exactly those steps have `status` 5, where every other finished step has 3 (or 7 for a failed result). What status 5 means is unknown; it is not a checkpoint, the first of which is at step 378. |
| Text, thinking or user input only in replay, and the joins around them | Five conversations, six steps | Steps only in the database. Four are planner steps stopped mid-response (`status` 6, three of them the same scheduling probe's last reply), which replay sends with their partial text. Two are unlogged `ERROR_MESSAGE` steps, which replay sends as assistant text starting "⚠ Individual quota reached". |

Nothing else differed: user text, assistant text, thinking, the order of
calls and every call's input matched.

Cold replay reported each ordinary call once, as a `tool_call` with its
final status: 1,093 calls, 19 of them `failed`. 705 carried `rawOutput`
(475 edits and 230 commands); file reads carried none. There were no
ordinary `tool_call_update` frames, including in the 500 ms after each
load response. YA's cold transcript makes a `tool_result` only from a
`tool_call_update` or a subagent's call, so it held no ordinary
`tool_result` row. Cold history today shows every ordinary call without its
result, although replay sends the output of edits and commands. The
comparison removes results by design, so these counts, not the comparison,
establish it.

YA's own replay check rejected four of the twelve replays ("saved replay
tail did not arrive"), so YA could not open those conversations cold before
[step 4](#serving-cold-history--plan-195-step-4), which opens them from the log:
three whose replay joins a database-only reply to the log's last text, and
one whose last text is a `USER_INPUT`, which the check compares with its
whole wrapped content. See the
[replay completion gap](../gaps/antigravity-acp-replay-completion-signal.md).

[`native-antigravity-log-projection.test.ts`](../packages/server/test/native-provider/native-antigravity-log-projection.test.ts)
runs real `agy` with the scripted model through thinking, text, one call,
two calls in one response, a background command and its wake, a cancel, a
compaction and a last turn. After the owner stops, it requires the
projection and the reader's ACP replay to have no mismatch after the
expected differences, and checks what only the projection has: each call's
result under its step's ID, the `RUNNING` launch, the wake, the cancel's
error and the checkpoint's summary. It passes on 1.5.13 and 1.5.14. The
cancel logged as described in [how far a record
trails](#how-far-a-record-trails-its-acp-event): on 1.5.13 the partial text
`DONE` and an `ERROR_MESSAGE` "The stream was interrupted. Please continue
the task you were working on."; on 1.5.14 the partial text `ERROR` with
`error: "context canceled by user"` and an `ERROR_MESSAGE` "API error
(attempt 1): context canceled by user", so the projection shows two errors.
Replay showed the partial text on both versions and neither error.

### Throughput

`antigravity-log-census.mjs project <log> --repeat 3` streams one log
through the projection. On the 500,072,946-byte generated target (99,990
records, `--interrupted-group-every 30000 --interior-gap-group-every 40000`)
it took 0.54–0.58 s per run on this host with Node 25.8.2: 174,000–186,000
records and 869–930 MB per second, producing 158,641 messages. The process
peaked at 1.3 GB resident because a whole-log projection holds every
message; a page holds only its own. After review round 1 added the UTF-8
and wrapper checks, three runs on Node 24.22.1 took 0.61–0.63 s
(158,000–163,000 records and 792–814 MB per second, the same 158,641
messages) and peaked at 1.9 GB resident. The reviewer's run of 1,935 windows of
at most 256 KiB over the same log produced the same counts at 162 MB peak
resident.

## Serving cold history — plan 195 step 4

[`antigravity-log-window.ts`](../packages/server/src/sessions/antigravity-log-window.ts)
reads one window of `transcript_full.jsonl` for the reader, through
[`antigravity-log-source.ts`](../packages/server/src/sessions/antigravity-log-source.ts);
the [provider contract](antigravity.md#cold-history-from-the-log) owns what
users see. A window:

- **Latest page.** Finds lines backward from the last newline (an
  unterminated tail is not a record) until the requested checkpoint, the
  file's start, or 4 MiB of lines. Once a record that is not a `GENERIC`
  has been found, a line that would not fit is not even found: its search
  stops at the page's remaining bytes, and the page starts at that record.
  Until then (a trailing tool group) lines are found whatever their size.
  A page that shows nothing extends to the one before it.
- **No context.** A page starts at a record that is not a `GENERIC`, so its
  messages do not depend on earlier records and nothing older is read for
  it (and nothing older is checked). An older page observes the records
  after its cursor that resolve a planner's calls or error.
- **Lines, then bodies.** Finding a line keeps its offsets and, for a line
  up to 64 KiB, its bytes while a page's worth is held. Every decision
  (page extent, tool group size) uses offsets and 512-byte heads; a body
  is read when the page shows it and released once decoded. A request
  counts the bytes it holds; the unit tests assert the peak.
- **Line memo.** A line whose start (after a newline or at offset 0) and
  newline are both known is remembered as a line. A range a search found
  free of newlines, such as from a bisection probe's midpoint, is
  remembered only as that, to skip rereading it, never as a line.
- **Cursor.** Finds a message's record by halving the byte range on the
  `{"step_index":N,` prefix every observed record begins with (a record
  without it is unknown), then reading forward below 256 KiB. The older
  page includes the cursor's own record and is cut before the cursor
  message, so every ID form ends a page exactly, including a `:result` and
  a later part of a planner record.
- **Record limit.** A line over 16 MiB is never parsed or held. Its first
  512 bytes must begin `{"step_index":N,"source":…,"type":…,"status":…`
  with a source and status the type allows; anything else is unknown. A
  short `"error"` and `"created_at"` follow in the observed order; an error
  too long for the head (a native `GENERIC:ERROR` had 458 bytes) leaves
  both out, and the placeholder then has no error text or time. The
  [provider contract](antigravity.md#cold-history-from-the-log) says what
  each type becomes. In a tool group whose results together exceed 16 MiB,
  results over 64 KiB are placeholders built from their validated heads
  (a result within the record limit whose head is not in the observed form
  is decoded for it). Both rules depend only on line sizes and build in one
  place (`antigravityPlaceholderRecord`). The only scans are newline
  searches and fixed-size heads, so no work grows faster than a line's
  length.
- **The whole-file helper.** `projectAntigravityLog`, used by the census
  script and as the tests' oracle, is not the complete window: it holds
  each line whole and applies only the record limit, not the group rule. It
  gives the same message IDs, and a group over 16 MiB shows its results in
  full there.
- **Blank lines.** An empty line, at the file's start or anywhere, makes
  the log unknown.
- **Reminders.** A system message whose head already shows a reminder is
  not decoded: it is never shown.
- **Identity.** Opening the file, taking the
  [append-only fence](claude.md#transcript-acquisition-and-retention)
  the Claude and Codex readers use (device, inode, size, and the first and
  last KiB) and reading are one attempt. A file whose identity changed, that
  shrank, vanished, was swapped between opening and the path check, or
  whose probes differ, during any of those, is read again from scratch, up
  to three attempts, then unknown. A path that leaves the store is unknown
  at once. Appends during a read are fine: the window ends at the size it
  opened.
- **Missing.** No file, an empty file or no complete record.
- **What a request costs.** No fixed byte budget: size alone never makes a
  log unknown, because a whole-history replay is the wrong answer to a
  large record. A request reads its page, the search probes and any record
  it must cross, a line over the limit once to find its bounds and then
  only its head. Bytes are counted as they arrive, across attempts. Held
  at once: found line bytes up to about a page (4 MiB of lines up to
  64 KiB), one body being decoded (at most 16 MiB), and a read block of at
  most 1 MiB. Chunks of a line are joined once, when its newline is found.

Measured 2026-11-22 on one macOS arm64 host, Node 24.22.1, on the generated
500 MB target (499,976,470 bytes, 99,990 records, 49 checkpoints,
`--interrupted-group-every 30000 --interior-gap-group-every 40000`), with two
checkpoints requested, after review round 2 (bytes held is the most line
bytes the request held at once):

| Window | Bytes read | Bytes held | Messages | Time |
| --- | ---: | ---: | ---: | ---: |
| Latest page | 5,444,096 | 4,203,597 | 1,247 | 11 ms |
| The page before it | 5,722,420 | 4,005,849 | 1,293 | 11 ms |
| The next older page | 5,679,751 | 4,059,525 | 1,337 | 9 ms |
| Catch-up from the newest message | 675,419 | 14,338 | 7 | 1 ms |
| A cursor its record lacks (a miss) | 5,391,461 | 4,063,658 | 0 | 10 ms |
| The whole log (a complete read) | 500,046,102 | 60,906 | 156,614 | 750 ms |

A page reads about its 4 MiB plus one read block (up to 1 MiB); a cursor
adds about 30 probes of a few kilobytes each. The unit test asserts the
first three rows' bounds on this target. Other measurements and unit
cases, each a few records around a large one:

- The reviewer's group: 26 results of 15 MiB, an interrupted last call and
  a short latest reply. Latest read 5,443,584 bytes and held 131 bytes;
  Load older crossed the group (412,583,821 bytes, 128 ms) holding at most
  1,094 bytes and showed the planner with 26 placeholders. The unit case
  uses 1 MiB results with a short subagent result, which keeps its child
  link.
- A 12 MiB reply before a short final reply: the final reply's page, then
  the 12 MiB reply in full from Load older's cursor, which read under
  28 MiB (the search crossed the line once, showing it read it again).
- A 24 MiB reply: a cursor in the short reply before it pages normally; the
  24 MiB reply is a placeholder.
- A 34 MiB reply: `beforeMessageId` on the reply after it returns the
  placeholder, and an `after` read crossing it is known.
- A 17 MiB reply of escaped newlines: paged in milliseconds (the earlier
  JSON scanner took 71 s).
- 400 hidden reminders of 90 KiB (35 MiB) after a prompt: the latest page
  is the prompt, reading under 40 MiB, each byte about once.
- The reviewer's retry case (a 33 MiB record, the head changed after every
  attempt): 16,330,752 bytes over three attempts and an 82 MiB resident
  peak (208 MB and 162 MiB in round 1); unchanged, 5,443,584 bytes.

All 12 logs in this host's store read as known. Paging backward with two
checkpoints a page gave exactly each whole-log projection, including the
four conversations YA's replay check refused (`0e5ebad0`, `15572d7f`,
`e6f567af`, `940db741`), which now open from the log. A latest page there
read 4.8 KB to 2.2 MB.

The real-`agy` [native case](../packages/server/test/native-provider/native-antigravity-log-projection.test.ts)
views its stopped conversation (latest page, older page, hover excerpt,
child mappings and a full read) and checks that no `agy` starts and that
every file in the store keeps its size, modification time and SHA-256, with
one exception: YA's read-only open of the summaries index creates the empty
`-wal` and the `-shm` that SQLite needs when `agy` has removed them. That
predates step 4 and every listing does it
([gap](../gaps/antigravity-summaries-read-creates-sqlite-sidecars.md)).

### Write order and refresh

YA's watcher observes each conversation's database and WAL and the
summaries index, not the brain log, while cold history now comes from the
log. A scratch native run (real `agy` 1.5.13 and 1.5.14, the scripted
model, one tool call then a reply, file stats sampled every 1 ms; not
committed) is one workload per version, so it shows sampled timing, not
write order for every turn. On 1.5.13 the last log change (127.3 ms)
came 0.1 ms after the last foreground WAL change, and the next database
change was at stop, about 1.5 s later. On 1.5.14 the first log change
(110.3 ms) came 4.1 ms before the next WAL change. In both samples the log
was complete before a refresh that the watcher's 200 ms debounce would run
after a nearby WAL event. On stop, `agy` wrote the database (393,216 →
425,984 bytes), emptied and removed the WAL, and wrote the summaries index.
The samples do not show that a browser received the refresh, and an
earlier observation of a stale page on a shared server is still
unexplained. A log append with no later database write would not be
observed
([gap](../gaps/antigravity-log-only-append-not-observed.md)).

## Resuming from the log — plan 195 step 5

Resume reads the log's latest page (back to two checkpoints or 4 MiB, as a
viewer's first read). When it is known, YA calls `session/resume`, then
reads the latest page again and records its last complete record, step and
byte end, as the owner's resume point (the first read's when the second
is not known). Windows for that owner pass the resume point: the window
ends at its byte offset, and the record just before that offset, which
must end in a newline, must carry that `step_index`, or the log is
unknown. Records `agy` appends after it (the resumed owner's own turns)
are not read for that owner's view.

Observed with real `agy` 1.5.13 and 1.5.14 and the scripted model (the
cold-resume and model-selection cases in
[`native-lifecycle.test.ts`](../packages/server/test/native-provider/native-lifecycle.test.ts)):
`session/resume` answered with the configuration options a load returns,
so the selected model and effort were applied as before; the next model
request held the prior turns and the tool result; no `session/load` was
sent; and while the resumed owner lived, a complete read showed the turn
before the resume point and the resumed prompt and reply once each. The
step 2 measurements of `session/resume` (no history streamed, the log and
database unchanged, the summaries index's time changed) still apply; a
resume therefore still produces a summaries-index change notification.

The resume point records the boundary record's step, the offsets where
its line starts and ends, and the file's device and inode. A window with a
resume point checks, at those fixed offsets: the device and inode, that the
file is at least as long as the end, that the byte before the end and the
byte before the start are newlines, and that the line begins with the same
bytes it began with when the point was taken (at most 40; since plan 195
step 6, so a record in a parseable but noncanonical encoding, accepted when
the point was taken, is checked by its own bytes rather than refused for
lacking the canonical `{"step_index":<step>,` prefix). That costs the same whatever
the record's size: in review, a live-row catch-up behind a 3.2 MB final
record read 3,435,560 bytes before this check was bounded; the unit test
now bounds it to the title's fixed 256 KiB read of the file's start plus a
few KiB. The append fence for that read probes the file's first KiB and the
KiB ending at the resume point, so the window reads no byte after the
offset (it only stats the file's size) and a change after the offset never
makes it unknown. In review, a 96 MiB unterminated record appended after
the resume point raised a latest page from 7,528 to 100,670,824 bytes read
before the window stopped looking for the file's physical end; it now
costs the same with or without it. A same-width in-place edit of an earlier
record is not detected, nor is a same-inode rewrite that keeps the
boundary line's first bytes and offsets (the step 5 review replaced one
record with two of the same total length): general in-place rewrite
detection belongs to plan 195 step 7.

**Never-prompted conversations.** The step 5 review measured an empty
conversation (created, never prompted, no log) on 1.5.13 and 1.5.14, two
samples per version: `session/load` took 136–140 ms and `session/resume`
33–48 ms, neither streaming history. After either, the summaries index
row had `step_count = 0` and the sentinel `last_modified_time`; a prompted
fixture had `step_count = 2`. YA does not read `step_count`. It is a
possible later way to resume a conversation with no log through
`session/resume` instead of the fallback, if a zero proves reliable across
stale rows and crash recovery. Not implemented.

## Live memory — plan 195 step 6

A live owner's in-memory rows hold only what the log does not serve yet;
the [provider contract](antigravity.md#live-memory) states the rules. They
rest on when `agy` writes a turn's records, measured 2026-11-23 with
[`antigravity-turn-end-probe.mjs`](../scripts/perf-repro/antigravity-turn-end-probe.mjs)
(run from `packages/server`, same profile and scripted model as the step 2
probe):

```bash
pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-turn-end-probe.mjs [--agy <path>] [--out <report.json>]
```

Two runs each on `agy` 1.5.13 (the pin) and 1.5.14, Node 24.22.1, one macOS
arm64 host. The delay is from the turn's end (the prompt's result, or for
a detached reply its last ACP update) to the first observation of its last
record, polling every millisecond; negative means before.

| Turn | Records it wrote | Last record |
| --- | --- | ---: |
| Plain reply | `USER_INPUT`, `PLANNER_RESPONSE` | −1 to 0 ms |
| Three calls in two responses, then a reply | `USER_INPUT`, planner, two results, planner, result, planner | −8 to −4 ms |
| A second prompt sent while the reply streamed (steer) | `USER_INPUT`, planner, `USER_INPUT` (the steer), planner | −2 to −1 ms |
| Stop (`session/cancel`) while the reply streamed | `USER_INPUT`, reminder, planner, `ERROR_MESSAGE` | −7 to −4 ms |
| `/compact keep the probe markers` | `USER_INPUT` (`/compact keep the probe markers`), `CHECKPOINT`, planner | −1 ms |
| A background command, then a reply | `USER_INPUT`, planner, result, planner | −4 to −3 ms |
| That command's wake | the task-end `SYSTEM_MESSAGE` +515 to +527 ms after the previous result; the wake's planner +6 to +11 ms after its last ACP update | — |
| A detached `invoke_subagent` | the parent's records by −1 ms; its wake on the child's report (two `SYSTEM_MESSAGE`s, a planner) +12 to +18 ms after the result | — |

So, on both versions:

- Every record of a foreground turn was in the log by its prompt's result,
  including a steered, stopped, tool-heavy or compacting one. Records after
  a result belong to new steps (a wake, a child's report), each with its
  own records.
- Each prompt, each steer and each `/compact` left exactly one
  `USER_INPUT`, in the order sent, whose request text is the text sent.
- A stopped turn here logged its partial reply and an `ERROR_MESSAGE`. A
  1.5.14 owner stopped by ending its process logs nothing for the reply in
  progress ([step 2](#how-far-a-record-trails-its-acp-event)), but then the
  owner is gone.

The owner reads only what follows its boundary
(`readAntigravityLogTail`): each record's step, type and offsets, a user
input's text and a planner's call count, with the same file identity,
fixed-offset boundary check, increasing steps and append-only fence as a
window, and at most 64 MiB, so its cost is the records it evicts. At a
turn's or command's result it moves the boundary to the log's last record
when every expected `USER_INPUT` is present and that record ends a turn;
otherwise it waits for the next turn's `USER_INPUT`, which proves every
earlier step final because steps only increase. The measurements make the
first case the ordinary one; the second needs no timing. It keeps a copy of
the turn it moved last, for catch-ups from clients that streamed it.

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
| [Log window](../packages/server/src/sessions/antigravity-log-window.ts) | `transcript_full.jsonl` | Cold history: pages, catch-up, children's and complete reads ([step 4](#serving-cold-history--plan-195-step-4)). |
| `readAntigravityResumePoint` (log window) | `transcript_full.jsonl` | Whether a resume can use `session/resume`, and its resume point: the latest page must read as known, and its last record is the boundary ([step 5](#resuming-from-the-log--plan-195-step-5)). |
| [`readAntigravityLogTail`](../packages/server/src/sessions/antigravity-log-tail.ts) | `transcript_full.jsonl` | A live owner's records after its boundary, to move the boundary once the log holds a turn ([step 6](#live-memory--plan-195-step-6)). |
| `readAntigravityReplayTail` | `transcript_full.jsonl`, else `transcript.jsonl` | The saved text a fallback replay, or a fallback resume, must reach. |
| `readAntigravityTurnBoundary`, `readAntigravityTranscriptPosition` | `transcript.jsonl` | The step and file position before a prompt. |
| `readAntigravitySubagentLaunches`, `readAntigravityTurnSubagentLaunches` | `transcript.jsonl` | Pairing `invoke_subagent` calls with child IDs. |
| [Compaction check](../packages/server/src/sdk/providers/antigravity-compaction.ts) | `transcript.jsonl` | A new completed `CHECKPOINT` confirms `/compact`. |
| [Log projection](../packages/server/src/sessions/antigravity-log-projection.ts) | `transcript_full.jsonl`, from the log window | Messages from records ([step 3](#projection--plan-195-step-3)). |

The other named log readers are in
[`antigravity-subagent-links.ts`](../packages/server/src/sessions/antigravity-subagent-links.ts)
and each read is bounded to 4 MiB. The projection reads nothing itself.
Cold history, root and child, comes from the log. A live session, new or
resumed from the log, is the log through its owner's boundary and the
owner's in-memory rows the log does not serve yet; one resumed through the
fallback is its owner's projection. ACP `session/load` replay runs only
when a log is missing or unknown, as [identity and history](antigravity.md#identity-and-history)
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
- Whether `agy` ever leaves a missing result step inside a group rather
  than at its end. None was seen.
- What `agy` writes between the snapshot moments of a load or resume.
- Why two `ERROR_MESSAGE` steps on this host were not logged, when a cancel's
  is.
- Whether a load beside a live owner writes the conversation's files.
- What `presence/<id>.lock` means. The one file observed was empty and
  dated 2026-11-03, although conversations had run since.
- What the full-text index's step byte offsets address.
- What database `status` 5 means, and why ACP replay omits the thinking and
  calls of those steps but keeps their text.

The [large-history gap](../gaps/antigravity-large-history-and-replay-ownership.md)
is the reason these matter: it asks whether the log can serve a bounded,
read-only view of a root conversation.
