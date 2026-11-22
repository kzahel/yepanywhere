# Message-control and queue contract (busy/idle and later intent)

> Message-control is the UI-visible contract for direct sends, steering,
> queueing, `/btw`, and deferred or later intent while a session is busy.

This note defines the UI-visible contract for message-control decisions in a YA
session: when the composer can send directly, when it queues, how `/btw` is routed,
and how model-selection text is substituted while busy. It is a consumer contract
for both client behavior and provider-specific control adapters.

Provider-level facts behind these intents — Claude's `priority`
(now/next/later) lanes, Codex `turn/steer` vs app-side queueing, and
end-of-turn signals — live in
[steer-queue-provider-differences.md](steer-queue-provider-differences.md).

## State inputs that drive UI behavior

- `processState` from `Process`:
  - `idle`
  - `in-turn`
  - `waiting-input`
- `isCompacting` from process status subtype (`status=compacting`).
- `sessionLiveness.derivedStatus` for automation/scheduling decisions:
  - `verified-idle` is the key boundary used for background automation.
  - `verified-waiting-provider` and lower-priority statuses are non-final and do
    not authorize model edits.
- `status.owner` for action permissions (`self`, `external`, `none`).
- message `deliveryIntent`: `direct`, `steer`, `deferred`, or `patient`.

## Model/indicator text contract (important)

The expanded bottom row next to the model selector must be status-first, not model-first.

1. Show normal model/provider text only when the session is effectively idle
   and not compacting.
2. Otherwise replace with provider-state copy:
   - `Thinking` for active turns (`in-turn`),
   - `Waiting for input` when `waiting-input`,
   - `Compacting` while `isCompacting` is true.
3. This text is also used as the canonical UX surface for compacting intent,
   both for auto-initiated compact attempts and user-issued compact flows.

Rationale:
- Model settings are likely stale or non-applicable while the turn is active.
- In turn mode, session control semantics are more valuable than model identity.

## Delivery intent behavior matrix

| Session condition | User action | Delivery intent / route | Why |
|---|---|---|---|
| `idle` | Send | `direct` | Normal turn submission into the current turn boundary. |
| `in-turn`, provider has steering | Primary action | `steer` (best effort) | User asks for immediate interrupt-style continuation; fallbacks to queue if steer unsupported at time of send. |
| `in-turn`, provider has no steering | Queue action | `deferred` | Keep immediate turn ownership untouched; append to deferred queue. |
| Any busy non-steering path where queue exists | Queue action | `deferred` | Keep the active turn untouched; append to the deferred queue. |
| Any queue path | Route | `deferred` | Messages are inserted through YA-managed deferred delivery, not as direct steering. |
| `Ctrl+Enter` alternate send | opposite of the visible Enter/default action | `steer` or `deferred` | In active steering sessions, Enter and `Ctrl+Enter` are complementary: one steers now, the other regular-queues. Patient is not the alternate-send shortcut. |
| `Ctrl+Enter` with visible Project Queue action and enabled Project Queue shortcut | Project Queue | `deferred` metadata on a Project Queue item | Project Queue is a higher-level backlog. When the user has exposed that action and enabled its shortcut, `Ctrl+Enter` chooses the project-level queue instead of per-session queue/steer. |
| Patient queue setting enabled for a new queued item | Queue action | `patient` | Claude and Antigravity wait for verified idle and the per-item quiet interval. Other providers use ordinary turn-end timing. |
| Any busy session with the toolbar action shown | **Next topic when done** | `patient` with `patientSource: "topic-shift"` | Same waiting as patient queue, plus optional compaction first at its own threshold. See [patient topic shifts](patient-topic-shift.md). |
| Queued chip on steering-capable active turn | `Steer now` | `steer` | User explicitly overrides queued/patient waiting and injects the queued item into the active turn. |
| Current-session Project Queue row | `Steer now` | Project Queue force promotion with `steer` metadata | User explicitly resumes global Project Queue dispatch, bypasses quiet/idle blockers, and injects the selected project item into its active target session. |
| `/btw` explicit route | Aside control | separate aside session | Not a queue path and not `steer`. |

