# Session rewind, `/clear N`, `/fork N`, and `/clearloop`

> An in-place rewind drops the tail of a live session while keeping its
> session id, records the dropped turns as a collapsed group in YA's durable
> history, and is the primitive behind `/clear N`, the turn menu's Clear
> entries, and the `/clearloop` repeat.

Topic: session-rewind

Status: implemented 2026-09-18 for Claude (`/clear N`, `/fork N`, the
turn-menu Clear entries, rewound groups in the main session view, and
`/clearloop` with the inactivity boundary). Hardened 2026-09-19: the pending
rewind is consumed at the supervisor's process-launch seam rather than by the
`/resume` route, a drop-guard refusal deletes its record, forks and clones of
a session with an armed rewind keep the cut, cached client transcripts
reload across a rewind, an idle reap no longer ends a clearloop, and the tail
window counts live turns. Corrected 2026-09-19 after a 69-iteration loop: a
watching tab no longer folds every earlier group inside the newest one (only a
dropped cut nests), and delivered queued messages and durable receipts inside a
cleared span are grouped with it instead of rendering as live rows scattered
through the collapsed history. Corrected 2026-09-26 after a loop ended at
12/100 on a background-command notification: clearloop rewinds no longer pass
the drop guard, a boundary waits for Claude background tasks, and a failed
iteration is retried instead of ending the loop. Known limits: the sidebar does not nest rewound
groups, `/clear 0` starts a new session rather than rewinding in place, and
secondary readers (catalog previews, search, counts) still project without
records until the next turn
([gaps/rewind-records-ignored-by-secondary-readers.md](../gaps/rewind-records-ignored-by-secondary-readers.md)).
Codex: `thread/revert` is in YA's generated protocol as of 2026-09-19, so the
Codex rewind is unblocked follow-on work (see § Defaults and compatibility and
[gaps/fork-is-the-only-rewind-and-changes-the-cache-key.md](../gaps/fork-is-the-only-rewind-and-changes-the-cache-key.md)
for the provider primitives and the cache measurements that motivated this).

Related topics:
[fork-from-turn](fork-from-turn.md) (the existing per-turn Fork menu these
entries join; a fork creates a new session, a rewind keeps this one),
[session-context-actions](session-context-actions.md) § Clear (the kebab-menu
Clear, which starts a *new* session; `/clear N` is not that),
[emulated-slash-commands](emulated-slash-commands.md) (YA-routed command
rules and the tagged `ya-command` queue chip),
[queued-messages](queued-messages.md) (the server-owned queue projection the
clearloop entry rides on),
[transcript-display-objects](transcript-display-objects.md) (the durable
notice and rewind records are display objects, never model context),
[claude](claude.md) § Transcript Structure (why a rewound tail is a dead
branch in the Claude transcript, and why the reader hides it today),
[settings-ui-placement](settings-ui-placement.md) (why the inactivity window
is one server-wide value).

## Vocabulary

- **The session is the full sequence.** YA's logical session is every turn
  ever made, in transcript order, including turns a clear later removed from
  the assistant's context. A clear changes which turn the next turn's parent
  is (the kept prefix stays byte-identical, so the prompt cache stays warm);
  it never removes turns from the session's history.
- **Turn index `N`.** The 1-based ordinal of a real user turn over that full
  sequence, cleared turns included. Tool-result user rows, compact rows,
  injected context, and synthetic rows are not turns. One predicate decides
  this for the turn index, the [fork-from-turn](fork-from-turn.md) and rewind
  boundaries, and the client, so a row is a turn everywhere or nowhere. `N`
  therefore never renumbers: after `/clear 2` the cleared turns keep 3–5 and
  the next new turn is 6, and its turn menu shows `[6]`. Server
  normalization stamps the ordinal on each user turn (`turnIndex`), and both
  the tooltip and `/clear N` resolve through that one stamp, which is the
  invariant. The stamp is authoritative: a persisted row the server left
  unstamped has no `N`, and the client numbers only rows the server has not
  yet normalized (the live stream tail), continuing after the last stamped
  turn. A rewind whose source row has no stamp is refused rather than
  recorded as turn 0. `N = 0` names the empty prefix before turn 1.
- **Cut.** The last kept chain entry. *After turn N* keeps turn N's prompt
  and its complete response; *before turn N* keeps everything preceding
  turn N's prompt, which is the same cut as *after* the turn N continued
  from. That is turn N−1 unless a clear dropped the turns between: after
  `/clear 3` drops 4–5, *before turn 6* is *after turn 3*. Both cuts, for
  rewind and for fork, are resolved on the source turn's own chain, so a
  cleared span is never the context of a live turn.
- **Rewind.** Drop everything past the cut from the provider's live
  conversation while keeping the session id. On Claude this is the SDK's
  truncating resume (`resume` + `resumeSessionAt`), so it is a process
  restart; the transcript file keeps the dropped rows as a dead branch.
- **Rewound group.** The dropped tail, kept in YA's durable session view as
  one collapsed outline entry at the cut.

## Commands

