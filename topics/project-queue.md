# Project Queue

> Project Queue is a durable, server-owned backlog for work that should start
> only after a whole project becomes quiet.

Topic: project-queue

It is project-scoped, not global across the YA install, and it is separate from
the existing per-session queue.

This topic describes the current single-lane model: one project checkout is
treated as the scheduling unit. [`workstreams.md`](workstreams.md) describes
a proposed lane-aware extension where Project Queue items can target a
specific lane — the canonical main checkout or a separate lane checkout —
instead of waiting for the whole project.

The candidate replacement for Hono's in-memory launch callback lives in
[Project Queue sketches](project-queue.sketches.md#provider-host-yacron-launch-requests).
It requires provider-host-integrated yacron and preserves this topic's complete
idle predicate; standalone yacron is explicitly ineligible.

## Core Semantics

- Project Queue items are persisted on the server. Clients must not mirror the
  queue in localStorage or hold invisible scheduled sends.
- Queue targets are either an existing YA session id or a future new session in
  a project. A provider with an authoritative catalog is revalidated at actual
  new-session process creation; enqueue-time UI validation cannot remain launch
  authority across an arbitrary queue delay. If promotion hands a new session
  to the internal worker queue, the durable item stays `dispatching` until that
  worker launch settles. Successful start removes it. Authoritative validation
  or a non-retryable launch failure moves it to `failed` with the reason,
  preserving the prompt for retry. A transient provider-startup failure before
  the provider reports its canonical session id returns the same item to the
  head of its project queue. The third consecutive startup failure pauses that
  item as `failed`; Retry resets its startup-failure count. This item-local
  pause does not set the global dispatch pause, although a failed head item
  continues to block later work in that project by ordinary queue ordering.
  A direct Gateway caller without this durable settlement channel receives the
  existing `queue_full` response at worker capacity instead of an acceptance
  whose deferred validation failure it cannot observe.
- An existing-session item resumes its session inside the sandbox the session
  was created with, as `/resume` does; a queued turn never asks for a
  different boundary.
- An item records the limited user who queued it, if any. That user's launch
  policy applies when the item is queued or edited and again at dispatch from
  their grants at that time, and the turn and any new session are attributed
  to them ([limited-users](limited-users.md) § Delivery v1). An item with no
  recorded user is the superuser's.
- Delivery never rewrites user text with hidden prompt framing, elapsed-time
  markers, or automatic anchors.
- A normal session queue is lower-level than Project Queue. Existing in-turn
  work, direct provider queue depth, deferred queue depth, pending input, and
  retained provider work must all drain before a Project Queue item promotes.
- Project Queue promotion requires the project to remain idle for the configured
  project-quiet window, then re-checks project idleness immediately after
  claiming the item.
- An admitted user request to start or reactivate a session reserves that
  project as busy before provider startup begins. The reservation remains until
  the provider harness has successfully started or the request reaches a
  settled failure, closing the gap before the new process appears in the
  ordinary idle predicate.
- Promotion handles one Project Queue item per project-idle boundary. Do not
  drain the project backlog in one burst.
- A global Project Queue dispatch pause gates automatic promotion above all
  project items. A valid action that mutates or dispatches an existing item
  (edit/save, delete/cancel, retry, reorder, Start/Force start, or Steer now)
  resumes dispatch globally before completing that action. Read-only actions
  such as Copy do not resume dispatch.
- A server restart with persisted Project Queue backlog starts
  paused-after-restart by default. After inspecting any work that may have been
  interrupted by the restart, the user can use Resume or act on an item; either
  path resumes dispatch.
- Dev-mode scheduled safe restart also pauses Project Queue dispatch before
  waiting for active sessions and in-memory session queued messages, including
  per-process direct/short-term deferred queues, to drain. Live patient
  session-queue entries are preserved as restart-paused work once those
  volatile blockers have drained. The durable Project Queue backlog survives
  the restart and remains visibly paused until the user resumes it. Persisted
  recovered patient session-queue entries are reported as preserved work in
  safe-restart status rather than as drain blockers, but they still count as
  project-busy for Project Queue promotion so project-level work cannot jump
  ahead of restart-paused per-session work.
- Empty Project Queue state is always normal/running. Do not preserve a hidden
  pause after the last queued/failed/dispatching item leaves the queue.

The intended ordering is:

1. Active provider turn.
2. Per-session direct queue.
3. Per-session deferred/patient queue according to its own rules.
4. Verified project idle.
5. One Project Queue item.

This means a session with five normal queued messages should finish those
messages before Project Queue starts. Project Queue is not a competing second
queue on the same session; it is a project-level backlog that injects only
after all lower-level work in the project is done.

## Durable new-session admission

Superuser ordinary text items supported by the common creation owner now use
[durable session admission](session-identity.md). The queue item id supplies a
stable operation key across promotion and restart. Admission saves the permanent
YA id, exact initial input, launch choices and original source before native
startup; Queue persists the item-to-session association before dispatch. Reads,
edits and dispatch claims recover an interrupted association from the compact
durable operation key, so the JSON write gap cannot allow a changed/retargeted
request to replace admitted input. Once
accepted, the common owner/worker queue owns startup, including worker deferral.
Project Queue completes its item and returns the saved YA session id rather than
owning another deferred-start/retry lifecycle. Provider-native ids never replace it.

Repeated promotion recovers the existing admission. Confirmed delivery completes
an interrupted Queue handoff without starting another provider. Unknown native
effects retain the saved session and refuse initial-input replay. An explicit
Retry can create another attempt under the same public id only after a proved
`failed`/`not-admitted` outcome. Qualified durable creation does not use Queue's
legacy automatic native-startup retries. Queue state and SQLite are separate
stores; a deterministic admission key recovers an interrupted association write,
without claiming a cross-store transaction.

A failed item exposes `creationSessionId` and an Open saved session link.
Accepted input is immutable: remove the item and enqueue changed input as new
work, rather than silently rewriting the saved request. Original source-less
legacy items retain unknown provenance through an explicit legacy-Queue context;
creator authority is independent of that descriptive source. Missing saved
admission for an already associated item refuses a replacement launch.

Attachments, limited-user/sandbox launches and other unqualified input/provider
shapes retain their existing implementation until the remaining consolidation
slices. Existing-session items keep their existing delivery policy. The optional
summary association is additive; older servers omit it and older clients ignore
it. This does not advertise the broader all-caller creation receipts capability.

## Quiet Window

Project Queue's quiet window is a user-interaction patience setting, not a
replacement for the idle predicate. Per-session direct/deferred/patient queues,
pending input, active provider turns, retained provider work, worker queue
entries, and known external ownership still block Project Queue absolutely.
Once those blockers clear, the project must stay clear for the quiet window
before one Project Queue item may promote.

Queue status must be server-computed. Project Queue responses expose each
project's scheduler state (`blocked`, `waiting-quiet`, `ready`, `dispatching`,
`paused`, or `empty`), the configured quiet window, the next eligible timestamp,
raw blocker strings, and resolved display titles for blocker sessions when
available. The client may format that state as "waiting for quiet" or "blocked
by ..." copy, but it must not infer idleness from stale local session rows.
Blocker strings keep their wire form (`<sessionId>:<reason>`, `readiness:…`,
`worker-queue`, …); shared `parseProjectQueueBlocker` is their one reader and
`PROJECT_QUEUE_SESSION_BLOCKER_REASONS` their one list of session reasons, so
every reason, `automation-paused` included, renders as words. The UI names the
first `PROJECT_QUEUE_NAMED_BLOCKER_COUNT` (three) blockers and counts the rest;
the server resolves titles only for sessions among those named blockers.

