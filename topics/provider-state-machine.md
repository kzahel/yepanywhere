# Provider state machine (UI contract)

This topic defines the provider/process state contract that YA should render in
the session UI: what it means, what to advertise in UI surfaces, and what actions
are valid in each state.

## Source states

- `processState` (`idle`, `in-turn`, `waiting-input`) from process status
- `sessionLiveness.derivedStatus`:
  - `verified-progressing`
  - `recently-active-unverified`
  - `long-silent-unverified`
  - `verified-waiting-provider`
  - `verified-idle`
  - `needs-attention`
- `isCompacting` (`system` status subtype `status` + `status=compacting`)
- `status.owner` (`self` / `external` / `none`) for action availability

Navigation status is only an optimistic bootstrap hint for a newly started
session. It may establish ownership and open the live stream, but it is not
durable evidence that a turn is still active. After the initial session-detail
load, the client must reconcile current ownership and `processState` even when
the process remains self-owned; browser history can replay an old navigation
hint after that process has become idle.

The session heartbeat repeats the authoritative process state inside its
liveness snapshot. Each heartbeat reconciles `processState`, so a missed
one-shot status or activity event cannot leave active controls and animation
stuck indefinitely. When `lastProviderMessageAt` is newer than the last applied
reader-owned `transcriptSnapshotUpdatedAt`, the heartbeat also requests an
incremental transcript catch-up. Empty or unversioned responses do not advance
that watermark, so the comparison keeps retrying until a row-bearing durable
refresh closes the gap. Provider-retained work remains active through the
liveness derived status even when the underlying process state is idle.
Codex's durable `task_complete` event normalizes to the same hidden
`turn_complete` boundary as the live stream, allowing transcript reload and
catch-up to settle stale active presentation without inferring completion from
assistant text.

Session-detail runtime snapshots obey event-versus-snapshot freshness. A
metadata request started for reconnect, phone wake, initial navigation-hint
reconciliation, or stream-error recovery may update lifecycle fields only when
no ownership, process-state, pending-input, liveness, or local lifecycle
observation arrived after that request started. Among overlapping runtime
snapshots, only the newest-started request may update lifecycle fields. This
keeps an older `in-turn` snapshot from restoring thinking/Stop UI after a newer
idle event, while a later reconnect or visibility refresh can still heal a
missed event.

`terminated` is a derived/diagnostic condition for unhealthy termination; it is
shown through liveness status (`needs-attention`) and server recovery workflows
rather than as a first-class interactive state.

## Primary UI-advertised model text

In `SessionPage`, the model selector title is computed from:
`currentOwnedProcessId` + `isCompacting` + `processState`.

- no owned process → `Slash commands`
- `isCompacting` → `Compacting`
- `processState === "in-turn"` → `Thinking`
- `processState === "waiting-input"` → `Waiting for input`
- otherwise → normal provider/model selector text (e.g. `sonnet · Thinking off`)

This text lives in `slashModelIndicatorTitle` and is passed to both:
`MessageInput` (`modelIndicatorTitle`) and `MessageInputToolbar`.

## Action matrix

| State | Safe actions | Disabled/blocked actions |
|---|---|---|
| `idle` | Send, queue, /model, queue mode, `/compact` if exposed | stop (no active turn), tool approval controls |
| `in-turn` (`status.owner="self"`) | Stop (interrupt/abort), queue/steer depending provider and queue mode, select effort or service tier for the next turn when supported, `/compact` if available | /model editing text; model/thinking/service-tier changes that require a restart |
| `waiting-input` (`status.owner="self"`) | Answer prompt with approval path (`ToolApprovalPanel` or `QuestionAnswerPanel`); select effort for the next turn when supported | regular composer send action; stop is currently off |
| `compacting` (overlay) | same as underlying `processState` | model/config substitution text is busy copy only |
| `needs-attention` | show warning copy and retain manual controls as supported | no automatic idle assumptions |
| `verified-idle` (liveness) | treat as normal boundary for automation | should not be assumed from `recently-active-unverified` / `long-silent-unverified` |

Action gating rules:

- Process state controls primary action availability; liveness is advisory/copy.
- Only queue/steer paths are valid when active turn is in progress and there is no
  immediate send path.
- Prompt keyboard shortcuts (`1`/`2`/`3`, Enter, Escape, Tab in
  `ToolApprovalPanel` and `QuestionAnswerPanel`) act only while focus is
  inside that panel. A keystroke aimed at the composer, another input, or
  the page body never answers a prompt: those keys are ordinary typing, and
  a tool approval unmounts the composer under a user who is still typing.
  Neither panel takes focus when it appears.
