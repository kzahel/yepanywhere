# Tooltip Interactions

> Tooltips use one browser-level appearance and timing preference while keeping
> ordinary hints compact, keyboard-accessible, and fast to scan once one has
> deliberately opened.

Topic: tooltip-interactions

Status: The passive-tooltip noninterference correction and first labelled-
control hint audit were enacted on 2026-08-04.

## Modes and settings

Appearance presents `Themed` and `Native` as an explicit two-way style
selector. The delay slider and number field remain visible beside that selector
in the same row:

- `Themed` is the default when the browser has no explicit saved mode. It
  renders YA's tooltip layer with the active theme and an initial 50 ms delay.
- `Native` leaves ordinary `title=` tooltips to the browser, including the
  browser's timing and colors. YA must not describe that timing as a numeric
  preset because it is controlled by the browser/OS.
- Explicitly saved `Native` and `Themed` choices remain authoritative across
  default changes.
- Moving the slider or entering a valid number selects `Themed`. Temporarily
  deleting the number while editing neither changes mode nor commits a delay.
- The mode and delay are portable browser preferences. The retired session
  hover-card delay seeds the shared delay at one third of its stored value when
  the new delay is absent, preserving that card's prior timing. Committing or
  resetting the shared delay removes that retired value and invalidates its
  same-tab cache immediately; returning to Native mode cannot resurrect the
  retired card delay until reload.

## Scope of the mode

`Native` and `Themed` select the renderer for ordinary text hints. This includes
static control labels as well as YA-computed text such as clipped commands,
hidden output tails, elapsed times, and concise file paths:

- In `Native`, the target owns a `title` and the browser/OS owns presentation,
  timing, placement, dismissal, and input behavior.
- In `Themed`, the target owns `data-tooltip` and YA renders the text in the
  document. This permits a configurable delay, immediate scanning between warm
  targets, stable placement during app scroll, secondary-click full-text
  copy/enlarge behavior, and contained wheel scrolling for long hints.

Themed tooltips therefore aim to preserve the basic semantics of native hints—
supplemental, nonessential information opened by pointer hover or
keyboard-visible focus—but they are not merely recolored native bubbles with a
delay setting. The extra interaction behavior is intentional and must remain
optional.

Some YA-rendered hover surfaces cannot meaningfully become native tooltips and
remain custom in either mode:

- The risk explanation attached to externally controlled-session and
  pending-tool warnings contains structured explanatory content. Hover or
  keyboard-visible focus may show that content as a rich tooltip on
  hover-capable devices; activation opens the same explanation in a modal,
  which is the touch path. Touch pointer activity and pointer-generated focus
  do not schedule the rich tooltip. In Themed mode it participates in shared
  timing and visibility ownership. Native mode preserves its immediate custom
  hover reveal.
- A session hover card previews session content and status. Session-list rows
  render that rich card only in Themed mode. In Native mode they expose the
  ordinary browser title only when the visible session title is actually
  clipped; a fully visible title has no hover surface. Non-list destinations
  that use the card as a confirmation preview remain custom in either mode.
  Touch pointer entry and touch-generated compatibility mouse events do not
  open or warm the card. Session-switch links in the Recent Sessions dropdown
  likewise attach their full-title hint only after non-touch pointer entry, so
  a tap cannot become a browser-native or themed hover hint.

Menus, dialogs, interactive help panels, and other popovers are not tooltips
and are outside the appearance setting. The mode name must not be interpreted
as a global ban on app-rendered overlays.

The composer bottom bar's quick-hide surface is one such contextual popover.
It repeats the control's current native or themed hint beside a **Hide** button
instead of making an ordinary tooltip interactive. Touch long-press opens it
for every customizable interactive control while preserving any specialized
long-press action. Desktop right-click opens it only where the control has no
special context action. While this surface is open, ordinary tooltip rendering
is suppressed so the two hint presentations cannot overlap.

## Themed timing

The configured delay measures **pointer rest**, not merely time since entry.
Pointer movement before the first reveal restarts the timer. Once revealed, the
tooltip remains open while the pointer moves within either its trigger or the
tooltip itself. Leaving both starts a close grace of twice the configured delay;
entering another tooltip trigger during that grace switches immediately.

