# Client Rendering Performance

This document describes the Yep Anywhere client render/update pipeline and the
performance invariants worth checking when browser-side latency regresses.

YA uses React for the ordinary app shell because most UI state is low-rate:
navigation, approvals, settings, queued-message controls, tool rows, and
completed transcript items. High-rate agent output is the exception. The design
is therefore to keep React for coarse UI structure while preventing token-sized
or bursty work from invalidating the whole transcript or running expensive
formatters repeatedly.

Do not replace React or introduce a custom framework-level renderer for this
class of bug. Prefer simple, standard React data flow first. Imperative DOM
updates are reserved for narrow leaf streaming paths where YA owns the chunking
and can prove the update is cheaper and behaviorally isolated.

Do not assume React will compute useful edit scripts inside long strings.
Changed text props and `dangerouslySetInnerHTML` updates should be treated as
coarse updates. Incremental wins come from YA-owned chunking, block DOM updates,
stable component identity, and lower update cadence.

## Measurement boundaries

The [isolated frontend calibration](../../docs/research/190-frontend-renderer-calibration.md)
compares the real transcript and full session page with completed normalized
turns, at controlled retained-history sizes. It measures frame opportunities,
long tasks, visible markers and every native typing prefix separately from
aggregate CPU. Unlimited history and disabled active-window trimming hold the
history axis fixed; these are explicit fixture preferences, not normal defaults.
Provider/network/backend work and high-rate streaming are separate workloads.
The [performance suite](../../topics/performance-regression-suite.md) owns the
harness contract and interpretation.

## Pipeline

1. Session streams enter through `useSessionStream` and are dispatched in
   `useSession`.
2. Token-level `stream_event` messages go to `useStreamingContent`, which
   accumulates deltas in refs and flushes React message updates at a bounded,
   adaptive cadence. Queue acknowledgements, full user/assistant messages,
   status changes, and explicit controls stay immediate.
3. Server-rendered streaming markdown enters through `useStreamingMarkdown`.
   Completed block augments are applied to DOM refs at a bounded cadence, with
   final flushes on stream end/reset/capture.
4. `useSessionMessages` merges live stream messages and persisted JSONL
   messages. Hot streaming-placeholder updates check the tail first before
   scanning the loaded transcript.
5. `MessageList` consumes a deferred snapshot of loaded messages, preprocesses
   them into `RenderItem[]`, groups adjacent assistant items into turns, and
   stabilizes unchanged render item object identity so memoized row components
   can skip unchanged history. React may coalesce obsolete transcript snapshots
   while urgent composer updates proceed; the session-detail store still
   retains every received message and the latest snapshot always renders.
   Older-page insertion and active-window prefix trimming bypass deferral so
   their scroll-anchor bookkeeping commits with the structural change. A
   large older page enters the DOM in bounded turn-aligned commits separated
   by animation-frame yields; each commit restores the original visible
   anchor in its layout phase before paint.
6. At 200 units of semantic row weight, `useTranscriptRenderWindow` replaces
   distant loaded rows with measured-height spacers and mounts the viewport,
   1.25 viewports of overscan, and at most 48 ordinary timeline rows. Search,
   turn navigation, route restoration, and live quote anchors wake or retain
   rows through the same render-id-to-height-model mapping. Short transcripts
   keep the unmodified full-DOM path.
7. `RenderItemComponent` routes exactly one render item to one block/tool
   renderer: text, thinking, tool call, user prompt, session setup, or system.
8. Rich renderers operate on block/tool-sized input:
   - text blocks use server markdown HTML when available, streaming markdown
     DOM while live, and local fixed-font math as fallback after completion;
   - tool renderers receive one tool input/result or one file/diff/output
     block, not the session transcript;
   - ANSI rendering receives one output string at a time.

## Invariants

- Rich formatting components must not receive the whole session history.
  KaTeX, markdown, Shiki HTML, ANSI, diff, and fixed-font renderers operate on
  one message block, one tool result, one file, or one preview.
- High-rate events must be coalesced before they reach React state unless they
  are user-visible acknowledgements or controls that need sub-second latency.
- The session stream entry point itself is coalesced, not only the token
  paths behind it: `useSession` dispatches events through
  `createStreamDispatchCoalescer`, immediate while quiet and one batch per
  adaptive gap under a burst. React 19 counts every commit that leaves more
  work pending as a nested update and throws "Maximum update depth exceeded"
  after 50 in a row, so a replay or busy turn that commits once per event
  freezes the tab and can blank it; no effect loop is needed. See
  [`topics/client-stream-dispatch-coalescing.md`](../../topics/client-stream-dispatch-coalescing.md).