Blocked automatic attempts must stay live. If a quiet-window timer fires while
absolute blockers remain, the scheduler keeps a bounded retry armed while
backlog remains so decaying liveness or external-ownership evidence cannot leave
the Project Queue inert forever.

Queue collection reads are retained projections, not provider discovery
triggers. Existing-session titles come from the
[`compact session catalog`](session-catalog-observation.md) plus immediate YA
metadata. Project and global queue reads share the catalog's accepted project
shard read, including after restart; concurrent requests join its source-versioned
read owner. A public session ID selects its exact native binding and original
project, with the working project checked against the queue's project. Legacy
lookups require unambiguous project/provider membership. No match means unknown
rather than confirmed absence: titles remain nullable until normal catalog
reconciliation supplies them. Queue reads do not initiate provider discovery,
native replay, identity adoption or title enrichment. Immediate custom metadata
still takes precedence. Repeated queue reads with unchanged state perform no provider,
session-index miss, transcript, or all-project work.

A limited user's global queue collection and promote-now response project
ordinary items, recovered session-queue items, and project-status entries to
that user's granted projects. The global dispatch pause remains visible because
it gates promotion of their own items too. This projection is an explicit
response-field allowlist: a field added to the global response is withheld from
limited users until its project scope is defined.

Item, dispatch, blocker, quiet-window, external-ownership, and recovery
transitions update one server-owned project-status projection and publish a
versioned delta. Client components share one source/query revalidation owner.
They render countdowns from server timestamps and may arm one exact
source-level deadline or capability-gated legacy poll; they never each start a
fixed interval. Existing catalog publications and user-set session metadata
changes revalidate that same shared source/query owner, so newly published or
renamed titles reach all mounted queue consumers. These are optional existing
events: older servers retain the normal refresh/reconnect/queue-event path;
no new wire field, action or capability meaning is required.
An event that lacks title fields must merge as a partial patch
and cannot erase a known catalog-backed title.

