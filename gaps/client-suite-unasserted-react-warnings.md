# Allowlisted client fixtures still emit unasserted React diagnostics

The client unit suite now fails a test that emits an unasserted React or jsdom
diagnostic ([zero-warning commits](../docs/development/code-quality.md#zero-warning-commits)).
Seventeen files that already emitted are recorded in
`packages/client/test/unasserted-diagnostics.json`, which names each file's
diagnostic kind and emitting cases. Sixteen emit React's "not wrapped in
act(...)" warning, among them `MessageList.scroll.test.tsx`
(ParagraphQuoteRail publication), `IssuesPage.test.tsx`,
`useSessionRightPane.test.tsx` and the settings pages.
`RemoteConnection.recovery.test.tsx` emits "Cannot update a component
(`Probe`) while rendering a different component
(`ClientSummarySourceBinding`)".

These are independent component, query, store and timer fixture boundaries;
changing them together or wrapping a whole test in act could hide unresolved
asynchronous work. Audit each producer and join the intended update through
React's test boundary, with explicit assertions for any deliberately emitted
diagnostic. Do not suppress console output or change production behavior just
to silence passing fixtures. The suite fails until a fixed file's kind is
removed from the list; delete this gap with the last entry.

The jsdom `Not implemented: navigation (except hash changes)` diagnostics
were `SessionIssuesLink.test.tsx` and `FileViewer.path-breadcrumbs.test.tsx`
clicking real links: jsdom queues the navigation on a zero-delay timer, so it
reported during the next test, and its default virtual console writes to the
worker's original console, so Vitest never attributed it to a test. Both
fixtures now cancel the navigation after the component's handlers and assert
whether it would have been followed.

Measured 2026-11-16: four full client runs emitted identically per file and
case, and gated runs at 3 and 12 workers found every listed file still
emitting.

Found 2026-09-30 while verifying the CI reliability repairs remotely; reduced
2026-11-16 when the gate landed.
