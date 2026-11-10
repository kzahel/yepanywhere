# Session UI Customization

> Session UI customization lets users choose which session controls are visible
> or enabled while preserving keyboard-driven access to advanced actions.

Topic: session-ui-customization

See also: [toolbar-settings-ui.md](toolbar-settings-ui.md) — the how-it-works
reference for the Toolbar settings pane (layout, narrowing priority, previews).

## Landed surface

The first customization surface has shipped as its own top-level **Toolbar**
settings category (id `toolbar`, separate from **Appearance**): it renders a
live `SessionToolbarPreview` mockup beside a per-control visibility list, plus
a reset-to-defaults action.
<!-- verified: i18n-settings.ts:103-112 (appearance vs toolbar categories);
     ToolbarSettings.tsx; SessionToolbarPreview.tsx -->

The `sessionStatus` control defaults **off on mobile** (`≤600px`,
`MOBILE_SESSION_TOOLBAR_VISIBILITY_DEFAULTS`) because the inline status row
crowds the cramped toolbar. Its description names the inline liveness/status
chips and the decoupled age float so the scroll-position "at N ago" anchor is
discoverable from the Toolbar pane.
The last-activity freshness and position age are nonetheless surfaced by a
fit-driven float whenever the inline row is unavailable; this float is
*decoupled* from this toggle — see
[composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md)
§ Freshness / position-age presentation. The toggle still governs the inline row
and the liveness chip.
Presence state is held by `useSessionToolbarPresence` and currently covers
`modeSelector`, `steerNow`, `attachments`, `slashMenu`, `thinkingToggle`,
`renderMode`, `conversationView`, `microphone`, `waveform`, `shortcutsHelp`,
`contextUsage`, `btw`, `nudge`, `sessionStatus`, `projectQueue`, and
`projectQueueNewSessionShortcut`. Changing a control updates the preview
immediately. The two Project Queue controls are independent and default hidden:
`projectQueue` targets the current session, while
`projectQueueNewSessionShortcut` exposes the `+` shortcut that sends an
existing session composer's draft to a future separate session.
Controls use one stored presence value: missing/`default` follows the current
client default, `hidden` is an explicit local hide, and `first`/`mid`/`last`/
`pin` show the control with that narrowing priority. The server also persists
`clientDefaults.sessionToolbarPresence` so the last selected toolbar value
becomes the default for devices with no explicit local override. Resetting
toolbar presence clears local overrides and returns that browser to following
the server client default.
Customizable interactive controls in the session bottom bar also expose a
contextual quick-hide surface beside their hint. Touch long-press always adds a
**Hide** action, including for controls whose long-press already performs a
special action; the existing action continues to run. On desktop, right-click
opens quick hide only when the control has no special context action. Hide
writes the same `hidden` presence value as the Toolbar settings pane, so every
rendered copy disappears together and the pane remains the recovery path.
`conversationView` is the narrow client-only exception: both its mode and its
toolbar-presence override remain browser-local and are not sent to older servers
as a new client-default key. The control defaults shown at the `last` narrowing
tier and Conversation view is active for a browser profile without a stored
choice. Changing this control from hidden to shown also activates the mode;
existing explicit mode and presence choices otherwise remain authoritative.
The same Toolbar category exposes the browser-local **Conversation View
history** slider (100 user turns by default). That limit applies when the user
explicitly switches Conversation view on; a view that opens already active
condenses all loaded turns. Revealing earlier turns changes only the mounted
transcript view, not this default. See
[conversation-view.md](conversation-view.md).
The **Live Microphone Waveform** control defaults shown and includes a nested,
browser-local **Button background opacity over waveform** slider. It covers
0–100% in 5% steps and defaults to 70%. The live toolbar preview paints a static
waveform at the current value, including when no microphone capture is active,
so the effect is visible before the user dictates. The opacity preference is
included in **Transfer browser settings** backups. It stays beside the waveform
presence control rather than moving to Appearance because it has no effect
without that specific toolbar element and the combined preview is the useful
editing surface.
Narrowing priority is derived by `useSessionToolbarPresence` and is editable
for controls the runtime overflow menu can actually reveal: the left-side
controls, shortcut help, `sessionStatus`, `contextUsage`, `btw`, `steerNow`,
`projectQueue`, and `projectQueueNewSessionShortcut`. The right-side controls
default to `pin` when shown, so they stay inline unless the user explicitly
chooses a collapse tier. `microphone` and `waveform` remain visibility-only
controls for now.