Keyboard-visible focus uses the same configured delay. Pointer-generated focus,
including touch focus, does not open a tooltip after activation. Escape,
primary click, blur, and a deliberate pointer departure dismiss the tooltip.
Other keystrokes, including modifier combinations used to capture a screenshot,
leave a visible tooltip alone unless they edit a composer or navigate a Source
Control list. Unmodified Up/Down in row-navigating lists and unmodified
Left/Right/Enter in the file outline, and unmodified `[`/`]`/Page Up/Page Down
in selected-commit review dismiss the current tooltip and suppress an immediate
focus reveal so source content stays unobscured. The commit files pane's
persistent selected-path box is file identity, not a hover tooltip. It may grow
left over the revision pane but never right over the source diff. Every composer edit
dismisses visible YA-rendered text, rich, and session-preview tooltips, cancels
their pending reveals, clears tooltip warmth, and suppresses new pointer/focus
activation for 100 ms after the latest edit. Suppression never schedules an
automatic reopen; fresh pointer or focus intent after the window is required.
Browser-native `title` presentation remains browser-owned. Scroll—including
transcript follow-scroll—otherwise does not dismiss a tooltip the user may be
reading. Browser re-hit-testing can emit pointer boundary events when scrolling
moves content under a stationary pointer; unchanged pointer coordinates are not
treated as departure. A visible tooltip keeps its fixed reading position during
scroll and is re-clamped to the viewport after resize.

Only a tooltip that actually became visible warms the tooltip system. After it
closes, entering another target within six times the configured delay opens the
adjacent tooltip immediately. “Adjacent” is temporal: no geometry test is
needed. Casually crossing targets that never opened does not warm anything.
Visibility ownership is global across the delegated text layer, rich
explanations, and session hovercards: granting it to a different tooltip
surface synchronously dismisses the prior owner. A genuine move between warm
text targets hands the delegated surface directly to the latest target in the
next animation frame, while small or absent pointer movement cannot switch it
during scroll or layout re-hit-testing. Neither path can flash two tooltips or
an intermediate blank tooltip. A passive ordinary
tooltip is visually frontmost but pointer-transparent. Its measured rectangle
still belongs to the active hover region: pointer motion inside it cannot warm
or switch to a tooltip target geometrically underneath it. Primary, middle,
and modified activation inside that rectangle passes through only when the
browser's hit target belongs to the active trigger. Activation of an unrelated
obscured control is blocked and dismisses the tooltip; the layer never
synthesizes or forwards a click. Secondary-click inside the rectangle remains
tooltip intent, and wheel input scrolls an overflowing tooltip rather than the
page beneath it. Explicitly activated glossary definitions may remain
pointer-interactive. Boundary motion accumulates from the last point inside
the active hover region; up to four CSS pixels is treated as hand/sensor jitter
rather than an intent to switch targets or dismiss.

An explicit tooltip target nested inside another tooltip target owns the hover
at its own text. Entering that child selects it for the next publication frame
even within the boundary-jitter allowance. This lets glossary definitions, file
paths, and other annotated output remain discoverable when the enclosing output
block also exposes a hidden-tail hint.

All YA-rendered pointer tooltip surfaces share one pending publication slot.
This includes delegated text, rich explanations, and session hover cards. A
new target replaces any unpublished dwell intent from any of those surfaces;
zero-delay and warm handoffs share one animation-frame callback and publish
only its final target. At publication, the target must still match the
browser's current `:hover` state. Keyboard-visible focus is the deliberate
non-pointer exception. Thus queued pointer events processed after a main-thread
stall cannot replay an obsolete tooltip or trigger an obsolete session-preview
refresh.

For a warm delegated-tooltip handoff, the layer releases at most the previously
published target and publishes only the final connected target. No intermediate
target may become visible or acquire the shared tooltip description. Leaving
the pending target before that frame cancels its handoff; the previously
published target keeps ownership until the ordinary departure dismissal runs.
Cold targets use the same replaceable publication slot with their dwell delay,
so crossing them before reveal remains silent. Browser-native titles and
CSS-only hover affordances remain browser-owned and need no application
publication queue.

Pointer transparency, not early dismissal, is the mechanism here. WCAG 2.2
success criterion 1.4.13 requires author-rendered hover content to stay
hoverable, persistent, and dismissible, so closing a tooltip the moment the
pointer leaves its trigger is not an available fix for the covered-control
defect; the measured rectangle supplies the hover region instead of
`event.target`. Passive tooltips traded selectable text for that transparency,
which full-text copy already covers. Cursor-relative placement is likewise not
the correctness mechanism: target-aware non-obscuring placement remains
optional presentation polish and must never replace the unrelated-control
guard.

