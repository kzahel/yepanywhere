# Emulated Slash Commands

> Emulated slash commands are YA-advertised commands whose submitted text is
> rewritten or routed by YA when the provider has no native command for that
> behavior.

Native provider slash commands win. YA should not shadow a command the provider
advertises; emulation exists to provide a stable user vocabulary across
providers and harnesses when the provider command inventory has a gap.

Default emulation behavior is based on the user-authored skills in
`github.com/graehl/agents`, whose local development checkout may be installed
as the runtime skills directory.

## Contracts

- A slash command entry may carry `emulation.providerText`, declaring the exact
  provider-visible replacement template YA sends when the user submits that
  command. `{{argument}}` is the raw text after the command name.
- Emulation must happen before provider ingress. Initial messages, resumed
  messages, direct queueing, and deferred-promotion paths should all pass
  through the same rewrite/routing layer before provider text is emitted.
- Provider-native commands take precedence. If the provider reports `/wish`,
  `/doubt`, `/rep`, `/harsh-review`, `/goal`, or another native equivalent, YA
  must expose and send the native command unaltered unless a provider-specific
  topic explicitly says otherwise. The one standing exception is `/clear` on
  rewind-capable providers, which [session-rewind](session-rewind.md) owns as
  YA's same-session `/clear N`; that topic also owns `/fork N` and
  `/clearloop`, whose progress entry is a `ya-command` chip.
