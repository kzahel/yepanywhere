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
inference the one `agy` continues from. ACP `session/load` can rewrite the
conversation's files, which is why YA never runs a load beside a live owner.
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

The `step_type` column is inferred from equal counts and matching positions,
not from decoding.

- **Order.** `step_index` equals the database `idx` and strictly increases
  through the file.
- **Coverage.** The database has 1,272 steps and the log has 1,271 records.
  The one step missing from the log is the only step of its `step_type` (17).
  What it is remains unknown.
- **Tools.** A `tool_calls` entry is `{name, args}` with no call ID. The
  records after a `PLANNER_RESPONSE` with *k* tool calls are *k* `GENERIC`
  records, one result per call in order. This held for all 297 such planner
  records, 778 calls in total. Argument values are strings, integers and
  booleans.
- **Results.** A result is rendered text that starts with `Created At:` and
  `Completed At:` lines. Its `status` is `DONE`, `ERROR` or `RUNNING`. The 55
  `RUNNING` records are launches of background tasks; the log does not
  rewrite them when the task ends.
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

Not measured: how long after an ACP event its record reaches the log, and
whether `session/load` or `session/resume` rewrites an existing log.

### What the log has and lacks against ACP replay

| | Brain log | ACP `session/load` replay |
| --- | --- | --- |
| Supported interface | No | Yes |
| Read without side effects | Yes | No: it can rewrite continuation files |
| Cost of the latest page | The tail of a file | The whole conversation |
| Compaction boundaries | `CHECKPOINT` records | Omitted |
| Per-step time, model, token counts | Yes | Not compared |
| Tool call ID, ACP kind, locations | No | Yes |
| Tool results | Rendered text | ACP content blocks |

## Runtime identity

ACP `initialize` reports `agentInfo.version` equal to `agy --version`:
`1.5.13` from the pinned Linux arm64 build and `1.5.14` on macOS arm64, both
observed 2026-11-22. YA's [version floor](antigravity.md#supported-runtime)
reads it. The same 1.5.13 build, on Ubuntu 24.04 with no `nobody` group,
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
  `<sessionId>:<plannerStep>`, and a permission prompt's ID is random. If
  that holds in YA's store, a live tool call can be tied to its log record.
  YA has not verified it.
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

- How the log behaves on a history of hundreds of megabytes.
- Whether `step_index` stays strictly increasing after an undo or rewind.
- What the unlogged step type is, and whether other types are skipped.
- How far the log trails ACP events during a turn.
- Whether `session/load` or `session/resume` touches an existing log.
- What `presence/<id>.lock` means. The one file observed was empty and
  dated 2026-11-03, although conversations had run since.
- What the full-text index's step byte offsets address.

The [large-history gap](../gaps/antigravity-large-history-and-replay-ownership.md)
is the reason these matter: it asks whether the log can serve a bounded,
read-only view of a root conversation.