### Queue text rule

- Default queueing never rewrites the user's text.
- The phrase `when done, ` is ordinary user-authored prompt text, not a YA queue
  mechanism. New patient queue submissions do not prepend it.
- Regular queue sends attach `deliveryIntent: "deferred"`.
- Patient queue sends attach `deliveryIntent: "patient"` and keep their own
  accepted queue timestamp/metadata. Changing the patient setting later does
  not mutate already queued items.
- Claude and Antigravity wait for provider-retained background work to settle
  and then for a quiet interval (two seconds by default). Antigravity includes
  the root reply that a detached child, tool or schedule wakes. Codex background
  work is recorded without retaining the session, so its patient entries use
  ordinary deferred timing. Patient intent still gives those entries durable
  restart preservation. See [provider work](provider-wait-and-background-work.md).
- `Steer now` on an existing queued chip strips one recognized patient prefix
  before steering for legacy queued items, because the user has explicitly
  overridden old prompt-visible "when done" wording with "now".
- Regular and patient queue entries are separate per-item intents. Regular
  entries may pass patient entries at delivery time. The composer tail should
  preserve the user's typed order while making patient rows visibly distinct
  (for example by offset, tone, status text, and age) so the display does not
  imply one strict FIFO when patient rows are waiting for the quiet threshold.
- Queueing remains in-session and avoids immediate active-turn injection.
- Patient mode is a persistent queue setting, not a replacement for the queue
  action. The status-bar appearance setting for queue controls gates only the
  regular/patient switch, defaults hidden for new users, and should be labeled
  as the patient-queue switch. It must not hide the alternate Steer/Later send
  button: in dual-action active sessions the non-primary send option remains
  visible whenever the provider/action state supports it.
- When the visible queue action is available, its icon/color should change so
  the click invitation reflects whether it will create a regular queued item or
  a patient queued item.
- The patient-mode switch should stay compact: show the active state in the
  switch glyph/thumb, but keep the actual quiet interval in tooltip and
  acknowledgement copy rather than widening the toggle with `Nm` text.
- Observed on 2026-06-07: patient rows did deliver per contract after the quiet
  threshold, while a later regular queued row passed them as intended.

### Composer acknowledgement safety

Send, Steer, Queue, and Project Queue optimistically empty the composer so the
next turn can be drafted while the request is in flight. A later successful
acknowledgement confirms only that optimistic empty state. If the user has
already begun the next draft, the acknowledgement must preserve both its live
text and its recovery copy; it must never clear the newer turn.

The recovery copy stays visible like any other draft — a reload or a second tab
on the same session shows it in the composer, because a send that never landed
must remain recoverable. It carries a `pendingSendAt` marker in the stored draft
envelope — the submit time on the client's estimate of the server clock — which
distinguishes it from text the user typed or recalled. Only a marked copy is
eligible for automatic discard, and only once the session proves that this send
is accounted for: a durable (non-optimistic) user turn in the recent transcript
tail, or a message the server reports as queued, with the same text and a
timestamp no more than five seconds before the recorded submit. Short prompts
repeat, so an earlier identical turn or queued message is not proof, and
evidence without a readable timestamp proves nothing. Comparison is exact after
trimming and queued-turn-marker removal, so anything YA appended on the way out
simply fails to match and the draft stays. A marker without a send time, as
written by an older client, reads as an ordinary draft.

A draft the user typed or recalled carries no marker and is never discarded
automatically. Restoring an untouched recovery copy after a request failure
keeps it eligible: a late response failure does not prove non-delivery, and
subsequent durable history may establish that the message was sent. Actual
user edits remain protected. If delivery is already observed when the request
fails, Send confirms its optimistic clear without retrying, restoring the
draft, or resetting session activity to idle.

Recovery scans count recent user prompts, rather than raw transcript records;
a tool-heavy response must not push its own prompt outside the search window.
The marker's own tab may never run its confirm: it can be
closed, reloaded, or lose the acknowledgement, which is exactly how a sibling
tab used to inherit the last sent prompt as an unsent draft. The reconciliation
runs on the receiving tab from its own session history
(`lib/draftSendReconcile.ts`), not from cross-tab messaging.

