# Session Context Actions

> How long provider session context survives, how it is recovered after
> inactivity, and the capability ground truth for a richer session action
> set — clear, fork, handoff (including synthetic-turn replay), and
> user-initiated compaction — per provider.

Topic: session-context-actions

Related topics: [provider-context-economics](provider-context-economics.md),
[forged-transcript-handoff](forged-transcript-handoff.md),
[resume-compaction](resume-compaction.md),
[compact-and-handoff](compact-and-handoff.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md),
[session-reactivation](session-reactivation.md) — planned message-less
reactivate (spawn an idle live process with no turn),
[session-ui-customization](session-ui-customization.md),
[recaps](recaps.md),
[fork-from-turn](fork-from-turn.md) — per-turn fork / fork-after-summary, which
revises the handoff decision below

## Context lifetime and recovery after inactivity

Nothing semantically owned by the conversation is discarded by
inactivity; what dies is the *process* and the *cache warmth*.

- YA may reap a verified-idle, unretained provider process after the
  server-wide `idleReapHours` grace (default 24 hours). A mounted view of that
  session suspends its own process's deadline; global app activity and views of
  other sessions do not. The final viewer release or a later verified-idle
  transition starts a fresh full grace. Active and waiting-input sessions have
  no viewer-absence deadline. Negative hours disable idle reaping. Until the
  setting is first saved, legacy `IDLE_TIMEOUT` seconds remain authoritative
  (`DEFAULT_IDLE_TIMEOUT_MS`/`DEFAULT_IDLE_TIMEOUT_SECONDS` in
  `packages/server/src/defaults.ts`, env parsing in `config.ts`). The supervisor
  `Process` tracks an actual expiry as an intentional idle reap, distinct from
  a crash.
- The transcript persists on disk independently of the process: Claude
  writes jsonl under `{CLAUDE_CONFIG_DIR}/projects/`, Codex writes
  rollout files under its own sessions dir. These survive server
  restarts and host reboots; there is no provider-side expiry we have
  observed for local CLI transcripts.
- Recovery is resume-by-provider-session-id: the provider process is
  relaunched with `resume` and reconstructs its context by replaying
  the transcript. The user-visible costs are (a) startup latency and
  (b) a cold prompt cache — Anthropic's ephemeral cache has a ~5-minute
  TTL, so resuming a long-idle session reprocesses the full input at
  uncached prices. That cost asymmetry is the whole motivation for
  [resume-compaction](resume-compaction.md): offer compact-first resume
  instead of full replay for old or context-heavy sessions.
- Claude edge case: a session whose latest assistant message is a
  recorded API error is treated as not safely resumable
  (`handoff-required` in `packages/server/src/routes/sessions.ts`); the
  validated recovery there is the template handoff.

In-memory-only state (deferred queue contents, per-process status) is
the one thing a reap or server restart can lose ahead of the
transcript; the restart-handoff path explicitly folds still-queued user
turns into the handoff text for this reason
(`getRestartQueuedMessages`).

## Clear

What Claude Code's `/clear` actually does, per the Agent SDK surface
(verified against the vendored `@anthropic-ai/claude-agent-sdk` 0.3.170
`sdk.d.ts`): it starts a fresh conversation and fires `SessionStart`
with `source: 'clear'` (the sources are
`'startup' | 'resume' | 'clear' | 'compact'`). The system prompt,
CLAUDE.md, and SessionStart hook context are re-injected — but that
injection is *mechanical harness work*, not agent work. `/clear` does
**not** preserve any agent-performed warm-up (file reads, derived
understanding); there is no "bare agent read state" snapshot to fork
back to. So a YA "clear" action is honestly equivalent to "new session,
same project/provider/model" — the convenience is staying in place in
the UI, not saved tokens.

If the goal is to keep warm-up work without the rest of the
conversation, that is not clear, it is **fork at a point** (below):
fork/resume up to the message UUID just after the agent finished its
initial reads.

Decision (2026-06-11): YA's clear should be implemented as
fork-up-to-a-point where the provider supports real prefix fork
(Claude today), with plain new-session as the fallback elsewhere; and
the general form is a per-turn "fork from here" (rewind-and-continue)
control, shown only where no full-replay emulation would be hidden
behind it. Cost semantics in
[provider-context-economics](provider-context-economics.md).

UI placement: a `Clear` entry in the session kebab menu
(`SessionMenu.tsx`, next to star/archive), not a bottom-bar control —
the composer bar is contested space and kzahel has disabled speculative
session-UI controls before; see
[session-ui-customization](session-ui-customization.md) and
`topics/kzahel-disabled.md`. Implementation is provider-neutral: create
a new session with the same project/provider/model and navigate to it.

## Clone and Fork

