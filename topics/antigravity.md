# Antigravity provider

Status: **experimental and listed by default when installed.** Basic foreground
work is usable. Patient delivery, detached work and scheduled backend reload
still have reproduced correctness gaps. The primary integration
runs Google's `agy acp` against the user's native login and store. Legacy Gemini
history retains its original provider and identity.

## Support status — 2026-11-22

Evidence below is from YA `eb520d058`. The
[scripted native test target](native-provider-testing.md) is `agy` 1.5.13.
Live Gemini 3.8 Flash Low probes used `agy` 1.5.14 on macOS arm64. Linux has
scripted native coverage. Windows execution remains unavailable pending native
child-tree teardown qualification. YA runs `agy` 1.5.13 or later only; see
[supported runtime](#supported-runtime).

| Surface | Current support and limits |
| --- | --- |
| Foreground delivery | Direct text, real tools, ordinary deferred queueing, cancellation, and cold continuation of short test sessions have native coverage. Steer sends a second native prompt for the next model boundary. YA waits for all submitted foreground prompts to return. |
| Patient delivery | YA saves patient intent durably and waits through retained native work and its root wake. The item's quiet interval starts at verified idle. An ordinary deferred message can deliver at the foreground turn boundary. [YA delivery rules](message-control-steer-queue-btw-later-interrupt.md#delivery-intent-behavior-matrix) · [Overlapping wakes](../gaps/antigravity-overlapping-wake-inbox.md) |
| Detached work | Known shell tasks, schedules and native subagents appear in live work state. An unsettled root wake retains its owner across the last task ending and the root generating a reply. Metadata and the session stream report its activity. [Provider settlement evidence](provider-wait-and-background-work.md#recorded-work) |
| Cold history and resume | Cold history comes from `agy`'s brain log a page at a time, starting no `agy` and writing nothing but [SQLite's sidecars for the summaries index](../gaps/antigravity-summaries-read-creates-sqlite-sidecars.md); see [cold history from the log](#cold-history-from-the-log). Resume uses ACP `session/resume`, which replays nothing: the resumed session's view is the log through its resume point plus the owner's own rows ([resume](#resume-and-the-live-view)). A live session keeps a bounded recent window in memory and the log serves the rest, so it runs however long it lasts ([live memory](#live-memory)). ACP `session/load` replay is the fallback for a missing or unknown log, for viewing and for resume; it keeps collecting ACP history after an early load response until it observes the persisted text tail, and a missing expected tail fails the operation. |
| Backend reload | `agy` is backend-local. Scheduled reload waits for retained work and checks blockers again at the wrapper handoff. Immediate restart can interrupt the session and records it in the shutdown log. [Reload contract](reload-safe-provider-runtimes.md#reload-ux-and-compatibility) |
| Other controls | Model and effort changes and advertised `/compact` are implemented. A verified native checkpoint gates delivery of messages queued after compaction. Permission prompts reach the approval handler in default and accept-edits sessions. Real `agy` cases cover Allow, Deny and Stop for the tested `write_file` and `run_command` calls, and each offered mode. Inline images/documents, rewind and fork remain unavailable. |

The [native lifecycle tests](../packages/server/test/native-app/app-antigravity-gap-repros.test.ts)
use real `agy` with a scripted model. They cover idle reap and scheduled
reload during detached replies, patient delivery after settlement, and late
foreground admission at the wrapper handoff. One scenario follows a wake
through patient delivery, safe reload, and reopening the final history. The
long native cold replay qualification uses a saved session. The
[upgrade checks](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
can run with an explicitly selected `agy` version. They check wire order in a
short native replay. A controlled ACP peer verifies that YA handles a final
frame held until after the load response, rejects a truncated stream and
retries without serving a stale cache entry.

## Installation selection

The shared [CLI installation selector](provider-cli-installations.md) can persist
an explicit Antigravity path on the target server/profile. `ANTIGRAVITY_ACP_PATH`
remains authoritative. Every candidate launches as `agy acp`; removed
executables and changed symlink targets are observed on each resolution. A
candidate whose `agy --version` is below the
[supported floor](#supported-runtime) shows that version beside an error naming
the floor and the update path. Auto marks the `agy` that a launch actually
runs, the first runnable one on `PATH`, even when it is below the floor; select
another installation explicitly to use it.
Offline execution verification is currently unsupported and is reported as such,
separately from authentication or an execution failure. No Windows support or new
provider authentication/update mechanism is introduced by the selector.

## Native installation and authentication

Install Google's `agy` CLI and sign in with it. Its ACP server (`agy acp`)
reuses the CLI's saved login and its `antigravity-cli` store. YA finds `agy` on
`PATH`; `ANTIGRAVITY_ACP_PATH` names an executable explicitly, and YA launches
whatever it names as `agy acp`. An explicit path never falls back to another
installation. YA launches the resolved target of an executable symlink. YA does
not download, update or reconfigure the runtime.

### Supported runtime

YA runs `agy` 1.5.13 or later, the [native test pin](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
(`ANTIGRAVITY_MIN_VERSION`). The version comes from the `agentInfo.version`
that ACP `initialize` reports, so a runtime that answers costs no extra
process. The whole value must be a valid Semantic Versioning 2.0.0 version:
no leading zeros, and non-empty dot-separated prerelease and build
identifiers. A prerelease ranks below its release, so `1.5.13-rc.1` is
refused. A missing value, a null or absent `initialize` result, a malformed
version, or one that merely contains a version, is refused rather than
assumed current.

An `agy` before 1.5 has no `acp` subcommand. When no ACP peer answers
`initialize` (the process exits, writes something other than the protocol, or
reaches the 30-second initialize timeout), YA runs `agy --version` once. That
probe gets YA's provider environment without YA's own credentials, has three
seconds, and is killed with its process group on its deadline or when the
owner stops the runtime; YA waits for it to exit either way. YA signals the
group only while its id is anchored: on deadline or stop while the command is
still running, and once as the command's exit is handled, so same-group
helpers die whether or not they hold its output. After that YA sends no
signal; a deadline or stop then only releases the pipe. A helper that started
its own session has left the group and is not stopped by YA. A whole version
below the floor gets the same refusal. Any other answer leaves the native
failure as the error. A runtime that does answer `initialize`, including with
an ACP error, is never probed, so its own error is kept.

The refusal names the installed version, the required version and the update
path, for example: "Antigravity requires agy 1.5.13 or later; the installed
runtime reports version 1.4.5. Run \`agy update\`, or install the agy CLI."

- **Provider status** reports the runtime unavailable rather than signed out.
  The refusal is the model catalog's error, Provider Settings shows it under
  the unavailable runtime, and the CLI installation list shows the
  candidate's version with the same text. Status and a forced catalog refresh
  read in the same request describe the same runtime.
- **A saved creation**, from the app or the v0 API, is refused before its
  provider starts. The creation records the known failure
  `startup-unavailable`, delivery `not-admitted`, and the refusal as its
  `failureDetail`, which the startup notice shows beside the saved prompt.
  The v0 receipt is `failed` with `failure.code: "startup-unavailable"` and
  the refusal as its message. Nothing reaches the runtime beyond `initialize`.
- **A resumed or reactivated session** ends with the refusal as its error,
  once `initialize` has answered or the version probe has run, and before any
  session is loaded or prompted.
- **History reads** that need ACP fail with the refusal.

YA dropped the standalone ACP 1.4.x distribution (`agy_acp_server.par`) and
its `antigravity-acp` store. Conversations that exist only in that store are no
longer listed or resumable; their native files are left untouched. Both
decisions are recorded in [plan 195](../docs/tactical/195-antigravity-native-history.md#decisions).

This is one integration interface for Antigravity, not a separate model or
subscription. Google's `agy` terminal CLI also
offers [headless stream-JSON input/output](https://antigravity.google/docs/cli/headless/).
A 2026-11-03 bounded CLI probe successfully reused the CLI's saved login with
`agy -p ... --output-format stream-json`; it did not authenticate again. Direct
CLI integration therefore remains an alternative to ACP, but the YA provider
implemented here still uses ACP. CLI permission round-trips, cancellation,
history and continuation have not been qualified as a replacement adapter.

Sign in through the `agy` CLI or another official Google client. YA starts the runtime with its existing environment, native
`GEMINI_HOME` and settings. Google owns credential storage and refresh. YA never
reads tokens, calls `authenticate` or `logout`, forwards an OAuth callback,
switches accounts, or selects an API-billed method. A missing login fails with
the native error; it does not start YA-managed sign-in.

For an explicitly configured `CLOUD_CODE_URL`, YA passes a configured
`GEMINI_HOME` to `agy acp` as `--gemini-dir` so the runtime and YA's history
reader use the same profile. See the experimental
[AAR Antigravity bridge](https://github.com/kzahel/agent-auth-router/blob/main/docs/antigravity.md)
for the manual subscription gateway setup.

On 2026-11-13, `agy acp` 1.5.8 reused the CLI's login with no further
sign-in. The ACP runtime saved its own `auth.type=oauth-personal` setting;
subsequent native creation and replay reused that saved login without another
auth call. Do not infer ACP readiness from a
successful `agy models` invocation or the old Gemini credential file.

Google's [ACP changelog](https://antigravity.google/docs/changelog) mentions
custom clients, while its [consumer FAQ](https://antigravity.google/docs/faq/)
restricts third-party access. YA identifies itself as `yepanywhere`; it never
impersonates an allowlisted editor or promises models available to that editor.
Account access remains Google's decision.

## Vanilla execution

The provider is listed by default, reports itself not installed without a
runtime or with one below the [supported floor](#supported-runtime), and is hidden by an `ENABLED_PROVIDERS` allow-list that omits it, like
every other provider. Session lists always include its native source, whose
retained-catalog project filter decides membership without starting `agy`. Existing
clients use the normal provider discovery and session routes; older servers
never advertise it, so updated clients send no new unsupported action. No
released capability is broadened and no new route or wire format is required.

The runtime owns tools, permissions, native configuration and session files.
YA sends ordinary text verbatim, adds no context prefix, advertises no client
filesystem/terminal tools and performs no model substitution. The native default
stays selected unless the operator explicitly chooses a model. The dynamic
catalog is the actual account's `session/new` response, not the CLI's catalog
or a static list. When `agy` returns structured ACP `configOptions` for `model` and
`thought_level`, YA projects the base models with per-model supported thinking
levels derived from the paired `availableModels` entries while keeping the
`default` sentinel as the default selection so untouched launches preserve the
runtime's own default model. Separate model and effort controls offer `Auto`
(restoring the level observed before a YA override) and `On` with the model's offered
levels, omitting thinking controls for fixed-effort models; explicit `off` from
API or older callers maps to the lowest offered level because `agy` has no
disabled thinking level. A setup without a `model` config option offers only
the runtime's default, and a request for any other model fails. The v0.12.0
and v0.13.0 server catalogs omit
structured Antigravity effort metadata. Current clients keep those flat
catalogs usable and omit thinking overrides for them. Both startup, resume,
and live mid-session
`setModel` / `setEffort` apply changes in place via `session/set_config_option`,
without restarting the runtime.
In-flight replies remain attributed to the model active when the turn started.
Combined changes hold input and publish the new configuration only after both
settings apply. If restoration fails, queued input waits until a configuration
request successfully reapplies the desired pair.
Legacy effort-suffixed model IDs remain accepted: when no explicit effort is
supplied, YA syncs the embedded effort into session state and persisted launch
settings; when an explicit effort is also supplied, the explicit effort takes
precedence. If catalog discovery is unavailable during launch, the saved ID
stays intact and the native session applies it using its own catalog.
Requesting an explicit thinking level on a model that does not offer
one fails explicitly before mutating active session state. A coalesced, short-lived
blank probe checks readiness without sending a model prompt, then removes only
its proven scratch session files.

YA default, accept-edits and auto select the native `default`, `accept-edits`
and `auto` modes. A requested mode the runtime does not offer fails the start.
Over ACP, `agy` 1.5.13 and 1.5.14 offer `default`, `accept-edits` and `plan`
(observed 2026-11-22), so auto currently fails. `agy` offers no bypass mode, so
bypass-permissions launches that session's server with
`--dangerously-skip-permissions` and keeps the native `default` mode. YA's Plan permission mode is refused; use native `/plan`.
Permission replies use the actual offered option IDs and never promote Allow
once to Allow always. Native fixed-choice questions require an offered answer.
Missing handlers and interrupted requests cancel.

Permission requests ([owner](../packages/server/src/sdk/providers/antigravity-permission-requests.ts)):

- **IDs and frames.** A request is recognized whatever its JSON-RPC ID
  type (`agy` 1.5.13 and 1.5.14 send strings), and its answer echoes that ID
  unchanged. Each request gets exactly one answer.
  - A response answers a call only if it has no `method`, one of YA's
    numeric IDs, and exactly one of a `result` or a valid JSON-RPC
    `error`. The exception is an `initialize` reply with neither, which is
    refused for its missing version.
  - These get an error and open no prompt: a frame that is not JSON-RPC
    2.0, a non-string method, a request YA does not serve (including a
    `session/update` that carries an ID), and a permission request without
    a session, a tool call ID or options.
- **Ownership.** One `agy` connection is one YA session, and a request
  belongs to its tool call.
  - Terminal evidence for the call (a `tool_call` or `tool_call_update` that
    is completed, failed or cancelled) withdraws its request.
  - Stop (`session/cancel`) answers every waiting request on the connection
    as cancelled and withdraws its prompt, including one naming a child
    conversation. It also marks the tool calls then running as cancelled. A
    later request for one of them, such as a delayed frame from a stopped
    turn or wake, is answered cancelled without a prompt. A request for a
    tool call first seen after Stop is new work and asks.
  - YA's session goes idle when it handles a turn's or a provider command's
    (such as queued `/compact`) result, so a request raised while a YA
    prompt ran and still waiting is withdrawn just before that result.
  - A request arriving after the last prompt has answered, such as a wake
    in the same write, is held. It is asked once YA reports it is idle, or
    when YA sends its next prompt, so it is visible. Both the foreground
    turn and provider commands use that one release point.
  - The running tool calls that Stop marks cancelled are remembered up to
    256, the oldest forgotten first. A delayed request for a forgotten call,
    or for a call already reported terminal, is treated as new work.
  - A withdrawn prompt's late answer is refused and does not move the
    session back in-turn.
  - From Stop until the cancelled prompt returns, nothing is steered in:
    `agy` refuses a prompt while it cancels one, so input sent then waits
    in YA's queue and is delivered afterwards.
  - Native permission requests from a child conversation have not been
    observed ([gap](../gaps/antigravity-child-permission-routing-unqualified.md)).
- **Limits.** At most 32 requests wait at once; more are answered
  cancelled. If two pending requests share an ID, the first is withdrawn and
  the ID gets one error answer. When the connection ends, intake closes and
  every waiting prompt is withdrawn, including for a frame flushed during
  shutdown.
- **Observed tool calls** (real `agy` with a scripted model):
  - in default mode, a scripted `write_file` and `run_command` asked;
  - in accept-edits, a `write_file` ran without asking and a `run_command`
    asked;
  - with bypass, neither asked;
  - after Allow of `write_file`, the file was written and the turn
    continued;
  - after Deny, nothing was written, YA showed an error result, and `agy`
    ended the turn without asking the model again; the next message
    started a new turn;
  - Stop while a `write_file` waited withdrew the prompt and wrote nothing.
    A message sent right after Stop was delivered once the cancelled prompt
    returned.

Stop requests native `session/cancel`; hard abort closes the owned process
group and waits for exit.

Initial support covers text and file references. Inline image/document blocks
fail explicitly rather than being discarded. Steer sends a second native prompt
to the active session. `agy` applies it at its next model boundary, and YA
keeps the turn open until all submitted prompts settle. The composer
lists native commands as the runtime advertises them, including `/plan`.

When the current session advertises `/compact`, YA supports manual and queued
compaction with optional focus instructions. The queue advances only after
the native command returns and a new completed checkpoint appears in the
native transcript. A missing checkpoint fails the command. An unreadable
outcome stays unconfirmed. Both hold later input under the existing
[queued compaction rules](../docs/tactical/173-queued-compact-delivery.md).
The live session shows a compaction boundary for a verified command, and
cold history shows every checkpoint in the log. ACP replay, the fallback, does
not supply checkpoint boundaries.

Known active root-session shell commands, schedules, and `invoke_subagent`
children appear in the shared
[background-work view](provider-wait-and-background-work.md). Non-daemon
work that outlives the foreground turn retains the native owner until its
terminal tool event (or, for subagents, until `conversation_summaries.db`
reports the child settled as idle/killed — with a bounded provisional grace
window while `agy` asynchronously flushes a freshly launched child row —
checked at turn settlement, passive updates, and retention queries with no
polling timer). Detached output appears
in the same conversation, including replies to scheduled wakes and subagent
completions. ACP does not guarantee a result notification for those replies. YA
displays them as background output, with steering and verified turn completion
available on submitted prompts.

The v0 API supports direct model discovery, creation, conversation following,
steering, background state, queued compaction and verified Stop using the
existing authority and receipt contracts. Eligible bypass-permissions CLI
launches receive their own private v0 connection when Agent API discovery is
enabled. See [HTTP API v0](http-api-v0.md#local-agent-bootstrap).
The shared subscription usage surface can show quota buckets from the CLI
status line on supported hosts. Rewind, fork and general YA instruction
injection remain outside the current provider scope.
Native skills, hooks, MCP configuration and provider-created workspace files
remain Google's behavior; YA creates no project-local cache or Git exclusions.
Native-only projects now join the shared retained catalog and project list;
Claude history is not required. External-process detection and focused native
history observation remain unqualified.

## Identity and history

The existing YA admission owner retains the public session identity. The
provider-native UUID is a continuation address under the runtime's canonical
store, `antigravity-cli/conversations` in the `--gemini-dir` YA passes or else
`~/.gemini`. Resume
validates the original store, physical database and project before native
effects. Rejected native resume never falls back to `session/new` or replays
queued input into another conversation.

History comes from native file facts and `agy`'s brain log, with ACP
`session/load` only as a fallback, and no YA shadow transcript or protobuf
decoder. Resume uses ACP `session/resume` when the log is readable, so a
resumed session's earlier history is read from the log as well. Session summaries take their title from the summaries index, or
for an untitled row from the log's first prompt, and start no `agy` (before
plan 195 step 4 they asked ACP `session/list`).
[Native storage](antigravity-native-storage.md) describes each file `agy`
writes and the brain log's record format. `agy` records each conversation's
workspace URIs, title and subagent lineage (`parent_conversation_id`,
`agent_name`, `nesting_depth`) in its `conversation_summaries.db` index; a
conversation without a workspace there is not listed. YA reads only those bounded summary
columns, read-only, rejecting out-of-store symlinks on the database and its
SQLite sidecars. Conversations with a non-empty `parent_conversation_id` are
excluded from top-level catalog scans, `listSessions`, `getSessionSummary` and
`getSession` before any ACP subprocess starts, keeping provider-managed
subagents out of top-level session lists even when their `<uuid>.db` files sit
inside `conversations/`. Durable child relationships flow through the shared
`ProviderChildRelationshipService` via `AntigravitySessionReader.getProviderChildSource`
using bounded read-only `conversation_summaries.db` snapshots; a missing
summaries index stays unknown rather than publishing an authoritative empty set, and running subagents whose
`last_modified_time` is the `0001-01-01` sentinel fall back to local `.db`/`.db-wal`
file mtimes and in-memory activity overlays without churning durable SQL edges.
Authorized descendant transcript reads serve children from their own brain
log's latest page ([children](#cold-history-from-the-log)); a running
child's log lacks the step in progress, and its missing log is an empty
transcript. Only a settled child whose log is missing or unknown replays
through `session/load`, after revalidating project-eligible lineage; a
running child never does. When several workspace URIs are listed
(`/private/tmp/x`, `/tmp/x`), the last is the cwd the client supplied and
matches YA's project binding. Reading never sends a prompt or auth request.
Unknown/foreign project files are not adopted. Around a native load or
resume of a stopped conversation, snapshots found its database content and
brain log unchanged, but `agy` adds temporary database sidecars and writes
store-wide files, including the summaries index
([measured](antigravity-native-storage.md#what-load-and-resume-write)). The `agy` 1.5.13 ACP stream and replay
report file-read tool identity, location and status, while the file contents
stay in native model context.

### Cold history from the log

Plan 195 step 4. The reader projects `brain/<id>/.system_generated/logs/transcript_full.jsonl`
([projection](antigravity-native-storage.md#projection--plan-195-step-3),
[windows](antigravity-native-storage.md#serving-cold-history--plan-195-step-4)).
It never reads the shortened `transcript.jsonl`.

- **Pages.** The detail route's compact-tail read returns the newest records
  back to the requested number of checkpoints, or about 4 MiB of records,
  whichever comes first. An older page ends before its cursor message. A
  page holds whole records and starts at one that is not a tool result, so
  a call and its results load together. A page whose records show nothing
  (only reminders) extends to the page before it. Older pages report
  `hasOlderMessages` with their first message as the cursor, as other
  providers' pages do. A catch-up from a durable overlay's ID (a recap,
  local-command or synthetic-done row) reads the latest page too; an
  overlay older than that page is a missed anchor, answered like any other
  with the page as a replacement window and its older-page cursor.
- **Whole-log reads** happen only when a caller asks for complete history:
  a detail read with `fullHistory=1` (including the saved full-history
  preference and opt-in aside polling and hydration),
  public-share capture, restart and handoff sources, the maintenance
  comparison and opt-in instruction restoration.
- **Message IDs** come from step indexes: `<id>:step-<n>` with `:thinking`,
  `:text`, `:error`, or a call's `:tool-<i>:call` and `:tool-<i>:result`. A
  page has the same IDs however it was reached. `beforeMessageId` and
  `afterMessageId` accept each form; a `:result` names the record at step
  P+1+*i* of planner P's call *i*. An ID from before this change (positional
  `<id>:<n>`, or an ACP tool call ID) misses cleanly: an older page is empty
  and reports no older history, and a catch-up gets the latest page as a
  replacement window. A catch-up further back than one page does the same.
- **Large records.** A record larger than 16 MiB is never parsed or held:
  its first 512 bytes must begin with the observed leading keys
  (`step_index`, `source`, `type`, `status`), or the log is unknown, and it
  is shown from that head alone; an `error` too long for the head leaves
  the row without its error text and time. A result becomes a placeholder in its step's slot; a planner
  response becomes an assistant row "too large to show" whose calls are
  unknown, so the results after it are covered by it and not shown; any
  other record becomes a row of its kind with that notice (a checkpoint
  stays a compaction boundary; a reminder stays hidden). In a tool group
  whose results together exceed 16 MiB, each result over 64 KiB is a
  placeholder from its head, and smaller ones, such as a subagent's result
  with its child link, are read normally. The rules depend only on line
  sizes, the complete read and every page apply them alike, and
  everything before and after stays reachable by paging. Size never makes
  a log unknown or starts a fallback.
- **Clipped prompts.** `agy` logs a prompt whose wrapped request passes
  192,000 UTF-8 bytes clipped to that length, followed by its own
  "truncated" notice ([measured](antigravity-native-storage.md#clipped-prompts)).
  YA shows such a record as the user prompt's beginning followed by
  "[agy logged only the beginning of this prompt; it left out the last N
  bytes.]". Only when the last `</USER_REQUEST>` in the kept text is
  followed by at most 512 characters (the longest trailer measured was
  387) that read as whole trailer blocks then one partial block is the clip
  taken to fall after the request, and the prompt shown whole; any other
  close, such as one a paste quotes, is part of the prompt, so every kept
  byte after the opening marker is shown with the notice. A clipped record
  is never unknown for its content; only another length, notice or opening
  is. An unclipped prompt that quotes the close is read correctly already:
  its real close is the last one. Pasted text that imitates a close and a
  trailer within the last 512 characters before the clip is still taken
  for the real ones, and the text after it is not shown. The live row,
  while the owner holds it, shows the whole prompt as sent.
- **Cost.** A page reads its own bytes (about 4 MiB, the first record or
  trailing tool group excepted), the records after an older page's cursor
  that resolve its group or error, a search by halves for a cursor, and
  append-only source checks. A page starts at a record that is not a tool
  result and reads nothing older than it needs. Lines are found by offsets
  first and their bodies read only when shown; crossing a record or group
  too large to hold costs its size in reads, with memory near one page.
  The detail title reads at most the file's first 256 KiB. A file replaced or
  truncated while it is opened or read is read again, up to three times,
  then unknown. Reads are read-only, start no process and take no
  ownership guard; the summaries index read is the one exception to
  writing nothing
  ([SQLite sidecars](../gaps/antigravity-summaries-read-creates-sqlite-sidecars.md)).
- **Fallback.** A missing log, one with no complete record, or an unknown one
  (malformed content among the records the window read, or a file that
  kept changing) falls back to ACP `session/load` replay of the whole
  conversation, which keeps its 8 MiB / 10,000-message limit. Requests for
  the same conversation share one replay whatever window each asked for; a
  caller whose own admission was refused (its child lineage changed, say)
  leaves the next caller to ask again, and there is never a second native
  owner. The fallback never starts beside a live owner. Validation covers
  what is read: the records a page shows, the heads of records it only
  steps past (an oversized record's body, a reminder's text and results
  under a placeholder are not read), so a malformed record elsewhere does
  not affect a page that does not read it.
- **Store binding.** A read is published only for the store the reader is
  still bound to: if its conversations directory now resolves to another
  store, or the reader closed, the read returns nothing.
- **What cold history shows**, unlike replay: tool results, checkpoints,
  `agy`'s tool names, each step's time and model, interrupted calls, and
  `ERROR_MESSAGE` records as errors (after a Stop too, where the live view
  just ends the turn). Inbox deliveries such as a background task's wake are
  collapsed "System message" rows; reminders `agy` adds to the model's
  context are not shown, as the live view and other providers' injected
  instructions are not. A tool result's leading `Created At:` and
  `Completed At:` lines with `agy`'s timestamps are dropped; other output
  that starts with those words is kept. A planner response's `error` is an
  error row unless the very next record (no tool results between) is an
  `ERROR_MESSAGE` whose text contains it, as on a 1.5.14 cancel ("context
  canceled by user", then "API error (attempt 1): context canceled by
  user"), which shows one error. Any other pair shows both.
- **What it no longer shows.** Steps that exist only in the conversation
  database, which ACP replay showed: replies cut off when the owner was
  stopped mid-response (1.5.14) and some quota errors. The step 3 census
  found six such steps in five of twelve local conversations
  ([census](antigravity-native-storage.md#comparison-with-acp-replay)). This
  is the accepted cost of reading the log without decoding the database.
- **Children.** An `invoke_subagent` result is shown as the `spawn_agent`
  `{agent_id}` result that makes the row expandable with Open only when the
  child it names is a direct child of the conversation in the summaries
  index; calls and results pair by step, so no argument correlation is used.
  Expanding or opening a child shows its log's latest page (back to two
  checkpoints or about 4 MiB), with the step in progress missing while it
  runs. The agent-session response has no field for earlier content not
  loaded, so a longer child's earlier steps are not shown, as before this
  change (a 4 MiB tail while running, an 8 MiB replay cap once stopped).
- **Title, hover and v0.** The detail title is the first prompt, read from
  the log's first records. A summary whose index row has no title takes it
  from the same bounded read of the log's start; listings do not read the
  log, so an untitled row lists as "Antigravity session", where ACP's list
  could name it before. The hover excerpt and the v0 conversation source
  use the latest page; an excerpt not found in it is unknown, never a full
  read. A v0 window whose page was cut by bytes reports incomplete coverage
  with earlier history in scope and a byte limit, not compaction scope.

A live YA owner's rows keep their own IDs until they move to the log; how a
view joins them is in [resume and the live view](#resume-and-the-live-view)
and [live memory](#live-memory). After the owner exits, a client's catch-up
from a live ID misses and takes the log's latest page. A v0 observer that
outlives the owner replaces that owner's rows with what the log holds
([simple client API](simple-client-api.md)).

A stopped page refreshes when YA's watcher sees the conversation's database
or WAL change, not the brain log. With 1.5.13 and 1.5.14, each log append
was followed within about 3 ms by a write to the conversation's WAL, and
stopping wrote the database again, so a refresh after the last database
event read every record. A log append with no later database write (an
external program, or a future `agy`) would leave a stopped page stale until
its next refresh ([gap](../gaps/antigravity-log-only-append-not-observed.md)).

### Resume and the live view

Plan 195 step 5. Resuming a stopped conversation (a resume, a reactivation,
or the reconnect after a scheduled reload) reads the log's latest page
first, as a viewer's first read would.

- **Known log.** YA calls ACP `session/resume`, which replays no history
  (qualified on `agy` 1.5.13 and 1.5.14 at 7,261 steps: about 37 ms, the
  same compacted context as a load,
  [measured](antigravity-native-storage.md#resume-on-a-large-compacted-conversation)).
  When it returns, the log's last complete record (its `step_index` and the
  byte offset after its newline) is the owner's **resume point**. The
  owner's in-memory projection starts empty there and retains nothing
  replayed. Model, effort and mode are applied to the resumed session as
  for a load, and no saved-tail check runs (there is no replay to check).
- **Missing or unknown log.** The named fallback: `session/load`, whose
  replay must reach the saved text tail and becomes the owner's retained
  history, under the 8 MiB / 10,000-message limit below. A conversation
  with no log at all also takes this path, because YA cannot tell one never
  prompted (whose replay is empty) from one whose log is gone without
  decoding its database; the viewer keeps seeing the history it could see
  before. Plan 195 step 8 decides this fallback's future.

While a resumed owner lives, every reader joins two sources, each row from
exactly one, with no row twice and none missing at the resume point
(apart from the residual and the cap described under
[live memory](#live-memory)):

- the log **through the resume point**, a page at a time with
  [step IDs](#cold-history-from-the-log); a window reads the file as if it
  ended there and reads nothing after it (a record still being written
  past it costs nothing);
- then **the owner's rows**, under their live IDs: everything it produced
  since, including steps the log has also recorded since, until the owner's
  rows pass a soft budget and the resume point moves to a proven split
  point ([live memory](#live-memory)).

| Read | Answer |
| --- | --- |
| Latest page, overlay catch-up, v0 window | The log's latest page through the resume point, then every live row; the route cuts compaction scope across both. |
| Older page before a log row | The log's page before it, as when stopped. |
| Older page before a live row | The latest log page and the live rows; the route cuts before the row. |
| Catch-up after a log row | The log from that row's page to the resume point, then every live row; a miss (replacement) if the row is before the boundary's step and the owner has moved past where it opened ([live memory](#live-memory)). |
| Catch-up after a live row the owner holds | The live rows. |
| Catch-up after any other ID (one that left memory, or never existed) | A miss: the latest page as a replacement. |
| Older page before a live row that left memory | Empty, as for any unknown ID; the browser takes its tail again. |
| Complete history | The whole log through the resume point, then every live row. |
| Hover excerpt | The owner's latest prose, else the joined latest page. |
| Agent mappings | The joined latest page. |

Every answer's title is the conversation's first prompt from the log (a
bounded read of the file's start when the log page itself was not read),
never the resumed owner's own prompt. A new session whose log holds
nothing yet takes it from its owner's first prompt. A live-row catch-up reads no records
but still checks the log through the resume point, at fixed offsets
whatever the size of the record there, and reads the title from at most
the file's first 256 KiB.

**Unavailable earlier history.** The resume point also pins the log file's
device and inode. If, while the owner lives, the log is missing, has been
replaced, is shorter than the resume point, or no longer has that step's
record there, the history before the resume point is unavailable: every
answer (latest, older pages, catch-ups, complete) carries the detail
response's existing `transcriptComplete: false`, still serves the owner's
rows (a page before a log row is then empty), and never starts the ACP
fallback beside the owner. The v0 source reports that read as incomplete
coverage with `earlierOutsideScope: "unknown"`. The browser does not read
`transcriptComplete` for any provider today, so it shows such a view
without a marker; no indicator was added in plan 195 step 5. An in-place
edit of earlier records that keeps the resume point's step and offset is
not detected; external writes belong to plan 195 step 7.

A read that an owner opened, closed or moved the resume point of is read
again, so a page never mixes one owner's split with another's. If the owner
changes during four reads in a row, the last read is the answer: its log
rows are cut to the current owner's resume point (none, if the read came
from a file other than the one that owner's resume point pins), the
current owner's rows follow it where the request includes them, and it is
marked `transcriptComplete: false`, rather than a missing conversation. A new
session's owner starts at an empty log, a resume point at offset 0 that
needs no file. Only an owner resumed through the fallback has no resume
point: its projection is the whole history (its replay, then its own rows).
So is the owner of a conversation the fallback reopened with no log and an
empty replay (one never prompted), which starts at an empty log too. A v0
observer that held the log's rows when a fallback owner attached
replaces them with the owner's whole projection at its next read, even
while the owner is in turn, because that owner replays the history under
its own IDs.

A resumed owner is **starting** from the moment its provider iterator runs,
before it is registered or holds the native lease, until its session is
open. While it starts, a read of a known log is served from the log
(nothing has been written past it), and a read that would need the ACP
fallback waits for the owner and then serves its view: the fallback refuses
while an owner is starting or open, checked again right before it would
send `session/load`. The preview uses a local in-process owner, even when
the shared provider host is enabled.

### Live memory

Plan 195 step 6. A live owner keeps a bounded recent window of rows; the
log serves everything through its boundary, as above.

- **Under the soft budget** (2 MiB of JSON or 2,000 rows) nothing moves:
  the view is the log through the boundary plus every live row, so a row a
  client streamed keeps its ID, and every catch-up appends. The window can
  pass the budget by what arrives before a split is usable (below), and
  indefinitely when no split is usable; then only the cap bounds it.
- **Over it,** the boundary moves to a proven split point and every row
  before it leaves memory. Each turn's first prompt P (sent only while the
  owner is idle: no turn, no compaction) is a candidate: right before
  sending it, the owner takes one synchronous `statSync` of the log, its
  size Z and identity, adding no await to the send. The log's path is
  resolved once per owner, asynchronously, when it opens or, for a new
  session, on its first turn's output; a prompt sent before that records
  no candidate. The stat is one call per turn on the server's event loop, so
  a stalled mount holding the Antigravity store stalls dispatch for every
  session. The candidate is dated after the stat returns.
- **The check.** When the window is over the budget and a candidate is old
  enough, the owner checks it asynchronously, one check at a time. A check
  can start when a row is recorded or when a candidate is added. It reads
  the 512-byte head at Z (a `USER_INPUT`), the byte before Z (a newline),
  and the record ending at Z, found and read once in chunks back from Z,
  the last chunk clamped to the 16 MiB record limit and its two newlines;
  it must be within that limit, parse completely and end a turn (a planner
  with no calls, or an `ERROR_MESSAGE`; a longer record fails, and a later
  candidate will do).
  These show the two records around Z, not that the input at Z is P's
  (step 7 adds that). Then it reads the span it would retire, from the
  current boundary to Z, through the log window reader, a page back at a
  time as "Load older" would serve it, stopping at the first unknown page;
  any unknown page, or an older-page cursor that does not resolve, drops
  the candidate and the rows stay in memory (the cap still bounds them).
  What these reads cost is a description, not a cap: the span check reads
  the span's pages through the window reader, which looks up each cursor
  by halving and may read the record ending at Z again; a failed
  candidate's reads are not reused by the next. Once the owner closes, the
  check opens no further page; a page read already started finishes, with
  its own retry on a changed file. The new boundary is the record ending
  at Z. A failed check discards the candidate and caches nothing, so a
  truncated, replaced or unreadable log moves nothing; a log with nothing
  past Z yet leaves it pending, checked again once a row arrives after
  its check started, and an older eligible candidate is tried meanwhile.
  Eight candidates are kept, thinned by time (the oldest always stays), so
  a burst of prompts never forgets every usable one. A proven candidate
  moves the boundary even if the cap already evicted every row before it,
  which clears the incomplete mark.
- **No candidate after some turns.** A turn that ends on a model HTTP error
  leaves its `USER_INPUT` last in the log, and a `/compact` cancelled after
  its checkpoint leaves the checkpoint last (both versions), so the next
  prompt's candidate fails; the window is cap-bound until an ordinary turn
  ends.
- **Why that splits correctly.** P follows the previous turn's result on
  the ordered ACP stream, so that turn's output has all arrived, and that
  turn's `USER_INPUT` is in the log before its result is sent (the
  [assumption](antigravity-native-storage.md#live-memory--plan-195-step-6)
  the proof rests on). On `agy` 1.5.13 and 1.5.14 every wake (a background
  command's, a detached subagent's report, one interrupted by a prompt)
  logs a non-terminal record (its task-end or inbox `SYSTEM_MESSAGE`, once
  a tool result) before its first ACP output, so a wake in flight when P is
  sent fails the terminal check, and one that lands between Z and P's input
  fails the `USER_INPUT` check ([measured](antigravity-native-storage.md#live-memory--plan-195-step-6)).
- **The residual.** Output for a record at or before Z that arrives on the
  ACP pipe after P was sent is not seen by the proof: `agy` sends no echo or
  other update tied to a prompt to order it by (none on either binary). The
  adapter already shows such a chunk as part of P's turn
  ([gap](../gaps/antigravity-late-wake-chunk-joins-next-turn.md)); once a
  move covers that record, the chunk is shown twice in the live view, once
  from the log and once as a live row, until the owner stops, when the log
  alone serves it. It needs a record written whole before P was sent while
  its last frame was still in transit; it was reproduced only by holding a
  frame at the transport. Likewise a detached tool's result that arrives
  after its call was retired has no live call to pair with, and is shown
  orphaned until the owner stops.
- **Not too early.** A candidate is used only once Process's replay buckets
  holding every row before it have expired: 30 seconds after P was sent
  plus a 5-second margin, measured on the monotonic clock. The buckets
  rotate on a timer, so an event-loop stall longer than the margin can
  leave a moved row in the buffer for a viewer that joins late, which then
  receives it under its old ID beside the log's copy until its next
  replacement.

Nothing is read in the background beyond these checks, no timer drives
them, and nothing is checked or moved after the owner closes, by natural
exit or abort.

**What a move changes.** A page read after it shows the rows before the
split from the log, as a cold view would: `agy`'s tool names and rendered
results, the records' times and models, checkpoints, a reply a steer
interrupted as one reply before the steer, a prompt `agy` clipped as its
beginning with a notice (below), and no rows for steps the log never
recorded (a reply cut off when the owner was killed, say). A read that a
move happened under is read again, up to three times; the last is served
cut to the owner's boundary and marked incomplete.

**Clients at a move.** A connected client whose last fetched row left
memory gets one replacement window on its next catch-up: the existing
answer to a missed anchor, which drops the older pages it had loaded and
its scroll position ([gap](../gaps/client-tail-replacement-drops-loaded-history.md)).
So does one whose catch-up starts at a log row before the moved boundary's
step while the owner has moved (it may hold the rows after it under live
IDs), decided from the steps without reading a page. A client whose last
row is still live keeps appending and loses nothing. "Load older" from a
row that left memory gets an empty page, the stale cursor the browser
recovers from by taking its tail again; then older pages load from the log
as usual. Apart from the residual and the late joiner above, a client
never sees a row twice.

**The cap.** What remains is capped at 8 MiB of JSON and 10,000 rows: past
either, the oldest row other than the one being recorded leaves without the
log serving it, and every answer carries `transcriptComplete: false` (v0:
incomplete coverage; frozen sharing refuses it) until a move covers it.
One row larger than the cap is stored cut, in at most four serializations:
its longest text field cut once; else every structured tool body replaced
by a short omission; else only each block's type, IDs and name. It ends in
a notice that the live view keeps only its beginning and that the log
shows what `agy` recorded once the row moves there or the session ends
(which may itself be clipped). While a cut row is held the answer is
incomplete too, so frozen sharing refuses it. A live text or thinking block
stops growing at 8 MiB, with the same notice, and is marked the same way;
the stream then carries that cut text. Nothing throws, and the session
keeps running. An update for a row that left memory (moved or evicted)
does not bring it back while its ID is among the last 10,000 to leave (the
retired-ID ring). An owner resumed through the fallback has no boundary
and only the cap bounds it; a conversation with no log keeps its first
prompt as its title even after the cap evicts it. The fallback replay
itself keeps its own 8 MiB / 10,000-message limit below.

**Stop before a send.** A Stop that arrives while a dequeued input is
still starting (its subagent position read) cancels it: it is never sent,
and the turn ends with a result. A configuration hold or a compaction that
arrives during that read is waited out, under the same Stop, and the
position read again.

### Fallback replay

ACP v1 orders history notifications before the load response. The
saved-session repro on `agy` 1.5.14 observed late history notifications
after that response. When a native brain log supplies recent replayable
content, YA requires that content to arrive before publishing or caching
fallback history or dispatching the first prompt of a fallback resume. The
bounded read prefers the unabridged `transcript_full.jsonl` when present.
YA surfaces an incomplete replay if the stream closes or its expected tail
fails to arrive. YA uses the ACP load response for stores without a text
witness. If a witness is malformed, abbreviated or unreadable, history
remains available with incomplete coverage. The snapshot is reused for the
same native conversation version to avoid a load and file-change loop. A
session reactivated without a prompt stays idle through replay.
[ACP load ordering](https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions)
Resume waits for an in-progress fallback read of the same conversation to
release it and refuses a second live owner. Owner projections survive YA's
short transport replay window, are discarded on owner exit, and are never
persisted as a substitute transcript. Concurrent use of the same
conversation in a separate editor/CLI is not qualified.

App browsing uses the shared catalog and provider-root watcher described below.
Fallback replays own subprocesses; reader disposal closes them. Because every `session/load` writes the store's summaries index, which the
provider watcher reports and viewers refetch, a fallback replay is reused
until the conversation's files differ from their post-load state (at most four per project
reader). Without this, opening a session could reload it repeatedly. Log
reads cache nothing; a refetch rereads its page.
At most eight detail reads per cached reader may run concurrently. YA bounds
the normalized history a fallback replay or a fallback resume replays to
8 MiB and 10,000 messages, and each ACP frame to 16 MiB. Tool fields that
YA does not display do not consume the history budget or prevent a
fallback resume. If a replay exceeds its limit, YA reports the
history-limit error. A resume from the log retains nothing replayed, so a
history of any size resumes. A live session has no history limit: its
rows are bounded as [live memory](#live-memory) describes, retained only
for an owned provider session, with no timers; its only log reads are the
bounded split checks.

Text and generic tool records are normalized from actual native notifications.
Live text and thinking blocks publish `_isStreaming` snapshots of one message
id and commit it without the flag when the next block, a tool call or the turn
end closes it, so viewers with response streaming off see only the commit.
Live messages carry arrival timestamps. A detail read of a live owner
serves a block still streaming marked `_isStreaming`, as the stream does,
so a client keeps following it rather than freezing that snapshot; its
commit replaces it. `agy` 1.5.13 and 1.5.14 send no `user_message_chunk`
for a live prompt; should one arrive, YA ignores it (it already published
that turn's user message), while `session/load` replay keeps native user
chunks as history. Detail reads of an owner's whole projection
or a replay return the complete history for anchored (`afterMessageId`)
requests, and log and joined reads return the anchor's page onward, leaving
the anchor for the detail route to find; a pre-sliced list would read as an anchor miss and the client
would replace its window with the tail. Native readers report no owner; a live
YA owner, not the reader, establishes ownership.
ACP does not provide YA's durable input UUID, so exact live-to-history user-turn
links are not promised; see the existing
[input-identity gap](../gaps/provider-user-turn-durable-identity.md).
Provider side-effect controls and the wider native tool/media matrix remain
unverified, as described in the existing
[side-effect](../gaps/provider-session-side-effect-controls.md) and
[display-coverage](../gaps/tool-display-native-provider-coverage.md) gaps.

## T3 Code reference — 2026-11-22

Source review of T3 Code `main` at [`122d3bf853`][t3-agy-revision]. The
[T3 provider guide][t3-agy-guide] documents `agy` 1.5 or newer and recommends
1.5.12 or newer. T3 runs `agy acp` with a managed profile and selects the
`antigravity-acp` app-data directory inside it. YA's usual `agy acp` path uses
the CLI's existing `antigravity-cli` store. Native file locations and layouts
need qualification in YA's actual launch mode. This review used T3 source and
its reported tests. Live and scripted reproduction evidence above is from YA.
[T3 launch arguments][t3-agy-launch] · [Shared ACP architecture](acp.md#what-t3-shares)

| Boundary | Reference in T3 | Application to YA |
| --- | --- | --- |
| Steering and Stop | The Antigravity flavor sends a second prompt for native steering and preserves background work on an ordinary follow-up after the prompt settles. Explicit Stop can cancel the native work. [T3 adapter flavor][t3-agy-flavor] | Keep Steer, ordinary deferred delivery, patient delivery and Stop distinct through the native boundary. Test that ordinary input and steering preserve background work unless the user explicitly stops it. |
| Prompt return and pending wakes | T3 can keep an application turn open after the prompt responds. Its wake check looks for unread high-priority messages in the native inbox or a trailing waking `SYSTEM_MESSAGE` in a bounded transcript tail. It also looks for child reports or killed children. Tests cover consecutive wakes, batched reports and a stalled wake. [T3 native readers][t3-agy-work] · [T3 wake fix and evidence][t3-agy-wake-fix] | Treat the inbox and tail as candidate positive evidence that work remains when the last tool or child clears. Check them against live ACP events and the root summary in YA's store. Missing or stale reads leave settlement unverified. Keep the ordinary deferred boundary at foreground completion and apply confirmed root settlement plus the quiet interval to patient delivery. |
| Detached reply completion | T3 uses `usage_update` to close an observed detached reply and checks for another pending wake before finalizing. It bounds how long it waits for quiet. [T3 wake fix and evidence][t3-agy-wake-fix] · [T3 ACP finalization][t3-agy-finalize] | Qualify `usage_update` on the pinned and live runtimes as one input to root settlement. Exercise a quiet end, delayed native publication and a second wake. Use the shared provider observation owner for exact-session reads. |
| Replay and live updates | T3's shared ACP adapter sends `_meta.isReplay: true` updates to history snapshots and skips prompt progress and wake tracking. The reported regression used a scripted ACP peer through the Grok adapter. [T3 replay fix and evidence][t3-acp-replay-fix] · [T3 replay classification][t3-acp-replay-classification] | Check whether `agy` marks the late frames seen in YA. YA currently forwards only the update and session ID to the adapter, so using a replay flag would require carrying notification metadata with them. Replay classification and proof that a cold read reached the saved tail are separate checks. The saved-session marker also exists in YA's bounded native JSONL reader. [YA ACP dispatch](../packages/server/src/sdk/providers/antigravity-runtime.ts#L435-L442) |

The applicable design is a provider-owned report of foreground completion,
detached work and verified root settlement, with YA retaining its delivery
policy. Use the existing scheduler and reload owners to consume that evidence.
The final scheduled-reload admission check still belongs at the YA wrapper
handoff. Shared ACP transport and provider-host continuity remain separately
scoped in their owning contracts. [YA session liveness](session-liveness.md) ·
[Reload ownership](reload-safe-provider-runtimes.md) · [ACP composition](acp.md#proposed-ya-boundary)

The [upgrade checks](native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
keep lifecycle and delivery on real `agy` against a scripted model. The
controlled ACP peer checks late history ordering in both the cold reader and
resume. The original long saved session provides native evidence for the
cutoff. Repeated replies and tool-only tails still need a
[provider completion signal](../gaps/antigravity-acp-replay-completion-signal.md).

[t3-agy-revision]: https://github.com/pingdotgg/t3code/commit/122d3bf853da716652d5066b54d05d7654c46e36
[t3-agy-guide]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/docs/user/providers-antigravity.md
[t3-agy-launch]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/provider/antigravityAuthSupport.ts#L558-L564
[t3-agy-flavor]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L236-L251
[t3-agy-work]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/apps/server/src/provider/acp/AntigravityChildWork.ts#L751-L815
[t3-agy-wake-fix]: https://github.com/pingdotgg/t3code/pull/39989
[t3-agy-finalize]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/packages/provider-acp/src/server/adapter.ts#L8753-L8783
[t3-acp-replay-fix]: https://github.com/pingdotgg/t3code/pull/40328
[t3-acp-replay-classification]: https://github.com/pingdotgg/t3code/blob/122d3bf853da716652d5066b54d05d7654c46e36/packages/provider-acp/src/server/runtimeModel.ts#L1319-L1322

## Qualification on 2026-11-03

This qualified the standalone ACP 1.4.5 runtime, which YA no longer runs; it
is kept as history. The official macOS arm64 ACP 1.4.5 distribution and CLI
1.4.12 were installed and signed in through Google's native flows. The account's existing storage
plan was sufficient for ACP Gemini 3.8 Flash; no AI-plan upgrade was purchased.
Live native probes covered text and a scratch-file tool action. Production YA
probes covered admission, streaming, distinct public/native IDs, app restart,
native history and cold resume with remembered context. Subsequent idle reads
retained history after the transport replay window expired.

Controlled real child-process tests cover modern notifications, approvals,
native cancellation, process teardown, refused cold continuation, native replay,
live-owner read exclusion and the YA admission boundary. Migration coverage
preserves existing unresolved allocations while admitting the new family.
Desktop 1000×600 and phone 375×812 captures exercised sequential typing during
native streaming: all 100 characters survived in each viewport, with the
slowest input acknowledgement below 12 ms. This does not qualify advanced
operations or another platform. Discovery has separate coverage below.

## Shared discovery first pass — 2026-11-03

Antigravity, Pi, Grok and OpenCode register their native catalog adapters in
`native-catalog-registry.ts`. The existing retained session catalog owns the
acquisition and durable rows; a compact projection contributes native project
paths, provider counts and activity to `ProjectScanner`. File-catalog production
reads the scanner's file layer, so project discovery cannot await itself.
Native project facts are not duplicated in the scanner's persistent cache.
Existing project permissions, hidden directories, ownership metadata and public
session adoption still apply.

Antigravity discovery enumerates at most 2,000 `<uuid>.db` conversations, in
batches of eight, and takes each one's project from the summaries index.
Native database and WAL file facts version rows; conversation databases are
never decoded. A row with a native title has head fidelity; one without has
identity fidelity and no inferred title. Browsing starts no native agent, login or model prompt. Explicit
history reads come from the brain log; their ACP fallback still uses Google's
loader and preserves the active-owner guard.
App-owned Antigravity session listings consume accepted catalog rows instead
of repeating native inventories per project. Public catalog projection honors
existing Antigravity bindings, so a discovered native UUID cannot replace an
already allocated YA session ID.

Retained project reads return accepted state while finite discovery runs.
Completeness requires accepted coverage of each eligible native store, including
empty stores; failed acquisition retains the previous generation. Only historically
used families are eligible. Antigravity joins the existing provider-root watcher
owner, watching native conversation database and WAL changes as well
as the sibling `conversation_summaries.db` and its `-wal` sidecar so
lineage-only WAL commits invalidate the retained catalog without rescanning
file-provider projects. Project notifications follow changed project facts,
rather than title changes alone. There is no new polling loop or watcher per
project.

The next cleanup slice shares exact reader selection for child sessions and
vocabulary, and Project Queue title lookups read accepted catalog facts without
provider work. This does not unify all per-project readers, focused history
watches or process-to-session correlation. Grok and OpenCode do not gain
a new root watcher here; their existing invalidation and explicit catalog refresh
behavior remains. Legacy Gemini execution and historical readers remain intact.
Focused Antigravity observation remains unavailable. Database/WAL notifications
alone do not authorize automatic `session/load`: it starts `agy`, which writes
store-wide files and the summaries index, and its effect beside a live owner
is unmeasured ([native storage](antigravity-native-storage.md#what-load-and-resume-write)).
The next slice needs owner-aware history acquisition,
a process budget shared across readers, and WAL-aware source versions before
turning those notifications into automatic history refresh. The local owner
map and per-reader limits do not establish those install-wide guarantees.
The remaining sequence below still applies; this is not Gemini retirement.

## Discovery and cleanup scope — discussion, 2026-11-03

The following records the original scoping discussion. The shared discovery
first pass above implements the catalog registry and project join. A common
reader registry, consumer migration, focused observation and transport sharing
remain proposals, with no approved implementation sequence. Legacy Gemini
history remains readable and never becomes an Antigravity continuation implicitly.

### Existing work to extend

[Plan 093](../docs/tactical/093-provider-session-reconciliation.md) already owns
install-scoped catalogs and exact process reconciliation. Its retained catalog,
successful-use eligibility and Pi/Grok/OpenCode native adapters are implemented.
The [catalog observation contract](session-catalog-observation.md) owns bounded
refresh, fidelity, source versions and publication. This scope extends those
owners; it does not create another catalog or transcript database.

Before the first discovery pass, the concrete splits were:

- [Project discovery](../packages/server/src/projects/scanner.ts) directly
  merges Claude, Codex and legacy Gemini discovery with registered projects.
  Pi/Grok/OpenCode have install-wide native session catalog adapters, but their
  catalog facts are not that scanner's common project-discovery input.
- [Catalog assembly](../packages/server/src/sessions/catalog-adapters/collection-catalog-adapters.ts)
  still chooses families itself and asks ProjectScanner for the
  Claude/Codex/Gemini projection inputs. Therefore making ProjectScanner await
  that same catalog refresh would create a dependency cycle.
- [Source resolution](../packages/server/src/sessions/provider-resolution.ts),
  app reader construction and focused watch resolution separately encode
  provider/family knowledge. The existing
  [three reader-selection rules](../gaps/reader-for-one-provider-has-three-spellings.md)
  gap identifies real consumers whose fallback semantics differ.
- Antigravity's preview reader has its own metadata inventory and per-project
  ACP list cache. It is not an install-wide discovery owner; multiplying that
  reader by project count would multiply native process work.

### Recommended first pass: discovery and source lookup

1. **Separate executable availability from readable native stores.** Keep
   execution adapters on AgentProvider. Establish a small server-side
   registration for a native family's existing catalog adapter and scoped
   reader factory. Instantiate it for the actual configured store, keyed by
   family and canonical storage scope. A historical reader must work without
   an installed or authenticated execution driver. Keep recognized historical
   provider IDs distinct from providers available for new execution.

2. **Join native catalog facts into project discovery.** Add an Antigravity
   NativeSessionCatalogAdapter and use Pi/Grok, with OpenCode as an existing
   database-backed case, to exercise the shared path. Reuse the existing
   retained catalog, eligibility ledger, project metadata and publication
   machinery. Keep Claude/Codex's incremental scanners and their measured
   optimizations intact in the first slice. Specify the dependency direction
   before coding: project refresh may consume accepted native contributions,
   but cannot wait on a refresh which is itself waiting for ProjectScanner.
   First-run completeness, publication-triggered project invalidation and
   source-version checks must cover that staged join explicitly. A newly
   created YA project should use existing app-data registration instead of
   waiting for another provider's files to establish its existence.

3. **Give consumers one exact source lookup.** Reuse native identity and the
   existing exact-provider resolver for reader selection. Route child-session
   and vocabulary consumers through it while retaining each caller's chosen
   missing-source behavior. Provide a bounded lookup of accepted catalog facts
   for collection consumers such as queue titles and focused observation; the
   [queue-title gap](../gaps/project-queue-titles-read-providers.md) is a concrete
   consumer. Unknown catalog membership is not authoritative absence. Detail
   reads retain their explicit provider-native acquisition path.

4. **Share observation policy, preserve native acquisition differences.**
   Use catalog locations and provider-supplied observation facts for file,
   database and protocol-backed sources. Reuse current coalescing, cancellation,
   source-version and disposal owners. Bound native subprocess allocation
   across readers, not just inside each reader. Antigravity's `session/load`
   writes store-wide native files, and what it does beside a live owner is
   unmeasured: consult the incumbent provider owner before replay, keeping
   that native constraint explicit. Reusing the existing
   provider-session owner is preferable to expanding the preview's isolated
   in-process ownership map into a second lifecycle system. Shared-host support
   needs its own qualification; a local memory guard is not a cross-process lock.

This pass should remove Antigravity's parallel project-inventory path and
reduce generic provider switches where the common registration is actually
used. Storage decoding, native project-membership proof, exact source versions
and resume validation remain provider-owned. Broad error catches must not
turn an unreadable store into a successful empty enumeration; the
[transient discovery-error gap](../gaps/project-discovery-transient-read-errors.md)
is relevant evidence, not something to close with a factory-only refactor.

Keep the implementation slices smaller than that whole pass. The recommended
starting slice is native catalog registration plus project contributions,
proven with Antigravity and existing Pi/Grok adapters. OpenCode's existing
adapter supplies a database-backed compatibility case without rewriting its
reader. Exact reader/caller cleanup and catalog point lookups form the next
slice; owner-aware history and focused observation follow independently.
Do not add a common path while leaving the old path in active use by the very
consumers being migrated. Each slice should identify which duplicate calls,
switches or caches it removes and verify the surviving behavior.

### Gemini retirement and optional ACP consolidation

The [ACP topic](acp.md) compares current YA and T3 sharing and recommends a
bounded transport/session composition. It refines this discussion without
authorizing implementation or changing the retirement/qualification sequence.

Yep Anywhere retired execution for `gemini` and `gemini-acp` on 2026-11-21.
Both IDs remain valid in historical records, URLs, and collection filters.
Gemini transcripts can be opened without the Gemini CLI. The session page
shows a read-only notice when its server omits the provider from discovery.
Launch, resume, and saved dispatch refuse retired providers explicitly. A
Gemini transcript retains its original provider and identity. Users can
start a separate Antigravity session in the same project.

Retired IDs in `ENABLED_PROVIDERS` match no live provider. Replace the
entries with `antigravity` if desired. Let active Gemini turns finish before
upgrading and fully restart the provider host along with the server.

Then assess a separate, bounded consolidation of Grok and Antigravity's ACP
transport: request correlation, framing limits, pending-request failure,
permission callback plumbing and actual child teardown are candidate shared
mechanisms. Text/thinking/tool-state assembly is another candidate only where
both agents' actual notifications establish the same semantics. The older
shared ACP client and Antigravity's preview transport
currently differ; choose one implementation only after it passes both agents'
real process/protocol cases. Keep session-load methods, native tool meanings,
identity and permission choices in the individual adapters. Do not generalize
Claude SDK, Codex app-server or Pi into ACP, or make this transport work a
prerequisite for discovery. Gemini retirement removes a frozen live consumer;
it does not authorize breaking retained Grok support.

### Acceptance and boundaries

- One bounded native enumeration per eligible store, shared by project and
  session consumers; adding projects or clients does not multiply store walks
  or native processes. Listing performs no full history replay or model prompt.
- Mixed-provider projects merge by canonical directory identity. Identical
  native IDs in different stores remain distinct, and public YA IDs stay stable.
- A project used only by Antigravity appears without seeded Claude history.
  Registered empty projects, cold retained state and first discovery work without
  an await cycle or premature complete-empty publication.
- Known file changes target affected work; title-only and token updates do not
  initiate full project rescans. Incomplete or failed acquisition preserves
  accepted rows and uses bounded retry admission. Unused providers stay unscanned.
- Active-owner history reads never start a competing native loader. Shutdown
  drains owned work and prevents late publication. Native process observation
  and session ownership remain separate: cwd or recent file modification is
  not proof that a particular external process owns a session.
- Queue/title lookups join accepted catalog facts without repeated provider
  reads. Each migrated reader consumer preserves its missing-source semantics.
- With the Gemini executable absent, old histories still open; attempted legacy
  execution is clearly unsupported and never becomes Antigravity execution.

Excluded from the first pass: a new transcript store or application framework,
account/OAuth management, new installers, model-setting unification, universal
tool normalization, proving all CLI/IDE/ACP stores interchangeable, and a full
external-process correlation rollout. Read-only support for old Gemini does
not imply continuing its execution adapter. Existing storage, identity, resource
and compatibility contracts still govern implementation.