The configurable range is 0-300 seconds, default 30 seconds. A value of 0 means
"promote as soon as the project idle predicate is true", while still performing
the immediate post-claim idle re-check. The effective minimum is therefore the
time required for lower-level queues to actually drain plus the configured
Project Queue quiet window; Project Queue must not rely on the patient-queue
safety margin as its only protection against launching too early.

## External readiness check

Settings → Message Delivery → Project Queue can configure one optional
server-wide readiness executable. It is unset by default. Saving or disabling
it takes effect on the server immediately and applies to every project's
queue, regardless of which browser configured it. The server stores
`projectQueueReadinessCheck` as `{ executable, args }` or `null` (disabled),
alongside the other server settings. Arguments are passed literally, without
a shell; the executable runs in the selected project's directory. Use a
native executable or executable script supported by the server OS; Windows
shell scripts such as `.bat` are not implicitly run through a shell.

Exit 0 permits promotion, subject to the normal project-idle predicate and
quiet window. Every nonzero exit holds the item; the first nonempty stdout
line, or stderr line when stdout has none, supplies the waiting caption.
Captions have terminal decoration removed and are limited to 512 characters.
Launch failures, signals, excessive output, and timeouts hold the item with
a server-generated explanation. No output is interpreted as instructions.

Automatic checking uses the existing blocked retry cadence, with a minimum
of ten seconds between attempts per project. Activity events and settings
changes cannot create a faster automatic poll. Queue/status reads never run
the executable. Once a blocked check clears, the quiet window starts again;
promotion rechecks readiness after that window, respecting the same polling
minimum. A zero quiet window permits promotion on the first clear result.
Readiness changes publish through the existing Project Queue event stream
(`reason: readiness`), sharing the client's existing revalidation owner.

Start now skips the quiet window and runs a fresh readiness check. Force start
bypasses the readiness check as well as ordinary idle blockers; the existing
in-flight dispatch guard still applies. Checks are advisory: YA acquires no
external claim and cannot eliminate the race between a clear verdict and
starting a session. A launched session remains responsible for its own claim.
For example, an independently installed `agentctl` can be configured with
arguments `others` and `--text`; YA does not depend on or vendor that tool.

The server bounds checks to four concurrent subprocesses and 8 KiB combined
output per check, with a five-second deadline. Pausing dispatch, emptying the
queue, changing the command, or disposing the scheduler cancels active checks.
POSIX checks run in a process group for descendant cleanup. Windows uses a
bounded `taskkill /T /F` helper, then direct-child cleanup if unavailable.
Commands must not detach independent background jobs; Windows tree cleanup
cannot recover descendants that have already outlived their parent. There is
no recurring check for an empty or paused queue. Server control-plane
credentials are removed from the child environment.

Compatibility approved 2026-09-07: optional capability
`project-queue-readiness-check` covers the setting on existing settings GET/PUT
routes. Stable v0.8.0 and v0.8.1 lack it. Clients hide the control and omit the
field when the capability is absent; existing capability meanings and queue
routes stay unchanged. The capability is version-implied from v0.8.2.