All three are YA-routed commands resolved by the composer's typed command
resolver before provider ingress (`parseComposerSlashCommand`,
`handleCustomCommand`). Their argument text is parsed by their handler, not
the generic layer. They exist only when the server advertises the
`session-rewind` capability and the session's provider supports rewind.
Otherwise YA neither offers them in the command menu nor intercepts them: a
typed `/clear`, `/fork`, or `/clearloop` is ordinary provider text, so it
reaches the provider's own command when it has one, directly or through
Project Queue. YA advertised no command there, so this is not the silent
fall-through [emulated-slash-commands](emulated-slash-commands.md) forbids.

- **`/clear N`** — rewind to the cut *after turn N*. Turn N and its response
  are the new tail. `/clear` with no argument is `/clear 0`.
- **`/clear 0`** — drop every turn. On Claude the first chain entry is turn
  1's own prompt row, so the truncating resume cannot express an empty
  prefix. v1 therefore implements `/clear 0` on Claude as the existing Clear
  action from [session-context-actions](session-context-actions.md): it
  opens the new-session form for the same project, provider, and model and
  leaves the old session untouched. The grouped-in-place guarantee below
  applies to `N ≥ 1`.
- **`/fork N`** — identical to the turn menu's **Fork after this turn** at
  turn N: a new cold session keeping through turn N. This session is
  unchanged.
- **`/clearloop [N] M: <prompt>`** — repeat: rewind to *after turn N*, send
  `<prompt>`, wait for the iteration to end, M times. The colon after `M` is
  required and separates the counts from the prompt, which is taken
  verbatim (leading whitespace trimmed). When `N` is omitted, `N` is the last
  turn still in the conversation — the index that turn's own **Clear after
  this turn** offers, not a higher ordinal held by an already-dropped turn —
  so the first rewind is a no-op and `/clear N` followed by
  `/clearloop M: p` is equivalent to `/clearloop N M: p`. That no-op first
  rewind may or may not leave a group header; it has nothing to expand
  either way. A session with no live turn has no "here" to loop from and
  reports that instead. `M ≥ 1`.

**Native `/clear` is deliberately shadowed.** The
[emulated-slash-commands](emulated-slash-commands.md) rule that a
provider-native command wins has one exception here: Claude's native
`/clear` starts a fresh context with no YA history, and the whole point of
`/clear N` is the kept id and the durable group. The composer's command
menu shows the YA entry, not the provider's, for `clear` on rewind-capable
providers.

## Turn menu

The existing per-prompt **Fork from this turn** menu
(`ForkTurnMenu`, rendered by `UserPromptBlock`) gains two same-session
entries on rewind-capable providers, after the fork entries:

- **Clear after this turn** — `/clear N` for this turn.
- **Clear replacing this turn** — the cut *before turn N*, recorded as
  `/clear K` for the turn K it keeps (see **Cut**), then hand
  this turn's prompt text back to the composer (the Codex Esc-Esc shape).
  The composer changes only after the rewind succeeds; a refused or failed
  rewind leaves the draft exactly as it was. An empty composer receives the
  prompt as its draft. A nonempty draft is never overwritten: its text stays
  and the prompt follows it after a blank line, as one undoable edit. Turn 1
  has no earlier boundary, so the entry reports that `/clear 0` is the
  new-session Clear.

The menu's trigger tooltip becomes **Fork from this turn [N]** so the index a
user types into `/clear N`, `/fork N`, and `/clearloop N …` is discoverable
from the turn it names. Both entries are disabled while the selected or
latest response is still active, exactly like Fork after; the menu never
waits implicitly. An accepted command clears the persisted composer draft as
a sent message would, so a reload does not restore it.

## Server rewind operation

`POST /api/projects/:projectId/sessions/:sessionId/rewind` with
`{ cut: { kind: "after-user-turn" | "before-user-turn", sourceMessageId } }`.
For a typed `/clear N` the client maps `N` to that turn's YA message id
through the server's `turnIndex` stamps (§ Vocabulary); the request carries
no `N`. The server resolves the real human-turn boundary from the
transcript exactly as the fork route does (provider ids stay server-side),
takes the record's `N` from the kept turn's own stamp, then:

1. Rejects (`409`) when the session is `in-turn`, `waiting-input`, or
   compacting, when a live queued or steered message is pending, or when the
   cut is not a completed human-turn boundary. The client never substitutes
   a partial boundary.
2. Records a **rewind record** in session metadata before touching the
   provider: `{ id, at, cutMessageId, droppedFromMessageId,
   droppedThroughMessageId, droppedTurnCount, reason: "clear" | "clearloop"
   (+ loop id and iteration) }`. `droppedThroughMessageId` is the
   transcript's last row, read after the live process stopped (the next
   step), so it bounds the dropped span by file position. Precisely, it is
   the last non-progress row with a uuid, read from the end of the file, so
   finding it does not require the rest of the transcript to load. It is a
   display object: never model context, survives restart and device change.