YA exposes one provider-native copy family for Claude, Codex, and Pi. A direct
**Clone** keeps the latest completed response; **Fork before/after** keeps a
server-resolved prefix at a real user-turn boundary. Both create a cold session
with no new provider turn and leave the source unchanged. The child persists
the source model for its first cold resume; a source launched through
`default` is pinned to the provider-reported model rather than re-evaluating a
possibly changed default. Effort remains an independent launch setting.
**Handoff** remains a separate replacement/continuation workflow.

Claude's underlying SDK 0.3.170 surface is:

- `forkSession(sessionId, { upToMessageId?, title? })` — copies the
  transcript into a new session file with remapped UUIDs and a
  preserved parent chain; `upToMessageId` slices the copy at a chosen
  message (inclusive). Returns a new session id resumable via
  `query({ options: { resume } })`. Forks drop undo/file-history
  snapshots.
- `query` options `resume` + `forkSession: true` — resume-as-fork
  (continue from an old session under a new id, leaving the original
  intact).
- `resumeSessionAt: <message uuid>` — resume the same session but only
  up to a given message; the branch-from-a-point primitive without
  creating a separate file first.

Codex uses native app-server `thread/fork`; new typed turn boundaries map
directly to inclusive `lastTurnId`, while legacy item anchors retain the old
read-and-rollback path. Pi writes a new Pi-format JSONL file containing the
retained branch. ACP providers (gemini-acp, grok-acp) and opencode hold session
state provider-side with no exposed branch surface.

The client requires both provider `supportsForkSession` and server capability
`session-fork-turn-intents`. Without either, it hides the complete unified
Clone/direct-Fork surface and sends no request. The server resolves real human
turns; user-role tool results and injected/synthetic rows are not boundaries.
Successful Clone/Fork/helper copies expose their source through
`forkedFromSessionId`. `parentSessionId` is reserved for the interactive Mother
relationship of a typed `/btw` aside, so ordinary copies never inherit `/btw`
badge or toolbar behavior.
The exact UI, completed-turn, draft, and failure contracts are in
[fork-from-turn](fork-from-turn.md); the original 2026-08-01 failures and repair
receipts are in
[`docs/tactical/075-session-fork-clone-unification.md`](../docs/tactical/075-session-fork-clone-unification.md).

## Handoff and synthetic-turn replay

Current validated mechanism: the scripted template handoff
(`buildRestartHandoff` in `packages/server/src/routes/sessions.ts`) —
one bounded user message carrying source-session metadata, recent
transcript, any compact summary, and still-queued turns. The originally
planned agent-summarization hook was dropped at first: the template plus
the source session id was enough, because agents look up the named
session when they need more. `RestartSessionModal` already lets the
user pick a different target provider/model, so "handoff to other
agent" exists today via restart-handoff.

Revised (2026-06-23): agent summarization returns as an explicit
opt-in, not the default. [fork-from-turn](fork-from-turn.md) builds a
working LLM-summary facility (the generalized recap/summary path), and
the same summary-instruction control is offered both by fork-after-summary
and on standard handoff. The default stays template + source-session-id;
the generated summary is opt-in. The earlier "dropped" posture held only
while no working summary path existed — it is superseded now that one is
committed to build.

The unexplored alternative — replaying selected or synthetic
user/assistant turns as real context rather than quoting them inside
one user message — splits by provider:

- **Claude, selected real turns**: fully supported and low-risk via
  `forkSession({ upToMessageId })` / `resumeSessionAt`. This covers
  most of the value ("hand the new agent the conversation up to here")
  without forging anything. It cannot *drop interior turns* — the slice
  is a prefix, not an arbitrary selection.
- **Claude, synthetic turns**: the transcript is plain jsonl that the
  SDK replays on resume, so writing a fabricated session file and
  resuming it is possible in principle. Unverified, and fragile: the
  uuid/parentUuid chain and message schema are provider-versioned
  internals (our own Zod schemas in `packages/shared` chase them), and
  drift breaks silently. One API-level constraint to know: mid-history
  assistant turns are ordinary and fine, but a *trailing* assistant
  prefill 400s on current models, so a forged transcript must end on a
  user/tool turn.
- **Codex**: rollout files are similarly on disk; same in-principle forgery and
  fragility for arbitrary synthetic transcripts. Prefix fork is supported
  separately through native app-server `thread/fork`.
- **ACP providers and opencode**: no injection surface — context can
  only enter as real user messages, so the template handoff is the
  ceiling there.

Assessment: prefer fork-slice (Claude) and template handoff
(everywhere) as the supported paths; treat forged synthetic transcripts
as an experiment requiring its own validation gate, not a feature
foundation.

## User-initiated compaction

Manual compaction is available wherever the provider advertises a
compact slash command; YA already has the machinery:

