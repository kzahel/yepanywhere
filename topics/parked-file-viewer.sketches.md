# Parked file viewer — sketches

Candidate designs that extend the [parked file viewer](parked-file-viewer.md)
contract. Not current guidance; routine topic reads exclude this file.

## Side-by-side workspace panel

Status: candidate design, requested 2026-09-15. The session-column
layout itself is now specified in
[session-right-pane](session-right-pane.md); this sketch remains the
file-viewer dock/tab migration notes until that consumer lands.

Today one managed viewer (file, tool detail, provider-child transcript,
artifact) covers the session's transcript row while the composer stays
operable below it, and it parks to a bottom-toolbar controller
(`sessionViewerController.ts` holds exactly one `current`). On a phone that
is right. On a wide desktop it wastes the width: the transcript is capped at
its content width, the viewer is capped at its 1200px reading cap, and the
two never share the screen. Source Control already proves the alternative in
this codebase: a resizable multi-column workbench with edge-only splitters
(`ResizableSourceColumns`) whose panes own their internal scrolling
([Source Control § Workbench geometry](source-control.md#workbench-geometry)).

### Shape

- **Dock mode.** On a viewport wide enough to hold the session's documented
  minimum column plus a readable viewer column, the managed viewer may
  present as a right-hand panel beside the transcript instead of covering
  it. The transcript, composer, and turn rail keep their existing layout
  inside the session column; the panel gets the remaining width up to the
  viewer's reading cap. One splitter between them, using the Source Control
  splitter contract: edge handles, keyboard operable, live reflow coalesced to
  one update per frame, width persisted per device.
- **Session view is permanent and primary.** The session column can be
  narrowed to its minimum but never removed. It may additionally collapse to a
  narrow strip that keeps the composer, status, and the parked controller
  operable, mirroring the desktop sidebar's expanded/collapsed modes
  ([Desktop Sidebar Display Modes](session-ui-customization.md#desktop-sidebar-display-modes)),
  so a reader can give a document nearly the whole width without leaving the
  session. The collapsed session still receives and buffers live updates
  exactly as the covered transcript does today.
- **Measurement, not breakpoints.** "Wide enough" is measured against the
  two minimum readable columns and the current font setting, per
  [responsive layout](responsive-layout-gaps.md); when the measurement fails,
  the viewer uses today's cover presentation. Resizing the window between
  the two presentations must reuse the same mounted viewer instance and keep
  its scroll, selection, mode, and search state, the same invariant the open
  ↔ parked transition already has.
- **Opt-in, default unchanged.** Dock mode is a per-device preference, off
  by default, reachable from the viewer header (a dock/undock toggle beside
  minimize) and Appearance settings, per
  [vanilla defaults](vanilla-defaults.md) and the local rule that a new mode
  must not re-default existing non-buggy behavior. The bottom controller
  keeps its meaning: minimize collapses the panel to the controller, restore
  reopens it in whichever presentation the measurement selects.
- **Parking in dock mode.** A docked panel still parks to the same
  controller so the state model stays `open`, `parked`, `closed`. Parking a
  docked viewer returns its width to the session column.

### Multi-window: tabs of recent viewers

The [browser-style tab sketch](session-right-pane.sketches.md) records the
2026-09-16 request for a selectable standard tab-strip display and keyboard
cycling. Initial right-pane delivery keeps minimize-to-bottom and close only.

The second, separable step relaxes "at most one managed viewer per session"
to "at most one *visible* per panel, a bounded set retained".

- **Recent tabs.** The panel header carries a most-recently-used tab strip of
  retained viewers (file paths with line suffixes, tool-detail labels,
  artifact titles). Opening a new viewer adds a tab and activates it instead
  of destroying the previous one; the previous tab keeps its mounted state
  exactly as a parked viewer does today.
- **Bounded retention.** A small retained count with least-recently-used
  eviction; evicted tabs close through the ordinary close path so grants are
  revoked and hydration resumes. Hidden tabs pause progressive hydration and
  buffer, like the covered transcript, so retention costs memory but not
  render work.
- **Replace versus add.** The current single-viewer replacement stays the
  default gesture. A modifier (Ctrl/Cmd-click on desktop; long-press on
  touch) or a per-device "open in new tab" preference adds a tab. Cover mode
  on narrow viewports keeps one visible viewer and exposes the same tab list
  as a menu, so a phone can switch among retained viewers without a strip.
- **Controller.** The parked controller shows the active tab's label and a
  retained count; close closes the active tab and activates the next
  most-recent one, and close-all is the existing close from a menu.
- **Browser history.** Each tab keeps the per-viewer history entry contract
  ([parked file viewer](parked-file-viewer.md#user-workflow-and-invariant));
  switching tabs is not a navigation, opening or closing one is.

A second dock panel (for example diff on the right, file on the left) is not
part of either step; Source Control's three-column layout remains the
precedent if demand appears.

### Evaluation

Captures at 1200×600, a wide desktop at 1600×900 or larger, and 375×812.
Success requires:

- the docked panel and session column both remain readable at their minimum
  widths, with the composer fully operable while the session is collapsed;
- resizing across the dock/cover threshold keeps the viewer's content, scroll,
  and selection, with no refetch;
- a live assistant response continues to render in the session column while
  a document is docked, and the parked controller still works in both modes;
- the phone presentation is byte-identical to today's when the preference is
  off; and
- with tabs, opening several files and switching among them never drops a
  keystroke in the composer under streaming load (the standing 100 ms
  acknowledgement rule).

### Open questions

Whether the docked panel should also host Source Control's diff pane for a
session's Edit-block Review link, so "review this edit" does not leave the
session; whether the session column's collapsed strip shows the turn rail;
and whether tab state should persist across reload or remain session-DOM
lifetime like the current viewer.