Per-project replacement/None choices and a future blocking-until-clear check
are deferred in [the readiness override gap](../gaps/sketches/project-queue-readiness-overrides.md).

## Project Idle Predicate

A project is not idle while any owned session in that project has:

- active `in-turn` or `waiting-input` state;
- retained provider work while otherwise idle;
- direct provider queue depth greater than zero;
- deferred queue depth greater than zero;
- pending input;
- liveness other than `verified-idle`.

A session whose user has queued `/done` is exempt from all of the above for
Project Queue promotion. The user has declared that session finished, so the
final action the agent is still completing is not backlog the next queued
request should wait behind, and the queued `/done` chip itself must not read as
a deferred-queue blocker. The exemption is Project Queue's alone: the
inactivity push notifier reports whether work is literally still running and
therefore keeps counting that session.

A project is also not idle while it has a worker/startup queue entry or known
external session ownership. It is likewise not idle while an admitted
user-initiated session start is still establishing its provider harness.
Project Queue promotion also treats persisted
`paused-after-restart` patient session-queue entries in the project as
not-idle, even when no live process currently owns those entries. External
ownership is best-effort and can decay; UI copy must not promise perfect
detection of all outside provider activity.

## Design decisions

- **Resolve effective working-project membership at the idle predicate (vs.
  mutating a live process's launch project):** `Process.projectId` remains the
  launch directory fact used by provider/runtime code. Project Queue overlays
  `SessionMetadata.workingProjectId` when assigning that process's active turn,
  retained work, and session queues to a project. Moving a session reschedules
  both its previous and destination projects: the previous project may begin a
  new quiet window, while the destination immediately inherits every live
  blocker. This keeps transcript location, process launch directory, and the
  user's explicit working-project classification as separate facts.

## UI Semantics

The toolbar affordances are YA-novel behavior, so both are hidden/default-off
unless the user opts into them. The current-session Project Queue button and
the active-composer `+` shortcut for a future new session have separate
presence settings. Enabling the current-session action must not implicitly
enable the cross-session shortcut.

The two toolbar actions must remain glanceably distinct wherever they render,
including the ordinary composer, compact keyboard-open row, and Toolbar
Settings specimen. The current-session action uses the standard Project Queue
purple. The new-session action uses a darker violet and a prominent
high-contrast `+` badge; the small mark must not be the only perceptible
difference between two otherwise identical buttons.
The circled plus straddles the upper-right button border, leaving the main
delivery arrow centered and unobstructed in both toolbar and keyboard rows.

Project Queue and its active-composer new-session shortcut are baseline
features in current clients. The fixed `projectQueue` and
`project-queue-new-session-shortcut-setting` gates and the redundant hosted
compatibility-generation check were retired on 2026-10-28. Servers below
v0.8.0 should update or use their co-deployed client. Current clients retain
all queue blocking/admission conditions, opt-in shortcut presence, source
readiness and interest-owned request/backstop lifetimes. Newer, separately
gated features such as attachment editing and readiness checks retain their
own capability contracts.

Blocked status groups reasons that name the same session so its short id is
shown once. The group ends with the session's display title as a link to that
session when the server supplied one; older servers retain the short-id-only
fallback.

After restart-paused dispatch, each queued new-session row in the sidebar's
Pending Sessions section exposes a compact Resume control. It atomically
resumes global dispatch and moves that item to the head of its own project's
queue. The ordinary scheduler still decides when it may launch; Resume is not
Force start. Failed items retain their explicit Retry flow instead.

When the button is visible by user preference, the UI should still suppress it
when Project Queue adds no useful semantics:

- Hide when the project is fully idle, has no Project Queue backlog, and normal
  send/start is equivalent.
- Hide when the only active thing is the current session and it has no
  server-visible normal queued/deferred backlog; normal queue is enough.
- Show when the current session already has normal queued/deferred work,
  because Project Queue then means "after this session backlog drains."
- Show when any other session, external session, or worker queue entry in the
  project is active.
- Show when the project already has Project Queue backlog, so a normal send or
  start does not accidentally jump ahead of accepted queued project work.

The dedicated new-session form follows the same rule: hide its Project Queue
action when the selected project is idle and has no Project Queue backlog; show
it when the project has active work or existing Project Queue backlog. Its
entry point remains governed by the ordinary Project Queue presence setting.
Independently of that action preference, the form shows any existing items for
the selected project directly below the project selector. The selector and
queue are one responsive layout unit: they remain in the same side column on a
wide form and move together ahead of provider controls on a narrow form. A
project change replaces the displayed items in place. An empty queue remains
hidden after a successful read, so users who have not invoked this default-off
feature do not encounter a new empty-state concept. An initial read failure is
still rendered even when no stale items exist; failure must not masquerade as a
confirmed empty queue.
Each ordinary Project Queue row shows the provider/model badge saved on its
target before dispatch. Older items without a saved provider omit the badge;
the display is informative and does not replace launch-time provider catalog
validation.
An active session composer's additional "queue as new session" action has
useful semantics even while the project is idle, but it is present only when
the separate `projectQueueNewSessionShortcut` toolbar control is enabled and
supported. The neighboring current-session Project Queue action retains the
activity/backlog visibility rule above.

The new-session initial-turn composer is part of the Project Queue contract.
When it queues a new session, the durable prompt/copy source is the text
accepted from that composer, because that is what the user typed (including
slash-command arguments). The promoted session should persist that text as its
initial prompt and derive its title/display fallback from that saved prompt.
Both the dedicated new-session form and the active-session composer's
additional new-session action create the same durable Project Queue target
shape (`target.type === "new-session"`); neither uses a client-held draft
queue. The active-session action inherits that session's selected provider,
model, executor, permission mode, and thinking settings for the future session.

Right-click (long-press on touch) on the active-session new-session action
opens a purple-tinted dock below the editable composer instead of queueing.
Right-click on the ordinary Send action opens the same dock with green tint.
It has no modal backdrop or explanatory caption. Project is first and widest,
model second, provider third; each starts at the current session's value.
The model dropdown lists the selected provider's catalog. Typing searches
launchable providers, with provider names in parentheses; choosing a completion
also changes the provider. Providers requiring an advertised model retain that
restriction. The composer remains editable while the dock is open.

Green starts a new session immediately through the ordinary session-start
API and navigates to it. Purple creates a new-session Project Queue item;
the toast names its project when it differs. Desktop Enter in the draft invokes
the entry point's action: green from Send, purple from Project Queue.
Shift+Enter and touch-keyboard Enter retain newline behavior. Model-completion
Enter chooses the highlighted model before a subsequent Enter can submit.
An explicit × beside “New session” or Escape exits the mode without changing
the draft; Escape first closes an open model completion list. Normal sending
resumes on exit. New-session delivery reuses draft recovery on failure and
only confirms draft removal after the server accepts the request.
Permission mode still follows the session. Its executor and its implicit
effort carry over only when the provider is unchanged, since another
provider's catalog may reject them; an effort typed in the draft itself still
applies. Cancelling leaves the draft and queues nothing. A click that ends a
long-press never also queues.

Current-session Project Queue action visibility should use both exact active
session ids, when available, and project-level Project Queue blocking-count
summaries. The count fallback covers cases such as a fresh client after server
restart where a project has queue-blocking work but the current session
composer has not yet seen every active sibling session in its local inbox
tiers. Do not derive this fallback from owned-process counts alone; idle
retained YA processes should not expose the current-session action.

When the current-session Project Queue action is visible and the Project Queue
Ctrl+Enter preference is enabled, Ctrl+Enter activates that same
current-session action instead of the regular per-session alternate action. In
the dedicated new-session form, Ctrl+Enter activates that form's new-session
Project Queue action. It does not activate the active-session composer's
additional new-session action. Each binding is intentionally conditioned on
the availability of the button it mirrors, so hiding or disabling Project
Queue cannot silently steal Ctrl+Enter from regular queue/steer behavior.

### Deferred startup-incident presentation

The basic surface is deliberately small: a project card shows a separate
warning badge in addition to its queue count whenever that project has a
`failed` item, and the existing Project Queue row carries the error and Retry
action. The badge is attention state, not another count. Automatic startup
attempts do not produce repeated browser toasts.

Field observation on 2026-08-09 confirmed this settled state after a real
post-restart retry: the item retained its prompt and startup-timeout detail,
rendered `Failed` with Retry/Edit/Delete actions, and kept only its own project
blocked as `Blocked: first queue item failed`. A later full YA reload made the
preceding dirty-server state unsuitable for exact reproduction; it is not
evidence for expanding the incident UI.

A richer state-apparent presentation is worthwhile only if field evidence says
this intermittent edge case is common enough to justify it. A future design
could keep the project card badge stable while expanding the queue row into a
compact incident summary: `startup attempt 2 of 3`, last-attempt time, next
automatic-attempt time, provider/runtime identity, and the last distinct error.
On the third failure it would switch in place to `Paused after 3 startup
failures` with Retry, Edit, Copy, and diagnostic-detail actions. The detail
view could retain the three timestamped errors and whether each failure
happened before provider session identity, making transient host trouble easy
to distinguish from an item-specific launch configuration or provider
rejection. It should remain item-local and avoid a modal, global banner, or
global Project Queue pause.

## Inline Rendering

Session views should render Project Queue items that target the current session
inline near the existing queued-message UI. Use the Project Queue purple action
color, not the normal per-session queue color. Each inline item should display
its Project Queue position within the project backlog so users can distinguish
local session queue order from project-wide queue order.

Inline rendering reuses the current-session queued-message actions for items
that target that session:

- Copy preserves the queued text.
- Edit is available only while the main composer has no text, attachments, or
  uploads. It atomically removes the item from Project Queue and restores its
  text, uploaded attachments, and permission mode into the composer. It is a
  take-to-composer action, not a second in-place queue editor.
- Steer now force-dispatches that item to the existing session with explicit
  steering intent, bypassing quiet/idle blockers and implicitly resuming global
  dispatch first, but not bypassing the per-project in-flight guard.
- Cancel removes the item from the inline queue.
- Resume is shown inline while global dispatch is paused. It resumes dispatch
  without otherwise changing the item.

There is no promote-to-patient action. Patient queue remains a per-session
delivery intent rather than another Project Queue state. The projects page
remains the authoritative queue manager for cross-project inspection, full
in-place edit, retry, and reordering.

An item whose attachments still exist only as Project Queue-owned staged
references cannot be taken into the session composer: removing that item also
cleans those staged files. Keep Edit hidden for that case rather than silently
dropping attachments. Existing-session items normally carry durable uploaded
attachment references and can restore them.

### Future inline editing

The take-to-composer action is intentionally only an incremental editing
affordance. A future inline editor should replace the queued row with a
textarea that grows and reflows the queued-message stack as lines are added,
while preserving the row's project-wide position. It must acquire a
server-visible edit hold before exposing mutable text: otherwise the scheduler
can dispatch the original item while its client-side editor is open. Save
patches the same held item and releases it; cancel restores the original item
and releases it. The shared rationale and interaction contract are in
[`edit-turn.md`](edit-turn.md).

The projects page is also the authoritative global dispatch pause surface. Show
Pause/Resume only while Project Queue has visible backlog. When dispatch is
paused after server restart, copy must distinguish that state from a manual
pause so users understand why durable backlog is not promoting automatically.
While paused, show Resume both in the section header and on each item so the
recovery action is available at the point of work. Any valid item mutation or
dispatch action is also an implicit global Resume.
The projects-page queue manager uses Delete/Remove wording for permanent item
removal. The session-inline queued-message surface uses Cancel, matching the
neighboring per-session queue action even though both remove the persisted
Project Queue item.

Move-to-top is project-local, but invoking it while dispatch is paused resumes
the global dispatcher before applying the project-local reorder.

Each item on the projects page may offer a Start now control. Start now skips
only the remaining quiet-window countdown and implicitly resumes global
dispatch; it still refuses when another item is already in flight for that
project or the project idle predicate reports blockers. When blockers remain
visible, the same item may offer an explicit Force start control. Force start
also resumes global dispatch and overrides the idle predicate, but not
per-project in-flight protection; the UI must surface the blockers before
making that override available.

When recovered `paused-after-restart` patient session-queue entries exist, the
projects page shows them above Project Queue items because they run first and
block Project Queue promotion. Each recovered row offers Resume and Delete
through the existing session-scoped routes. Resume keeps the established
resume-through ordering, while Delete removes only the selected durable id; the
row remains until a server-confirmed collection read removes it. The session
link remains the surface for full context and Steer now. There is no
project-wide Resume all action.

## Queued YA commands

A YA-emulated slash command is not provider text: the composer normally
consumes it and performs the operation immediately. That is exactly wrong on
a delayed lane, where the point of choosing Project Queue is to run the
command later. So composer text bound for Project Queue is classified before
anything runs, and a queueable command is carried to the scheduler as a
`yaCommand` tag on the item while `message.text` stays the verbatim command
line every queue surface displays. This is the same routing-at-ingress rule
[`emulated-slash-commands`](emulated-slash-commands.md) states for the
per-session YA-command lane; the tag decides routing, and no queue surface
ever reinterprets slash-shaped text by content.

Three outcomes, all decided at enqueue so the user learns immediately:

- **Queueable** — `/clear N` and `/clearloop [N] M: <prompt>`. The server runs
  them against the target session at dispatch. An argument that cannot run —
  bare `/clear` or `/clear 0`, `/clear abc`, a `/clearloop` without `M:` and a
  prompt — is refused with a visible reason and the draft is restored, rather
  than failing when the project goes quiet. A `/clearloop` promoted this
  way starts **patient** ([session-rewind](session-rewind.md#clearloop)): the
  user chose a lane that waits for the project, so the loop it starts keeps
  waiting, including for items this queue is about to promote.
- **Composer-only** — `/model`, `/btw`, `/done`, `/archive`, `/terminate`,
  `/title`, `/compact`, and `/v`/`/view` where YA's
  [view command](view-command.md) is available. These act on composer or
  client state, so queueing
  one would have to either run it now or run it later against a composer that
  no longer exists. They are refused with a visible reason and the draft is
  restored.
- **Not yet queueable** — `/fork N`. It creates a *new* session, so a queued
  fork would have to change its own item's target; that remains a separate
  design. Refused with its own reason, not silently run.

Anything else — ordinary prose, a provider command, a skill line, an effort
modifier such as `/fast …` — queues as text exactly as before. That includes
`/clear`, `/fork`, and `/clearloop` from a session without rewind support
([session-rewind](session-rewind.md#commands)): there they are the provider's
own commands, not YA's.

The text is the only source of what a tagged item runs. The tag is a marker:
the server re-derives the command's name and argument from `message.text` on
every create, edit, and load and again at dispatch, so a queue row can never
show one command while another runs. Editing a tagged item's text to another
`/clear` or `/clearloop` changes what runs; editing it into prose makes it an
ordinary prompt, because the queue editors re-tag from the new text before
saving. An edit to a malformed `/clear` or `/clearloop` keeps its tag, so it
is refused rather than queued as provider text. The server refuses a tagged
message whose text no longer spells the tagged command or whose argument
cannot run, reading it with the same shared parser the dispatch runner uses,
and a tagged item whose target is, or is edited to be, a new session. An item
persisted in any of these states by an older build loads as failed
with that reason instead of being dropped, and a Retry of it unchanged fails
the same way at dispatch rather than delivering the command line to a
provider as a prompt. Editing untagged text into a command line does not tag
it: the queue editors do not know whether the target session supports rewind.

A queued command resolves its turn at **dispatch**, not at enqueue. `/clearloop
3: p` queued now loops over turn 3 as it stands when the project finally goes
quiet, and a command with no number uses the tail then. A queued command takes
no attachments, targets an existing session only, and `/clear 0` (or bare
`/clear`) is refused at enqueue because it is the composer's
navigate-to-a-new-session action rather than a session operation a scheduler
can perform. Only the turn is resolved late; the argument's shape is not.

Dispatching a YA command starts no provider work, so it settles the item
without a session launch. A refusal from the session — a provider that does
not support rewind, a turn still running, a turn number that is gone — fails
the item with that message and keeps the command text for Retry, like any
other dispatch failure.

## Draft acknowledgement

The dedicated New Session form captures the exact draft and staged-file
selection before project resolution or enqueue. Typing stays available while
the request waits. Acceptance conditionally confirms that captured draft; it
never clears a newer local, sibling-tab or remote revision. Only submitted file
IDs are removed when that confirmation clears the captured input; a newer
upload still in flight survives. A rejected enqueue conditionally cancels the
account/slot-bound capture, adopts any newer physical sibling value, and leaves
the current text/files exact. A differing submitted copy is retained separately
as recovery metadata, rather than prepended to the newer editor. Reload
preserves the newer
local draft, and the usual independent synchronization continues.

Source/account retirement prevents a pending form reply or delayed project
resolution from clearing or publishing into its replacement. A manual Project
Queue action awaiting speech
settlement also retains its delivery intent when final speech contains a send
command. If final wording differs from the manually selected visible snapshot,
that unsent wording is retained instead of acknowledged as submitted.

The enqueue payload, acceptance boundary and capability checks are unchanged.
This does not introduce a durable browser enqueue receipt or make a lost reply
safe to repeat blindly; inspect the server-owned queue before repeating an
unconfirmed enqueue. Older-server creation fallback and template/handoff draft
acknowledgement retain their separately tracked boundaries.

## Attachments

Existing-session Project Queue items may contain already uploaded attachment
references because the session id and upload destination exist at compose time.

New-session Project Queue items support attachments through the server-owned
pre-session staging area. The queue persists only staged references, not
browser `File` objects, blob URLs, or in-flight upload handles. Promotion
materializes those staged files into the new session's normal attachment
destination. The design and lifecycle are documented in
`docs/tactical/028-pre-session-attachment-staging.md`.

When a session composer redirects its draft through the new-session chooser,
already uploaded attachments are read through their original session's
authenticated upload route and copied into account staging first. Both queued
and immediate delivery materialize into the chosen project's new session
before the first message. A failed copy prevents submission and restores the
draft. The source files remain intact. This reuses Project Queue's existing
staging capability and does not add a sandbox choice to the chooser. Final
storage and sandbox access remain governed by
[Attachment Storage](attachment-storage.md#location-resolution).

A submission racing an upload failure is refused rather than sending a subset
of its files. The draft and successful uploads remain available for recovery;
the failed file must be attached again. The collector carries those successful
results through the direct-send, deferred-send and Project Queue error paths.

When draft synchronization is initialized, draft attachments are copied into
queue ownership on create or edit, including references whose first draft save
is still in flight. Enqueue must not move an original out from under that save.
The queue stores the copies' canonical references in the
submitted order, including when mixed with retained or unsynced attachments.
Reload, promotion and cancellation use those references; cancelling an item
or rolling back a failed save leaves the synced originals usable.

With draft synchronization initialized (`draft-sync-v1`), a queued draft may
combine upload batches from the same account. Create and edit preserve each
reference's canonical batch and the submitted order, including retained files
from earlier batches. Reload and promotion deliver every accepted file in that
order. The envelope's batch does not require all references to share a batch;
each is validated against its own staging record in the item's account store.
This uses the existing draft-sync support and request shape, with no additional
capability. Without draft-sync initialization, newly transferred drafts retain
the staging service's single-batch validation.

Staged references belong to the account that queued the item. Queuing looks
the drafts up only in the acting account's own draft store — the superuser's,
or the limited user's isolated one ([limited users](limited-users.md)) — and
moves them into that store's queue-owned area. A reference staged by any other
account is refused as invalid (400) and its draft is left untouched; no other
account's store is searched. The item's recorded user names that store for
the item's whole life: after a restart, at dispatch, on a failed save's
rollback, and when an edit, delete or completed dispatch cleans the files up.
An edit by another account (the superuser editing a limited user's item) may
keep or remove the item's existing attachments but cannot add new staged
references, since those would come from the editor's store; such a save is
refused with a reason, and the editor's draft stays theirs until discarded or
expired.

When the server advertises `project-queue-attachment-editing`, the projects
page's in-place editor accepts clipboard file items through the normal staged
attachment pipeline. Save may retain or remove existing attachments and add
newly uploaded ones in one atomic item update. Discard preserves attachments
already owned by the queued item and requests deletion of newly staged draft
attachments; failed cleanup falls back to the staging expiry. An upload or save
failure keeps the editor open. Without the capability, the editor remains
text-only and sends the original attachment fields unchanged.
