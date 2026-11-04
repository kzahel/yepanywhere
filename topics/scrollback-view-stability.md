# Scrollback View Stability

> When a reader has scrolled back from the live tail, streaming output and
> layout changes must not move what they are reading. Defines the two scroll
> regimes, the stability target and its required granularity, why the collapse
> trigger is independent of jitter, what the current implementation actually
> does, and the known regressions to fix.

Topic: scrollback-view-stability

See also: [`packages/client/RENDERING_PERFORMANCE.md`](../packages/client/RENDERING_PERFORMANCE.md)
("Transcript Layout Stability"), [predictive-scroll](predictive-scroll.md)
(placeholder-height prevention), [rich-text-rendering](rich-text-rendering.md)
(`useScrollPreservingToggle` / `lib/scrollAnchor.ts`).

## Two scroll regimes

The transcript reader is always in exactly one of two regimes, and the policy
differs between them:

- **Following the tail** — pinned at/near the bottom, watching live output.
  `shouldAutoScrollRef` is true; `isScrolledToBottom` is true. Here the view
  *should* track new content: appended rows and the streaming current turn may
  freely change height, and the view re-pins to the bottom. Settled visible
  positions advance that session's device-specific turn/activity high-water
  mark and record that it was following; an active turn counts before
  completion, and whole-turn completion also publishes without a scroll event.
- **Scrolled back** — the reader has scrolled up to read or review earlier
  content. `shouldAutoScrollRef` is false. Here the view *must hold still*: no
  streaming growth, expand/collapse, hydration, late markdown/highlight, or
  background heuristic may move the content the reader is looking at. This
  transient reading position must not lower the durable resume high-water mark.

