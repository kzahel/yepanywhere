# Session Liveness And Queue Intent

> Session liveness is the provider/session contract for bounded recovery,
> user-visible progress and queue promotion decisions.

This topic covers YA's provider/session liveness contract and the features
that depend on it, especially deferred queue promotion and
patient queue intent.

Related topic: [heartbeat ownership and timers](heartbeat.md).
Related topic: [YA-owned session identity](session-identity.md) — selected
durable session/startup ownership before a provider process or transcript
exists; implementation pending. [Creation/navigation](session-creation.sketches.md)
builds on it without treating a saved session as a live provider turn.
Related topic: [session ownership and shared-transcript writers](session-ownership.md)
— who is writing the file, a different axis from whether the turn is progressing.
Related topic: [reload-safe provider runtimes](reload-safe-provider-runtimes.md)
— proposed owner continuity across a replaceable development backend.
Related topic: [provider waits and background work](provider-wait-and-background-work.md)
— how each provider sleeps, keeps work alive after a turn and wakes itself,
and why Codex background terminals do not retain a session.

## Contracts

- Transport liveness, process liveness, provider progress, and user intent are
  separate signals. A connected browser, ticking heartbeat, live child process,
  or detached background job is not proof that the active agent turn is still
  progressing.
- `SessionLivenessSnapshot` is the provider-neutral summary. It must carry raw
  evidence timestamps and a conservative derived status so clients can show
  uncertainty instead of inventing progress from silence.
- `verified-idle` is the only liveness status that means YA may safely treat a
  session as idle for automatic work. Synthetic heartbeat turns and their
  steering-capable doubt probes were retired; transport heartbeats remain
  status signals only.
- A mounted live-session stream is a session-local resource-retention lease,
  not liveness evidence. It suspends idle reaping only for that provider
  process; global app activity and views of other sessions do not. Active and
  waiting-input sessions are presumed live and have no viewer-absence kill
  deadline; only `verified-idle` without another retention owner is eligible
  for the configured idle grace.
- Every session-row projection reports the same live-process state. Ownership,
  `pendingInputType`, `activity`, and `hasUnread` come from one owner,
  `sessionRowRuntimeOverlay` in
  `packages/server/src/sessions/session-runtime-overlay.ts`, so All Sessions,
  the inbox, a project's session list, and the retained collections cannot
  disagree about a session they all show. The live events that update those
  rows between fetches use the same owner: `session-status-changed` carries
  `sessionOwnershipFromProcess`, and `process-state-changed` carries the row's
  activity and pending input (`sessionActivityEventFromProcess`, reporting no
  activity as `idle`). In particular an idle process that still retains
  provider work (background tasks, crons) reports `activity: "in-turn"` on
  every one of those surfaces and in their live updates.
- An idle grace owns one absolute deadline. Delays longer than Node can arm in
  one timer are scheduled in safe chunks against that unchanged deadline; a
  chunk firing is not grace expiry. Live timeout changes replace the deadline
  from the current idle/no-viewer anchor rather than restarting the idle period.
- `verified-idle` plus grace expiry permits `Process` to begin teardown; it does
  not permit `Supervisor` to release session ownership. Idle teardown fences
  direct and deferred input synchronously, while the existing process mapping
  and `owner: "self"` projection remain until provider exit is positively
  verified by PID, provider liveness, or iterator completion. Failed or timed-
  out verification remains a terminal error owner: it emits no completion or
  `owner: "none"`, refuses resume/reactivation/configuration replacement, and
  can be released only by a later explicit abort that verifies exit.
- Once explicit Kill/Terminate persists `autoResumeDisabled`, no automatic
  work may start that provider session again. Wake and cold fork-recap revival obey this gate. Explicit user continuation through
  the full session page may still reactivate the session.