- Light-load queue/ack/status UI should remain immediate. Backpressure belongs
  on token/render/freshness paths, not on user message acceptance.
- Transcript projection and DOM commits are non-urgent work. They consume a
  deferred message snapshot so React can prioritize composer input and coalesce
  obsolete intermediate snapshots during bursts. Queue acknowledgements,
  status, approvals, and other session controls remain outside that scheduling
  boundary and must not wait for the transcript. Prefix-changing pagination and
  trimming remain immediate because their scroll corrections are coupled to the
  new transcript structure.
- A covering non-App managed modal may hold the transcript's last committed
  projection stable. Incoming session data continues to buffer and surrounding
  controls and viewer sources remain live, but transcript reconciliation and
  progressive hydration resume only after the modal is parked or closed. App
  and artifact iframes, right-pane viewers, and parked viewers leave transcript
  reconciliation live.
- Conditional UI controls must not run an expensive render only to decide
  whether the control exists. Prefer transforms that return structured metadata
  such as `{ html, changed }`, and pass that first completed scan into the
  toggle/display component. Do not require expensive edit-distance or span
  mapping for packages that do not naturally expose it. Span/position edits are
  an acceptable optional result only when the transform already knows them and a
  caller can apply them incrementally.
- Avoid string comparisons as change detection after a formatter has already
  determined whether it changed anything. Preserve and reuse the boolean.
- An optional per-block HTML transform is absent, not an identity, where it
  cannot change anything. The session app-link rewriter
  (`SessionViewerProvider`) exists only when
  `sessionLocalhostRewriteApplies` holds for the page, so ordinary direct
  sessions parse no streamed or completed HTML block for it.
- When fixing one high-rate path, keep tracing. A throttled markdown path does
  not prove text placeholders, tool previews, activity/freshness state,
  queued-message UI, or composer-adjacent state are also covered.
- Long transcript work must preserve render-item, turn-group, and display-row
  identity for unchanged history and avoid front-to-back scans on hot
  current-message updates. User and assistant timeline entries are memoized at
  the turn boundary: a live-tail replacement may enter the changed current
  turn, but must not re-enter historical turn galleries or render items.
- Loaded transcript length must not determine mounted DOM length once semantic
  row weight reaches the render-window threshold. Off-window geometry comes
  from stable-key height measurements or conservative estimates. A scroll
  shift or estimate correction preserves the visible render-row anchor;
  explicit search/turn/route targets mount before their exact alignment pass,
  and rows carrying live quote anchors remain mounted as sparse islands.
- Native transcript scroll handlers perform only constant-time follow/intent
  bookkeeping and schedule one trailing position read. Transcript-position
  context is measured after 200 ms of scroll rest and indexes rendered rows
  once. Settled scroll position, row hover, and turn-marker hover publish their
  latest effective timestamp through one per-session external store at most
  once per animation frame. The composer toolbar is the subscriber; position
  changes must not render `MessageList`, `SessionPage`, or historical rows.
- YA-rendered pointer tooltips share one pending publication slot across text,
  rich explanations, and session hover cards. Dwell intent is replaceable;
  zero-delay handoffs publish at most once per animation frame; and every
  pointer publication rechecks the browser's current `:hover` state. Recovery
  from main-thread backlog therefore skips crossed targets, and a stale session
  target cannot begin preview refresh work.
- Selection-action geometry always reads the latest native range. Pointer drags
  defer placement until release. Non-pointer range-change, resize, and scroll
  bursts use a bounded leading/latest cadence: the first scan is immediate,
  then at most one latest scan is pending per interval. Browser events must
  never enqueue a geometry scan for every intermediate selection or viewport
  position.
- Ordinary session-composer edits are local to the composer. They must not
  render `MessageList`, `RenderItemComponent`, `MessageAge`, or historical
  transcript rows, regardless of transcript size or whether the edit crosses
  the empty/non-empty boundary.
- Draft-dependent transcript affordances subscribe below the transcript
  boundary. Quote reconciliation consumes a stable draft-change signal and
  queued Edit actions consume only a primitive availability snapshot.
- Reactive browser-local preferences use initialized in-memory snapshots.
  Repeated hook snapshot checks must not reread `localStorage`; same-tab
  application writes use the owning setter or explicit invalidation, while
  cross-tab `storage` events reconcile the cached value.
- Composer text is user data. Streaming/render work must not steal focus,
  defeat normal browser key buffering, or delay page-lifecycle draft flushes.