- The compacting overlay never changes process-level controls; it only changes
  visible status copy.

## Interrupt visibility and provenance

Provider interrupts are active state transitions, not passive refresh artifacts.
YA must not create a provider interrupt merely because a browser tab refreshed,
reconnected, resubscribed, or re-read the session file. If an interrupt does
happen through any path, the UI must show it with the same seriousness as the
provider-native surface: an explicit interrupted boundary, a timestamp/provenance
where available, and no stale spinner that implies the previous turn may still be
working.

A browser refresh caused by a YA server restart is a different class of event:
the restart may kill or disconnect the provider-owning process. That owner-loss
path may explain a real provider interrupt, but it does not relax the UI
obligation to show the interrupt boundary and reconcile stale activity.

The dangerous failure mode is a split-brain UI: Codex TUI shows a conversation
interrupt while YA still shows ambiguous activity such as an old `Edit` spinner
or generic thinking indicator. That is a severe UI correctness bug even if the
root cause of the interrupt is outside YA, because the user cannot distinguish
"agent still working" from "turn was interrupted and YA missed the boundary."

## UI surfaces that must agree

- `SessionPage`: `slashModelIndicatorTitle`, status chip context, placeholder text,
  and `processState`-driven placeholders.
- `MessageInputToolbar`: model title + liveness chip (`sessionLiveness`).
- `MessageInput`: model title + slash command menu.
- `MessageList`: compaction banner for compaction events.
- `ProcessInfoModal`: process + liveness metadata.

## Implementation invariants

1. Use concise status text while busy to avoid implying model reconfiguration is
   safe during active work.
2. Use `verified-idle` as the only stable boundary for automation and
   completion assumptions.
3. Keep liveness-derived states visible without turning them into hard action locks.
4. Never hide or soften a known provider interruption behind generic running,
   stale-spinner, or reconnect copy.
5. An effort selection made during an active turn is pending next-turn
   configuration when the provider supports per-turn effort: show the selection
   immediately, keep it selected across process-info refreshes, apply its
   provider control at the idle boundary before queued work, and never interrupt
   the active turn. Claude and Codex both support this contract.

## Hard abort contract

The Agents-page `Kill` action is a hard provider-process abort, not merely a
request to stop the current turn. Success requires positive evidence that the
target stopped: the recorded PID no longer exists, the provider liveness probe
reports dead, or the provider iterator has ended. Sending a signal, setting a
child-process `killed` flag, or waiting until a timeout is not success.

The server retains the process row when termination cannot be verified and
returns an actionable error. On verified success it reports the PID and the
verification source, and stopped history contains at most one row for the
canonical session id. Restarting and killing multiple process instances for the
same provider session must replace that stopped record rather than duplicate it.

## Queue-state consistency edge case (provider desync)

Claude and Codex sessions can report queued message state that diverges from
provider acceptance state.

- a deferred/queued row can remain marked `Queued` after provider replay already
  accepted it, or
- a sent/accepted row can remain pending when local state still shows queued.

The contract is: local queue indicators are advisory until reconciliation arrives.
A message is considered sent only when one of these confirms:

- user message echo with matching `tempId`,
- deferred-queue refresh that omits that `tempId`,
- reconnect/session snapshot showing the message in history and not in queued summary.

The live user-echo is the fast path, not a required notice. While the tab
stays connected, a `Sending` chip with no echo must still reconcile from
durable session history (file-change fetch and a bounded retry) using the
same content/tempId match as reload. Reload clearing the chip while the
provider transcript already has the turn is a missed-notice failure, not
proof that the send had not landed. POST success must not remove the chip
until a transcript row exists, or the bubble vanishes until the echo
arrives.

When this mismatch is observed, UI should preserve the queued row for recovery
actions (`cancel`, `edit`, `retry`) and mark the state as uncertain rather than
forcing silent state transitions.[^claude-queued-bug][^codex-queued-bug]

## Provider-specific capability notes

- Claude exposes provider steering (`supportsSteering=true`). YA sends active-turn
  input through Claude's `now` lane by default, with `next` available through the
  explicit **Steer now** preference. Matching foreground Bash calls may be made
  resumable by exact tool ID after the steer enters Claude's input stream; this
  preserves the command but permits concurrent agent action.[^claude]
- OpenCode reports no slash commands or permission-mode/steering toggles in current
  provider metadata (`supportsSlashCommands=false`, `supportsPermissionMode=false`,
  `supportsSteering=false`), so state is mainly communicated through process/liveness
  signals rather than slash-driven controls.[^opencode]