- Once `/done` persists `automationPausedUntilUserTurn` — at the request,
  including while a turn is still running — no YA-driven provider work may
  enter that session: session wake, recap/forked recap,
  threshold compaction, prompt-cache keepalive, patient queue promotion, and
  automatic Project Queue revival all stop. The action does not interrupt an
  active turn. Message-less Activate leaves the pause in force; the next real
  user turn clears it, while automatically sourced turns never do. The
  Process-local `/done` chip and synthetic row may still be waiting for idle
  finalize; losing that chip does not clear the persisted pause.
- Sidebar session rows are navigation and status surfaces only; they never
  reactivate a provider process. Message-less activation remains available in
  the full session's model panel, while sending a message resumes an unowned
  session and delivers that turn.
- Heartbeat turns are idle-timeout checks, not wall-clock ticks. Once a session
  is `verified-idle`, the timeout anchor is the latest real provider/session
  liveness signal, including verified idle/progress, normalized provider
  messages, raw provider cadence, or successful provider probes; client
  transport heartbeats do not reset this timer.
- `verified-waiting-provider` means an active probe confirms the provider still
  owns the turn even though no user-visible progress has arrived recently.
  Queue controls may remain available, but the UI must not imply that a
  natural boundary has been reached.
- Raw provider/app-server events are cadence and debugging evidence, not proof
  of user-visible progress. They should be visible in snapshots/tooltips, but a
  recent raw event alone must not upgrade a stale active turn.
- `stream_event` transport traffic alone is not user-visible progress. A stale
  active turn should move to `verified-progressing` only when the stream event
  carries user-visible content (for example text/thinking delta content), not
  for envelopes that only describe connection state.
- Use the explicit term **user-visible liveness** for this upgrade gate: only
  content that is actually rendered to the user qualifies as progress.
- Provider control-channel probes may verify that a provider runtime is still
  responsive while the active turn is silent. They should be labelled by source
  and detail, and should not be described as user-visible progress.
- `long-silent-unverified` and `needs-attention` are product-visible states.
  They should not be hidden behind calm queue wording or spinner animation.