A tab learns that the shared copy carries the marker when it hydrates the key
and from the browser's own `storage` event, which is what reaches a tab that
was already open when another tab sent. Because the receiving tab reconciles
against every transcript update, an unmarked composer must reach that answer
without reading or parsing storage.

### Patient countdown and promotion proposal

Status: promotion landed 2026-07-03; countdown still a proposal.

- When a session is idle and patient queued rows are counting toward autosend,
  patient rows should show a countdown to the quiet-threshold send time.
  (Still open.)
- Patient rows should expose an explicit promote/send-now action. Landed: each
  live patient chip has a `Steer now` action
  (`POST /sessions/:id/deferred/:tempId/steer`,
  `Process.steerPatientDeferredMessagesThrough`).
- Promoting a lower patient row should promote all patient rows above it, because
  that preserves typed order within the patient lane and avoids sending a later
  patient thought while earlier patient context remains delayed. Landed: the
  action steers the clicked entry plus every patient entry ahead of it; when
  the queued-send batching window (`deferredJoinWindowSeconds`) is enabled they
  deliver as one concatenated steering turn, otherwise as separate steers in
  queue order. Each steered message drops one recognized patient prefix and
  switches to the steer intent (Claude `priority: "next"`); regular deferred
  entries keep their queue positions.
- This is distinct from regular queued rows jumping ahead during active work:
  promotion is a user override of patient waiting, not a change to the ordinary
  regular-vs-patient delivery ordering.
- Restart-recovered (`paused-after-restart`) patient chips carry the same
  `Steer now` action (`POST /sessions/:id/recovered-queue/:queueId/steer`,
  2026-07-03): the clicked entry and every recovered entry before it rejoin
  the live queue, then steer through as above. This is the direct unlock for
  preserved work — no resume-first step. Both recovered steer and recovered
  resume reject only when a *newer* live patient entry exists (delivering the
  older recovered content behind it would break compose order); resume of a
  non-head recovered entry resumes every recovered entry before it instead of
  erroring. See [queued-messages.md](queued-messages.md) § Patient
  persistence revision.

Narrow bottom-row overflow is tracked in
[`composer-bottom-bar-overflow.md`](composer-bottom-bar-overflow.md).

### Queued-item navigation affordance

Status: first implementation landed on 2026-06-06. Current queued rows expose
copy, edit, cancel, steering-capable `Steer now`, and a context jump. The first
anchor is the queued row's accepted timestamp, not the earlier first-typed-char
timestamp.

- Live regular, patient, and current-session Project Queue rows share the same
  Copy/Edit/Steer-now/Cancel action component, with inapplicable actions
  omitted. Recovered-after-restart rows remain distinct because Resume and
  Delete have different persistence semantics.
- Edit appears only when the main composer is whitespace-only and has no
  attachments or uploads. It cancels/removes the queued item first, then
  restores its text and recoverable attachments into the composer. If the user
  types during that asynchronous take, append the restored text rather than
  overwriting the new draft.
- This take-to-composer edit intentionally does not recreate the former
  server-side in-place deferred edit/barrier subsystem.
- Queued rows of all delivery intents should include a hyperlink-style jump
  affordance. It jumps to the scroll/view position where the message was
  significantly begun (earliest non-deleted character timestamp) when that
  anchor is available; using the sent/accepted timestamp is the simpler first
  implementation.
- After such a jump, show a temporary one-shot jump-back anchor with a matching
  icon in the left gutter. Activating it returns to the queued row and removes
  the one-shot anchor.
- The jump affordance is independent of edit/cancel/steer controls and applies
  to regular queued, patient queued, and recovered/verifying queued rows.

Clarified intent (2026-06-10, from the originating request):

- The affordance is navigation-only. It must not render a visible turn-like
  row, marker, or duplicated content at the compose position — its purpose is
  to let the reader see the agent-output context around the moment the
  message was typed, not to relocate or mirror the sent turn there. The only
  in-transcript artifact is the existing one-shot jump-back gutter icon
  after an explicit jump.