The former composer model indicator chip is removed from the customizable
toolbar. The top-right provider badge remains the model/effort status surface
and opens the mid-session model, thinking, and effort control panel for owned
sessions.

This is the resolution path for session controls that are useful to some users
but too busy, speculative, or maintainer-contested for the default UI. Examples
include composer delivery choices such as regular queue versus patient queue,
secondary search/edit controls, and other advanced per-session actions.

Patient queue is a distinct per-item delivery intent, not a magic prompt prefix.
The phrase `when done, ` is ordinary user-authored text. YA must not add it
when queueing. The active composer model is:

- **Plain Enter** follows the user's selected default action for the active
  steering state, currently steer by default when the provider supports
  steering.
- **Ctrl+Enter** is the "other" regular action: if Enter steers, `Ctrl+Enter`
  regular-queues; if Enter queues, `Ctrl+Enter` steers. Patient is not the
  shortcut.
- The **straight-arrow queue button** remains available for steering providers
  while a turn is active, including mobile users who cannot rely on keybinds.
  The patient-switch visibility setting must not hide this alternate send
  option.
- Text arrows in delivery controls share one optically centered glyph envelope
  across ordinary, collapsed, and touch-keyboard composer layouts. Their
  surrounding button sizes and hit targets do not move to compensate for font
  metrics.
- The **patient stopwatch toggle** is default-off and affects only future queue
  submissions. Accepted queued items keep their own regular or patient intent.
- Patient queued rows wait for their per-item verified-quiet patience seconds
  (default 30s).
  Regular queued rows may pass patient rows at delivery time, so UI should
  visibly distinguish patient rows while preserving composition order in the
  scroll-following queue tail.
- The `?` shortcut help should mention right-click/long-press as the route to
  change key behavior. The first narrow setting is swapping Enter and
  `Ctrl+Enter`; broader keybind remapping can build from there.

`onQueue` is only supplied while the agent is running, so a "done" agent never
reaches the queue path. The patient queue default is a Message Delivery
setting, not a Toolbar visibility key; the alternate Steer/Later send button
remains visible when dual-action delivery is available. Tooltips must state the
regular queue and patient queue distinction. See
[`message-control-steer-queue-btw-later-interrupt.md`](message-control-steer-queue-btw-later-interrupt.md).

### Escape interrupt preference

Right-clicking or long-pressing **Stop** opens **Stop options** with
**Disable Esc to interrupt**. This browser-local opt-out defaults off, so Esc
continues to interrupt a running turn from the composer unless explicitly
disabled. The menu then offers **Enable Esc to interrupt** to restore it.
The preference applies across sessions, survives reloads, and is included in
browser-settings transfers; it requires no server support.

Disabling Esc interruption does not disable clicking Stop or Esc's existing
speech, editing, suggestion, and overlay cancellation actions. The Stop tooltip
and shortcut guide reflect the active binding. Opening or dismissing the Stop
menu must never interrupt the turn; touch long-press suppresses the resulting
click. Keyboard users can open the menu with Shift+F10 on Stop.

## Remaining work

Relative to the landed surface:

- Hidden/shown list rows are the editing surface, not click-on-the-mockup-
  control interaction in the top preview.
- Visibility is binary show/hide; there is no "visible but disabled" treatment
  (dimmed / crossed-out) that keeps a removed control legible in the real UI.
- No per-session override distinct from the browser-local explicit choice yet.
- Hidden controls do not guarantee a surviving keyboard-accelerator hint on a
  hover/tooltip surface.

## Contract

- Defaults may stay conservative, but optional controls should have a path to
  remain available without rebuilding the UI for each maintainer preference.
- A disabled visible button is a UI preference, not necessarily a disabled
  command. If the keyboard accelerator still works, tooltip and mouseover
  surfaces should continue to show that accelerator.
- Customization state should distinguish global defaults from per-session
  overrides, matching the pattern used by new-session/global defaults where
  possible.