- The transcript's processing indicator rotates its phrases only while output
  is recent. After 30 seconds with no new output during an open turn (counted
  from the newest of the turn start, the latest transcript message, streamed
  content, and the server's last provider message), it shows a static
  "No new output for {duration}" that ticks each second, adding "provider
  reports the turn active ({age} ago)" only when an active provider probe ran
  after that output. The 30-second threshold is deliberately shorter than the
  five-minute long-silence status: a silent tool-call generation runs for
  minutes, and phrases during it read as progress.
- A provider-reported interrupt is terminal liveness evidence for the affected
  turn, not silence and not progress. YA must render it explicitly and reconcile
  pending tool rows, queued-message state, and ownership rather than leaving an
  old spinner to imply work may still be continuing.
- Background or detached tool handles count as useful session context only
  when YA can tie them to a currently awaited foreground tool result. Detached
  jobs alone are not liveness evidence for the agent turn.
- Provider process/server liveness is weak evidence. It may explain why a
  session can still be recovered or queried, but it must not upgrade a silent
  active turn unless the provider exposes a real active-turn status signal.
- Provider-native transcript storage can change independently of YA process
  liveness. A valid native session that survives a YA restart must be readable
  through the provider's current durable export/list surface, not only through
  an older on-disk layout that happened to exist when the adapter was written.
- Provider child-process session-id propagation for `agentctl` active-session
  upkeep is coordination metadata, not liveness evidence. A `BASH_ENV` bridge
  can make future provider-spawned Bash tool shells inherit
  `AGENTCTL_SESSION_ID`, but it does not mutate an already-running process
  environment and must not upgrade a silent turn to progress or idle.
- OpenCode `/session/status` is a real active-turn status signal for that
  provider. `busy` and `retry` entries are active evidence, `idle` and missing
  entries mean no active OpenCode work is reported for that session, and
  malformed present entries are probe errors rather than idle proof.
- OpenCode `session.status` and `session.idle` SSE events are raw
  provider-cadence/status evidence. They may reset idle quiet-period timers and
  help explain a silent turn, but raw SSE cadence alone should not become
  user-visible progress without a normalized message or active status probe.
- Queue intent is message intent, not scheduling proof. Queued messages stay in
  the parent session; they should not steer the active turn or route through
  `/btw`.
- Patient queue intent is explicit message intent. It may carry softer
  "when done" wording and `deliveryIntent: "patient"`, but it is still not
  liveness evidence or a scheduling guarantee.
- User-message composition timing and delivery intent are YA-owned metadata.
  They describe what the user did and intended, not whether the provider is
  alive, and provider adapters should forward them only through a real
  structured channel or through an explicit prompt-visible product decision.
- New-session initial prompts accepted by YA should remain recoverable from
  session history even if provider startup fails before transcript persistence.
  Lists and details may use metadata or the first-message full title as the
  copy source, but should not require the provider JSONL to exist first.

## Invariants

- Provider adapters may add stronger evidence, but weaker evidence must not
  upgrade a session to `verified-progressing` or `verified-idle`.
- Active probes are rate-limited and separate from stale-process termination.
  A failed or contradictory probe should update liveness evidence before any
  destructive recovery policy is considered.
- Probe timeouts must resolve into liveness evidence. A hung probe must not
  leave YA silently believing verification is still underway forever.
- Browser refresh, reconnect, resubscribe, or session-file refresh must not
  generate a provider interrupt. If an interrupt is observed after one of those
  paths, YA should treat the correlation as a high-priority causality bug while
  still surfacing the interrupt boundary immediately.
- A transport heartbeat is not provider progress, but a session heartbeat can
  expose provider progress the client failed to render. If its
  `lastProviderMessageAt` is newer than the last applied reader-owned
  `transcriptSnapshotUpdatedAt`, the client must catch up from durable
  transcript state. Empty or unversioned reads do not advance that watermark,
  so later heartbeats keep retrying while the gap remains.
- A session heartbeat repeats the authoritative process/liveness snapshot
  every 30 seconds. When current process state is idle and that snapshot says
  `verified-idle`, unfinished transcript tool rows cannot keep the processing
  animation, Stop action, or deferred-send mode active. Missing completion
  messages remain recoverable through transcript catch-up. A newly active
  process state supersedes an earlier idle snapshot; provider-retained work
  still counts as active. Stream silence triggers the existing 75-second
  subscription watchdog, rather than implying provider progress.
- A viewer opening a session cancels that process's pending idle teardown.
  When the final viewer of that session leaves, its eligible idle process
  receives a fresh full grace. Other session views, provider traffic, and
  process liveness do not extend the deadline, while explicit retention
  continues to block idle teardown.
- Server restart or hot reload that tears down the provider owner is not passive
  browser refresh. Treat it as owner-loss liveness evidence first, then decide
  whether the process can be safely resumed or must be shown as interrupted.
- Patient-queue quiet periods reset from real provider/session evidence,
  not from transport status frames.
- If a provider probe says the turn is idle while YA is still blocked in an
  active turn, the adapter should reconcile through the normal provider event
  path whenever possible. That keeps transcript, queue promotion, and client
  status semantics aligned.
- Queueing, sending, and steering must preserve the user's text unless the user
  explicitly typed a prefix, used the Ctrl+Enter patient queue accelerator, or
  chose queued-chip `Steer now`, which strips one recognized patient prefix.
- A raw event timestamp may explain that the provider transport is still
  emitting JSON-RPC traffic, but derived liveness still needs a normalized
  provider message, awaited tool lifecycle, or explicit active probe to claim
  progress.
- An OpenCode status map with no entry for the current session is different
  from a malformed entry for that session. Missing means no active entry;
  malformed means the provider contract is not understood and the probe should
  surface an error.
- OpenCode text parts must be interpreted through the corresponding
  `message.updated` role metadata when it is available. A user text part is not
  assistant progress and should not be rendered as an assistant message.
- OpenCode 1.14.x may emit `message.part.delta` SSE events. When the
  adapter has already learned the part's message role and type, text deltas
  may become normalized assistant progress, but raw delta cadence alone is
  not a stronger liveness proof.
- OpenCode may return the completed assistant message in the
  `POST /session/:id/message` body even when `/event` closes before carrying
  assistant content. YA may use that body as a final-response fallback only
  after no assistant content has streamed, and must not duplicate later SSE
  text after taking the fallback.
- User-message metadata should survive REST acceptance, optimistic/replayed
  user echoes, and deferred queue summaries without becoming hidden prompt text.
- Deferred messages promoted at a natural turn boundary should produce the
  same user-message echoes as direct queue acceptance, even when a
  non-steering provider receives the promoted backlog as one concatenated
  provider turn. Client recovery must reconcile each visible queued chip
  against that concatenated turn rather than treating unmatched localStorage
  state as still pending.
- Initial-prompt recovery metadata is a copy/retry affordance. It must not
  replace transcript messages or be treated as provider progress evidence.

## Lifecycle Ownership

`ProcessViewerLifecycle` is the single owner of viewer leases, the no-viewer
anchor, the absolute idle deadline, reload-safe viewer publication, and the
pending-teardown ownership fence for one `Process`. `Process` reports state and
retention transitions into that owner and receives one result:
`onIdleReap`. Provider iteration, abort, and positive teardown verification
remain in `Process`, so the lifecycle owner cannot release session ownership
on its own.

This boundary keeps every deadline-affecting transition in one state machine.
A viewer transition, process-state transition, retention change, live timeout
change, reload detach, and verified teardown all enter through explicit
methods; no caller directly arms or clears the timer.

## Representative Change Types

- Adding a provider-specific status probe or raw event cadence source.
- Changing the reducer that derives `SessionLivenessSnapshot.derivedStatus`.
- Changing liveness probe boundaries or deferred queue
  promotion boundaries.
- Changing composer queue controls or queued text transformation.
- Adding user-message timing or delivery-intent metadata.

## Tests That Should Fail On Contract Regressions

- An idle process with contradictory active-provider evidence becomes
  `needs-attention`, not `verified-idle`.
- A stale active turn with recent active-provider evidence becomes
  `verified-waiting-provider`, not `long-silent-unverified`.
- A stale active turn with only a recent raw provider event stays
  `long-silent-unverified`.
- A stale active turn with a stream_event envelope but no user-visible progress
  stays `long-silent-unverified`.
- A stale active turn with no usable probe stays unverified.
- OpenCode `busy` and `retry` `/session/status` entries become active probe
  evidence, while an unrecognized present entry becomes probe error evidence.
- OpenCode user text parts do not become assistant messages when
  `message.updated` identifies the message role as `user`.
- OpenCode `message.part.delta` text streams incrementally without duplicating
  the final `message.part.updated` content.
- OpenCode completed message POST-body fallback renders assistant text when
  SSE closes without assistant content.
- Synthetic heartbeat turns never execute. Patient messages retain their
  verified-idle and real-activity quiet-period checks.
- Queueing and steering preserve the user's text.
- Deferred queue summaries preserve accepted delivery intent and composition
  timestamps for reconnecting clients.
- A failed or not-yet-persisted new session with an accepted initial prompt
  exposes a copy action for that prompt in session history.
- Sidebar session rows expose no message-less Resume action or reactivation
  request; full-session Activate and resume-on-send remain available.
- Claude control probes time out and surface errors rather than relying on
  process-alive as proof of progress.
- Viewer-absence reaping applies only to verified-idle, unretained work. Any
  open app tab globally refreshes the grace; active, waiting-input, and
  explicitly retained processes have no viewer-absence deadline.
- An idle timeout longer than Node's maximum single-timer delay is armed only in
  bounded chunks and reaps at the original deadline. Live shortening and
  lengthening retain the current idle/no-viewer anchor.
- Pending or failed idle teardown keeps the same registered process, rejects
  direct/deferred input and replacement, and emits no ownership release. A
  later verified abort retry emits exactly one completion and `owner: "none"`.