3. Stops the live process, if any, and arms the record as the session's
   **pending rewind**. Claude's truncation is a resume option, so the rewind
   takes effect when the next process for the session launches, whichever
   path launches it: the `/resume` route, the `/clearloop` sender, Project
   Queue dispatch, a heartbeat or wake turn, reactivate, or a settings
   restart. The supervisor resolves the truncation at that one seam
   (`resolveResumeTruncation`): a pending rewind passes
   `resumeSessionAt = cutMessageId` and wins over any caller-supplied
   truncation (the API-error tail cut), and the record stops being pending
   once the process has started. A route never consumes it itself, so no
   launch path can replay a tail the view shows as dropped. When exactly one
   turn is dropped by `/clear N`, `resumeDropsTurn` names that turn's prompt
   UUID so the CLI refuses if the discarded range holds anything the user's
   view had not seen (an absorbed queued message, a task notification). The
   SDK validates only a single declared turn, so a multi-turn drop passes no
   `resumeDropsTurn`. A clearloop iteration's rewind passes none either: the
   loop discards its iteration whole by contract (§ `/clearloop`), and an
   agent's background command routinely lands its completion notification
   inside the turn, which the guard would refuse. A refusal of the same
   record is deterministic: it arrives as an `error_during_execution` result
   whose text starts with `Resume rejected by --resume-drops-turn:`; the
   supervisor deletes that rewind record, emits the metadata event with
   `rewindRecordRemoved`, every open view takes the server's projection again
   (the grouped rows are live again), and the next send resumes the full
   chain. The
   process exit publishes a "Claude refused the rewind" notice rather than
   the unexpected-exit one
   ([stream-persisted-render-parity](stream-persisted-render-parity.md)). A
   running clearloop treats the refusal as a failed iteration (§ Stopping).
4. Returns the record (`null` when the cut was already the tail, a no-op)
   and whether a process was stopped. The session metadata event carries
   the record (`rewindRecord`). **Group membership is computed only by the
   reader below**: every open view of the session refetches its bounded
   tail and replaces its loaded window with that projection, keeping the view
   mounted, so a watching tab and a tab opened afterwards show the same
   outline by construction. The client never regroups rows itself, since an
   incremental catch-up can only append. The tab that issued the rewind
   refetches on the response and ignores the event echoing the same record;
   if the refetch fails, the view reloads the session. The detail response carries
   `rewindRecordIds`, the ids of the records its projection applied; a tab
   returning to the session with a cached transcript compares them and
   reloads whole when they differ, since an incremental catch-up can only
   append rows, never regroup older ones.

**Forks and clones.** The SDK fork copies file lines positionally and
remaps every uuid, so rewind records cannot travel with a fork. A fork or
clone whose slice point is at or before a cut excludes the dropped rows
outright; one sliced at a later live turn carries them as a dead branch the
reader hides. A full copy taken while a rewind is still pending (no turn yet
written past the cut) is sliced at the cut, so the child is exactly the kept
prefix rather than a session whose tip is the dropped tail. The legacy
`/clone` route copies the transcript verbatim with its uuids, so it copies
`rewindRecords` and any pending rewind to the child instead.

**Idle reaps are not stops.** An idle reap tears down a quiet process for
want of viewers and reports `session-aborted` with `reason: "idle-reap"`;
a clearloop waiting out its inactivity window ignores it and its next send
starts a fresh process as it would have anyway.

The rewind changes only the conversation. Files, worktree state, and
provider-side file checkpoints are untouched; a code-restoring rewind is the
separate [fork with worktree checkpoint](../gaps/sketches/fork-with-worktree-checkpoint.md)
story.

## Durable history: the rewound group

YA's session view must not lose rewound turns. The Claude reader today hides
a deliberate rewind branch (the active branch continues through a user row)
per [claude](claude.md) § Transcript Structure. With rewind records as an
input, the reader instead emits the dropped rows as a **rewound group**:

- Group membership is positional: every row after the cut's line in file
  order through the record's `droppedThroughMessageId` row, not already
  claimed by an earlier rewind (a row keeps its first claim). Rows the
  session writes after the rewind are the live branch and are never grouped,
  even before the next turn exists (the record, not tip selection, decides
  the cut; until a new turn is written the displayed tail is the cut
  itself). Positional membership means a compaction inside a cleared span
  cannot split it, and no timestamp is compared, so a transcript writer
  whose clock differs from the server's cannot move rows. Every row in that
  span is claimed, including one on a sibling branch of the dropped chain.
  A record without the bound — written before the field existed, or when
  no transcript file could be read at rewind time — instead claims the rows
  after the cut stamped no later than its `at`. Those records do depend on
  clock skew: a writer behind the server's clock stamps the next live turn
  early enough to be claimed. A record whose bound row is missing from the
  read transcript groups nothing.
- Membership is by position, not by whether the provider stamped the row with
  a uuid. A queued message delivered into a cleared iteration is a transcript
  row with no uuid, and it joins that iteration's group; leaving it live
  would scatter delivered queued messages through the collapsed history as
  though they were still in the conversation, and would count them as live
  turns — for the tail window, and for the next rewind's `droppedTurnCount`
  and `droppedFromMessageId`, which grow without bound across a long loop
  when the previous iterations' queued messages never leave the live branch.
  A durable receipt — a `/goal` receipt or clearloop notice — follows the
  rows' own rule: of the rewinds whose cut precedes its merged position, it
  joins the earliest one made at or after the receipt was written, among the
  groups of the rows on either side of it and the groups enclosing them. A
  receipt written after the last rewind — a clearloop's final notice, a
  `/goal` receipt after `/clear N` with no later turn — stays live even when
  it follows a grouped row, so a reload shows what the watching tab showed.
  A retry notice written between two iterations joins the later iteration's
  group, the rewind that dropped it.