The session preview hover card is intentionally slower and requires pointer
rest: pointer movement before its first reveal restarts the three-times-
configured delay (150 ms by default), so a casual pass across a session list
remains quiet. After one card opens, scanning neighboring session rows retains
the configured base delay instead of switching a large surface instantly. A
zero configured delay remains an explicit request for instant reveals. When
horizontal room permits, the card opens beyond the row's right or left edge so
it does not cover the session list; cursor-relative viewport-clamped placement
is the fallback when neither side fits.

## Themed presentation

Appearance → Typography offers a **Tooltip size offset** slider and numeric
entry from -3 to +6 px in 0.5 px steps. The browser-local value defaults to
0 px, preserving the existing size, and adds to the UI-size-derived text of
ordinary, enlarged, and glossary tooltips in the shared layer. It does not
resize session preview cards, rich risk explanations, or browser-native hints.
The typography specimen always includes an in-flow themed tooltip sample with
the same font, size, colors, border, and shadow as an ordinary tooltip. Committed
slider or number edits update that sample and live tooltips together; reload
preserves the offset. Reset typography restores 0 px, and Appearance's Undo
restores the value from when the pane opened. Changing the offset does not
switch the saved Native/Themed mode.

Plain text tooltips retain familiar tooltip geometry: a compact monochrome
surface with maximum black/white contrast and polarity opposite the active
light or dark color scheme, a visible border and modest shadow, 500-weight UI
text for legible glyph strokes, tight unzoomed line spacing, and no decorative
animation. Before the user offset, the ordinary themed tooltip is one pixel
larger than the compact `--font-size-xs` UI token; its enlarged treatment
advances to half a pixel above
`--font-size-sm`. Glossary text retains its additional one-pixel offset in both
states. Multiline content preserves line breaks. Content taller than the
viewport-relative cap scrolls inside the tooltip rather than being clipped.

The shared layer consumes both legacy static `title=` hints and explicit
`data-tooltip` hints. New and pointer-computed producers assign exactly one
owner: themed mode uses `data-tooltip`; Native mode uses `title`, never both.
Shared helpers enforce that rule for React attributes, pointer-computed hints,
hidden-content badges, and generated fixed-font file links.
Themed mode proactively detaches every legacy browser `title`, including titles
added or updated after mount, and retains its text as YA tooltip metadata for
the entire time Themed mode is active. A detached React-owned title remains as
an empty `title=""` sentinel: it cannot produce a browser bubble, but it lets a
later React update or removal remain observable. Removing the source title also
removes the layer-injected `data-tooltip`; switching to Native restores only
titles whose producers still own them. No pointer departure, dismissal, or
viewport change may reintroduce a browser-owned bubble while Themed mode owns
tooltip presentation.

An ordinary control hint must add information not already conveyed by a
persistent visible label: hidden or clipped content, a shortcut, disabled
reason, consequence, dynamic state, path/range, or explanation. A `title` that
only repeats or lightly restates a visible button/link label is omitted at the
producer. Visible label text supplies the accessible name. An icon-only control
still needs an independent `aria-label`, `aria-labelledby`, or visible label;
its same-text visual hint is not also associated as a duplicate accessible
description.

A hint that exactly repeats its target or one of its measurable text-owning
descendants is omitted only when every exact-text owner is visible in its own
scrollport, every clipping ancestor, and the viewport. The actionable target
may also contain metadata; that does not make a fully visible exact-title
descendant need a tooltip. If any exact owner is clipped or cannot be measured,
the hint remains. If there is no exact owner, the layer does not infer
redundancy from partial string similarity. Explanatory hints and extra metadata
are not inferred to be redundant. Ran commands use their producer's hidden-
content count first, then the same actual scroll-visibility check on hover.
Thus a command without a `+N` badge still reveals its full text when partly
scrolled out of view, while any fully scroll-visible command has neither a
themed nor native command tooltip. Expansion alone does not suppress the hint
when the command remains clipped by its own scrollport, an ancestor, or the
viewport. The Ran-label hint separately owns elapsed time.

Faded output/diff previews reveal a plain-text tail through shared preview
machinery: an ellipsis plus the final configured number of lines. The same
tail is available from the faded content and its `+N` hidden-content badge
where present. Bash/Ran, Web, Edit, and Write use this contract; the badge
requires its producer to supply the actual omitted-tail text so a new badge
cannot silently omit the affordance. When the line-count/character budget says
all content fits but wrapping, a clipping ancestor, or the viewport still hides
part of the rendered surface, hovering exposes the full content. Only content
that both fits and is fully scroll-visible remains without either tooltip
attribute.

File links use only the concise path and optional line/range as their hint.
Filename and adjacent `N lines` range links may therefore show the same hint.
Instructions such as “Click to view” are omitted because link activation and
browser link gestures are already conventional.

