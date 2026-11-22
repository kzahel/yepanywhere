# Shared UI Controls and Feedback

> Shared controls own their placement, feedback, and recovery behavior so every
> caller receives the same interaction contract.

Topic: shared-ui-controls

See [UI architecture](ui-architecture.md) for rendering and interaction
ownership, and [tooltip interactions](tooltip-interactions.md) for hints.

## Transient Feedback Lifetime

Routine success and informational toasts are compact notices at the upper
right below the header. They use the current theme's raised surface, with
a small checkmark for success. The latest routine notice replaces the
previous one and clears after three seconds. It is announced as a status,
allows pointer input to pass through, and is visually hidden while the
sidebar drawer is open. The lifetime continues while the drawer is open.

Errors and notices with an action appear ahead of routine notices, are
announced as alerts, and have dismiss buttons. An action notice lasts seven
seconds and an error lasts 12 seconds. Only the controls receive pointer
input. Toasts stay fully opaque for the first 75% of their lifetime, then
fade before removal. With reduced motion they stay opaque until removal.

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
