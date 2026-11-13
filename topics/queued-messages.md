# Queued messages (server-authoritative)

> Queued ("deferred") messages are server-owned state. The client renders the
> server's list and issues add/cancel requests. It never keeps its own copy of
> the queue or reconciles by text. Long-lived patient entries are durable
> server state while queued; short-term direct/deferred entries remain
> process-local. YA-local command chips may reuse this projection without
> entering any provider-delivery queue.

Topic: queued-messages

This note defines the intended design for queued messages. It is a deliberate
simplification back toward the original, working implementation. The current
code diverges from it — it mirrors the queue into `localStorage`, layers on
client-only delivery states, and reconciles the two stores by fuzzy text
matching. That divergence is the source of a large, untrustworthy class of
split-brain bugs (see "What we are removing" below) and is being corrected.

Provider-level delivery facts (Claude `now/next/later` lanes, Codex
`turn/steer`, end-of-turn boundaries) live in
[steer-queue-provider-differences.md](steer-queue-provider-differences.md). The
busy/idle composer contract lives in
[message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md).
This note is narrower: it governs *where queued-message state lives and how the
client learns about it*.

Terminology warning: current code stores both short-term `deferred` entries and
long-lived `patient` entries in `Process.deferredQueue`. In product discussion,
"the queued messages worth preserving" usually means the patient queue: visible,
cancellable entries that wait for verified idle and can remain pending for many
minutes.

## Principles

1. **Server-authoritative.** Live queue state is owned by the in-process queue
   on `Process` (`deferredQueue`), while restart-recovered patient entries are
   owned by the server persistence service. Every client renders exactly the
   server's canonical projection of those two stores. There is no client-side
   queue model, merge step, or reconciliation pass.
2. **There is one composer draft, and it is the only client-persisted state.**
   Queued messages introduce no draft of their own. The only thing persisted on
   the client is the existing main session composer draft — the text you are
   typing — using the same draft persistence the composer already has. "Queue"
   versus "send now" is a routing decision made at submit time on that single
   composer's content (the steering mechanism), not a separate editor or a
   separate draft store. The queue itself is never written to `localStorage`.
3. **Identity is a server-owned id, never text.** Messages are addressed by id.
   Three queued messages that all say "proceed" are three distinct ids and are
   never collapsed, matched, or de-duplicated by their content.