- Controls disabled by upstream preference should be candidates for
  configurable default-off restoration before the implementation is removed.

### Sidebar launcher gestures

The page-header Open/Toggle sidebar control and the collapsed-rail Expand
sidebar control share one launcher contract. A normal click opens or toggles
the sidebar in the current tab. Middle-click and browser-modified clicks open
New Session in a separate browsing context, preserve the direct or relay base
path, and add `sidebar=expanded` without changing the source tab. Their
tooltips expose the discoverable Shift-click form as
`<ordinary action> / [Shift] New Session`.

### Sidebar spacing

Sidebar spacing is a portable browser preference with two modes. Comfortable
is the default and keeps the intentionally enlarged 34px desktop session rows;
Compact uses the earlier density plus one pixel of separation: a
`calc(1.5rem + 1px)` minimum, 2px block padding, and 1.2 line height. Coarse
pointers keep at least 40px rows with 6px block padding in both modes, so
desktop density does not reduce phone and tablet tap reliability.

Both modes keep the YepAnywhere sidebar wordmark and the same navigation type
size. New session uses the green circular plus in expanded and collapsed
sidebars so the create action stays recognizable. It uses the same 16px footprint
as the other top-level navigation icons; the green fill supplies emphasis without
making the action geometrically larger. Sidebar density never changes branding,
action meaning, or type size. The mobile close control and collapsed desktop
rail remain available in both modes.

The same preference controls navigation-row padding and the gaps between
sidebar sections. For top-level navigation, one metric controls both the
leading edge inset and the icon-to-label gap: `0.75rem` in Comfortable and
`0.5rem` in Compact. This keeps icons visually balanced between the viewport
edge and their labels. Nested session and queue rows retain their `1ch` inset.
Compact leaves a 1px top breathing gap above New session and starts the
scrolling navigation immediately below that row instead of retaining
Comfortable's separate 0.25rem inset.

The persisted preference remains `comfortable` / `compact`, but its visible
label is **Sidebar density**. It appears with the main Appearance layout
controls beside Content width, not inside Typography, because it changes row
and section spacing rather than text rendering.

Sidebar session rows in both Compact and Comfortable density modes reserve no
permanent lane for their hover-only overflow menu. The menu is vertically
centered over its own row and may temporarily cover trailing project/status
metadata; resting rows keep that width available to the session title.

### UI size

UI size is stored as a numeric percentage. Its slider covers 85–130% in 5%
steps, with notches every 15% at 85, 100, 115, and 130. The adjacent numeric
field accepts values between steps and clamps only to 50–300%, preserving an
escape route when the slider range is too narrow. For a numeric value outside
the slider range, the slider thumb stays at the nearest end while the field
remains authoritative. Existing `small`, `default`, `large`, and `larger`
stored values load as 85, 100, 115, and 130% respectively; the default remains
115%.

## Session Header Space

Session and shared page headers reserve a 44 CSS pixel single-line row. Their
sidebar/back, model and overflow controls use 36 pixel mouse targets and 44
pixel coarse-pointer targets. Vertical row padding fits around those targets
within the reserved height, rather than increasing the row when actions load
or pointer type changes. Model pills and icons keep their compact visual size;
intentional multi-line content, including inline rename, may expand the row.
Session titles use the base UI font size at every width. Crossing a responsive
breakpoint changes available text space and controls, never the title's size.

The session header reserves space for the session title and the `…` menu.
The project breadcrumb stays visible on the same line at every width. It uses
the assigned short code when enabled and supported, otherwise the project
name. The label is ellipsized to fit its width budget; the session title yields
space first. Its accessible label and tooltip retain the full project name,
and its link still opens the project's sessions. Missing code metadata or an
older server never hides the project identity.
The model pill carries the activity indicator at every width; the header does
not repeat it as a separate thinking icon.
Its responsive tiers use the header column's width, including space taken by
the sidebar or a docked pane, and restore controls in the reverse order:

- At 720 CSS pixels and above, Share and Issues retain their header controls.
- Below 720 pixels, Share and Issues move into the session menu. Their menu
  entries retain viewer/link and association counts; Issues opens the session's
  filtered issue list. Hidden controls do not keep polling behind the menu.
