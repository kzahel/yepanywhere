# UI Architecture

> UI architecture keeps shared rendering, layout, and interaction behavior
> attached to the data or render boundary that produces it, rather than patching
> generated DOM after the fact.

See also: [`injected-message-visibility.md`](injected-message-visibility.md) —
how YA-injected, non-user text (compaction commands, summaries, skill/resume
init text) is hidden or given the system/boundary contract instead of rendering
as a normal turn.

Topic: ui-architecture

## Render Boundary Principle

When two views present the same model data, prefer to share the component,
renderer, or source adapter that creates the UI state. Do not satisfy a view
request by adding a custom click interceptor that inspects already-rendered DOM
and rewrites destinations as a primary design; that creates view-specific
spaghetti and prevents other views of the same data from inheriting the fix.

Preferred order:

1. Amend the data/model/render generator so the current UI state is produced in
   the right shape for all callers that should share the behavior.
2. Add an explicit view-bound adapter near the origin when only one context
   should differ, such as public-share snapshot/live file links.
3. Add a default-preserving parameter when other callers need the old behavior.
4. Use post-render rewriting only as a small containment bridge, with the rule
   named and scoped so it cannot silently become the architecture.

## Narrowing/Widening Stability Principle

Any UI surface that sheds items as space narrows and restores them as space
widens must behave with a fixed order in both directions: widening brings
items back in exactly the reverse order narrowing removed them, and the same
width always yields the same set. Two acceptable constructions:

1. **Provably fixed-order algorithm** (preferred — simpler): the shed/restore
   decision is a deterministic, monotone function of available space over a
   fixed removal order, so reverse-order restore holds by construction and no
   history is needed.
2. **Tracked removal order**: record the actual order items were removed
   (fine to compute in advance, e.g. width cutoffs) and replay it in reverse
   on widen.

What this bans: unordered recomputation — e.g. bin-packing by measured item
widths, or iteration-order-dependent selection — where widening can restore a
different set or sequence than narrowing removed, or where a boundary width
oscillates. Near-equality thresholds also need slack/hysteresis so measured
feedback (an item returning changes the measurement) cannot latch or
flip-flop; see the compact-signal traps in
[`composer-bottom-bar-overflow.md`](composer-bottom-bar-overflow.md).

## Mobile Viewport Ownership

The shared navigation shell stays anchored to the mobile viewport on Inbox,
session, and other authenticated routes. Safe-area spacing must not make the
document scroll, move the header above the viewport, or leave a second gap below
the composer. Browser-bar and keyboard viewport resizes preserve that anchoring;
only the page's designated content regions scroll.

A provider-host degraded notice reserves space inside this same shell above
the app frame. Showing it must keep navigation and composer controls reachable,
without changing which container owns the viewport. The frame retains its
keyboard and safe-area insets; the outer body does not add a second inset to the
mobile shell's geometry.

## Public Share Example

Public shares have a valid reason for an independent unauthenticated top-level
page: the route is a read-only bearer-link trust boundary. That does not justify
forking the normal session/file presentation stack. The public route should feed
share-scoped loaders and link transforms into shared viewers, transcript rows,
media affordances, copy UI, spacing, and inspection behavior whenever those
affordances remain read-only.

Dynamic-scope or explicit snapshot/live link adaptation is acceptable for public
shares when the adaptation is attached to the shared rendering context or file
viewer source. It is not a license for arbitrary `onclick` URL surgery after
the UI has already been generated.

## Global Tooltip Boundary

`TooltipLayer` is the shared interaction boundary for ordinary `title` and
`data-tooltip` hints. It owns timing, placement, dismissal, and accessibility
association. Producers supply semantic hint text, including omitted-tail text
for hidden-content badges; the boundary must not infer behavior from that text
or rewrite unrelated rendered content.

Themed mode normalizes legacy and dynamically added `title` attributes into
YA-owned tooltip metadata, restoring them only on a switch to Native. This is
a compatibility boundary for older producers. Structured explanatory tooltips
explicitly share its timing coordinator; interactive help panels retain their
own popover state. Exclusive attributes, native fallback, and the full
interaction contract live in [tooltip interactions](tooltip-interactions.md).

## Selected-Route Module Ownership

Keep source/authentication, navigation, error handling, and layout in a stable
shell; acquire only the selected page and its dependencies. Loading and error
boundaries preserve page geometry, URL, visible header/composer, and retained
session DOM. Each module generation has one shared acquisition promise.

Initial route acquisitions start together. Settings search explicitly loads
otherwise inactive panes progressively without hiding existing results or
blocking input. Detailed startup, search, and deployment requirements live in
[client asset delivery](client-asset-delivery.md#selected-route-module-ownership).

## Surface Contracts

Detailed control behavior belongs with its owning surface. Extend that owner
when changing a control rather than appending a feature specification here.

- [Session UI](session-ui-customization.md#session-header-space): header sizing,
  responsive controls, rename, sidebar modes, and session-row menu visibility.
- [Settings panes](settings-ui-placement.md#settings-pane-conventions): apply,
  Save, and pane-level undo semantics.
- [Shared UI controls](shared-ui-controls.md): toast lifetimes, dropdown
  placement, and fatal client diagnostics.
- [Reload notices](client-asset-delivery.md#global-reload-notice-placement):
  shared placement, dismissal, and action lifetime.