4. **Patient persistence only.** Short-term deferred and direct queues live in
   the Process and die when the process restarts or the session stops. Patient
   entries are durable server state while queued on every provider. Delivery
   timing remains provider-specific: providers without verified background-work
   retention promote patient intent at the ordinary turn-end boundary, but must
   not weaken its restart durability. Restart-loaded patient entries surface as
   `paused-after-restart` queue chips and require an explicit action: resume
   (rejoin the provider's patient/deferred delivery path), steer (deliver now),
   or delete.
5. **YA commands are explicitly tagged controls.** A queued YA-routed command
   uses the Process-local `pendingYaCommands` lane and a `kind: "ya-command"`
   summary. It is never inferred from slash-shaped queued text and never enters
   deferred, patient, direct, or provider delivery. This preserves provider
   skills with colliding command names. The `/done` chip itself stays
   Process-local; its automation pause is durable session metadata written at
   request time (see [session-context-actions](session-context-actions.md)).
6. **No optimism.** Queuing and cancelling behave exactly like sending a normal
   session message: the composer disables, the request goes to the server, and
   the UI only changes when confirmed server state comes back. No optimistic
   chip, no optimistic removal, no revert path.

## Behavior contract

- **Refresh / any tab / any machine → identical state.** Because every client
  renders the server's list, there is nothing to diverge. Open the session in
  two tabs and you see the same queue.
- **Queue (add).** Only offered while a turn is active (`in-turn`). The composer
  disables on submit; the chip appears when the server's updated queue is
  delivered. Queuing is meaningless when idle.
- **Idle send.** When the session is idle the queue affordance is not shown; a
  send goes straight through as a normal message. Nothing is queued.
- **Cancel (delete).** Issue the delete request; the chip disappears only when
  the next server state no longer contains it. A delete of an already-gone id is
  a no-op.
- **Composer recall never unqueues.** Queuing leaves focus in the emptied
  composer, so ↑ and Ctrl+P there are easily pressed by accident. While the
  last submission is still queued they do nothing; the message stays queued
  and only the chip's explicit Edit or cancel controls remove it.
- **Process restart / session stop.** Short-term direct/deferred queue state is
  gone. Persisted patient entries load as `paused-after-restart`; clients
  reflect those server-reported entries on the next sync and never resurrect
  queue state locally.
- **YA-local command boundary.** An accepted command may use the same queued
  chip while an agent turn remains active. The control lane resolves locally at
  the first safe boundary, and ordinary queued provider work stays held until
  that resolution commits. It neither consumes a patient/regular queue
  position nor exposes provider-queue edit, steer, or cancel actions.

## Explicit queued compaction

On a server advertising `queued-session-compaction`, Queueing `/compact`
creates one separately identified operation for an existing Claude or Codex
session. It follows the selected regular or patient boundary. Earlier regular
work keeps its order; waiting patient work retains its existing readiness
policy. Native Codex compaction uses its RPC, while Claude receives its exact
command and optional instructions. The command never joins prose batches,
steers into an active turn, or becomes text on an interrupt-drain batch.
Queue the follow-up as a separate message.

Compaction waits for provider-retained background work to end. Claude's
fallback also ignores results until its exact command input has been consumed.
After compact reserves execution, later input is held in YA, including an
ordinary Send; sending cannot restart the compacting provider. The composer keeps Queue
available while compaction is running. A compact boundary alone is insufficient:
YA waits for provider turn completion and a successful compact observation
before releasing later work. A delayed dispatch reply also holds the reservation.
Pending commands can be cancelled. Dispatched commands cannot be edited,
steered or cancelled as though provider execution were undone; Stop/Kill remains
a verified process-stop action and never automatically replays compaction.

A definitive native refusal becomes an idle, cancellable failed operation;
a lost transport reply remains unconfirmed until actual completion or Stop.
Retrying provider errors do not fail an operation that subsequently succeeds.
A failure retains the command with **Compaction failed; waiting**, its reason,
and all following work. The user can cancel a failed command after its provider
turn settles to continue without it. The three-minute observation deadline
reports **Compaction outcome unconfirmed; waiting**; it neither retries nor
releases input. Later successful completion releases work normally. If the
provider never settles, Stop/Kill ends that owner. Failed operation recovery
never means sending `/compact` as a model prompt.

Regular entries retain their process-local lifetime. Pending patient compact
commands use the existing patient persistence and resume paused after restart.
Hard-abort recovery reactivates the existing conversation without using a
compact as its launch prompt, then restores and dispatches the ordered queue.
Before provider dispatch, YA removes their replayable durable entry; a command
already handed to the provider is never silently replayed on restart. This does
not add durable regular queues, receipts for compaction, or automatic recovery
of uncertain operations. A retained worker may finish after its controller
leaves; an old callback cannot dispatch into a departed controller.

The additive queue summary marks `operation: "compact"` and publishes
`cancellable: false` while execution is unconfirmed. Older clients can render
the existing content/status fields. New clients without scheduling support
refuse Queue `/compact` locally and preserve the draft, while retaining idle
manual Compact. No unsupported delayed command is sent to an older server.
Project Queue's separate compact restriction is unchanged.

## Canonical queue projection

Every complete wire snapshot is produced by `sessionQueueSummaries()`. It
combines the active `Process` deferred and YA-command projections with
persisted `paused-after-restart` patient entries, orders the result
chronologically, and removes a
resume-transition duplicate by durable queue id. A resumed live patient entry
carries the same durable id as its persisted representation and wins while both
stores briefly contain it.

The initial session `connected` event, every `deferred-queue` event, session
detail reads, and queue mutation responses all publish this same projection.
An internal `Process` `deferred-queue` event is only a change signal; the
transport queries the projection when it emits rather than forwarding a
process-local list. Consequently, replacing the client's last snapshot remains
correct: an empty authoritative list removes deleted work, while a stream event
cannot erase a recovered chip that still exists on the server.

## Surface

Labeled Copy controls align the visible label optically with the copy icon
inside their button bounds, including the confirmation state.
Session and project queue bubbles balance their text optically within the
background, preserving total height and the distinct queue accent colors.

- **List:** the client receives the queue from the server only — the `connected`
  event payload on (re)connect and `deferred-queue` subscription events on
  change. Session detail/metadata responses use the same canonical projection
  for initial load after a server restart.
- **Add:** `POST` a queue request; the server appends and returns/broadcasts the
  new canonical list.
- **Cancel:** `DELETE` by id; the server removes and returns/broadcasts the new
  canonical list.
- **Draft:** the main composer's existing single draft, persisted in
  `localStorage` per session and cleared on a confirmed send. Queue and send-now
  share this one draft; there is no queued-message-specific draft.

The client holds no queued-message React state of its own beyond rendering the
last server-reported list; it does not maintain `deliveryState`,
`recovered`/`verifying` flags, client `tempId` reconciliation, or any text-match
removal logic.

## Non-goals (explicitly deferred)

These are intentionally out of scope for the core. Reordering and inline editing
are reasonable future features and can be layered on **once the basic
queue/cancel functionality is bug-free and trustworthy** — they are deferred,
not rejected. The point of this note is to ship a correct minimum first.

- **Editing a queued message.** To change a queued message, cancel it and queue
  a new one. (Future: in-place edit can be added on top of the server model.)
- **Reordering / reshuffling the queue.** (Future: server-side reorder by id.)
- **Steering a queued message into the active turn.** (Landed 2026-07-03 for
  patient entries, on top of the server model: the chip's `Steer now` action
  steers that entry plus every patient entry ahead of it, and appears on
  restart-recovered chips too, where it resumes-through before steering — see
  [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  § Patient countdown and promotion.)
- **"Jump to context" / nearest-timestamp navigation** from a queued chip.
- **Disk persistence of short-term direct/deferred queues.** A planned durable
  slice is patient-only; direct `MessageQueue` entries and short-term
  `deliveryIntent: "deferred"` entries only exist while a session is active, and
  active sessions already block safe restart until those entries drain.
- **Optimistic UI** for add or delete.
- **Any fuzzy or content-based matching**, ordering inference, or client merge.

## Patient persistence revision

`docs/tactical/037-session-queue-persistence-prep.md` tracks the planned
revision. The agreed live persistence shape is intentionally narrow:

- persist every `deliveryIntent: "patient"` entry, independently of whether the
  provider can wait for verified background quiet or uses ordinary turn-end
  delivery;
- load persisted patient entries after server restart as paused-after-restart,
  never auto-send them on startup;
- continue rendering queue state from server-owned state, not browser storage;
- keep short-term `deliveryIntent: "deferred"` entries ephemeral because they
  are tied to an active session and should promote before safe restart is
  possible;
- keep direct `MessageQueue` entries ephemeral for the same restart semantics;
- do not use text matching to recover, deduplicate, or remove entries.

Status as of 2026-06-30 (revised 2026-07-20): live patient queue write/delete
is wired into `Process`/Supervisor. A queued patient entry is written to the
server persistence service for every provider, and cancel/promotion/drain
removes it — including Codex's ordinary turn-end promotion and the
promote-straight-through path, which consumes the entry's durable row even
though no queue entry exists to drain later. Startup-loaded paused entries are
surfaced through session detail/metadata responses and can be deleted by
durable queue id. Per-entry resume resumes *through* the clicked entry: a
non-head resume also resumes every recovered entry before it, so compose order
is preserved rather than rejected. Recovered chips also expose `Steer now`
(`POST /sessions/:id/recovered-queue/:queueId/steer`), which resumes-through
and then steers the group into the session immediately. Both actions reject
only when a live patient entry *newer* than the clicked entry exists
(delivering older recovered content behind it would break compose order);
regular-lane deferred entries never block recovered work, since that lane may
pass patient work by design. Safe restart
reports recovered patient entries as preserved work, not blockers, and converts
live patient entries to `paused-after-restart` once active sessions plus
short-term/direct queue blockers have drained. Project Queue promotion treats
persisted recovered patient entries as project-busy so project-level work
cannot jump ahead of preserved per-session work. The Projects page groups
recovered entries by session and offers per-row Resume and Delete through the
same session-scoped routes as the session page. Those actions remain
server-confirmed and id-addressed: Resume preserves resume-through ordering,
and Delete removes only the selected durable id. Full context and Steer now
remain on the session page; there is no project-level Resume all control.

A session page can show a recovered chip whose entry the server no longer
holds. When Delete, Resume, or Steer now reports the entry missing, the page
rereads the session's queue so the chip goes. Delete then reports nothing,
since the entry is gone as asked; Resume and Steer now still report that they
did not run.

## What we are removing and why

Each removed piece maps to a concrete bug class it produced:

- **`localStorage` mirror of the queue** → split-brain between the persistent
  client copy and the ephemeral server queue: ghost chips that look queued but
  will never send, and chips that send twice.
- **Client `deliveryState` (`queued`/`sending`/`recovered`/`verifying`) and
  the connected-event merge** → "recovered" scratchpad entries the server has
  no record of, kept alive locally and never delivered.
- **Fuzzy text matching (`userTextContainsDeferredContent`, time-marker
  stripping, transcript/echo removal)** → identical or similar messages (the
  "proceed / proceed / proceed" case) collapsing into each other or being
  removed before they are actually delivered.
- **Client `tempId` re-threading and the edit barrier** → fragile id churn and
  an orphaned server-side barrier that silently blocks delivery of everything
  behind it.
- **Optimistic add/remove with revert paths** → transient failures that reorder
  the queue or leave the UI inconsistent with the server.

The original simple implementation — render the server's queue, add, cancel —
worked. This note codifies returning to that and keeping richer features off the
critical path until the base is solid.