- Below 600 pixels, the model pill keeps model identity with abbreviated effort
  (`L`, `M`, `H`, `XH`), retains full accessible labels and its configuration
  action, and carries the activity dot.
  The project breadcrumb retains up to 3.5rem (5rem in the compact tier,
  8.5rem in the full tier), independently of session-title length.

Narrow or crowded headers open manual Rename in a compact dialog with a labeled
input and explicit Save/Cancel actions. Leaving the field or dismissing the
keyboard never saves the dialog; closing or Android Back cancels. Roomy headers
retain inline rename. The presentation is chosen on opening and stays stable
through keyboard resizes and rotation; an inline field wraps rather than
collapsing when its header narrows. Navigating away dismisses Rename without
saving. Both editors focus/select in their mounting commit, keep their drafts
independent of transcript updates, do not submit an active IME composition, and
retain the field and draft on save failure.

## Desktop Sidebar Display Modes

The desktop sidebar has three browser-persisted display modes. Expanded mode
reserves the configured sidebar width; collapsed mode reserves only the icon
rail; minimized mode reserves no width and leaves the standard sidebar toggle
fixed over the page at 2px from the top-left viewport edge. The floating toggle
is an overlay: page headers and content do not add padding or otherwise reflow
around it.

Every desktop mode carries its own toggle: expanded mode puts it at the right
edge of the sidebar header opposite the brand, collapsed mode centers it in the
rail, and minimized mode is the floating restore control. Page headers show a
sidebar control only when the sidebar is an overlay rather than a persistent
column — the narrow-viewport case and the content-frame routes. A page header
with no leading control widens its left inset, since the missing button's own
padding no longer supplies it.

The sidebar header's controls align on the brand glyph. Their icon ink matches
the wordmark's inset.

Minimize is available only from the collapsed desktop rail. Its small
bottom-line control removes the entire rail, and the floating standard toggle
restores the collapsed rail rather than expanding it. Mobile overlay behavior
is unchanged. The normal default remains the expanded sidebar, so the new
control appears only after the user has already selected or reached collapsed
desktop mode.

A fresh Settings window or reload starts with an expanded preference reduced
to the collapsed icon rail. This initial route choice does not write browser
preferences or change another open window. A saved minimized mode stays
minimized, and an explicit `?sidebar=expanded` takes precedence. The reader
can expand the rail normally; same-window navigation retains its current mode.

A tab opened directly on the new-session page or reloaded there honors the
saved expanded, collapsed or minimized mode. With no saved choice, it starts
expanded. The [pre-boot composer](early-typing-handoff.md#pre-boot-composer)
reserves the same sidebar space so adopting early typing does not require
hiding navigation; `?sidebar=expanded` still wins.

## Session List Subagents

Compact session rows with subagents show an expander without a visible count
badge. Its tooltip retains the count and child names; expanding reveals the
child sessions. The parent's unread state does not add emphasis to the expander.

## Session List Menu Visibility

Session row menus remain hidden at rest on both desktop and touch screens.
Desktop hover reveals only the hovered row's menu. Touch devices reveal the
menu for the focused row; keyboard focus and an open menu keep its trigger
visible. Touch hover emulation must not reveal menus across the list or require
a second tap to open a session. These rules apply to compact sidebar rows and
session cards alike.

## Mockup Requirements

The landed surface shows a realistic session composer/toolbar mockup
(`SessionToolbarPreview`). The target end state, not yet fully reached, is that
clicking a control in the mockup itself toggles whether the real session UI
shows or enables that feature, and that disabled controls remain legible in the
mockup using a visual treatment such as dimming or strikethrough/cross-out so
the user understands what can be restored.

The hover surface for grouped or secondary actions should include keyboard
accelerators for actions that remain available by shortcut, even if their
visible buttons are disabled.

## Related Topics

- [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md) defines
  the measured-fit float that surfaces the last-activity freshness and
  scroll-position age over the composer independently of the `sessionStatus`
  toggle on narrow screens.
- [kzahel-disabled.md](kzahel-disabled.md) logs upstream-disabled features that
  should be reconsidered as configurable default-off session controls.
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  defines message delivery behaviors that session customization may expose or
  hide.
