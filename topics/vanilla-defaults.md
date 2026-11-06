# Vanilla Defaults

> Out of the box, YA must feel exactly like the first-party provider UIs
> users already know; every YA-novel user-visible behavior ships
> configurable and default-off until promoted by a deliberate product
> decision.

Topic: vanilla-defaults

## Theory

YA's users arrive trained by first-party surfaces — the Claude Code TUI,
claude.ai web, the Codex CLI/app, desktop agent clients. The overarching
UX rule for all new user-visible features: a first-time user must not
have to learn, or even notice, a new concept. In the maintainer's words
(2026-06-11): "it should just be totally normal like the desktop
applications", "I don't want to have something that requires people to
think when they first use it", "the default behavior should just be
totally vanilla".

This is a rule about *defaults and onboarding*, not about ambition.
Novel features remain welcome — do not assume first-party harnesses have
already implemented every useful behavior. The constraint is only that
novelty must never be the out-of-the-box experience.

## Contract

- **Default behavior is indistinguishable from first-party
  expectations.** If a user who has only ever used the provider's own
  UI would be surprised, the behavior is YA-novel and falls under this
  contract.
- **YA-novel user-visible behavior ships configurable and default-off.**
  This applies to UI chrome, new interaction concepts, and — easy to
  miss — anything that modifies what the user submitted before it
  reaches the provider. Sent text is delivered verbatim by default,
  apart from explicitly invoked transforms (emulated slash-command
  expansion, attachment references): "when I send a message I want my
  exact message to be sent", with no YA-added framing or annotations.
- **The filesystem is also a user-visible surface.** Creating hidden state,
  growing a checkout, or changing its Git metadata is observable even when an
  exclusion keeps `git status` clean. YA-managed project storage is therefore
  novel and default-off; ordinary project/session viewing stays project-read-
  only. See [project-directory-storage](project-directory-storage.md).
- **Established-convention affordances, invisible until invoked, may
  ship always-on.** A behavior a first-party-trained user already
  recognizes from common harnesses — a shell-escape command prefix such
  as `!!`, echoing the Claude Code TUI's `!` bash mode — is not
  YA-*novel*, so the novelty test that drives default-off does not fire.
  It may ship always-on when all three hold: (1) it mirrors an
  established cross-harness convention, (2) it manifests only when the
  user deliberately types its trigger, and (3) it adds no default-visible
  UI surface. This is the same "explicitly invoked transform" logic
  carved out above (slash-command expansion), applied to a command prefix
  that *diverts* rather than annotates: a `!!` line runs locally and is
  never sent to the provider, so the verbatim-to-provider invariant is
  untouched. Any *discoverable* surface such an affordance introduces (a
  sidebar entry, a toolbar section) is itself YA-novel and still ships
  default-off.
- **Believed-useful is not proven-useful.** A plausible, even
  well-argued benefit does not earn default-on; it earns an option.
  Promotion to default-on is a product decision that should state why
  the behavior is safe and unsurprising for users who never chose it
  (see [hard-development-rules](hard-development-rules.md) for the
  configuration-precedence side of that bar).
- **Options must pay rent.** A default-off option that turns out not to
  be useful should be removed, not accumulated. The configuration
  surface is itself a user-visible cost.

Synthetic `/done` is a direct instance of this rule. Its toolbar presence
defaults to Off, so an agent or installed skill named `/done` continues to
receive the user's text. Opting into Hidden enables YA's local command without
adding chrome; visible narrowing tiers also show its toolbar button.

A configurable, visible resource-protection limit may default safer than the
first-party harness only when invisible nested fan-out can cause unpredictable
token or quota burn, the provider default remains an explicit choice, and the
Maintainer has authorized the exact exception.

## Known Exceptions

**Server Connections availability** defaults on, authorized by the maintainer
on 2026-11-01. An empty installation needs no separate enable step; each device
still requires owner-authenticated enrollment and a directional grant. No peer
is contacted without configuration. Settings offers pairing/removal rather than
a global enable switch. `YEP_PEER_API_ENABLED=false` remains the optional kill
switch; explicit owner-API disablement and environment overrides are respected.
See [peer access](peer-access.md).