- The processing phrase typewriter is local leaf state. Clicking its text (or
  focusing it and pressing Enter/Space) pauses phrase progress at the current
  character; repeating the action resumes it. The processing text has no
  typewriter cursor. The pause lasts only for the mounted processing cycle and
  never pauses the agent. **Fun Phrases** controls the phrase pool, not whether
  the typewriter animates. Timer expirations queue through one pending animation
  frame, so phrase rotation and character progress produce at most one React
  update per painted frame. The timer and frame stop while the indicator is
  outside the viewport or the document is hidden; resuming does not replay
  missed progress.
- Activity pulses and spinners inherit one viewport-owned CSS animation play
  state. A shared `IntersectionObserver` pauses them outside the viewport, and
  document visibility pauses every observed activity animation while the tab is
  hidden. Adding another activity indicator must reuse that observer rather than
  create a per-indicator observer or JavaScript animation loop.

## Design decisions

- **Defer the transcript message snapshot** (vs. adding another wall-clock
  throttle): full messages, tool activity, and streaming placeholders all
  converge on `MessageList`, so React's deferred-value boundary covers every
  message-driven transcript path and lets urgent input preempt it. A cadence
  controller would duplicate the existing token/markdown throttles while still
  needing a separate path for full activity messages.
- **Use immutable source-message identity for tool projection stability** (vs.
  deep-comparing rebuilt tool payloads): tool input, result, and display actions
  are pure projections of the source messages already checked by identity.
  Live approval can change the projected status, so status remains an explicit
  comparison. This avoids deep walks over old, potentially large tool results
  on every tail update.

## Transcript Layout Stability

See also: [`topics/scrollback-view-stability.md`](../../topics/scrollback-view-stability.md)
for the scrolled-back anchor target (content position, sub-item granularity, the
~20% soft target with boundary snap) and the known regressions.

A user must be able to scroll back and read or review a session transcript
without historical rows changing height at unpredictable times.

Do not add timers, idle callbacks, reconnect effects, visibility effects, or
stream-status effects that automatically expand, collapse, hide, reveal, or
otherwise change the rendered height of past transcript rows. Automatic height
changes are acceptable only for the actively streaming tail/current turn, for
new transcript content being appended, or in direct response to an explicit user
action.

If a feature wants to reduce old transcript noise, prefer an explicit
session-level display mode or user-triggered control. Do not make old row layout
depend on elapsed time, viewport position, or background heuristics without a
documented design tradeoff and browser verification.

## Profiling

For a user-enabled real tab, Remote Browser Debugging owns a bounded recorder
for the 30-minute lease. Start with the built-in command from the copied grant
instruction:

```text
yepanywhere browser-debug snapshot <grant-url>
```

The result separates the previous complete five-second collection window plus
the current partial one from lease totals. It correlates main-thread frame gaps,
long tasks, and editable-control key latency with these named application
phases:

- `session-stream.event`
- `streaming-content.event`, `streaming-content.flush`, and
  `streaming-content.flushed-event`
- `streaming-markdown.event`, `streaming-markdown.flush`, and
  `streaming-markdown.flushed-event`
- `message-list.preprocess`, `message-list.conversation-projection`,
  `message-list.group`, `message-list.commit`, and
  `message-list.scroll-position`; the commit duration spans from entry into the
  `MessageList` render through its layout effect after the DOM commit, while
  scroll-position measures the one trailing transcript-position read

The recorder and `window.__YA_BROWSER_DEBUG__.performance` API exist only while
the visible red lease control is active. Application callsites perform only a
cheap inactive-recorder check otherwise. The expanded control's performance
text reads the recorder during the already-required countdown refresh and does
not start another sampler.

Enable Developer Mode remote log collection, or set this in DevTools:

```js
window.__RENDER_PROFILE__ = { thresholdMs: 4 };
```

Slow formatter calls emit `[RenderProfile]` console entries locally and
`render-profile` entries through the remote client log path when remote logging
is enabled. Current profiled components include:

- `fixed-font-math`
- `fixed-font-rich-content`
- `ansi-render`

Each entry includes duration plus coarse input size (`chars`, `lines`) where
available. Use these timings with stream-event counts and React update cadence:
a slow formatter matters most when it is reached by a high-rate path or when it
runs over a long block more than once.

## Live diagnostic evidence

A consented real-work tab on 2026-08-14 established the scheduling boundary.
Conversation View projection itself peaked below 4 ms, while complete
`MessageList` work and browser event handlers repeatedly occupied 200–600 ms
frames during active output; the largest observed key-dispatch delay was
582.5 ms. Turning Conversation View off enlarged the DOM and worsened the
symptom, but did not make projection the owner.