Secondary-click inside a visible passive plain-text tooltip's measured bounds
copies the text the enlarged tooltip presents and immediately increases the
tooltip by one text-size step, without animation or changing primary hit-
testing. A producer may supply a zoom-only one-line headline and detail body;
ordinary hover keeps its compact text, while enlargement renders the headline
in stronger weight above that additional detail. A nonempty existing selection
or an app-owned context menu retains browser/application behavior; right-click
outside the visible tooltip bounds likewise remains owned by its page target.
Whenever the tooltip declines a secondary click this way, it also dismisses
itself and stays dismissed until the pointer leaves the trigger: the menu that
opens claims the same screen position, and the pointer then rests, so nothing
else would clear the hint before it had covered the menu's first entries. Menus
the tooltip layer never sees — an app menu whose handler stops propagation,
such as the file link's Copy path menu — assert the same invariant for their
mounted lifetime through the shared suppression hold, so a hover hint cannot
reappear over an open menu. The compact tooltip reserves no empty enlarged-
state space and retains its ordinary size limits. Enlargement adds a font-
relative increment to the maximum width, keeping its usable line length close
to the font step until the viewport clamp takes over. It also raises the
vertical cap to use available viewport height before contained scrolling is
needed. The box keeps its existing top-left position when the result fits; each
axis moves only the minimum needed to remain inside the viewport. The enlarged
tooltip follows the same hover-region and close grace as its ordinary form.
Passive tooltip text is not pointer-selectable: full-text copy is the retrieval
path. Wheel input inside a vertically overflowing tooltip changes only its
internal scroll position: the tooltip rectangle, word wrapping, and underlying
page position remain fixed, including at the tooltip's scroll boundary. A non-
overflowing tooltip does not consume wheel input.

Explicit primary or secondary glossary-term activation begins in the same
enlarged treatment and copies the exact definition because activation expresses
reading intent; passive pointer hover remains compact. Glossary context adds one
pixel to both corresponding text sizes, without changing ordinary themed
tooltips. Long definitions use the shared tooltip's contained scrolling. The
activated definition itself does not intercept a secondary click or touch
long-press; the browser keeps those gestures for text selection and its normal
context menu. Tapping or selecting inside the tooltip does not dismiss it;
Escape or activation outside the term and tooltip does.

Rich explanatory tooltips may retain structured content while using the same
dwell/warmth coordinator and the same keyboard-visible versus pointer-generated
focus distinction. Touch activity does not render or warm a rich tooltip when
activation provides its corresponding dialog path. Interactive help panels and
menus are popovers, not tooltips; they keep their own explicit open/close
interaction instead of pretending to be hover hints.

## Future: rendered hidden tails

The shared hidden-tail tooltip is currently plain text in the tooltip UI font.
A future rendered tail may use its normal output renderer or text/output font,
but it remains a tooltip-like affordance: the same monochrome high-contrast
shell, normal tooltip geometry, dwell/adjacency behavior, and slightly tighter
unzoomed metrics. “Rendered” changes the body typography and content treatment,
not the surface into a card.

## Verification contract

- Bottom-bar long-press exposes the hint plus Hide for ordinary and specialized
  controls without replacing a specialized mobile action; desktop right-click
  does so only for ordinary controls. Hide uses the toolbar presence setting.
- Static and pointer-computed hints obey rest delay, persistent trigger/tooltip
  hover, delayed pointer departure, keyboard-visible focus, and exclusive
  native/themed ownership. Themed mode contains no nonempty native titles;
  removing a detached source title clears its themed metadata, and Native mode
  restores only titles still owned by their producers.
- Keyboard-visible focus opens themed tooltips; pointer-generated focus,
  including touch focus, does not reopen a dismissed tooltip.
- Rich explanatory tooltips likewise ignore touch pointer activity and
  pointer-generated focus while retaining their activation-to-dialog path.
- Once visible, a tooltip survives same-target pointer motion, transcript
  follow-scroll, scroll-generated pointer boundary events, and non-Escape
  keystrokes that neither edit a composer nor navigate a Source Control list.
  Source-list navigation dismisses the current tooltip and does not open one on
  destination focus. Composer edits dismiss every
  YA-rendered tooltip owner and suppress pending/new reveals for 100 ms after
  the latest edit; nothing reopens without a later pointer/focus event.
- Exact visible-content hints are absent only when every measurable exact-text
  owner (target or descendant) is fully scroll-visible, and remain when any
  owner is clipped by self, descendant, ancestor, or viewport; no-`+N` Ran
  commands follow the same measured rule.