- Codex can surface steering and compact-capable command flow, but still
  participates in the same process state machine and compaction non-interruptible
  UX path.[^codex][^handoff]

## Optional Provider Detail Dictionary

Providers may carry optional, provider-specific detail when it either maps cleanly
to existing renderer semantics or preserves compact signal for a later provider
UI. These fields are additive: generic session rendering must keep working when
they are absent. When the UI grows a provider-neutral renderer contract, promote
matching fields out of provider-specific namespaces instead of keeping duplicate
Grok-only paths. For example, future first-class diff/ListDir/plan renderers
should use optional provider-agnostic fields when the semantics are one-to-one;
Grok-only provenance and lossy raw structures stay under `providerDetails.grok`.

| Field / capability | Source | Current YA mapping | UI status |
|---|---|---|---|
| `tool_use.input.kind` / `title` / `status` | Grok ACP `tool_call*` | Carried on Grok tool inputs; `title`/`kind` also choose the closest YA tool name. | Generic tool row status is rendered via existing result pairing; explicit metadata expansion is not landed. |
| `tool_use.input.locations` | Grok ACP `locations[]` | Carried when present; first location can help derive `Read.file_path`. | First-class location/follow-along UI is not landed. |
| `tool_use.input.rawInput` | Grok ACP `rawInput` | Carried when useful for future inspection; normalized fields are still populated for `Read`, `Bash`, `Grep`, `Edit`, `TodoWrite`, and `Write` when one-to-one enough. | Existing renderers use normalized fields; raw expansion is not landed. |
| `tool_use.input.content` | Grok ACP update `content[]` | Carried for non-terminal tool update detail such as diff snippets or short status text. | Dedicated inline expansion is not landed. |
| `toolUseResult` normalized from Grok `rawOutput` | Grok `ReadFile`, `Bash`, `GrepSearch`, `SearchReplace`, `Todo` | Mapped to existing YA result schemas for `Read`, `Bash`, `Grep`, `Edit`, and `TodoWrite` when fields line up. | Rendered by existing tool rows. |
| Grok custom `rawOutput` fallback | Grok `rawOutput` types without a close YA schema, e.g. `ListDir` | Kept as compact provider result data rather than forcing a misleading generic tool schema. Per-update `_meta` is intentionally not carried. | Fallback JSON only; custom Grok UI is not landed. |
| `message.content[].grokPlan.entries` | Grok ACP `plan` | Plan entries are carried on a thinking block while also rendering readable `status: content` text. | Thinking text renders; structured plan UI is not landed. |
| dynamic command inventory | Grok `available_commands_update` | Live Grok `availableCommands` maps into the existing `SlashCommand[]` provider hook and `/` menu names; descriptions, argument hints, and compact `providerDetails.grok` provenance are preserved on the command objects. Persisted replay still treats command updates as capability evidence, not transcript messages. | `/` menu names are wired for live sessions. Description/hint/provenance display is not landed. |
| `SlashCommand.providerDetails.grok.source/scope/path` | Grok command `_meta` | Carries whether a command is built-in or skill-backed, plus skill scope/path when Grok reports them. `_meta.tools` is intentionally ignored as noisy tool inventory, not slash-command UI data. | API-carried only; client command menu does not yet display provenance or hints. |

When adding fields here, prefer the existing renderer schema if the semantic map
is close enough. If not, keep the Grok-specific structure compact and explicit
rather than widening a generic schema until the UI actually consumes it.

## Provider handoff verification status

- Provider-native handoff behavior has not yet been independently verified as a
  production-safe control path across provider surfaces. The current default remains
  template-driven handoff as the validated recovery baseline.

[^claude]: Claude steering and foreground-Bash re-entry semantics are measured and
  maintained in [steer-queue-provider-differences.md](steer-queue-provider-differences.md).
[^opencode]: OpenCode tool-approval semantics are explicitly marked as experimental in
provider metadata; avoid baking policy assumptions beyond current runtime signals.
[^codex]: Codex is non-interruptible while compacting at the provider level; treat
compact progress as a terminal visual lockout for model-selector details.
[^handoff]: Provider-driven handoff has not been independently proven as an
  end-to-end baseline in this codebase; prefer explicit provider handoff validation
  before replacing scripted handoff templates.
[^codex-queued-bug]: Codex queue-state reconciliation gaps have been observed as
  visual state drift; treat queued status text as advisory and keep recovery
  actions available when stale.
[^claude-queued-bug]: Claude queue-state reconciliation gaps have been observed as
  visual state drift; treat queued status text as advisory and keep recovery
  actions available when stale.
