# Toolbar Settings UI

> The Settings → **Toolbar** pane lets users pick which composer-toolbar
> controls are shown and, for overflow-supported controls, how eagerly each
> moves into the More (`...`) menu as the bar narrows ("narrowing
> priority"). Both are edited through one **presence slider** per control:
> a notched scale from Hide (left) through the collapse tiers to
> "Show always" (right).

Topic: toolbar-settings-ui

See also: [composer-bottom-bar-overflow.md](composer-bottom-bar-overflow.md)
(the runtime overflow engine the priority feeds) and
[session-ui-customization.md](session-ui-customization.md) (the broader
visibility-customization concern). This doc is the how-it-works reference for
the pane itself.

## Where

`packages/client/src/pages/settings/ToolbarSettings.tsx` (pane, category id
`toolbar`), rendering `SessionToolbarPreview` / `ToolbarControlPreview` from
`packages/client/src/components/SessionToolbarPreview.tsx`. State comes from
one hook: `useSessionToolbarPresence` (stored per-control presence, plus
derived visibility/priority projections for the toolbar runtime). It migrates
the pre-presence localStorage pair (visibility + priority maps) on first load;
the server does the same for stored `clientDefaults` in
`ServerSettingsService.mergeLoadedClientDefaults`.

The full preview delegates its display to `SessionToolbarPreviewView`, which
also powers `Scenes/Composer` in `design.html`. Settings supplies live visibility,
priority and waveform opacity; the design scene supplies fixed values and a
reference clock. Settings explicitly enables its synthetic waveform
demonstration when the waveform control is shown; ordinary design scenes
do not simulate speech capture. Inert previews use `InertPreviewProvider` to show the
context-usage meter and microphone trigger without mounting their server-backed
editors. The normal session toolbar retains its interactive controls and
existing data acquisition.

## Layout contract

The pane is three stacked pieces, top to bottom:

1. **Live top preview** — a full, faithful, inert render of the composer
   toolbar with the user's actual visibility + priority
   (`SessionToolbarPreview`). Its job is **spatial memory**: it shows the
   visible controls in their real left-to-right positions so a user can locate
   one by where it sits, not by reading a list.
2. **Hidden zone** (first) — controls that are currently off. Split into **two
   side-groups**, left-aligned and right-aligned (matching the toolbar edge the
   control lives on; either group may be empty and shows "None hidden"). The two
   groups render as **two columns when there is room** and stack to one when
   narrow (`grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))`). Each
   row uses the same control-row style as Shown: specimen preview, copy, and
   the presence slider sitting at its Hide notch. Hidden-first is deliberate:
   off controls are the ones a user is hunting for to re-enable, and putting
   them up top makes them scannable even though the live preview already
   locates the *visible* ones.
3. A thin **separator**, then the **Shown zone** — visible controls in
   left-to-right toolbar order, split into the same **left-side** and
   **right-side** groups as Hidden. Both zones render their side groups as two
   columns when there is room and stack them when narrow. Each side keeps its
   heading when empty; Hidden also says "None hidden." Each row has a specimen
   preview, copy, and the **presence slider**.

Both zones show a **per-row specimen** (`ToolbarControlPreview`) so a row is
identified by the actual element, not just text. The specimen is also an
activation surface: pointer and keyboard activation on the specimen focuses
the row's presence slider. The specimen is somewhat redundant with the top
preview by design — recognizing a control should not require cross-referencing.

Row placement is stable during one visit to the pane. Hidden vs Shown section
membership is anchored to the presence snapshot from pane entry, not recomputed
from each change. A slider commit updates the real toolbar preview, persists
the setting, and changes the row's in-place state, but the row does not jump to
the other section until the user reloads, re-enters the settings pane, or
otherwise accepts a fresh saved baseline. Undo returns both the real toolbar
state and the row's in-place controls to the pane-entry snapshot.

Action-dependent specimens may provide invisible support context that the real
toolbar requires to construct the control, but the visible specimen remains
single-control: the current-session `Project Queue` row shows only its
project-queue button, the new-session shortcut row shows only its `+` button,
including its darker violet and prominent badge treatment, the `Now` row shows
only the steering toggle, and none should leak the primary send button or
disappear because an adjacent send context was omitted.

## Presence slider & narrowing-priority model

The presence slider merges visibility and narrowing priority into one ordinal
scale — "how long does this control stay visible when space is tight".
Notches, left to right (end labels **Hide** / **Show always**; intermediate
notches are unlabeled — a caption under the slider states the selected notch's
meaning, so tier definitions are not tooltip-only):

| notch | stored presence | meaning                              | legacy tier |
|-------|-----------------|--------------------------------------|-------------|
| 0     | `hidden`        | not on the toolbar                   | —           |
| 1     | `first`         | moves to More first                  | `early`     |
| 2     | `mid`           | moves to More after the first group  | `medium`    |
| 3     | `last`          | moves to More near the end           | `late`      |
| 4     | `pin`           | always visible (no menu copy)        | (always-on) |

The stored data model is that single enum (`ToolbarControlPresence` =
`"off" | "hidden" | ToolbarNarrowingPriority`) — one value per control, no
separate visibility boolean. Ordinary controls do not expose `off`; it is
reserved for controls whose behavior itself can be disabled. Hiding a control
**forgets** its previous tier; sliding back out of Hide lands on whichever tier
the release chooses. The toolbar runtime still consumes boolean-visibility and
tier *projections*, derived in `useSessionToolbarPresence` — non-settings
render state, not stored.

Synthetic `/done` is the first disable-capable control. Its six notches are
`off → hidden → first → mid → last → pin`: Off preserves provider-owned `/done`
handling, Hidden enables YA's typed command without showing a button, and the
four narrowing tiers enable both command and circle-check button. The setting
row is absent when the server lacks `synthetic-done-command`.

Defaults preserve the runtime collapse order: `modeSelector,attachments →
first`; `slashMenu,thinkingToggle → mid`; `renderMode,nudge,shortcutsHelp →
last`. Right-side controls (`sessionStatus`, `contextUsage`, `btw`, `steerNow`,
`projectQueue`, and `projectQueueNewSessionShortcut`) are priority-editable and
default to `pin` when shown, preserving today's out-of-box toolbar unless the
user chooses to collapse them. The current-session Project Queue button and
the `+` new-session shortcut have separate rows and separate presence values;
enabling one must not enable the other. `MessageInputToolbar` derives each
supported overflow control's tier CSS class from its priority
(`priorityToTierClass`); the measured-width collapse logic is otherwise
unchanged (see `composer-bottom-bar-overflow.md`). Controls in that supported
overflow set get the full five-notch slider, so a visible tier always maps to
real runtime behavior. `microphone` and `waveform` remain outside the priority
editor — microphone is the primary speech trigger, and waveform is elastic
capture feedback rather than a fixed-width collapsible control — so their
sliders have only the two end notches (Hide / Show always), which stays
honest: those controls genuinely never collapse.

## Edit surfaces & persistence

- **Presence slider** — the settings-pane edit surface in every row (Hidden and
  Shown). A commit (release/keyup) maps the notch to one
  `setControlPresence(key, value)` call; only changed values are written.
  Changes update the live toolbar and the row's in-place state without
  immediately moving the row between Hidden and Shown. While dragging, the
  caption (and tick highlight) track the draft notch so a user can read each
  notch's meaning before committing.
- **Bottom-bar quick hide** — touch long-press on a customizable interactive
  control exposes **Hide** beside its hint. Desktop right-click does the same
  only when that control has no existing special context action. A mobile
  control's special long-press action remains active alongside quick hide.
  Choosing Hide calls the same `setControlPresence(key, "hidden")` path as the
  slider; Settings remains the place to restore the control or choose a tier.
  Transcript scrolling, including reflow caused by editing file-link options,
  must not dismiss this menu: its anchor stays in the composer toolbar. Scrolling
  an ancestor of the anchor, resizing, clicking outside, or Escape dismisses it.
- **Specimen activation** — focuses the row's presence slider; it must not be
  a dead visual-only affordance.
- **Header undo / Reset** — snapshot restore covers the presence map; Reset
  clears it.

The setting persists to **localStorage** and syncs to server
`clientDefaults.sessionToolbarPresence` (server parse/merge in
`packages/server/src/routes/settings.ts`), mirroring each other exactly.

Implementation note: hidden rows must not use the old toggle-switch visual
language. Hidden and Shown rows are variants of one control-row component; the
slider position differs, while the edit surface stays identical whenever the
runtime overflow engine supports that control.

## Status / follow-ups

- **Remaining non-priority controls are deliberate exclusions.** The pane
  exposes collapse tiers only where the runtime overflow engine has a real
  menu copy (others get the two-notch slider). A future speech-specific design
  can revisit microphone/waveform without implying that today's row should
  show deceptive priority choices for them.
- **Regression cases to preserve.** Tests should keep covering row-specimen
  activation (focusing the slider), Hidden rows retaining the full notch scale,
  action specimens showing only their own visible control, hide forgetting the
  stored tier (re-show picks the landed notch), legacy two-map migration on
  both client and server, and presence changes not relocating rows during the
  same pane visit.
