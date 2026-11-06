# Provider Waits And Background Work

> How Claude and Codex wait, keep work running after a turn, and wake
> themselves, and the provider-neutral record of that work YA keeps for the
> sessions it owns, and the inbox indicators built on it.

Related topics: [session liveness](session-liveness.md) owns liveness
statuses, retention and idle reaping; [Claude provider control](claude.md)
owns the Claude background-task retention contract.
Dated observations, prompts, versions and source citations:
[evidence](provider-wait-and-background-work.evidence.md).

Provider behavior below was observed on 2026-10-15 with Claude Agent SDK
0.3.296 / CLI 2.1.296 (`claude-sonnet-5-5`) and Codex CLI 0.160.0
(`gpt-6.1-sol`), and checked against Codex source `rust-v0.162.1`. It is
provider behavior, not YA contract, and can change with any provider
release. Recheck it during a [provider refresh](provider-refresh.md) and add
a new dated section to the evidence file rather than editing old ones.

## Vocabulary

- **Foreground wait** — the provider turn is still active, but the model is
  not generating: it is sleeping, waiting on a running command, or waiting on
  a subagent. The session is genuinely `in-turn`.
- **Background work** — the turn has ended and something the session started
  is still alive: a shell or monitor process, a background subagent or
  workflow.
- **Scheduled wake** — a provider-owned timer that will start a new turn
  without user input (Claude session crons and `ScheduleWakeup`).
- **Self-started turn** — a turn the provider begins without a YA
  `turn/start` or user message: a finished Claude background task, a fired
  Claude cron, a Codex goal or thread-queue continuation.

## Provider Behavior (observed 2026-10-15)

| Situation | Claude | Codex |
|---|---|---|
| "Check in with me in N minutes" | Background Bash `sleep`, turn ends; the task's completion wakes a new turn | Turn stays active, chaining `clock.sleep` items (≤60 s observed) between model steps |
| "Remind me in N minutes" | One-shot `CronCreate`, turn ends; the cron fires a new turn | Same as check-in |
| "Check back in N minutes" | Background task plus `ScheduleWakeup`, turn ends | Sleeps inside the active turn |
| "Let me know when the build finishes" | Background Bash; completion wakes a new turn | Turn stays active and polls the running command |
| Dev server left running | Background Bash task retains the session; a `nohup … &` launch escapes tracking entirely | Turn ends `idle`; the process is visible only through `thread/backgroundTerminals/list` |
| Background process exits after the turn | `task_notification` and a new turn | Late `item/completed`; no new turn |
| Subagent | `local_agent` task; foreground in the probe, backgrounding possible | Separate child thread with its own turns; parent waits in its turn |
| Provider status while waiting in the background | SDK reports idle; `background_tasks_changed` lists tasks; crons only in Stop-hook input | `ThreadStatus` `idle` with no flags; no change notification |
| Process teardown | Kills tracked background tasks | Kills all background terminals (`killpg`) |

Two provider facts matter for any later design:

- Claude session crons, including `ScheduleWakeup`, were held back while a
  background task was running; a check-in scheduled beside a running dev
  server did not fire on time.
- Codex's `clock.sleep` is offered only for models whose catalog lists the
  `clock` tool (bundled gpt-6 models), and a single sleep may last up to
  12 hours.

## Recorded Work

YA records provider-held work for the sessions it owns as two optional lists
on the liveness snapshot's `providerRetention` (`ProviderWorkItem` in
`packages/shared/src/session-liveness.ts`). Each item has an `id`, a `kind`
(`shell`, `monitor`, `subagent`, `workflow`, `mcp`, `cron`, `sleep`,
`other`), a `label`, the raw `providerType`, and the `source` evidence it
came from, plus `command`, `startedAt`, `until`, `schedule`, `recurring` or
`parentId` when known.

- **Foreground waits** are what an active turn is blocked on. Claude reports
  the main thread's blocking tasks from `task_started`
  (`is_backgrounded: false`, not owned by a subagent): foreground Bash calls
  that run long enough for the CLI to announce them (about 6.5 s), and
  foreground subagents. They clear on the task's notification or terminal
  update, on a move to the background, or at `result`. Codex reports the
  turn's `clock.sleep` item with its `until` time; it clears on the item's
  completion or at `turn/completed`.
- **Background work** is work that runs independently of model steps.
  Claude reports the latest `background_tasks_changed` level (excluding
  `ambient` tasks; older CLIs fall back to task edges and Stop-hook input),
  enriched with the Stop hook's shell command, plus Stop-hook
  `session_crons` with schedule, prompt and `recurring`. Codex reports
  unified-exec processes (`source: "unifiedExecStartup"`) from
  `item/started` until their `item/completed`, during and after the turn,
  for the session's own thread only.
- Codex notifications are observed as they arrive, so a process that exits
  between turns clears immediately. At each `turn/completed` YA reconciles
  once with `thread/backgroundTerminals/list`; an item that ends while that
  request is in flight is not resurrected. A replaced app-server process
  clears the record, because its terminals died with it.
- The Info tab of the session model panel (`ProcessInfoBody`) lists both,
  under **Waiting on** and **Background work**, from the live session
  stream; a liveness update is published on every change.
- Lists are bounded to 64 items and 500 characters per text field. They
  describe what the provider reported; untracked descendants (a Claude
  `nohup … &` launch, daemons a command forks) never appear, and YA must not
  present the list as a complete process inventory.

## Contracts

- Recording work and retaining a session are separate. Claude background
  tasks and session crons retain the session and defer idle reaping, as
  before. Codex background terminals are recorded with `retained: false`:
  they do not retain the session or defer idle reaping, and reaping ends
  them. A future setting may change that; until then it is deliberate.
  (Decided 2026-10-15.)
- A provider snapshot change that does not flip `retained` refreshes
  liveness only. It must not restart the idle grace, emit row activity or
  rerun idle-boundary work (done finalization, threshold compaction,
  post-compact replay).
- Codex reconciliation happens only at turn boundaries. No timer polls an
  idle session for its terminals, per the
  [architecture mandates](architecture-mandates.md).
- Row activity is unchanged: an idle process that retains provider work
  still reports `activity: "in-turn"`, so queued messages keep waiting.
  Inbox rows add an optional `providerPhase` beside it: `generating` (in a
  turn, no foreground wait), `waiting` (in a turn with foreground waits) or
  `background` (an ended turn held by retained work), with up to three of
  those work items and `workCount` when there are more. It is absent for
  idle, waiting-input and unowned sessions, and on older servers, where the
  client keeps the plain activity dot.
- The phase is derived only from event-driven state; no timer recomputes it.
  A provider snapshot change that moves it publishes
  `session-provider-phase-changed`, a row-only event that carries no
  activity and drives no turn, idle, queue or webhook work. The inbox
  refetches on it; the session-collection generation ignores it because the
  inbox computes the phase per request. A row-level "no output for a while"
  state would need a timer and is not shown.
- Inbox shows the pulsing dot for `generating`, an orange ring and pill
  naming the first foreground wait for `waiting`, and a gray ring and pill
  for `background`. Pills lead with elapsed time or the wake time so
  truncation drops the label; ages are as of the last row refresh. Sessions
  in `background` leave Active for a Background tier that appears only while
  it has rows. The sidebar keeps the plain dot.
- Codex self-started turns (goals, thread queue) carry no trigger field over
  app-server; YA can record that a turn began without a YA `turn/start`, not
  why.