- Every faded hidden-content preview exposes its actual tail from the fade and
  `+N` badge where present; an unfaded preview exposes its full content when
  any of its rendered surface is not scroll-visible.
- Read/file links expose only a concise path/range and never carry native and
  themed attributes simultaneously.
- Only visible tooltips enable immediate temporally adjacent reveals.
- At most one delegated, rich, or session-preview tooltip is visible, and warm
  handoff changes ownership without a blank or dual-tooltip frame.
- Crossing several warm delegated-tooltip targets before one animation frame
  publishes only the final target; intermediate targets never become visible
  or acquire the shared tooltip description.
- Boundary jitter within four CSS pixels neither switches tooltip content nor
  starts departure dismissal, except that entering a nested explicit target
  immediately gives that child ownership over its enclosing target.
- A passive visible tooltip is pointer-transparent but geometrically remains
  part of its active hover region. Native activation passes through only to its
  own trigger; unrelated obscured controls are blocked without synthesized
  events or partial press/focus state.
- Persistently labelled controls have no hints that merely restate their
  labels. Icon-only controls have independent accessible names, and a same-text
  visual hint is not also exposed as a duplicate accessible description.
- Native mode leaves ordinary browser titles intact.
- Valid slider/number edits select themed mode; an empty number draft does not.
- Themed session-list hover cards require pointer rest, use the 3× first-open
  delay, and retain the configured base delay for warm switching. Native
  session-list rows render no rich card and expose only clipped titles through
  ordinary browser tooltips.
- Touch activation of a session row or Recent Sessions link navigates without
  opening, warming, or leaving behind a session preview or text tooltip.
- Primary or secondary activation of a glossary term reveals and copies its
  enlarged definition; an existing text selection wins, and secondary-clicking
  inside the activated definition remains browser-owned.
- Secondary-click inside passive tooltip bounds copies/enlarges the presented
  text while respecting existing-selection and app-context-menu exclusions. A
  producer's zoom-only headline/detail replaces the compact hint only after
  enlargement. A declined secondary click dismisses the tooltip until pointer
  departure, and no hover hint is visible while an app context menu is mounted.
  The compact box reserves no enlarged-state gap or changed size limit;
  enlargement preserves its top-left position unless the viewport requires the
  minimum per-axis clamp, adds a font-relative maximum-width increment, and
  raises the viewport-bounded height cap.
- Wheel input over an overflowing passive tooltip scrolls its content without
  changing its rectangle, wrapping, or the underlying page position; passive
  text remains unselectable.
- The local and remote entry points install the same tooltip layer and
  pre-render appearance initialization.

## Automation and screenshot verification

Native and Themed mode require different assertions because a native tooltip is
browser/OS UI rather than page DOM:

| Scenario | Semantic assertion | Screenshot expectation |
| --- | --- | --- |
| Native ordinary hint | Target has `title`, has no `data-tooltip`, and exposes the title as an accessibility description where the browser supports that mapping | A Playwright page screenshot generally does **not** capture the native bubble, even after a real hover; absence from the image does not prove failure |
| Themed ordinary hint | Target has `data-tooltip`, has no nonempty `title` (a detached legacy source may retain `title=""`), and a delayed hover or keyboard-visible focus creates one page-DOM `role=tooltip` surface | The tooltip is part of the page and should appear in a screenshot after it becomes visible |
| Touch activation | A real touch tap may focus and activate the target, but waiting past the configured delay must not create an ordinary themed or rich explanatory tooltip | No custom tooltip remains over the post-activation UI |
| Rich explanation or session preview | Assert the custom surface's own content, timing, ownership, and activation contract independently of ordinary `title` ownership | These surfaces are page DOM and are screenshot-visible in either mode |

Use keyboard `Tab` to verify keyboard-visible focus and a real mouse click or
emulated touchscreen tap to verify pointer-generated focus. Programmatic
`focus()` is not a substitute for a pointer test: browsers commonly treat it as
`:focus-visible`, so it can produce the keyboard branch. For Native mode,
prefer attribute and accessibility-tree assertions over screenshot matching.
A whole-device or OS-level capture may include native browser chrome, but that
is platform-dependent and is not a portable browser-test oracle.

The touch regression sequence is specifically pointer activation followed by
pointer-generated focus: dismissal on pointer-down is insufficient if the
subsequent focus event schedules the hint again. Exercise that complete
sequence, wait beyond the configured delay, and let the browser's
`:focus-visible` result distinguish keyboard-visible from pointer-generated
focus.