- Jumping is click-driven only. Queue promotion, merged delivery, reconnect,
  snapshot reconciliation, and re-renders must never scroll the view to a
  compose anchor on their own (see
  [scrollback-view-stability](scrollback-view-stability.md) for the general
  no-unsolicited-movement contract).
- The affordance should survive delivery: each chunk section of a sent
  multipart queued turn (the `--------`-separated blocks) gets its own
  side-link jump icon, because the chunks were composed at different times.
  Currently the affordance exists only on pre-delivery queued rows and
  disappears at delivery; per-chunk icons on the delivered turn are the
  intended extension, not yet implemented.

Observed bug (2026-06-10, diagnosed and fixed): the reader's scroll was
repeatedly pulled to the first merged send's compose context without the
affordance being knowingly clicked. It was not a scroll-writer at all: the
transcript content itself was being reordered on every merge. Claude
transcripts chain conversation rows through hidden connector rows
(`attachment`, `system`/api_error), and live stream rows arrive without
`parentUuid`. The client's `orderByParentChain` treated rows whose parent
chain was broken (missing connector) as orphans to append at the tail, and
parentUuid-less stream rows as roots to pull forward — so an api_error
fork's dead branch landed at the bottom of the transcript (directly above
the queued chips) and stuck there across merges, which read as "scroll
pulled to old context". Two fixes: `orderByParentChain` is now stable and
minimal-motion (only a row whose parent appears later in the array moves,
to just after its parent; broken-chain and parentless rows keep their
position), and the incremental-fetch cursor now tracks the newest
JSONL-sourced row instead of the array tail, so streaming can no longer
advance it past never-fetched connector rows.

## Compact-aware state transitions

- If YA triggers a pre-send compact attempt for a targeted provider/model,
  set `isCompacting` so UI enters `Compacting` state until YA receives a
  compact boundary event or the attempt fails/aborts.
- While compacting, show compacting copy and keep regular action constraints from
  the underlying turn/owner state (stop/queue/steer should follow those rules).
- If compaction is non-interruptible in the provider and blocks continuation,
  manual retry should remain a conscious user action, not automatic polling
  forever.

## `/btw` contract vs queue/steer

- `/btw` is a session-routing command, not a delivery intent.
- `/btw` must remain distinct from queue modes and steering.
- Parent session composer actions should be explicit; no implicit route sharing.

## Deferred queue reconciliation

Delivered-turn bubbles now carry this contract's spirit: a self-sent
turn renders as "sent" — fainter, with a margin "sent" tag — until its
durable transcript copy merges in, then confirms. Mechanism and the
Claude queue-operation pairing behind it:
[stream-durable-id-dedup.md](stream-durable-id-dedup.md) §Claude.

A server-accepted in-turn steer must survive reconnect while the provider is
still working on that turn. Its optimistic user echo remains in replay through
the provider turn boundary, even when a long-running tool outlives the ordinary
15–30-second replay window; the durable transcript remains authoritative once
the provider writes the turn. Reload must therefore show the accepted steer,
then reconcile it with the durable row rather than letting a live assistant
response appear without the user turn it answers.
Until that durable counterpart arrives or explicit cancellation succeeds, a
persisted-tail replacement must retain the optimistic echo as a transient
overlay. A tail snapshot may predate the provider write that confirms the send;
it is authoritative for its persisted window, but its omission cannot revoke a
server-accepted user turn. A later replacement containing the durable row must
collapse the overlay into that row rather than render two user turns.
Accepting a direct or steering send also rejoins the live viewport tail.
Subsequent visible thinking growth continues that follow until an explicit
wheel, touch, keyboard, or scrollbar gesture cancels it; confirming the
optimistic row must not make the accepted turn appear to vanish above the
viewport.

`sent` is server acceptance, not proof that the provider consumed the message.
If Codex rejects a steer because YA's cached active-turn ID is stale, the
adapter adopts Codex's reported actual ID and retries once. Only a successful
retry counts as provider steering; otherwise the already accepted message must
remain queued for a later delivery boundary.