After deferring the message snapshot, a ten-second active sample contained
three long animation frames at 67, 76, and 96 ms instead of repeated
200–600 ms frames. A later lease snapshot measured transcript preprocessing at
19.5 ms maximum and render-through-DOM-commit at 76.6 ms maximum. A controlled
Follow jump reached the live tail synchronously, returned its next animation
frame in 12.3 ms, and had one 76.7 ms long animation frame in the following
five seconds. These were contended diagnostic samples rather than calibrated
ratchet measurements; they support the scheduling decision and do not define a
portable latency ceiling.

A later 2026-08-23 real-work trace found the remaining identity leak: with
7,543 DOM elements, active stream updates produced `MessageList` commits up to
181 ms in one renewed sample (and 276 ms in the preceding lease), while
preprocessing remained at or below 20.5 ms. A deterministic 40-turn update
probe reproduced the structural cause: one changed live tail re-entered all 40
historical assistant galleries. Stabilizing Conversation projection items,
turn groups, display rows, and the derived thinking-preview set reduces that
update to exactly one gallery and one render item—the changed live tail. These
render counts are the regression contract; a separate 20-turn tool-heavy probe
also records zero historical explored-tool group renders. The real-work timings
remain diagnostic rather than portable ceilings.

The post-fix active-stream sample in the same real-work session ran for 90
seconds and recorded 193 keystrokes with no delayed keystrokes, a 46.6 ms
maximum key-to-frame delay, and no long tasks while assistant text, thinking,
tool activity, and the processing typewriter continued updating. The trace had
one isolated 100.7 ms frame gap and a 36.8 ms maximum `MessageList` commit,
rather than the earlier sustained 200-plus-ms delays. This satisfies the
user-approved approximately-100-ms heavy-redraw target and closes the specific
active-stream typing-latency gap. These values remain diagnostic, not a
portable ceiling.

The same consented tab separately isolated scrolled-back position tracking as a
separate scroll-rate owner. With roughly 980 rendered rows, one scroll event
performed 165 full render-row queries while the bottom-follow path performed
none. An 8,000-pixel out-and-back probe took about 5.3 seconds normally; a
causal control that bypassed only those repeated row queries took 0.70 seconds,
with steady steps at 21–29 ms after two transition frames. This established the
scroll-rest measurement and one-index-per-measurement invariant above; it is
diagnostic evidence, not a portable timing ceiling.

A 2026-08-31 follow-up isolated row hover in a consented long-session tab.
Crossing 20 mounted transcript rows produced 19 complete `MessageList` commits
totaling 293.3 ms over 598.5 ms, with no conversation projection,
preprocessing, or browser long task. The corrected path holds row, marker, and
settled-scroll timestamps outside React transcript state. Its deterministic
regression crosses multiple rows before one frame, publishes only the final
timestamp, restores null on leave, and records zero additional transcript
commits.

A ratchet-grade three-repetition 360-turn trace on 2026-08-29 accepted the
measured-height semantic render window and eight-unit yielded prepend. Final
mounted rows fell from 722 to eight, elements from 18,985 to 435, and layout
objects from roughly 26,500 to 451–454. Full-projection typing maxima fell from
239.5–244.3 ms to 18.8–21.2 ms, prepend-associated longest tasks reached
118–127 ms without a control timeout, and tooltip long-task time fell to zero.
The result is not uniform: full-mode scroll frame p95 rose from 16.8 to 33.4 ms,
though maximum frames remained 33.4–50.1 ms with no long task. The complete
identity, limitations, and augmentation control are in the
[`2026-08-29 system-observed follow-up`](../../topics/performance-regression-suite.runs/20260829-system-observed-followups.md).

## Review Checklist

- Does this change introduce a new path from token-sized events to React state?
- Does any formatter see more than a block/tool/file-sized input?
- Does a conditional affordance render or parse content just to decide whether
  it should appear?
- Is the first expensive transform result reused by the component that displays
  it?
- Do unchanged transcript rows keep stable object identity across a streaming
  update?
- Does an ordinary composer edit commit any part of the historical transcript
  subtree?
- Are draft-dependent quote and queue behaviors subscribed at the narrowest
  leaf instead of publishing the draft string through a transcript parent?
- Can this change alter the height of transcript rows above the current reading
  position without a user action?
- Does any timer, reconnect, visibility, or stream-completion effect expand,
  collapse, hide, or reveal historical transcript content?
- Do tests cover both the cheap live path and the completed rich path?
