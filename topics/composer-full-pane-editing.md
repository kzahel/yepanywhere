# Composer Full-Pane Editing

> Composer full-pane editing gives long drafts a viewport-bounded editor that grows with the draft while preserving the page title and the composer's ordinary action controls.

Topic: composer-full-pane-editing

## Contract

- The New Session composer and editable handoff composer expose a visible
  full-pane toggle. The in-session composer exposes the same mode through
  `Ctrl+U` and a top-right maximize/restore control that remains available when
  the composer is minimized to one line. The centered chevron continues to own
  only the independent one-line collapse state.
- The visible controls' tooltips and the in-session `?` shortcuts panel identify
  `Ctrl+U` as the shared maximize/restore accelerator.
- On New Session and handoff composers, the attachment action retains the
  leading left toolbar position. The lower-frequency full-pane toggle follows
  the other auxiliary controls so it does not replace an established action's
  muscle-memory target.
- Follow and the in-session maximize/restore control keep the same horizontal
  anchors when the composer changes between its ordinary and one-line states.
  Collapsed-field actions fit below that stable control group instead of moving
  it sideways.
- Full-pane mode is transient UI state. Leaving the page or restoring the
  ordinary composer does not change a saved preference or the draft text.
- A nonempty in-session composer exposes **Clear composer** at its upper left
  on phone widths (600px or less). It shares `Ctrl+G` behavior: stop dictation,
  clear the text through the browser undo path, remove draft attachments and
  correction state, persist the cleared draft, and focus the composer. Empty
  composers hide it, and disabled composers cannot clear. Desktop retains the
  keyboard shortcut without another visible control.
- The textarea continually resizes as the draft changes. Its target height is
  the rendered draft plus one additional text line, capped by the space
  available in the pane; once capped, the textarea scrolls internally.
- Entry preserves the ordinary composer width when that width can accommodate
  the target height. The New Session and handoff composer may widen to the
  available pane when wrapping at the ordinary width would exceed the height
  cap.
- `Enter` always inserts a newline in full-pane mode, independent of the normal
  Enter/Ctrl+Enter setting and any queue shortcut. `Ctrl+Enter` performs the
  direct send or start action. The ordinary tappable send/start control remains
  available.
- In a session, the session title bar, transcript, auxiliary pane content, and
  ordinary bottom composer bar remain rendered. The existing split point moves
  upward as the textarea grows, shrinking the content scroll region only by the
  height the composer actually needs. On New Session and handoff surfaces, the
  containing page or modal header remains visible while launch settings yield
  the editing area.
- Activating the transcript's **Follow** control restores a full-pane composer
  to its ordinary size while rejoining the live tail. Activating the composer's
  own maximize/restore control changes only composer size; it does not move the
  transcript or change follow intent. The one-line collapse state remains
  independent of both.

## Deferred UI Design

Keeping the New Session and handoff project, provider, thinking, and related
launch controls visible in full-pane mode requires a deliberately compact
launch-controls layout. Until that layout is designed and evaluated, those
controls yield to the editing area and return unchanged when full-pane mode is
restored; do not improvise a partial compact toolbar as part of the current
interaction.

The in-session top-right maximize/restore placement is a live prototype. It
uses window-management iconography and a top-right control group to avoid
confusion with the centered one-line collapse chevron; evaluate its live fit
before treating the icon geometry and placement as final.

## Verification Boundary

`resizeComposerTextarea` owns the draft-plus-one-line calculation and height
cap. `NewSessionForm` owns the visible toggle, width escalation, and handoff
reuse. `MessageInput` owns the visible in-session entry and the editing-first
Enter contract.

Behavior tests cover live sizing, height capping, both entry paths, newline
semantics, and direct Ctrl+Enter submission. Final browser captures cover the
New Session and in-session layouts at desktop and phone widths.

## Related Topics

- [composer-bottom-bar-overflow](composer-bottom-bar-overflow.md) — responsive
  ownership of the action controls that remain available in full-pane mode.
- [session-context-actions](session-context-actions.md) — handoff creation and
  the editable handoff launch surface.
- [vanilla-defaults](vanilla-defaults.md) — records the explicitly authorized
  default-visible New Session affordance.