**Agent use of paired servers** defaults on, authorized by the maintainer on
2026-11-01. Server enrollment and local Agent API access remain explicit opt-ins;
paired servers are intended for agents without another visible enablement step.
The separate agent-use option remains configurable through the owner API but is
hidden in Settings. Source and target grants still apply, and existing launches
are not upgraded. See [peer access](peer-access.md#manual-owner-ceremony-and-management-api).

**Remote SRP resume persistence** defaults on, authorized by the maintainer on
2026-10-31 so normal direct/relay logins survive server restarts. Saved opt-outs
remain authoritative, storage uses the existing private resume-credential file,
and existing expiry/revocation still apply. This does not persist owner
passwords or change independent peer credentials. See the
[resume contract](mobile-server-pairing.md#current-srp-resume-facts).

The **session read/unread shortcuts** ([inbox](inbox.md#readunread-keyboard-actions))
are always available, authorized on 2026-10-18 after the maintainer requested
single-key session triage. Unmodified `r` and `u` explicitly set read state for
the focused session; they leave typing, menus, dialogs and viewers alone. Their
only visible addition is a key hint beside the existing menu action.

The Inbox's **provider-phase indicators**
([provider waits](provider-wait-and-background-work.md#contracts)) are always
on, authorized by graehl on 2026-11-06 after approving the mockup. They refine
YA's own Active-row dot, which had no first-party equivalent, so it no longer
claims generation while a turn waits on a command or background work holds an
ended turn: a ring and a short pill replace the dot, and background-held
sessions move into a Background tier shown only while it has rows. Queue and
idle behavior are unchanged.

The File Viewer's **clickable path segments**
([media routing](media-rendering-and-routing.md#resource-actions-and-file-presentation-choice))
are always on, authorized by graehl on 2026-10-29 after approving the mockup.
Clickable path breadcrumbs are an established file-browser convention; the
path keeps its width, folders keep its link color, and the visible changes
are muted separators and a plain-text file name. Right-click on a folder now
opens a folder menu instead of the file menu, which the name and separators
keep.

The **managed first-party artifact viewer** is enabled by capability for the
first-party hosted client, authorized 2026-10-16. Opening agent-generated HTML
with its local assets is an expected file-viewing action; users need no domain
or tunnel setup. It uses isolated content origins and the existing encrypted
connection, preserves explicit custom deployments, and falls back on older
servers. See [active-content security](active-content-security.md#managed-first-party-relay-previews).


The New Session **model-list provenance line**
([session-defaults](session-defaults.md#provider-catalog-readiness)) shows by
default under the model picker, authorized by graehl on 2026-10-06 after
choosing the muted "updated Xm ago · Refresh" form. A built-in fallback list
can omit or misname current models, so the user must be able to tell it from a
live list without opening settings. The live state is one muted line; only a
fallback or failed refresh uses warning styling. It sends nothing to the
provider until Refresh is clicked.

The **context breakdown** ([context-breakdown](context-breakdown.md)) shows by
default in the existing context-usage popover, authorized by graehl on
2026-10-01 after accepting its mockup. It mirrors Claude Code's `/context`,
appears only when the user opens that popover, and adds no visible chrome; it
renders nothing for sessions whose provider cannot report one.

The **last file chevron** ([parked-file-viewer](parked-file-viewer.md#last-file-after-close))
is default-visible in spare session right margins, authorized by graehl on
2026-09-30 after accepting its mockup. It remembers only the last file-view
route per session ID in browser storage, survives Close and reload, and opens
the ordinary viewer only when clicked. It hides on narrow layouts and while
the existing viewer is open or minimized.

The **`/v` / `/view` view command** ([view-command](view-command.md)) ships
always-on wherever the server supports it, authorized by graehl on
2026-09-30. It acts only when the user types it, opens the file viewer a link
click already opens, and sends nothing to the provider. Its only default-
visible trace is its row in the slash-command menu. A provider command or
skill named `v` or `view` keeps that name, and `/v` then reaches the provider
unchanged.

**Copy Markdown** defaults visible in the existing selection actions, authorized
by graehl on 2026-09-29 to keep Markdown copy accessible on mobile while native
Copy and `Ctrl/Cmd+C` copy visible text. Its blue copy icon sits above quote
reply on mobile; an explicit saved visibility choice remains authoritative.
See [rich-text rendering](rich-text-rendering.md).

The server runtime upgrade notice is default-visible and nonblocking, authorized
by the Maintainer on 2026-09-08 so remote users can arrange a runtime upgrade
while continuing to use their existing server. It adds no frontend cutoff or
update-command gate. See [server runtimes](server-runtime.md).

The session toolbar's Search transcript button ships default-visible,
explicitly authorized by graehl on 2026-09-23 so that touch users can discover
transcript search, which otherwise needs Ctrl+R-style keys. It takes the
lowest narrowing tier, so it shows only where the bottom row has spare width
and otherwise sits in `...`; opening search is its only effect. Toolbar settings
can hide it. See
[composer-bottom-bar-overflow](composer-bottom-bar-overflow.md).

Structured Codex async questions and their toolbar reminders ship default-on,
explicitly authorized by graehl on 2026-09-07. They make an existing provider
question answerable without blocking ongoing work. Clickable choices and the
inline reply composer send only after a deliberate user action. One searchable
**Question reminders** slider in Toolbar settings scales both reminder-aging
stages; zero hides toolbar reminders while transcript answering remains
available. There is no separate enable setting. See
[provider-output-contract](provider-output-contract.md#asynchronous-codex-questions).

[provider-runtime-status](provider-runtime-status.md) gives Codex
`serverOverloaded` turns a built-in, bounded same-model retry. Codex itself
ends these turns, but the failure is transient and the recovery adds no new
user concept or submitted text: YA resamples the already-recorded turn after
20, 45, 80, 125… seconds, exposes the existing retry status, and stops after
16 attempts or an explicit abort. Quota and other terminal errors are
unchanged. Authorized by graehl on 2026-08-24 in the originating request, with
the five-times-slower schedule supplied as a follow-up.

The server-wide **Subagent nesting limit** defaults to depth `1`, rather than
Claude Code's first-party default of `3`. Native subagent fan-out can multiply
token and quota use before an operator can see or stop the deeper work, so this
configurable resource guard intentionally starts safer. `0` disables subagents,
`1` through `4` select an explicit maximum depth, and **Provider default** makes
YA inject no override. An explicit Claude or Grok depth value in YA's
environment still wins. The control identifies its actual provider coverage
and applies only to newly started or resumed processes; it never mutates
provider configuration files. Authorized by graehl on 2026-08-16 as a
deliberate quota-protection exception. See [claude](claude.md),
[codex-sessions](codex-sessions.md), and [grok](grok.md).

Claude Gateway's **Disable plan mode** setting defaults on. Gateway-routed
copilot-api models can otherwise drift into Claude Code's plan workflow, so YA
removes only `EnterPlanMode` and `ExitPlanMode` from the Agent SDK launch.
Regular Claude and task tracking remain unchanged, the setting is explicitly
opt-outable, and a stored false stays authoritative. Authorized by graehl on
2026-08-17 as a deliberate Gateway reliability exception. See [claude](claude.md).

[source-review-to-session](source-review-to-session.md) defaults review
history and outcome visibility on for new installs. A review is already an
explicit user action; the default makes its submitted history and eventual
agent response discoverable in Source Control and Inbox. With no submitted
review, it performs no response-observation work. The setting remains
available, explicit stored false remains authoritative, and old stored false
values are not migrated because they cannot be distinguished from an earlier
untouched default. Authorized by graehl on 2026-08-11.

[composer-full-pane-editing](composer-full-pane-editing.md) adds a visible
full-pane toggle to the New Session, editable handoff, and in-session
composers. The in-session top-right control remains available in the one-line
composer and is currently a live placement prototype. Authorized by graehl on
2026-08-08 for New Session and handoff, then extended on 2026-08-09 to the
in-session composer because the mode remains entirely user-invoked; ordinary
composer behavior and draft submission are unchanged until the user enters it.

[tooltip-interactions](tooltip-interactions.md) Themed tooltips ship default-on
for browsers without an explicit saved mode. Explicit Native and Themed choices
remain authoritative. Authorized by graehl on 2026-08-04 after the
pointer-generated touch-focus reopen defect that motivated the temporary Native
default was fixed; the shared layer now provides fast scanning, selectable text,
and readable glossary definitions without changing control activation.

**`!!` bang commands** ([bang-commands](bang-commands.md); recall drawer
in [composer-recall-drawer](composer-recall-drawer.md)) run a local shell
command from the composer instead of sending the line to the provider.
Under the established-convention carve-out above — shell-escape is
familiar (Claude Code `!` bash mode), the `!!` prefix is typed
deliberately, and provider-bound text is untouched — bang *execution* and
the Ctrl+Up recall drawer ship always-on; only the discoverable "!!
Commands" sidebar section stays default-off. Authorized by graehl
(2026-07-25) as an explicit amendment reversing an earlier default-off
decision, and canonized here (and in the commit) for kzahel's review
given the default-disabled preference ([kzahel-disabled](kzahel-disabled.md)).

[prompt-cache-keepalive](prompt-cache-keepalive.md) must default off, including
no-context-move refreshes. The 2026-10-27 decision supersedes its earlier
default-on exception: enabling it requires at most ten refreshes between real
uses, a running net-savings UI log and durable per-session loss disablement.
Live-viewer leases and no-context-pollution constraints remain. The topic's
implementation checkpoint distinguishes this selected policy from the current
default-on implementation.

**Handoff from…** on the scrollbar turn-notch menu ships default-on.
Authorized by graehl on 2026-09-09: it is an explicit successor-session
start from a selected in-memory turn, copies that session's launch
options, and does not change ordinary send or Conversation view
presentation. See [fork-from-turn](fork-from-turn.md) and
[conversation-view](conversation-view.md).

[conversation-view](conversation-view.md) and its Session Toolbar control ship
default-on. The condensed projection keeps user/agent conversation, media, and
important failures visible while preserving one-click access to every routine
activity in original order. This was approved by graehl on 2026-07-28,
relaying Kyle's chat approval, because the resulting default matches the
condensed conversation presentation users already encounter in the Codex and
Claude harnesses. Existing browser-local mode and toolbar-presence choices
remain authoritative.

[mic-button-speech-ui](mic-button-speech-ui.md) ships the configurable live
microphone waveform default-on, with toolbar-button backgrounds at 70% opacity
over it by default. It appears only during an explicit YA-controlled microphone
capture, uses real audio samples, and changes no submitted text or provider
behavior; browser-native Web Speech receives no fabricated waveform. Users may
hide it or set button backgrounds anywhere from fully transparent to fully
opaque. Authorized by graehl on 2026-08-11 so microphone feedback is
discoverable without requiring users to predict the useful opacity first.

[media-rendering-and-routing](media-rendering-and-routing.md) compact
multi-image galleries ship default-on as a browser-local Appearance preference.
For an assistant turn with at least two eligible images, the preference enables
one turn gallery while preserving every original text link and full-size target.
**Expand Inline Media by Default** controls only whether that gallery starts
open. When inline expansion is off, a compact **Gallery** action beside the
final image link makes the capability available without expanding content. It
is a stateful **+ Gallery** / **− Gallery** toggle, while each image's own
`+` / `−` toggles the same gallery centered on that image. Image links retain
their conventional direct-view behavior without changing inline gallery state.
Disabling the gallery preference removes the action and restores independent
inline previews. Authorized by graehl on 2026-07-29 because the default bounds
an already-requested automatic presentation, adds only a contextual action on
multi-image turns otherwise, and avoids burdening new users with another
preference.

[agents-process-observability](agents-process-observability.md) ships
default-on in the existing Agents view. Sampling is request-driven and occurs
only while that view is open and visible; a Performance setting disables it,
and a user can also avoid the work simply by not opening Agents. The browser
receives only normalized provider identity, PID, start/sample times, recent
CPU, and RSS/process-tree counts—never command lines, environment, executable
paths, or working directories. Authorized by graehl on 2026-07-28 as an
explicit product decision: Agents is already the process-inventory surface,
and standard process metrics plus independently launched agent processes make
that purpose useful without changing session or provider behavior elsewhere.

[steer-queue-provider-differences](steer-queue-provider-differences.md)
promotes Claude's existing **Steer now** preference to default-on when no stored
preference exists. An explicit false remains authoritative and restores the
`next` lane. Authorized by graehl on 2026-08-08 after live Claude 2.1.223 probes
showed that `now` stayed queued behind a foreground Bash command without
interrupting or backgrounding it, while a second correction delivered 112 ms
after the first boundary correction prevented the first correction's proposed
tool call. The behavior reduces the correction race but does not make separately
submitted steers atomic; the provider can still launch a tool before a later
message arrives. Transparency for non-Bash tools remains unverified.

The same topic defaults Claude foreground-Bash re-entry on for all main-turn
commands, configurable through the server's whole-command allow/deny expressions.
Authorized by graehl on 2026-08-08 after exact-ID SDK probes showed that Bash
continued to completion while Claude received the already-enqueued correction and
no forbidden follow-on command launched. This does not interrupt the command, but
it lets Claude act concurrently with it; operators can deny expensive,
side-effecting, or lock-holding commands. Other tool types, subagent-owned Bash,
and the SDK's all-task background control remain excluded.

YA launches Codex sessions with Codex 0.164's default-on `instant_interrupt`
feature disabled, so a steer lands after the current tool call instead of
discarding a response or tool call still being generated. This departs from
first-party Codex 0.164 but restores YA's documented steer lane, which a live
on/off probe confirmed the flag had broken. Any mention of `instant_interrupt`
in the user's `$CODEX_HOME/config.toml` stays authoritative and suppresses the
override. Authorized by graehl on 2026-10-23 after a session lost four
multi-minute writes to steers. See
[steer-queue-provider-differences](steer-queue-provider-differences.md).

[mic-button-speech-ui](mic-button-speech-ui.md) treats conservative
mid-sentence capitalization smoothing as built-in speech-input behavior, with
no preference. Some recognizers title-case every finalized phrase after a
pause; YA lowercases only an allowlist of ordinary continuation words on a
second or later chunk in the same mic transaction. Sentence starts, provider
revisions, acronyms, single letters, and unlisted title-case words remain
provider-verbatim. Authorized by Kyle on 2026-07-30 as an explicit product
decision after observing the pause-boundary behavior interactively.

## Known exception: default speech annotation

[mic-button-speech-ui](mic-button-speech-ui.md) offers a browser-local
**Speech message prefix** selector with `🎤`, `[ASR]`, `[STT]`, `[Dictation]`,
Custom, and Off choices. The selector defaults to `🎤`, so Smart Turn and
spoken `send` prepend the microphone emoji plus one separating space. An
optional Quick-send window extends the selected prefix to one rapid manual
delivery after finalized speech; it defaults to 0/off. Explicit stored choices
remain authoritative. Graehl authorized this provider-text exception on
2026-08-22; Off continues to guarantee verbatim delivery.

## Worked instances: queued-turn delivery

[compose-time-context-anchors](compose-time-context-anchors.md)
prepended `(Ns ago)` / `(Ms later)` staleness markers to queued turns at
delivery, so an agent would not misread a stale queued comment as
referring to its most recent output. The benefit was believed but
untested, and the mechanism rewrote provider input — the provider saw
text the user did not type. Upstream removed it outright
(`25e7f5d1`, "Keep queued messages verbatim"). The resolution under this
theory and [kzahel-disabled](kzahel-disabled.md): preserved behind
`YEP_COMPOSE_ANCHORS=1`, default off.

Batched deferred flush is the sibling instance: merging several queued
turns into one `--------`-joined provider turn defeated the upstream
usage of queueing N "good, proceed" messages to buy N work slices, and
was claimed to differ from first-party queue delivery. Default is now
one verbatim deferred turn per delivery boundary; joining is preserved
behind a configurable compose-time join window
(`deferredJoinWindowSeconds` server setting / `YEP_DEFERRED_JOIN_WINDOW_S`,
0 = never join). The blind-go-ahead intent itself deserves a first-class
control someday (a slice or duration budget), rather than riding on
queue mechanics.

## Worked instance: live worktree monitoring

Source Control's lease-backed live filesystem snapshot defaults on only on
Linux, where its bounded native-watcher profile has been measured. macOS stays
off after its watcher-exhaustion incident, and Windows stays off pending native
measurement; explicit opt-in on either uses poll-only reconciliation. Core YA
sessions, static Git status, bounded working-tree inventory, explicit refresh,
and file viewing do not require live monitoring. Continuous monitoring is
YA-novel and may scale with an externally controlled directory tree, so the
Linux default is a deliberate measured exception rather than a general
promotion. Hard watcher ceilings and resource-exhaustion fallback remain
mandatory wherever native watchers run. See
[source-control](source-control.md) and
[live-worktree-resource-safety](../docs/tactical/113-live-worktree-resource-safety.md).

## Related topics

- [hard-development-rules](hard-development-rules.md) — explicit user
  configuration is authoritative; trust-sensitive defaults need opt-in
  or migration paths.
- [kzahel-disabled](kzahel-disabled.md) — upstream disablement of a
  speculative feature is a product signal; prefer configurable
  default-off preservation over silent code stripping, with the
  maintainer choosing the resolution.
- [session-ui-customization](session-ui-customization.md) — the
  visibility/enablement configuration surface that default-off UI
  features typically live behind.