- The Supervisor's compact-first resume (`ResumeMode =
  "full" | "compact-first"`, `Supervisor.ts`) discovers an advertised
  `compact`/`compress` slash command, queues it, and waits for the
  compact boundary before submitting the user turn.
- Claude (`supportsSlashCommands = true`) documents `/compact
  [instructions]` — the optional free-text instructions are the only
  "aggressiveness" knob: a focus directive ("keep only the auth-bug
  work"), not a numeric shrink level. Compaction can fail when the
  conversation is already too full; see the failure posture in
  [resume-compaction](resume-compaction.md).
- Codex advertises `/compact` (no instruction argument observed); the
  targeted auto-compact guard for `gpt-5.3-codex-spark` is documented
  in [compact-and-handoff](compact-and-handoff.md). Codex compaction is
  non-interruptible while running.
- Gemini CLI has `/compress`, but YA's gemini adapters set
  `supportsSlashCommands = false`, so no YA path today. opencode and
  codex-oss likewise expose no compact command through YA.
- Raw-API compaction exists (Anthropic `compact-2026-01-12` beta with
  compaction blocks; OpenAI `POST /v1/responses/compact`) but YA wraps
  CLIs and does not call these directly; they matter only if a future
  API-direct provider lands.

A "Compact now" session action would be thin: send the advertised
compact command on an idle process, show the `Compacting` busy state
per [provider-state-machine](provider-state-machine.md), and surface
failure without retry loops.

Codex manual compaction requires an idle provider turn, including when the
active turn is waiting for an external tool. This is a provider lifecycle
constraint, not a model restriction: in Codex 0.153.3, manual compaction starts
a replacement task and aborts the previous task. YA rejects the command before
dispatch rather than cancelling that work. A rejected native command exposes
the provider's reason in the response's primary `error` field (and retains
`reason`), so clients show why the action failed instead of a generic command
failure.

Native slash commands use the same provider dispatch for live sends, deferred
sends, and session startup or resume. YA waits for provider initialization
before dispatching a startup command. Codex `/compact` calls
`thread/compact/start`; it never becomes model-visible text or a deferred
model turn. Providers that handle slash commands through their ordinary input
queue retain that delivery path. Acceptance emits a local command receipt
with the submitted message ID, clearing the composer's pending send without
claiming that compaction has finished. Compaction status, boundary, and completion
are consumed while idle without requiring another user message. A command
rejection on a live worker preserves that worker and returns the reason; it
must not be interpreted as a dead worker and retried on a replacement.

A paused goal does not block native compaction on resume. Codex's “Resume
paused goal?” interview belongs to its TUI; YA uses the app-server protocol,
which has no such interview. YA preserves the provider's goal status while
requesting compaction and never sends an implicit goal-resume operation to
complete it. Goal pause/resume remains an explicit user control.

While Codex is in a turn or waiting for input, the compact autocomplete entry
explains that it is unavailable until the turn finishes, including tool waits.
The session menu disables Compact with a visible turn-active label. Submitting
the command directly shows the same explanation without sending a request.
These controls become available again when the turn becomes idle. The server
still checks availability to handle stale clients and state changes in flight;
neither path interrupts work or queues a later compaction automatically.

## Synthetic done, archive, and terminate

YA's optional `/done`, `/archive`, and `/terminate` commands are local session
boundaries, not provider commands. An exact attachment-free submission persists
a synthetic user row in YA metadata, marks the session read, sends no provider
turn, and verifiably aborts the whole YA-owned provider process. `/archive` and
`/terminate` additionally archive the session in the same metadata mutation.
The row is merged into session history by timestamp without mutating the
provider transcript, so it remains visible on a later visit.

During an active turn, including provider-retained background work, the action
first persists the complete pending boundary—command, UUID, request timestamp,
and request-time user-turn version—together with
`automationPausedUntilUserTurn`. It uses the Process-local done lane only as a
durable transition: YA immediately promotes the boundary to the synthetic
transcript row, clears the pending record, and then aborts and verifies the
owned process. `/archive` and `/terminate` persist archive before termination.
The command never enters the deferred, patient, direct, or provider queues.

This is deliberately a process abort rather than the provider's graceful turn
interrupt. A graceful interrupt can leave provider-owned background jobs and
watchdogs registered, allowing them to wake a session after the user declared
it finished. Process abort owns those jobs as one lifecycle unit. YA's process
abort verifies the captured provider process or process group is gone on its
supported host path; a verification failure fails the request without rolling
back the already-durable boundary.

The pending boundary and pause remain session metadata so a crash between
persist and finalize is recoverable. Registering a replacement restores the
same command, UUID, timestamp, and user-turn version to the done lane for
explicit retry. A failed initial metadata persist fails without queuing or
aborting. A later synthetic-row or read-state failure leaves the persisted
pause and pending boundary visible for retry, still runs verified process
cleanup, and does not send provider input.

All three boundaries pause YA-driven provider work until a later real user
turn. They block automatic compaction, recaps (including forked and cold
recaps), heartbeat/session-wake turns, prompt-cache keepalive, patient queue
promotion, and automatic Project Queue revival. `/terminate` also sets the
durable explicit-kill resume exemption (`autoResumeDisabled`) and disables
heartbeat turns; automatic paths cannot restart it until a deliberate user
action clears that exemption. `/done` can be deliberately continued by a later
user Send, and `/archive` can be unarchived and continued.
If `/terminate` cannot persist the additional resume exemption after its
archive boundary is durable, process termination still proceeds and the
response reports `resumeExemption.error`; the already-persisted archive and
automation pause remain in force.

The ordinary UI Archive action uses the generic archive metadata route rather
than adding a synthetic transcript row. The server nevertheless treats every
`archived: true` transition as a stop boundary: it persists archive first and
then verifiably aborts any YA-owned provider process. This covers older clients,
sidebar archive, and bulk/global archive callers without relying on client
cleanup.

`/done`, `/archive`, and `/terminate` are consumed on submit.
The composer clears the text optimistically and the settled request drops the
localStorage recovery copy, so the session shows no "Draft" badge and a later
visit does not restore a command already consumed; a failed request restores it
for retry. The aside-closing `/done` variant clears the same way. `/archive` and
`/terminate` are Mother-session operations and fail visibly instead of reaching
a focused `/btw` aside.

Because the user has declared the session finished, every durable boundary also
stops that session from blocking Project Queue promotion for its project. See
[project-queue](project-queue.md) § Project Idle Predicate.

The `/done` feature is server-capability gated (`synthetic-done-command`) and
defaults to `off`, preserving provider-owned `/done` skills. `hidden` enables
typed local `/done` without a toolbar button; the ordinary narrowing tiers
enable the command and show the circle-check button. `/done` follows its
composer: an aside-routed composer closes that aside, while the Mother composer
keeps this synthetic session behavior even when a side pane is open. With the
setting Off, Mother passes `/done` through to the provider.

`/archive` has its own permanent `synthetic-archive-command` capability and
route because older done-capable servers cannot atomically archive with the
boundary. When that capability is absent but `synthetic-done-command` is
present, the client immediately canonicalizes exact typed `/archive` to the
ordinary `/done` operation: the queued chip and durable row both read `/done`,
and no archive request is made. When neither capability is present, the
existing provider-command fallback remains. Stable `v0.7.0` and `v0.6.2` lack
the archive capability and route. The source-ahead `v0.7.1` done/archive
contracts now include verified process termination; no stable release
advertised either capability.

`/terminate` has its own permanent `synthetic-terminate-command` capability and
route. It shares Synthetic Done's default-off activation setting: with that
setting Off, the client hides it from suggestions and passes typed text to the
provider. When the capability is absent, the same provider-command fallback
makes no unsupported request. It never degrades to `/archive` or `/done`,
because those operations do not set the durable explicit-kill resume exemption.
Stable `v0.7.0` and `v0.6.2` lack this capability and route.

A source-ahead server with the original immediate done route may omit the
additive `queued` and `deferredMessages` response fields; the client treats both
as optional and retains the immediate local-done behavior.

## Action set

Session kebab menu, capability-gated per provider, hidden or
configurable per [session-ui-customization](session-ui-customization.md):

| Action | Mechanism | Providers |
|---|---|---|
| Clear | New session, same project/provider/model; navigate | all |
| Clone | Provider-native full fork through latest complete turn | claude, codex, pi |
| Fork | Provider-native prefix fork at a real user-turn boundary | claude, codex, pi |
| Handoff to agent | Existing restart-handoff with provider/model picker | all |
| Compact now | Queue advertised compact command; busy state | claude, codex |
| Done | Transcript boundary, automation pause, verified provider-process stop | all |
| Archive | Done boundary plus atomic archive; UI archive also stops the process | all |
| Terminate | Archive boundary, explicit-kill resume exemption, verified stop | all |

The fork point lives in the inline menu on each real user prompt; the right-side
turn rail is an accelerator for the same actions. Remaining questions are
whether clear should offer "keep a recap" (see [recaps](recaps.md)) and whether
compact-now belongs in the same menu or near the context-usage indicator.

Decision (2026-06-12): do not make the context-usage indicator itself
send `/compact`. Accidental clicks can mutate an existing session, and
the indicator is expected to be passive status chrome. Keep compaction
behind explicit slash-command/session-menu paths unless a future design
adds a clearly named, deliberate control.