The boundary between regimes is itself a policy decision (see "Near-bottom
re-engage" below) and is the source of the worst current bug.

## Stability target (policy)

When **scrolled back**, the quantity to hold constant is a **content position**,
not a render row. The reader's eye is at some point in the content; that point
must stay put across a height change elsewhere.

1. **Anchor to a content position, at sub-item granularity.** A single thinking
   or output block routinely exceeds the viewport. "Top of the first visible
   item" is the wrong unit: if the reader is scrolled into the middle of a tall
   block and content *within that same block, above the reading line* reflows
   (a streaming line-wrap earlier in the block, a re-highlight, a late markdown
   augment), pinning the block's top lets the reading line drift by the
   intra-item delta. The held point must be *inside* the item — a line box,
   child block, or DOM text offset at the chosen viewport line — so it sits
   below the reflow, not above it.

2. **Target line: ~20% down the viewport, as a soft target.** The exact
   fraction is a comfort knob, not a correctness property: between-item growth
   is compensated in full regardless of the fraction, and the dangerous case
   (intra-item growth above the line) is governed by granularity, not by the
   fraction. 20% (eyes in the upper region, with headroom above) is the default;
   it is explicitly *not* 0% (a torn line at the very top reads worse) and the
   choice of 20% vs any nearby value is not load-bearing.

3. **Boundary snap (the "smart flex").** If the content at the target line is
   within a small threshold `T` of an item's top, snap the anchor *up* to the
   item top instead of freezing a torn line mid-paragraph. This reads better
   (clean semantic boundary) and is cheaper — it reuses the item-granular anchor
   path — so the expensive sub-item machinery is only needed when the reader is
   genuinely deep inside a block taller than the viewport. Snap **upward only**,
   bounded by `T` (≈ half to one line height, or a small viewport fraction);
   never push the item top off-screen. The snap is a **nice-to-have**, not on
   the critical path, and must engage only when scrolling has come to **rest** —
   a mobile momentum-scroll settle, or a discrete `PgUp`/`PgDn` jump. It must
   **not** fight smooth continuous mousewheel scrolling, where adjusting the
   position under an active scroll feels like the view resisting or jumping.

4. **Capture once, restore exactly.** Establish the anchor (including any snap)
   when scrolling settles, then restore to that fixed anchor on every
   subsequent reflow *without re-evaluating the snap*. Re-snapping each frame
   turns the ±`T` flex into its own jitter. The snap is a one-time reposition,
   not a live target.

5. **Restore before paint.** Height change and `scrollTop` restore must happen
   together in `useLayoutEffect` (or a tight rAF pair) so there is no visible
   intermediate frame.

### Native `overflow-anchor` tradeoff

CSS `overflow-anchor: auto` (browser scroll anchoring) gives sub-item
granularity for free — the browser holds a deep node near its anchor point —
but it will **not** do the boundary snap and is finicky under programmatic
`scrollTop` writes. YA has no `overflow-anchor` CSS and reimplements anchoring
manually at *row* granularity. The clean split, if pursued, is: native owns the
**scrolled-back** hold (sub-item, free), manual `scrollTop` owns only the
**following-the-tail** case. If the boundary snap matters, prefer a YA-owned
anchor (we control the snap and the sub-item position); native is the cheaper
sub-item fix but drops the snap. Either path needs browser verification — native
anchoring is suppressed under several conditions and fights manual scroll.

## Jitter is independent of the collapse/tidy trigger

A recurring confusion is to treat "auto-collapse on a timer" as the cause of
scroll jitter. It is not. **Jitter is purely whether a height change compensates
`scrollTop` against the anchor.** The *trigger* for a height change — a 4.2s
timer, a "block scrolled past while following", a "collapse previous when the
current thinking block completes", a streaming line-wrap — is orthogonal to
whether it jitters.

Consequences:

- Any tidy/collapse rule is jitter-free **if** it routes through the
  scrolled-back anchor restore and is **deferred or skipped while scrolled
  back**. Pick whatever trigger serves the reader's mode; the trigger is not the
  hazard.
- A content-driven trigger (e.g. collapse the previous thinking block when the
  next one *completes*) is strictly better than a wall-clock timer — the read
  grace becomes "as long as the next block streams" instead of a fixed guess —
  but it is still a past-row height change and so is bound by the same anchor +
  scrolled-back-guard rule. It also only tidies multi-block turns, not a lone
  block followed by idle.

## What the implementation does today

- **Item-granular anchor** — `getFirstVisibleRenderAnchor` (MessageList.tsx)
  records the first render row intersecting the viewport and a **signed**
  `topOffset = rowRect.top - scrollRect.top`. A negative offset (scrolled into a
  tall block) is preserved, so it *does* hold a mid-block scroll position — but
  only at *row* granularity, so intra-item reflow above the reading line is the
  uncovered case (see target #1).
- **`preserveScrollAfterTranscriptHeightChange`** applies that anchor (or a
  pure height-delta shift when no anchor row is found) and re-pins to bottom
  when following. It is currently wired to **exactly one caller**: the global
  hide/show-all-thinking toggle (`toggleThinkingItemsVisible`). Per-row thinking
  expand/collapse and streaming growth do **not** route through it.
- **`useScrollPreservingToggle`** (`lib/scrollAnchor.ts`) anchors the
  *acted-on element* (the Σ fixed-font toggle) — correct for that one control.
- **Height-change restoration lifetime** — mode/window changes restore their
  anchor after two projection-settling animation frames. Both frames belong to
  the mounted transcript and are cancelled on unmount; restoration also
  requires the current transcript and its parent. A detached view must never
  restart follow timers after its scroll cleanup has run.
- **`ResizeObserver`** (MessageList.tsx) re-pins to bottom on every height
  increase while `shouldAutoScrollRef` is true. During streaming this fires at
  the flush cadence (~200ms). During initial parked restoration, it instead
  reapplies the pending retained anchor through asynchronous content growth;
  the first user scroll or explicit Follow action ends that retry. A 2px
  oscillation of the conversation-activity row therefore moves the whole
  transcript; that row's published thinking height ignores ≤2px shrinks and
  its same-line vs wrapped test uses a 1px/4px deadband (see
  [conversation-view](conversation-view.md)).
- **Near-bottom re-engage** — historical behavior let size/resize paths
  re-arm `shouldAutoScrollRef` whenever `isNearScrollBottom` held, i.e. within
  `BOTTOM_FOLLOW_VIEWPORT_FRACTION` (0.45) of the viewport, capped at
  `MAX_BOTTOM_FOLLOW_THRESHOLD_PX` (520). As of 2026-07-03, transcript
  `ResizeObserver` growth and window resize no longer *start* following from
  near-bottom geometry; they only continue an already-following viewport.
  Programmatic-scroll release still uses the near-bottom check to confirm
  explicit bottom commands.
- **Explicit Follow intent** — activating Follow sets `shouldAutoScrollRef`
  before restoring composer geometry. While that intent is active, a scroll
  event at the latest follow-written `scrollTop` whose geometry has temporarily
  fallen behind transcript growth re-pins rather than canceling follow. A
  `scrollTop` movement upward from that write releases follow even if no wheel,
  touch, scrollbar, or keyboard precursor was observed. Ordinary bottom geometry
  can still acquire follow when it was already off. Follow also publishes its
  live-tail route snapshot synchronously; programmatic scroll events are
  suppressed and cannot be the persistence trigger.
- **`RENDERING_PERFORMANCE.md` "Transcript Layout Stability"** is the
  kzahel-side statement of the invariant (no timers/visibility/stream-status
  effects changing historical row height; tidy only via explicit user control).
  This topic is the YA-side elaboration of the *anchor target* that invariant
  leaves unquantified.

## Explicit message navigation during layout settling

A message link or recall jump owns its target position through cold renderer
height changes. The jump retires any pending first-load restoration, records
the target in the existing retained-anchor owner and marks its own scroll as
programmatic. That scroll event must not look like user input and release the
anchor before asynchronous layout settles. Genuine user scrolling still
releases it through the existing wheel/touch/pointer/key ownership paths.
No polling or separate navigation retry loop is added.

## Contracts / invariants

- **Keyboard pagination acceptance** — with observer loading disabled, PageUp
  and previous-turn Home at the loaded boundary request older history. Browser
  coverage establishes reader intent with a real upward wheel gesture and waits
  for `scrollTop === 0` before the key. A bare DOM scroll write can race initial
  follow restoration and does not establish this setup condition.
- Scrolled back ⇒ no automatic height change moves the anchored content
  position. Defer such changes until the reader returns to the tail.
- Every transcript height change, from any trigger, restores the scrolled-back
  anchor (content position, sub-item granularity) when not following — not just
  the one path currently wired.
- Following the tail ⇒ appended/current-turn growth re-pins to bottom; this is
  the only regime allowed to chase height. A direct or steering send performs
  its first bottom write in the committing layout phase, so the optimistic row
  cannot paint once against the previous bottom before catch-up begins.
- The explicit **Follow** action also restores a full-pane composer to ordinary
  size so the reclaimed transcript remains visible. Composer maximize/restore
  and one-line collapse actions do not change transcript position or follow
  intent.
- The explicit **Follow** action commits live-tail return state before a route
  switch or reload can unmount the session view.
- Initial parked restore keeps its retained anchor authoritative through late
  transcript growth. Browser clamping against incomplete layout must not turn
  a saved position into the beginning of the transcript; user scroll or
  explicit Follow transfers ownership and cancels further restore retries.
- The collapse/tidy trigger is a UX choice; jitter-safety is a separate,
  always-required property.
- A reader release (upward wheel, touch, key, scrollbar press or upward
  displacement from the follow write) records the lowest `scrollTop` reached
  since. Bottom geometry re-acquires follow only after the reader scrolls back
  down past that low point; any bottom write clears it, and navigation or
  selection stops leave plain bottom geometry in charge. The last line stays
  visible for the container's bottom padding plus tolerance, so without this a
  slow wheel step's first smooth-scroll frames re-acquired follow and the next
  streaming re-pin cancelled the step — only a burst of notches escaped.
- Reader intent cancels pending follow release frames as well as smooth-scroll
  timers, follow-up writes and forced catch-up timers. An old frame cannot
  re-enable Follow after a wheel gesture, held transcript press or search
  navigation has taken ownership. A queued scroll event from the last bottom
  write does not resume following under a held press; release without movement
  retains the explicit click-to-resume behavior.
- Committing in-session search (Enter on the highlighted match, or a click
  jump to that same match) is explicit navigation: leave tail-follow, jump
  to the selected row, and if search then unhides non-matches, pin that row
  while the document height changes. Dismissing a committed search match also
  stops Follow before unhiding rows: an earlier bottom event may have re-acquired
  it before the final reader scroll event arrives. Layout observers must retain
  the selected anchor rather than continue that stale follow intent.
- A search frame belongs to the selected turn identity. If regrouping or
  windowing replaces its DOM row, transfer the frame to that turn's connected
  row without scrolling again or renewing the fade deadline. A later clear
  cancels queued transfer work and wins over any pending reveal.

## Follow-engagement policy & proposed preferences

The regime boundary — *when* the view (re)engages "following the tail" — is now
represented by a browser-local policy value for route restore, with several
live-follow axes still implemented as fixed behavior (send-forces-bottom and
the thinking-delta guard). Several observed bugs (#1, #3, #4 below) are at root
disagreements about that policy, and different users hold different
expectations. The policy decomposes into a few orthogonal axes; surfacing some
as preferences would resolve much of the "is this a bug or intended?" ambiguity:

- **Re-engage policy** — how does follow turn back on? *Auto* (current: re-pins
  whenever the reader lands within the near-bottom band) vs *manual-only* (only
  the Follow button engages it; reaching the bottom by scrolling does not).
- **On-send policy** — *jump to bottom and follow this turn* vs *jump once then
  freeze* vs *stay put*. (Bug #3 is the current send path getting this wrong.)
- **Background persistence** — is follow *durable session intent* that survives
  the tab being hidden and refocused, or a viewport-cursor recomputed from
  geometry on return? (Bug #4.) Some users expect the former.
- **Content filter while following** — *all output* vs *exclude thinking*
  (current special case, `cebac6b7`) vs *never auto-follow* (manual Follow is
  the only thing that ever moves the view to the tail).

Design caution: expose these as a **small set of named modes** (currently
`live-tail`, `remember-place`, and `no-memory` internally), not
four orthogonal toggles — orthogonal toggles are 2⁴ states to reason about and
test, whereas the internal model can stay axis-based. The browser-local policy
value persists via the existing `UI_KEYS` localStorage pattern and ships as
a visible, searchable Development setting. Its advanced placement keeps the
ordinary provider-like default unobtrusive without making the recovery modes
hard to refind. This does not substitute for fixing the bugs — a broken default
is broken under every preference — but it clarifies which behaviors are bugs
versus legitimately user-dependent.

## Planned improvements

Ordered roughly by reader impact.

1. **Streaming yanks a near-bottom reader down (~200ms cadence).** *Observed,
   streaming-on:* while the agent thinks for a long time, the reader cannot hold
   a scrolled-up position — every streaming flush (~200ms) re-pins them to the
   bottom. Escape only succeeds once they scroll far enough that the streaming
   turn is fully offscreen (past the near-bottom band), after which the view is
   stable. *Likely mechanism (corroborated by that escape behavior, not yet
   instrumented):* the `ResizeObserver` re-pins on every height increase while
   `shouldAutoScrollRef` is true, and the near-bottom re-engage heuristic
   (`isNearScrollBottom`, ~45% / ≤520px) keeps flipping follow back on after a
   small scroll-up — defeating the intended `thinkingDeltaFollowAllowedRef`
   guard. Fix direction: a deliberate scroll-up should *latch* scrolled-back
   until the reader returns to the actual bottom (or crosses a much tighter
   threshold), so a single small scroll-up is not re-captured by ongoing
   streaming growth.

   *Mitigation (symptom-hiding, not a fix):* at the start of a thinking turn,
   pre-allocate the block's expected height — an estimate, capped so it never
   exceeds ~60% of viewport height — so streaming growth re-flows *within* the
   reserved box instead of increasing transcript height on every flush, which
   reduces `ResizeObserver` re-pins. This only masks the yank (and over-reserve
   would itself shift layout, hence the cap); the latch above is the real fix.
   Same reserve-to-avoid-shift idea as predictive-scroll placeholder heights.
2. **Fast-burst Follow and compaction scroll release — fixed 2026-08-19.**
   The original double-click behavior reproduced when transcript height grew
   after Follow's programmatic-scroll release but before a catch-up write. The
   2026-08-18 fix made active intent authoritative, but a compaction-progress
   animation then exposed the opposite race: when an upward scroll had no
   recognized input precursor, each animated layout event snapped the reader
   back to the tail. Active follow now records its latest written `scrollTop`.
   Unchanged position plus increased height is stale geometry and re-pins; actual
   upward displacement releases follow. Focused regressions cover both sides of
   that distinction.
3. **Send lands short; the live thinking indicator is clipped after submit.**
   *Observed, streaming-on (screenshot 2026-06-16):* right after the user
   submits, the view scrolls *most* of the way down but stops a fraction short —
   the streaming thinking indicator ("Contemplating…") is clipped at the
   composer edge and the "Follow" button appears, despite the user having just
   acted at the tail without scrolling up. *Likely mechanism:* the send path
   forces a scroll via `forceScrollToCurrent(SEND_CATCH_UP_DELAYS_MS)` **without**
   `allowThinkingDeltas`, unlike the Follow button which passes
   `{ allowThinkingDeltas: true }`. The programmatic send-scroll never routes
   through `handleScroll`'s at-bottom branch, so `thinkingDeltaFollowAllowedRef`
   stays false; the first expanded thinking delta then trips the follow-cancel
   guard, whose `stopFollowingForUserScroll` also calls
   `clearForcedCurrentScrollTimers`, aborting the remaining send catch-up retries
   mid-settle. The indicator keeps growing after that freeze, so its final
   ~half-line is never scrolled into view. This is the **inverse of #1**: there
   the near-bottom re-engage heuristic defeats the thinking-delta guard
   (over-follows a reader); here the thinking-delta guard defeats the send-scroll
   (under-follows a sender) — same two flags, opposite winner, decided by timing.
   *Fix direction:* treat a send as explicit intent to follow the resulting
   turn — the send transition should enter "following the tail" for the
   just-issued turn (granting thinking-delta follow as the Follow button does),
   or at minimum land the scroll with the current tail fully visible before any
   cancel fires. Naively passing `allowThinkingDeltas` on every send risks
   re-introducing the chase-long-thinking behavior `cebac6b7` deliberately
   removed; the regime-aware fix (the #1 latch plus "send ⇒ follow this turn")
   subsumes both.
4. **Follow disengages after the tab is backgrounded and refocused.**
   *Observed:* fully at the bottom with follow engaged, background the tab,
   return — follow is no longer engaged though the reader never scrolled.
   *Suspected mechanism (not instrumented):* `MessageList` has no
   `visibilitychange` handler, so this is emergent — while hidden, rAF and
   `ResizeObserver` callbacks are throttled, so content that streams/arrives in
   the background grows the transcript without the auto re-pin running; on
   refocus `scrollTop` is stale (no longer at bottom) and the first
   `scroll`/`resize`/observer evaluation reads not-at-bottom and clears
   `shouldAutoScrollRef`. Connection churn may compound it — `ConnectionManager`
   and `useSession` do react to visibility (reconnect/refetch), which can
   re-render and reset scroll position. *Preference-adjacent (see
   "Follow-engagement policy" above):* some users expect follow to be
   **persistent session intent**, not a viewport-cursor recomputed from geometry
   only while visible. *Fix direction:* on refocus, if follow was engaged when
   the tab was hidden, re-assert it (re-pin to the new bottom) instead of
   letting a stale-geometry evaluation cancel it — persist the *intent* across
   visibility transitions rather than recomputing it from post-hide geometry.
5. **Wire all height-change paths through the anchor.** Per-row thinking
   expand/collapse and streaming growth currently bypass
   `preserveScrollAfterTranscriptHeightChange`; route them through it so the
   scrolled-back hold applies regardless of trigger (target #1, #4).
6. **Sub-item anchor granularity.** Replace the row-granular anchor with a
   content-position anchor at the ~20% soft target (targets #1–#2) so intra-item
   reflow above the reading line stops moving the view. Evaluate native
   `overflow-anchor` for the scrolled-back hold versus a YA-owned anchor.
7. **Boundary snap (nice-to-have, not urgent).** Snap the anchor to a nearby
   item top within threshold `T` (target #3). Lower priority than 1–6, and
   gated: engage only at scroll rest (mobile momentum settle, `PgUp`/`PgDn`),
   never during smooth continuous mousewheel scrolling. Requires a YA-owned
   anchor — native `overflow-anchor` cannot do the snap.
8. **Re-introduce auto-tidy of thinking, jitter-free.** With the anchor wired,
   an attention-driven tidy (collapse a thinking block once scrolled past while
   following, or "collapse previous when current completes") can return the
   self-cleaning transcript without the original timer's hazards — deferred while
   scrolled back. Coordinate with the `RENDERING_PERFORMANCE.md` invariant, which
   currently forbids visibility-driven collapse and would need the documented
   tradeoff + browser verification it itself calls for. Context: commit
   `0958645d` removed the prior timer/moving-id auto-collapse to stop the jitter;
   this would restore the benefit (bounded reading time, tidy transcript) on the
   correct trigger.