- **Nesting.** A group nests exactly when its own cut is a row that some
  other rewind dropped. A clear whose cut is earlier than an existing group's
  cut therefore encloses that group: the new block claims the unclaimed rows
  after its cut, the older block's cut row among them, the older block sits
  inside it unchanged, and it renders nested, collapsed under the outer
  header and expandable on its own once the outer block is open
  (`rewoundParentGroupId` on the inner header and rows). Repeated rewinds to
  one still-live cut — every `/clearloop` iteration — are **siblings**: none
  of them drops the shared cut, so each stays its own top-level collapsed
  entry in iteration order rather than vanishing inside the newest one.
- A tail window never starts inside a group: when the window boundary
  lands on a grouped row or header — a caller-chosen `tailFrom` row, or a
  compaction boundary a rewind dropped — it backs up to the header of the
  outermost group enclosing it, since a nested header is hidden while any
  enclosing group is collapsed.
- Placement: at the cut, in transcript order, before any later live rows.
- Presentation: one collapsed outline entry by default. Expanding shows the
  dropped turns with their ordinary rendering, styled as nested rows (the
  `subagent-item` presentation). The main session view is required; the
  sidebar's nested rendering of the same group is optional and not built.
  The dropped-turn count is in the header's tooltip. A clearloop
  iteration's header also offers a copy control that yields the `/clearloop`
  command for the iterations still to run after that one
  (`/clearloop N (M−m): prompt`), so a loop can be relaunched from history.
- The header reads as the command that produced the group: `/clear N`, or
  `/clear N [#m/M: prompt]` for a clearloop iteration. It carries a boxed
  `+`/`−` marker; expanded rows hang off a vertical bar beneath it. Toggling
  keeps the header fixed under the pointer (the list never jumps to the
  tail), and works the same with Conversation view on or off, where the
  expanded rows are projected like any other rows.