- Project Queue is a delayed lane and therefore must not run an emulated
  command at enqueue. [`project-queue`](project-queue.md#queued-ya-commands)
  owns which commands it carries as a tagged `yaCommand` for server execution
  at dispatch, and which it refuses visibly because they act on composer
  state.
- Codex user skills activate through `$skill`, not `/skill`. For Codex-backed
  sessions, YA preserves native/system slash commands such as a leading
  `/goal`, but translates an exact `/name` token to `$name` only when the
  current Codex `skills/list` inventory resolves that installed, enabled skill.
  Unknown slash-shaped text remains literal. The adapter also supplies Codex's
  structured `skill` input item for resolved skills.
- The command menu should distinguish availability from implementation shape.
  A command may be native, provider-text emulated, YA-routed, or unavailable;
  unsupported commands should not silently fall through as ordinary prompt text
  when YA advertised them as commands.
- `argumentHint` and `argumentCompletions` are provider-owned command metadata.
  Completions are non-exhaustive first-argument suggestions, not a validation
  grammar: free-form arguments remain available when the provider accepts them.
  A stopped-session fallback must retain the richest known metadata for each
  provider command rather than replacing live metadata with a name-only row.
- A provider-native local command may return structured YA-local output instead
  of starting a provider turn. YA publishes that output as a synthetic
  `local_command` row for live delivery and short replay, without writing it to
  the provider transcript. Once advertised, such a command must either produce
  its local result or fail visibly; it must never fall through to model text.
- A YA-routed command accepted during an active provider turn may project a
  tagged `ya-command` chip through the canonical queued-message UI until the
  safe local boundary. Routing is decided before provider ingress and carried
  by the tag; YA must never reinterpret arbitrary deferred slash-shaped text by
  content, because the same name may belong to a provider or user skill. The
  boundary consumes the tagged control locally and sends no provider turn.
  `/done` and `/archive` deliberately share one semantic done lane while
  carrying distinct visible command text; this keeps Project Queue and
  automation-pause behavior unified instead of creating another scheduler.
- Immediate YA session operations use the same typed composer resolver but do
  not enter that lane. `/title <text>` saves metadata immediately and bare
  `/title` starts the existing generated-retitle helper. A local operation that
  cannot safely consume the current composer state, such as title with an
  attachment or either Mother-only operation in an aside-routed composer, fails
  visibly and remains recoverable rather than becoming provider text.
- `/v` and `/view` are an immediate YA operation that opens a project file in
  the session viewer; [view-command](view-command.md) owns their resolution,
  completion, and yield to a provider command or skill of either name.
- Emulated commands should preserve the user's argument text verbatim except
  for the declared template substitution. Parsing inside the command belongs to
  the skill/provider behavior, not to the generic rewrite layer.

## One-turn effort commands

`/fast <message>` (also `/f`) uses one lower selectable effort for that
message's turn. `/slow <message>` uses one higher; both saturate at the
model's supported endpoints. `/fastest <message>` disables thinking, or uses
the provider's minimum when it cannot disable reasoning. `/slowest <message>`
uses the selected model's highest selectable effort. There are no `/quick`,
`/quicker`, or `/slower` aliases. These commands change effort, not a paid
service tier. Their argument is required and becomes the submitted text.

The normal session configuration remains unchanged. A modifier submitted
during an active turn becomes a deferred queue item automatically. Ordinary
steers continue the active turn at its effective effort; a modifier cannot
be steered into that turn. Each modified item owns a separate turn, even
with a queue join window or after an interrupt. Ordinary queued messages use
the normal session setting when delivered. Changes to that normal setting
during a modified turn apply to subsequent work and do not replace the
active override. Queued-item edits retain the command.

The model catalog defines the ordered choices. UI **Extra High** is native
`xhigh`; UI **Max** represents the highest supported native choice, preferring
`ultra`, then `max`, then the model's lower ceiling. Thus models advertising
both native `max` and `ultra` have one Max UI choice mapped to `ultra`.
The regular effort selector uses the same mapping as the commands. Auto uses
the model's advertised default for relative steps; if the default is unknown,
relative commands fail visibly rather than guessing. Absolute endpoint commands
do not require a known default, though the provider must be able to restore
its normal setting.

A queued item may show its resolved effort badge when it differs from the
present normal setting. Ordinary items and equal-effort modifiers have no
badge. The badge follows model and normal-setting changes; unknown defaults
have no guessed badge. Modified items do not offer the Steer action.

These semantics are supported by the Codex and Claude SDK adapters. Specialized
new-session launch flows without per-message metadata reject modifiers. The
new client requires permanent capability ID **58**, `turn-effort-modifiers`,
version-implied from **0.8.2** (explicit numeric advertisement for source-ahead
builds). The optional-feature compatibility review covered **v0.8.0** and
**v0.8.1**, the latest two stable releases and all stable releases in the
preceding 14 days. Both lack `messageMetadata.turnEffort`; without the capability
the client hides the commands and rejects typed modifiers while retaining the
draft. It does not use the old `/fast` path that changed normal thinking.
Existing submission routes and queue metadata carry the optional enum
`fast | slow | fastest | slowest`; no old capability meaning is expanded.
The maintainer approved this gate and fallback on 2026-09-07.

Codex restores future thread effort after starting the modified turn; its
active turn retains the requested override. Claude restores controls before
publishing the completed-turn boundary, so queued promotion sees normal
settings. Provider control failures fail visibly and do not silently run at a
different effort.

## Routing decisions

- **Tag pending YA commands at ingress** (vs. interpreting slash-shaped queued
  text at delivery): explicit routing preserves provider and user skill name
  collisions while allowing YA-local commands to reuse the existing
  server-authoritative queue projection and UI.
- **Attach argument completions to provider commands** (vs. a goal-specific UI
  vocabulary): the provider owns argument semantics, while the composer only
  filters and inserts optional suggestions. Older inventories without the field
  retain the existing command-name completion.

## Codex goal commands

Codex `/goal`, `/goal clear`, `/goal pause`, `/goal resume`, and
`/goal <objective>` are provider-native control operations. YA dispatches them
through `thread/goal/get`, `thread/goal/clear`, and `thread/goal/set`; none may
become model-visible turn text, including when starting or reopening a session.
Goal controls execute out-of-band even with the composer's deferred-send option;
providers that do not handle the command retain ordinary delivery semantics.
Setting a new objective clears any preceding goal before setting the new one.
This resets the provider goal without falsely marking the preceding goal
complete. Submitting the existing objective again (after command-argument
whitespace trimming) only reads the goal: it preserves status, token budget,
usage counters, and creation time. Pause and resume results report the status Codex
actually returns, including a preserved usage- or budget-limited state, rather
than echoing the requested transition.

Goal pause/resume can be applied during an active Codex turn. Pause prevents
autonomous continuation without interrupting that turn; resume continues when
idle. Ordinary steering preserves goal status. The Codex TUI separately
pauses an active goal when Escape interrupts its work; that pause is not an
intrinsic effect of `turn/steer` and YA does not automatically undo it.

The Codex inventory preserves the original “Keep working toward a verifiable
end state until it is met” description and `<verifiable end state>` free-form
argument hint, and offers `clear`, `pause`, and `resume` as completions. When
the attached provider reports a current objective, typing exact `/goal` offers
that objective first; Tab inserts it into the composer for editing. Enter on
bare `/goal` submits the read-only goal query and shows the objective (or “No
goal set”) in the session. The session header also shows a flag with the
provider-reported objective as its tooltip. Clearing the goal removes the flag
and objective suggestion. YA saves provider-observed goal inventory separately
from historical receipts, before returning queried inventory or streaming an
inventory change. A stopped session, including after a YA restart, restores
the last observed objective, header flag, and Tab completion. An explicit clear
is saved too. Unknown inventory never erases a saved observation; a fresh
provider observation replaces it. Changes made outside YA while no worker is
observing become visible when the provider is attached and queried again.
Historical receipts are never used to infer current provider state.
When inventory includes `providerDetails.codex.goalStatus`, the outlined flag
uses subtle green for active and yellow for every resumable state (paused,
blocked, usage-limited), and its tooltip names the actual status. Click, tap,
or keyboard activation opens a goal panel with the full selectable objective,
copy control, and provider-observed status. Desktop opens an anchored popover;
phone opens a bottom sheet with a scrolling body and reachable actions. Opening,
closing, copying, and cancelling edits send no goal command and create no
transcript receipt. Escape, outside click, the close button, and browser Back
close the panel; focus returns to the flag.

Explicit panel buttons pause an active goal or resume a paused, blocked, or
usage-limited goal. Complete, budget-limited, and unknown states have no toggle.
Edit goal opens a local editor; Save goal submits `/goal <objective>`, while
Cancel preserves the provider objective. Clear goal explicitly sends `/goal clear`.
All panel commands preserve the composer draft and attachments. While a request
is pending, duplicate submissions are ignored and command buttons are disabled.
Failures keep the panel/editor available and never change the observed status
optimistically. The flag and panel status change only on a provider observation,
including status-only notifications; rejected or limited transitions never
acquire an optimistic success color. These controls use existing native command
delivery during active turns and preserve current turn status.

Right-click retains the themed tooltip's enlarge/copy behavior. It also fills
an empty or whitespace-only composer with `/goal <current objective>` and
focuses it for editing. A nonempty draft remains untouched. This is an explicit
user action and does not submit or replace the goal by itself.

Native interactive `/goal edit` is not advertised; an explicit attempt directs
the user to `/goal <objective>`. The panel editor submits that existing command
and does not depend on a provider-native editor.

Successful goal commands produce an always-readable local receipt with the
full objective itself. The command result (such as “Goal paused” or “Goal
resumed”) appears visibly above the objective, rather than only in a tooltip.
Read, clear, pause, and resume receipts share that style. The receipt
acknowledges the submitted composer temp ID, so the local command does not leave a “Sending…”
bubble while waiting for a provider user-turn echo that will never exist.
With status-aware inventory, submitting a native goal command also preserves
the observed idle/busy state until actual provider lifecycle events change it;
reading or reissuing the same goal must not create a synthetic busy turn.

Goal receipts are YA-owned display history. YA saves the existing
`system/local_command` row in session metadata before publishing it, preserving
its UUID, timestamp, details, and preceding provider-message anchor. Live,
replayed, and reloaded copies render once with the same style and placement;
bounded history reads include only receipts within that history window. They
never enter provider transcripts or model context. Earlier transient receipts
cannot be reconstructed after their replay buffer has expired.

The receipt's anchor includes an assistant draft already visible in the live
stream. Provider output arriving while that receipt is being saved waits for
its publication, so disk latency cannot move the marker relative to subsequent
output. A failed save reports failure, publishes no success receipt, and
releases provider delivery.

Codex can start another turn autonomously after a goal command or a preceding
turn ends. YA continues observing the app-server notification stream while
waiting for input, and streams that work without requiring another user send
or a browser reload. Waiting is event-driven and releases its queue listener
on every wake or abort.

Compatibility: goal receipts use the existing local-command message shape and
session-read routes; older clients can show the generic command receipt.
Current-objective metadata and argument completions are optional inventory
fields. Servers that omit them retain command-name completion and no current
goal flag; the client makes no additional provider or REST requests for these
enhancements. No existing capability is expanded.
The optional status field also gates pause/resume controls: inventories without
it keep the neutral objective-only flag and make no pause/resume request. The
optional-feature review covered `v0.8.1` (2026-09-05) and `v0.8.0` (2026-08-31), the latest two
stable releases and all stable releases within 14 days. Both lack the status
field; no route, command meaning, or existing capability changes. The maintainer
approved completing this plan on 2026-09-06.

## Claude goal commands

Claude Code owns `/goal` natively as a session-scoped Stop hook, and its
command surface is only `/goal <condition>` and `/goal clear` (Claude also
accepts `stop`, `off`, `reset`, `none`, and `cancel` as clears). Setting a
second condition replaces the first: Claude removes the installed hook before
adding the new one, so YA never stacks goals. Claude reinstalls an active
goal's hook when the session resumes, so an auto-restarted provider keeps
working toward it.

Claude offers no goal query. YA reads goal state from the `goal_status`
attachment rows Claude writes into its own session transcript: the set
sentinel, each not-yet-met iteration, the satisfied row, the impossible row,
and the explicit clear. Every flag change therefore follows a provider
observation — a `/goal` that Claude refuses (untrusted workspace, hooks
restricted by policy) leaves the flag alone, and a goal Claude judged met or
impossible clears the flag without any YA action. State is read incrementally
at turn boundaries and on a short interval while a dispatched goal command is
unconfirmed; the first read of a resumed transcript looks back a bounded
distance for the last goal row.

Pause and resume have no Claude equivalent, so YA emulates them: pause clears
the Stop hook and remembers the objective, and resume reissues
`/goal <objective>`. The paused objective exists only in YA, so it is saved in
session metadata and restored when the session is resumed or the server
restarts; an active goal is not restored that way because Claude reports it
itself. Because the Stop hook fires before the queued clear is delivered, a
not-yet-met row for the same objective can arrive first; it leaves the pending
pause in place, and only a hook carrying a different objective discards it.
Clearing a paused goal needs no provider text. Reissuing the live objective
reads it rather than spending a turn re-acknowledging it.

A `/goal` that is a session's first message — a new session, or the first
message after its process was reaped — is delivered as that prompt instead of
being dispatched out of band, because Claude has no session yet to command
(`session-context-actions.md`). Claude installs the hook itself and the
transcript row raises the flag as usual.

YA sends this goal text on Claude's most urgent command-queue lane. The lower
lanes wait for a delivery boundary a goal loop never reaches on its own:
releasing the Stop hook is what ends the turn, and that release is the message
being delivered. A receipt reports the state the transcript confirms, or says
the transition is not confirmed yet rather than claiming success.

The inventory publishes `providerDetails.claude.goalObjective` and
`goalStatus` (`active`, `paused`, or null for no goal) on the native `goal`
entry, plus completions for the current objective, `clear`, and whichever of
`pause`/`resume` applies. The header flag, its tooltip, its goal panel, and the
right-click objective fill are the same controls as the Codex goal flag. When
Claude is old enough to lack a native `/goal`, YA's `/loop wish` alias stays in
place, carries no goal state, and offers no controls. A saved goal observation
never displaces it: the stopped-session restore fills in a native entry that
reports no objective, never an emulated one, whose provider text is the only
way YA can send the command at all.

Compatibility: Claude goal state uses the same optional inventory fields as
Codex, so a server that omits them leaves the client with no flag and no
pause/resume request. The optional-feature review covered `v0.8.1`
(2026-09-05) and `v0.8.0` (2026-08-31), the latest two stable releases and all
stable releases within 14 days. Neither reports Claude goal state; no route,
command meaning, or existing capability changes. The maintainer approved this
gate and fallback on 2026-09-09.

## Default Skill Vocabulary

These are the default user-facing fallback commands YA should prefer when a
provider has no native equivalent:

- `/wish <goal>`: pursue a goal until it is verifiably done. On Codex and
  current Claude builds, the native `/goal` is preferred; see § Codex goal
  commands and § Claude goal commands. YA exposes `/goal <goal>` as an alias
  that sends `/loop wish <goal>` only when Claude reports `/loop` but not
  `/goal`.
- `/rep ...`: repeat or self-pace a prompt across wakeups. This is ordinary
  command behavior, not a side-session helper.
- `/doubt ...`: run an independent re-check before comparing with the prior
  answer. When YA implements this without provider-native support, it may use
  the shared helper side session from
  [side-session-config.md](side-session-config.md), but independence is an
  instruction to the helper, not a special partial-catch-up mode.
- `/harsh-review ...`: run the stricter structural/correctness review pass.
  This is ordinary command behavior unless a provider later ships an equivalent
  native review command.

## Future Skill Distribution

YA should not silently assume these skills exist in the user's provider
environment. If a provider session lacks the target skill/command, the first
product step is to explain that the command is unavailable and suggest
installing the relevant `github.com/graehl/agents` skill, with a link or
copyable install instruction.

Vendoring is a possible later implementation choice for YA-private use, such
as a side-session `doubt` helper. If YA vendors a skill, keep two concerns
separate:

- User slash-command invocation remains explicit. YA must not cause the user's
  agent harness to run a vendored skill just because matching text appears in
  the conversation; invocation still requires an advertised slash command or a
  YA-owned explicit route.
- A user-installed skill or provider-native command of the same name wins over
  YA's bundled fallback. Vendoring supplies a fallback implementation, not an
  override of the runner's chosen skill version.
- Private helper prompt text can be bundled for YA orchestration, but should
  use the same precedence rule: prefer the user's installed skill when it is
  available and intentionally invoked.

In other words, vendoring must not create accidental non-slash invocation, and
must not replace a user-customized skill of the same name. Native provider
commands still take precedence, and no vendoring work is implied by the current
recap/goal implementation.

## Tests That Should Fail On Contract Regressions

- A YA-advertised emulated command sent as the first message of a new or
  resumed provider session reaches the provider as its expanded/routed form.
- A directly queued or deferred-promoted emulated command reaches the provider
  as its expanded/routed form.
- If a provider advertises a native command with the same name, YA does not
  rewrite that command.
- An advertised but unsupported YA-routed command fails visibly instead of
  being sent to the provider as plain prompt text.
- Provider-native local output reaches both a live subscriber and the replay
  buffer, while the provider receives no user/model turn.
- Provider argument completions filter after an exact command token, insert the
  provider-authored value, and disappear for a complete or free-form argument.
- Stopped Codex sessions preserve the `/goal` objective hint and control
  completions, and every advertised goal control dispatches without a model
  turn.
- A Claude transcript whose last goal row is the set sentinel reports an active
  goal; a met, impossible, or cleared row reports none, except when the clear
  is the one YA requested for a pause.
- Claude `/goal pause` sends a clear and reports `paused` only once the
  transcript confirms it; `/goal resume` reissues the remembered objective.
- A not-yet-met row for the pausing objective, arriving before the clear,
  still yields `paused`; an installed row for another objective does not.
- A Claude build advertising no native `/goal` keeps the `/loop wish` alias and
  publishes no goal state, including when session metadata holds a saved goal
  observation.
- A Claude session whose transcript gains a goal row mid-turn publishes the new
  state in a `commands_changed` inventory at the turn boundary, and publishes
  Claude's own auto-clear the same way.
- Supported `/archive` projects `/archive`; an archive-incapable but done-capable
  server projects `/done` without receiving an archive request. `/title` is
  handled locally and never reaches a provider or focused aside.
