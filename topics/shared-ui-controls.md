# Shared UI Controls and Feedback

> Shared controls own their placement, feedback, and recovery behavior so every
> caller receives the same interaction contract.

Topic: shared-ui-controls

See [UI architecture](ui-architecture.md) for rendering and interaction
ownership, and [tooltip interactions](tooltip-interactions.md) for hints.

## Transient Feedback Lifetime

In-page toasts remain click-to-dismiss alerts. Success and informational
feedback uses a 4.5-second lifetime, or seven seconds when it includes an
action. Error feedback remains for 12 seconds because it commonly carries the
only explanation for a failed operation. The toast stays fully opaque for the
first 75% of its lifetime and fades only near removal, so nominal lifetime and
readable lifetime do not diverge. One duration resolver owns both the removal
timer and CSS animation value.

## Desktop Dropdown Panel Placement

A desktop `FilterDropdown` panel (the model picker, session filters, and the
other shared selection menus) must fit inside the visible area of the window
and of every scrolling or clipping ancestor. It opens below its trigger unless
its content does not fit there and the space above is larger; then it opens
above. Its height is capped to the room on the chosen side (and never more
than 480px or 60% of the window), and a longer list scrolls inside the panel.
Every option must be reachable by scrolling inside the panel. Opening the panel
must not scroll the page or lengthen its scrollable area. The mobile bottom
sheet is separate and unaffected.

## Fatal Client Diagnostics

The root client error boundary preserves enough context to diagnose an
otherwise unrecoverable React render failure without reproducing it. Its
fallback exposes a copyable diagnostic containing the error and component
stacks, route, client/server versions, timestamp, user agent, bounded DOM
counts, and the browser-local Conversation View/thinking settings relevant to
session rendering. It never includes transcript or draft text.

The copy icon beside Diagnostic details copies that same complete diagnostic
without opening or closing the disclosure. It shares success/failure feedback
with the Copy Diagnostics button and remains usable without the app's styles
or hook-based providers.

The Report Issue action targets the canonical repository and pre-fills the
same diagnostic plus a prompt for the immediately preceding action. Optional
remote client-log collection receives the diagnostic as one formatted error
entry, so object serialization cannot discard React's component stack.
