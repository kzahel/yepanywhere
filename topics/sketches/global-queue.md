# Global Queue for existing sessions

Status: **proposal only.**

Companion to: [Project Queue](../project-queue.md)

## User experience

- **Settings → Toolbar → Global Queue** reveals a composer action labeled
  **Global Queue**. Its tooltip says **Send after Project Queue is empty and
  this server is idle**. It starts hidden and uses the existing toolbar
  presence controls. Hiding the action leaves accepted entries available
  from the queue manager. [Toolbar presence](../session-ui-customization.md)
- Click **Global Queue** to queue the message in the composer as a turn in
  that session. Click **Send** for ordinary submission, including deliberate
  parallel work. On queue acceptance, the composer acknowledges that message
  and shows its queue position. With an idle server, an empty Project Queue,
  and dispatch running, the global head can start immediately. Machine
  Control arbitrates actual VM access, including between clients on
  different servers.
- On the Projects page, place **Global Queue** directly below **Project
  Queue** while there is global work to show. List entries in submission
  order, offer Cancel or Retry where applicable, and show the blocker for
  the head, such as **Waiting for Project Queue**. Show one **Pause queues**
  or **Resume queues** control when either queue has backlog, including
  when Global Queue is the only section shown. The server owner sees these
  states on the selected YA server.
- In a session, use the existing queued-message stack above the composer.
  Show normal session items first, then Project Queue items, then Global
  Queue items for this session. Give the Global Queue button and rows a teal
  accent alongside Project Queue purple. Label each global row with its
  server-wide position, for example **Global Queue · #2**.

## Dispatch and recovery

- Accept entries durably in FIFO order across projects. Wait for admitted
  starts, active turns, runnable session input, retained provider work and
  known external ownership on this YA server to drain. An approval request
  counts as activity, as does a still-running turn with `/done` queued.
  Use live supervisor and queue facts, without scanning the session catalog
  or replaying transcripts. [Project idle predicate](../project-queue.md#project-idle-predicate)
- Global Queue may start only when Project Queue contains zero items across
  all projects. Queued, blocked, failed and dispatching project items all
  count. Project Queue **Move to top** orders work within one project. Global
  Queue presents its own entries in submission order. Use one shared guard
  for the final emptiness and idle checks and the dispatch reservation. A
  project item added during a global turn can dispatch after that turn
  settles and takes precedence over the next global turn. Session and queue
  events drive scheduling while work is pending.
- Use one persisted Pause/Resume state for automatic dispatch of both
  queues. Already-admitted work can finish while paused. The empty-backlog
  reset applies once both queues are empty. Existing Project Queue actions
  that resume dispatch, including **Move to top**, resume both queues.
  [Project Queue pause semantics](../project-queue.md#core-semantics)
- Reuse Project Queue's draft acknowledgement, attachment staging and
  authorized existing-session delivery. Put global entries in a distinct
  app-data file using the same persistence primitives. Older servers would
  parse an extra scope field on ordinary `project-queues.json` items as a
  project-scoped entry after downgrade. Preserve a dispatch record through
  the startup-to-turn handoff so a second item cannot slip into that gap.
- Restore waiting entries and an observed active turn on orderly reload
  through the existing handoff. Pause after an unclean restart. An item with
  uncertain delivery requires explicit review before retry. [Orderly queue recovery](../reload-safe-provider-runtimes.md#orderly-queue-recovery)

## Implementation and acceptance

1. **Server order and safe handoff.** Reuse the existing session blockers
   and dispatch path with an install-wide view and one automatic admission
   guard. Exercise a failed Project Queue head, pause with only Global Queue
   backlog, and a project enqueue racing global admission. With two global
   entries, confirm that the first waits for Project Queue and active work
   to drain, and that the second waits through the first turn and its
   retained work. Exercise cancellation and crash recovery around delivery.
2. **Composer and queue manager.** Add one Toolbar setting, one composer
   action and server-reported queue rows. Verify draft acknowledgement and
   sequential typing under concurrent queue updates on desktop and phone.
3. **Hosted client compatibility.** Give Global Queue its own capability
   covering queue reads and mutations, state updates and the toolbar key.
   Without it, hide the action and setting, omit the key from settings writes
   and skip Global Queue requests. The local stable-tag corpus at scoping is
   v0.12.0, v0.13.0 and v0.14.0. Recheck that corpus and approve the exact wire
   contract before editing it. [Server capability horizons](../server-capabilities.md#minimum-compatibility-horizons)