Hard-abort recovery owns the same accepted-message obligation. YA may drain
pending user messages from the failed process for transfer, but it must keep
the prior provider ownership claimed until shutdown is verified. A replacement
process may receive those messages only after that verification, preventing
two app-server clients from claiming one retained Codex runtime and socket.

A delivered steering turn renders at its delivery point, not its send
point. In particular, when pending steers are delivered by an interrupt
(Claude rejects the running tool and consumes the queue), the turn must
read immediately after the `[Request interrupted…]` marker — one turn, no
stale "sent" copy left above the interrupt — so the reader can see what
the agent's next response is responding to (2026-07-04 request; dequeue
pairing in [stream-durable-id-dedup.md](stream-durable-id-dedup.md)
§Claude).

Deferred rows are server-owned queue state, not a second client-persisted
queue. A `connected` event, `deferred-queue` event, or queue-action response
replaces the client mirror with the reported server snapshot.

A delivered user echo is also authoritative server evidence. Its `tempId`
removes the matching deferred row; when a queued batch is joined into one
provider turn, `concatUserMessages` records every chunk's `tempId` in
`UserMessage.tempIds`, the echo carries the whole list, and the client removes
every matching chip. The client remembers those delivered identities for the
mounted session so a slower, older queue snapshot cannot resurrect accepted
rows. Unrelated queued rows remain visible.

Deferred rows do not reconcile by text. Identical prompt text can legitimately
exist in a delivered turn and a still-queued turn, so an echo without identity
waits for the next server queue snapshot or reconnect. Reload likewise rebuilds
the mirror from server state rather than restoring client queue scratch.
Content-and-timestamp reconciliation remains limited to optimistic normal sends,
whose providers can omit a temporary identifier.

A self-sent steering turn that is still only an optimistic `sent` echo and has
not been consumed by the provider must expose Cancel. Cancel is conditional: if
the provider input queue still holds that `tempId`, remove the provider-queue
entry and the local echo; if the provider has already acted on it, leave the row
in place and report failure/refresh rather than pretending the message was
cancelled.

## Action matrix by readiness

- `idle`
  - primary send is direct.
  - model/menu edits are available when session ownership is clear.
  - compact commands may be exposed when adapter metadata supports them.
- `in-turn` / `waiting-input`
  - primary control is state-aware (`Steering/Queue/Compaction` as applicable).
  - full model editing is deferred/hidden by rule above.
  - compacting overlay remains copy-only and must not advertise model edits.
- non-`self` ownership
  - queue remains allowed where supported.
  - direct send and model edits should remain guarded, not forced.

## Known provider gaps / portability guardrails

- Codex
  - supports steering via provider controls and exposes compact behavior; compact
    can still fail if context is already saturated.
  - native Codex TUI evidence suggests typed mid-turn input can wait under
    `Messages to be submitted after next tool call`, while `Esc` on that prompt
    interrupts enough to submit the pending steer promptly. Treat YA steering as
    active-turn input, not a stop guarantee; Stop/interrupt remains separate for
    mistaken or slow running tools.
  - compacting is strongly non-interruptible in observed flows, so the overlay and
    no-auto-retry posture should be treated as expected behavior.
  - target-specific workaround currently validated for `gpt-5.3-codex-spark`:
    preemptive compact-on-idle boundary before user message send when usage
    pressure exceeds the tuned threshold.
- Claude
  - slash command availability is unevenly surfaced and no reliable internal
    compact control is validated in this contract layer.
  - steering is not currently part of the path, so queue/deferred paths carry the
    primary queueing burden.
- OpenCode
  - no validated compact command path is currently exposed.
  - control is split between status/event evidence and message routing; no automatic
    compact expansion beyond explicit template/handoff behavior.

## Provider-driven handoff status

Provider-native handoff has not been independently verified end-to-end in this
workstream. The scripted template-based handoff remains the validated behavior,
with prompt-visible context carry-forward to ensure recoverability even when
provider-native handoff is unavailable or unsupported.