- Each rewound group is its own outline level for the opt-in margin
  navigation owned by
  [turn-rail-marker-layout](turn-rail-marker-layout.md#margin-navigation).
- Every rewind produces its own group, so M clearloop iterations leave M
  reviewable groups at the same cut, in order.
- The header row carries the cut row's timestamp, not the rewind time:
  timeline entries are ordered by their latest row time, and a later time on
  the header would drag the cut's turn past the group's own rows. The rewind
  time is kept in the header's `rewoundGroup.at`.
- Grouped rows keep their stamped `N` (§ Vocabulary), so a cleared turn's
  menu still shows its index, but they are history rather than live turns:
  search reaches them only while their group is expanded, turn navigation
  skips them, the tail window does not count them, and `/clear N` naming one
  is refused (§ Future work).

**Composer recall.** `/clear N`, `/fork N`, and `/clearloop …` never become
transcript turns, so accepted commands are recorded per session in browser
storage and merged ahead of the turn history in the recall drawer
(Ctrl+Up). One browser-local key holds that history for the 30 most
recently used sessions, 50 commands each, so running commands in many
sessions cannot grow storage without bound; the per-session keys earlier
releases wrote are folded into it and removed on the next read. A command
that fails to parse is put back into the composer
instead of being discarded. Harness-injected user rows such as task
notifications are never offered for recall.

## `/clearloop`

A clearloop is a **server-owned job** persisted in session metadata
(`{ id, cutMessageId, cutTurnIndex, prompt, total: M, completed: m,
state: "running" | "completed" | "cancelled" | "interrupted", startedAt,
endedAt }`). The requesting tab may disconnect; the loop continues.

**Iteration.** Rewind to the cut (the first iteration is a no-op rewind when
the cut is already the tail), then send the prompt as an ordinary direct
turn. The iteration ends when the session has been **inactive for the
inactivity window**: no user send and no assistant progress for that long,
where progress is any provider message or raw provider event and the session
is idle or waiting for input at the end of the window. Then `m` increments;
if `m < M` the next iteration starts, else the loop completes.

**Background tasks hold the boundary.** While Claude reports a background
task still running (a backgrounded command or agent; session crons do not
count, since they last as long as the process), the session is busy for
the loop: no countdown runs and no rewind happens. The rewind would stop
the process and kill the task, and the task's completion notification
would start a turn the agent needs to see. Once no task remains, the
window counts from the last progress as usual. The hold is bounded: after
30 minutes of waiting on background tasks alone (a task that never exits,
such as a dev server) the boundary proceeds and the rewind stops them.

**Why inactivity, not turn counting.** A strict "one assistant turn plus its
blocking question and answer" boundary requires YA to classify every user
send as a question answer or a manual turn. The inactivity boundary needs no
classification and behaves obviously with the rest of the queue: a patient
queued message lands when the session is quiet, a steer lands during work,
and both simply reset the window. They are part of the iteration, and the
next rewind discards them into that iteration's rewound group along with
everything else after the cut. The strict variant remains a candidate behind
the same boundary seam; v1 ships inactivity only.

**Inactivity window setting.** One server-wide value,
`clearloopInactivitySeconds`, in the **Message delivery** settings
category, titled "/clearloop Inactivity Window", default 60, range 10 s to
1 h. It has a slider and a text field accepting a number with an `s`, `m`,
or `h` suffix (`45s`, `2m`, `1h`; a bare number is seconds), rounded to
whole seconds and clamped to the range, and displayed in the same form. It
is server-definitive because the server runs the timer. A running loop reads
the current value at each boundary.

**Queue rail entry.** While a loop is running, the canonical queued-message
projection carries one entry `kind: "ya-command", yaCommand: "clearloop"`
with the prompt, `m/M`, and state. Once the server observes inactivity the
entry also carries the quiet anchor (`quietSince`) and the window; the
client counts down to the next rewind once a second from that anchor
locally, with no per-second server traffic. The server republishes the
entry whenever it re-checks (every 5 s while the provider is busy, once when
quiet), so a moved anchor corrects the countdown within that lag. The loop
itself runs on the server and does not depend on any client viewing the
session. It renders through the existing chip
surface with a **m/M badge**, is always ordered last in the rail, and its
tooltip shows the full prompt. It never occupies a deferred, patient, or
provider delivery position, exposes no Steer or edit action, and no queued
send is ever admitted through the patient or deferred lane to start an
iteration: the loop sends its prompt directly at the boundary it owns.
Because the projection is server-owned, the badge is identical on every
tab and survives reloads.

**Remaining-count badge.** While a loop runs, the session's sidebar row, its
title in the session header, and its process card in the Agents view show
a green badge with the remaining iteration count. It rides the session
summaries and process list as a small `clearloop` object (remaining, total,
cut turn, prompt, window) and the session metadata change event, so it
updates live and clears when the loop ends. Every surface takes the object
from the clearloop service, so each shows the same window, and none shows a
record a previous server process left `running`: only a loop this server is
running has a badge, whether or not startup has yet closed that record out
as interrupted. Its tooltip states the
contract: Stop or a server reload aborts the loop; otherwise the window of
inactivity rewinds to `/clear N` and relaunches the prompt. The header
title lays out as a flex row so the badge survives a long ellipsized title.

**Patience.** A loop is *impatient* by default: the inactivity window alone
decides when the next rewind happens. A *patient* loop additionally waits for
the [project idle predicate](project-queue.md#project-idle-predicate) — the
same predicate Project Queue uses, minus its readiness check, because that
check is only refreshed while Project Queue has backlog. Blockers naming the
loop's own session are dropped: that session's quiescence is what the
inactivity window already measured, so counting it would hold the loop
against itself. A patient loop also yields to Project Queue: while the project
is otherwise quiet and Project Queue has an item it will promote once its quiet
window passes, the loop is held (`project-queue:item-waiting`, then
`project-queue:dispatching`), so a loop window shorter than the quiet window
cannot start first at every boundary and keep that item waiting for the whole
loop. Queued items therefore run at the loop's next boundary, one quiet
window apart, before its next iteration. An item Project Queue is
itself holding — dispatch paused, a failed first item, automation paused on its
session, a readiness check not passed — does not hold the loop, and neither
does a queue that the loop's own session is blocking. While a patient loop is
held, the queue-rail entry reports the raw blockers in place of the countdown,
and it re-asks every five seconds. Those re-checks republish the entry but are
not project activity, so they do not restart Project Queue's quiet window.
A server with no Project Queue cannot report project idleness; it refuses to
make a loop patient rather than silently running it impatiently.

A loop starts patient when the command itself arrived through a patient lane —
a `/clearloop` delivered by Project Queue (§ Queued YA commands in
[project-queue](project-queue.md)) — and impatient otherwise. Patience is also
a runtime control on the remaining-count badge; changing it lands at the next
boundary and never disturbs the iteration already running. A change made while
that iteration rewinds or sends is kept: the loop's own record writes apply to
the record as it is then, not to the copy the iteration started from.

**Remaining-count badge menu.** Right-click, long-press, or the context-menu
key on the session header's badge opens Stop, the patience toggle (Patient /
Impatient), and Start now. Start now ends the current iteration immediately,
skipping both the remaining inactivity window and any project wait; it refuses
while the loop is already starting an iteration, rather than overlapping
itself. Starting spans the boundary's record of the finished iteration through
the next send, so a Start now that lands while a timer-driven boundary is
still writing is refused rather than counting an iteration twice. A left click still cancels, as before. The badge is green while
impatient and Project Queue purple while patient, so the wait the loop is in
is legible without opening the menu. The sidebar and Agents chips stay
passive and carry the same color.

**Settings changes take effect on the next iteration.** A rewind's stop,
like every stop, completes the save of any effort, thinking, model, or
permission mode applied to the live process before it returns
([session defaults](session-defaults.md) § Per-session live picks), so the
resume that sends the next prompt (a clearloop iteration or the user's next
send) uses what was last applied mid-session rather than the original launch
values. An iteration's resume is assembled by the same code as the `/resume`
route, with those saved launch settings standing in for a client's request:
the session's saved model, executor, recap mode and timing, prompt-suggestion
preference, and settled sandbox all apply. Choices only a client request
carries and the session never saves (a helper side model, permission rules)
are absent, exactly as in a resume request that omits them.

**The loop's own rewind is not a stop.** Rewinding aborts the live process
to arm the truncating resume, which raises the same abort signal as a kill.
The service ignores that signal while its own rewind is in flight; only a
stop it did not request interrupts the loop. A requested turn stop is a
separate signal that the rewind never raises, so it ends the loop whenever
it arrives.

**Stopping.**

- The entry's **x / cancel** control cancels the loop **without** stopping
  in-flight assistant work and **without** starting a turn: the current
  iteration is left to finish on its own, no further rewind happens, and the
  loop state becomes `cancelled`.
- The session **stop** button (abort) interrupts the provider as usual and
  also ends the loop as `interrupted`.
- Ordinary sends do not stop the loop (see the inactivity rationale). A user
  who wants to keep the current iteration's result cancels the loop before
  the window elapses.
- A failed iteration — its rewind or launch fails, or the provider refuses
  its truncation — is retried rather than ending the loop: the loop writes
  a durable "iteration m failed; retrying" notice with the error, restarts
  the inactivity window from zero, and at that boundary rewinds and sends
  the same iteration again, which resumes the provider process when none
  is attached. `m` does not advance. The third consecutive failure ends the
  loop as `interrupted` with the error; a successful send resets the count.
- A server restart during a running loop marks it `interrupted` at the next
  startup (with the durable notice); YA never resumes a loop on startup.
- The remaining-count chip in the session header is also the cancel control:
  clicking it (after a confirmation) cancels like the queue entry's x, so the
  current turn finishes and no further rewind happens. Its context menu's Stop
  entry does the same. The sidebar and Agents chips are passive. Every chip's
  tooltip states the contract.

**Durable notice.** Every terminal state writes a durable notice into the
session at the tail (a `local_command` display row, like goal receipts):
the original `/clearloop N M: <prompt>` line, `completed m of M`, and for
`cancelled`/`interrupted` the remaining `M−m`. The notice is session
history, not a toast, and is never model context. A notice carrying an
error (an interruption, a retry) shows the error expanded without a click.

## Defaults and compatibility

- The commands are explicitly invoked transforms and need no option
  ([vanilla-defaults](vanilla-defaults.md)). The two menu entries are added
  inside the existing hover menu on rewind-capable providers; the rewound
  group is collapsed by default so the default view reads like the
  provider's own rewound timeline. Authorized by graehl on 2026-09-18 in the
  originating request.
- `session-rewind` is a permanent, version-implied server capability,
  **ID 78**, introduced after 0.8.2, gating the rewind route, the clearloop
  routes (including the `PATCH` patience/Start-now route), the `clearloop`
  queued-entry kind, the `yaCommand` field on Project Queue items, and the
  rewind records in metadata. Those were all added before the capability
  reached a stable release, so they extend ID 78 rather than allocating a new
  one. The optional-feature horizon on 2026-09-18 is v0.8.0 and
  v0.8.1 (the latest two stable releases and all releases from the
  preceding 14 days); neither has any of these. Without the capability the
  client hides the menu entries, leaves the command names to the provider
  (§ Commands), makes no rewind or clearloop request, and ignores unknown
  queue kinds and metadata fields. No existing capability meaning changes; existing fork behavior is
  unchanged. The originating request approved this gate.
- Providers: Claude, Claude Gateway, and Claude Ollama sessions. Others
  report rewind unsupported; the route returns `409` and the client hides
  the surface. This Claude-only placement is the accepted first revision
  (graehl, 2026-09-18). Codex supports the same verb through
  `thread/revert {threadId, beforeTurnId}`, which keeps the thread id and so
  the prompt-cache key; the generated protocol carries `ThreadRevertParams`,
  `ThreadRevertResponse`, and `ThreadRevertedNotification` as of 2026-09-19
  (graehl approved the refresh). A fork-based Codex rewind is ruled out: the
  Quick Answer measurements show a Codex fork child starts 94% uncached, so
  the feature stays disabled on Codex until the in-place verb is wired
  (between turns, on an idle thread, with the thread re-read afterwards) and
  its cache effect measured. Pi has a more general tree operation (`/tree`)
  that could back it. Neither changes the command vocabulary or the
  rewound-group presentation.

## Future work: continuing from any node

The positional model supports the well-defined tree operation of continuing
from any turn, including one inside a cleared span (Claude's truncating
resume accepts any chain entry). It is deliberately not exposed yet:
`/clear N` on a cleared turn is refused with a message, because the UI is
unspecified. The naive display would leave the new parent and its ancestors
hidden inside the collapsed block they belong to, so the part of history now
back in the assistant's context would not be re-exposed; that is acceptable
for a first version only with a warning banner saying so. Selecting the
target belongs in an interactive `/tree` picker (as Pi's `/tree`), with a
dotted path notation for addressing nodes. The reader's active-branch
selection also needs a rule for a live branch whose ancestors are grouped.

## Implementation map

Durable pointers by symbol and module; grep for the symbol.

**Shared** (`packages/shared/src`)
- `session-rewind.ts` — record/job/badge types, `parseClearloopArguments`,
  `parseTurnIndexArgument`, the inactivity-window constants and clamp,
  `parseDurationSeconds`/`formatDurationSeconds`, `REWOUND_GROUP_SUBTYPE`.
- `app-types.ts` — `rewoundGroupId` on messages, `clearloop` on session
  summaries, `SessionQueuedClearloopProgress` on queue entries.
- `capability-ids.ts` / `server-capabilities.ts` — `sessionRewind`.
- `transcript/messageProjection.ts` — the `rewound_group` system item;
  `isRealUserTurn`, the one "is this a turn" predicate.

**Server** (`packages/server/src`)
- `routes/sessions.ts` — `runRewindCommand`, the one operation behind the
  `/rewind` and `/clearloop` routes and queued `/clear N` / `/clearloop`
  commands (provider and running-loop refusals, one session read, typed-N
  resolution, then rewind or loop start); `rewindSessionToCut` (the rewind
  itself, also run by each clearloop iteration), `resolveRewindCut`,
  `sendClearloopPrompt` over `buildResumeLaunch` (the resume launch assembly
  shared with the `/resume` route), the clearloop runner, `rewindRecordIdsFor`
  on the detail responses, the `/clone` rewind-state copy.
- `supervisor/resume-truncation.ts` — `resolveResumeTruncation` (the
  activation-seam consumption of `pendingRewind`) and
  `isResumeDropsTurnRefusal`; `Supervisor.consumePendingRewind`,
  `Supervisor.discardRefusedRewind`, `Process.appliedRewindRecordId`, the
  pending-cut slice in `Supervisor.forkSessionWithinSandboxLaunch`;
  `SessionMetadataService.copyRewindState`.
- `services/ClearloopService.ts` — the loop state machine and inactivity
  timer (`iterate`, `check`, `readQuietAnchor`), `getProgress` for the queue
  entry, `getBadge` for every summary surface (injected into the Agents
  and All Sessions routes as `getClearloopBadge`), `reconcileAfterRestart`,
  the durable notice.
- `sessions/claude-messages.ts` — `collectRewoundRows` (positional
  membership, nesting), `lastRewindableClaudeRowId` (the bound
  `rewindSessionToCut` records); the `rewindRecords` option of
  `collectVisibleClaudeEntries`, threaded through `normalizeSession` in
  `sessions/normalization.ts`.
- `sessions/turn-index.ts` — `stampTurnIndexes` (the `turnIndex` stamp
  applied by `normalizeSession` for every provider), `turnIndexOf` (used by
  the rewind routes for the record's `N`); `routes/sessions.ts` fork and
  rewind boundaries use the same shared predicate.
- `sessions/pagination.ts` — the tail window backs up to a group header.
- `metadata/SessionMetadataService.ts` — `rewindRecords`, `pendingRewind`,
  `clearloop` fields and their accessors.
- `routes/session-queue-summaries.ts` — the clearloop queue entry, always
  last.
- `supervisor/SessionActivationCoordinator.ts`
  `settleStoppingProcessLaunchSettings` — the rewind's abort, like every
  stop, saves settings applied since the last save.
- `sdk/providers/types.ts` / `sdk/providers/claude.ts` — `resumeDropsTurn`.
- `routes/version.ts` `BASE_CAPABILITIES`; `routes/settings.ts` and
  `services/ServerSettingsService.ts` `clearloopInactivitySeconds`.
- `routes/global-sessions.ts`, `sessions/Session.ts`, `routes/processes.ts`
  — the `clearloop` badge on list rows, detail summaries, and process cards;
  `watcher/EventBus.ts` — `clearloop` and `rewindRecord` on the metadata
  change event.

**Client** (`packages/client/src`)
- `lib/slashCommands.ts` — `REWIND_SLASH_COMMANDS`, parser entries.
- `hooks/useSessionRewindControls.ts` — `handleRewindCommand`,
  `rewindToCut`, `startClearloop`, `cancelClearloop`, the
  `SessionRewindProvider` value, draft restore/clear, the metadata-event
  rewind application; `pages/SessionPage.tsx` keeps the header badge.
- `lib/sessionCommandRecall.ts` — the bounded command-recall store and
  `useSessionCommandRecall`.
- `lib/sessionRewind.ts` — `getSessionTurnIndex` (server stamps, live-tail
  numbering), `supportsSessionRewind`; `contexts/SessionRewindContext.tsx`.
- `components/blocks/ForkTurnMenu.tsx` — Clear entries and the indexed
  tooltip; `components/RenderItemComponent.tsx` — `RewoundGroupHeader`
  (toggle, copy control) and the nested-row styling.
- `lib/sessionDetail/renderItems.ts` — `getDisplayRenderItems` collapse
  filter, `getRenderItemRewoundGroupId`; `lib/sessionDetail/search.ts`
  excludes rewound rows from turn-navigation anchors.
- `hooks/useSessionMessages.ts` — `refreshTranscriptTail` (the bounded
  tail refetch through `fetchNewMessages`, replacing the loaded window via
  `applyFullTailReconciliation`).
- `components/MessageList.tsx` — scroll-anchored `toggleRewoundGroup`,
  the clearloop chip and `ClearloopCountdown`;
  `components/ClearloopRemainingBadge.tsx`.
- `lib/composerTurnRecall.ts` — `mergeCommandRecallEntries`, task
  notifications excluded.
- `pages/settings/MessageDeliverySettings.tsx` — the inactivity setting.
- `api/client.ts` — `rewindSession`, `startClearloop`, `cancelClearloop`;
  `lib/clientSummaryState.ts`, `lib/clientSummaryCollections.ts`,
  `lib/sessionCollectionRecords.ts` — the badge through the sidebar store.

## Tests that should fail on contract regressions

- `/clear N` on an idle Claude session restarts the process with
  `resumeSessionAt` equal to the last chain entry of turn N, records the
  rewind, and the next transcript read shows turns `1..N` live plus one
  collapsed group holding the dropped turns; the group persists across a
  metadata reload.
- `/clear N` during `in-turn` or with a pending queued message is refused
  with `409` and records nothing.
- A single-turn drop passes `resumeDropsTurn`; a multi-turn drop does not,
  and a discarded range containing a non-turn row is refused by YA. A
  clearloop iteration's rewind never passes it
  (`session-rewind-orchestration.test.ts`).
- A clearloop boundary waits while Claude reports a live background task,
  not for session crons, and proceeds once the hold limit passes; a failed
  iteration is retried after a fresh window without advancing `m`, a
  refusal outside the loop's own launch counts as a failure, and the third
  consecutive failure interrupts the loop (`ClearloopService.test.ts`).
- A refused guarded resume publishes the refused-rewind notice, not the
  unexpected-exit one, with its details open (`process.termination.test.ts`).
- `/clearloop 3 2: p` and `/clear 3` then `/clearloop 2: p` produce the same
  rewind records and sends.
- A queued `/clear N` and the interactive rewind of the same turn record the
  same rewind, each reading the transcript once; a queued `/clearloop` starts
  a patient loop at that cut; an iteration's resume carries the session's
  saved launch settings and recap preferences
  (`session-rewind-orchestration.test.ts`).
- After `/clear 3` drops turns 4–5, **Clear replacing this turn** on turn 6
  cuts after turn 3 and records `/clear 3`, and a fork before turn 6 keeps
  turns 1–3; neither lands on the cleared turn 5
  (`session-rewind-orchestration.test.ts`).
- A clearloop iteration ends only after the configured inactivity window
  elapses with no user send and no provider event; a steer or patient
  delivery inside the window resets it and is included in the next group.
- Cancel on the clearloop entry leaves the running provider turn alone,
  performs no further rewind, and writes the `completed m of M` notice.
- The clearloop entry never appears in deferred or patient positions and is
  ordered last.
- The inactivity setting rejects values outside 10–3600 seconds and parses
  `s`/`m`/`h` suffixes.
- Without `session-rewind`, the client shows no Clear menu entries and sends
  no rewind request for a typed `/clear N`.
- A pending rewind is applied by every Claude launch path, and it wins over
  a caller-supplied `resumeSessionAt`; a non-Claude provider or a new
  session gets no truncation (`resumeTruncation.test.ts`). The real-SDK
  launchers, used when no provider is resolved, truncate and disarm like
  the provider launchers (`supervisor.test.ts` § a pending rewind on the
  real SDK launch path).
- A `Resume rejected by --resume-drops-turn:` result deletes the record and
  ends a running clearloop as `interrupted`; an idle-reap abort leaves the
  loop running (`ClearloopService.test.ts`).
- An unchanged transcript re-projects when its rewind record set changes,
  including when a record is deleted (`normalization.test.ts`).
- The tail window and `totalUserTurns` count live turns only; grouped rows
  ride along with their cut (`pagination.test.ts`).
- A queued message delivered inside a cleared span is grouped with it and
  keeps its delivery stamp, while a queued message delivered on the live
  branch stays live and in place, after the whole group whatever its length
  (`claude-messages.test.ts`).
- Two rewinds to the same live cut produce two sibling groups in order, with
  no `rewoundParentGroupId` on either (`claude-messages.test.ts`).
- A continuation stamped behind the server's clock stays live under a
  bounded record, and a clear whose cut precedes an earlier group encloses
  it with each row in its own group (`claude-messages.test.ts`); the
  rewind route records the transcript's last row as the bound
  (`session-rewind-orchestration.test.ts`).
- A rewind, whether issued here or seen on the metadata event, replaces the
  loaded window with the server's bounded tail projection without unmounting
  the view, fetching once per record; a failed refetch reloads
  (`useSessionMessages.cache.test.tsx`, `useSessionRewindControls.test.tsx`).
- A durable receipt written before a rewind that dropped its position joins
  that group (the enclosing one when an inner rewind came first); one written
  after the last rewind stays live at a group's tail or before the next turn
  (`goal-overlays.test.ts`).
