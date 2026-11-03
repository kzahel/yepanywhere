# React State Patterns

> Rendering and synchronization must settle when their meaningful inputs stop
> changing. Recreating JSX, objects, or callbacks must not sustain a cycle of
> store writes, notifications, and renders.

Topic: react-state-patterns

Read this before changing React state ownership, effects that publish state,
external-store snapshots, or subscriptions. These are development requirements
for affected code, not a claim that every existing component has been audited.
[UI architecture](ui-architecture.md) owns shared rendering boundaries;
feature topics retain their observable interaction and lifetime contracts.

## Choose One Owner For Each Fact

Keep shared facts in their owning store and consumer-specific presentation
state in the component that owns that presentation. Derive values from current
props or snapshots during rendering when possible. Copying a prop into local
state and echoing it back through an effect creates two competing owners.

Handle user commands in the event that caused them. An effect is appropriate
for synchronizing an external resource, such as a subscription or browser API;
name that resource and the values that require resynchronization. An effect
that only tells another React component what this render already knows is a
reason to reconsider ownership. See React's
[guidance on unnecessary effects](https://react.dev/learn/you-might-not-need-an-effect).

Keep rendering and snapshot reads free of observable writes: no store
notifications, persistence, acquisition, or updates to another component.
Register and dispose external resources at the owning lifecycle boundary.
Setup, cleanup, and setup again must leave exactly the intended resources;
late asynchronous work must not publish into a departed owner.

## Make Publication Converge

Trace the whole dependency cycle when an effect publishes into a store:

```text
parent render -> fresh prop -> publishing effect -> store notification
      ^                                                |
      +---------------- subscription ------------------+
```

The shared write boundary must recognize equivalent updates by the fields
that define the operation. A repeated equivalent update preserves the snapshot
and sends no change notification. Do not make every caller responsible for
breaking the cycle with perfectly memoized arguments. Compare small data
descriptors explicitly; deep comparison of React elements and closures is not
a publication protocol. Keep command handlers separate from observable data
when their allocation does not itself represent a state change.

For cross-tab storage, receiving a value is not a new local edit. Reconciliation
must stop without another write when no meaningful value advances. New
timestamps, revisions, or observation IDs must not manufacture progress from
an unchanged value.

`useMemo` and `useCallback` can reduce work, but correctness must survive cache
recomputation and ordinary parent renders. Do not suppress effect dependencies
to hide a cycle. React documents memoization as an
[optimization rather than a semantic guarantee](https://react.dev/reference/react/useMemo#preventing-an-effect-from-firing-too-often).

When an external listener needs the latest callback without recreating its
resource, use a stable adapter that reads the latest committed handler. Keep
actual resource identity in the effect dependencies. This technique must not
hide changes to data the UI displays or freeze props that are meant to stay
live. Follow React's
[effect dependency and cleanup rules](https://react.dev/reference/react/useEffect).

## Keep Snapshots Stable And Subscriptions Narrow

An external store's `getSnapshot` returns the same immutable value until the
selected data changes. Cache object snapshots; allocating a new wrapper or
parsing storage on every snapshot read can make an unchanged store appear
permanently changed. Snapshot reads must not touch an observable LRU, reclaim
entries with notifications, or start a fetch. Follow the
[useSyncExternalStore contract](https://react.dev/reference/react/useSyncExternalStore).

Subscribe at the component that renders the changing information. A page that
needs only viewer placement should read placement, rather than every content
update. A selector returning an object needs stable identity or explicit
equality too; moving object allocation into a selector does not solve it.
Side-effect-only observers can subscribe directly with lifecycle cleanup
instead of rerendering a page to run another effect.

Existing worked examples:

- [Local preferences](../packages/client/src/lib/localStorageValue.ts) cache
  snapshots and notify only when the effective primitive value changes.
- [Session App indicators](../packages/client/src/lib/sessionApps.ts) select a
  boolean for rows that only need to know whether an App exists.
- [Session view publication](../packages/client/src/hooks/useSessionViewPublication.ts)
  observes the viewer directly and deduplicates reports without subscribing
  the session page to those reporting changes.

Shared request acquisition and revalidation still follow
[client global store ownership](client-global-store.md#retained-query-invariants).
Token and replay bursts follow
[stream dispatch coalescing](client-stream-dispatch-coalescing.md) and
[rendering performance](../packages/client/RENDERING_PERFORMANCE.md). A finite
burst of real updates and a self-sustaining feedback cycle need different fixes;
adding a debounce does not make a feedback cycle correct.

## Apply This To Managed Viewers

Viewer publication is particularly sensitive because the source component can
be underneath a parent subscribed to that same controller. Passing freshly
allocated `children`, `actions`, or render callbacks through an effect into a
widely observed controller closes the cycle above. The viewer's existing
[controller ownership contract](parked-file-viewer.md#controller-ownership)
requires publication on meaningful viewer changes.

For new or redesigned APIs, prefer a data descriptor identifying the content
and lifecycle, with the host rendering from that descriptor. For example, an
open command could carry `{ kind: "provider-children", projectId, sessionId }`;
the mounted viewer reads current child data through its own subscriptions.
Arbitrary React content can instead remain declarative in a stable portal
slot while the controller carries lifecycle metadata. These are design
options, not an already selected migration of the current viewer API.

Retain selection, loaded content, and mounted state for the lifetime required
by the feature contract. Freezing the initial JSX is appropriate only for an
intentional snapshot. Exit-animation retention should capture the last
committed view for the closing transition rather than mirror every newly
allocated content prop through another state update. Parking, closing,
switching session, and changing placement each need explicit semantics.

## Review And Regression Evidence

For an affected publication path, establish both convergence and freshness:

- Include the real subscribing parent or an equivalent dependency cycle;
  rendering the publisher and host alone can miss the defect.
- Rerender with freshly allocated but equivalent objects, JSX, and callbacks.
  After input settles, verify writes and notifications stop and the UI remains
  usable. Do not require a particular React render count.
- Change meaningful data and the handler, then verify fresh content and the
  current action still work. An implementation that stops updating is not a fix.
- Exercise the relevant cleanup and retained-view transitions. Use two tabs
  for cross-tab reconciliation; use real sequential typing under concurrent
  updates when the path can affect an input.

Choose the smallest meaningful boundary under
[E2E testing](e2e-testing.md) and
[test value and CI cost](../docs/development/testing.md#test-value-and-ci-cost).
Join asynchronous publication and cleanup in the test; unexpected React
warnings are failures to diagnose, not noise to suppress. See
[code quality](../docs/development/code-quality.md#zero-warning-commits).
