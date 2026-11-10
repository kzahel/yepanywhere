# Commit Browser's re-click test races the initial hunk measurement

Plan 191 step 1 verification exposed an intermittent failure in unchanged
`packages/client/src/pages/CommitBrowser.test.tsx:1802`, “re-clicks the selected
file to advance to the next diff hunk”. One full `pnpm test` passed; a second
expected the second `.line-hunk` at line 1847 but observed the first. An immediate
isolated file run passed all 38 cases in 2.11 seconds. No timeout expired.

The fixture waits for two hunk elements but supplies no layout rectangles.
`GitStatusDiffPreview.tsx` schedules `updateHunkPosition` on an animation frame;
with jsdom's zero rectangles it selects the last hunk (both are above the
threshold). A click before that measurement advances from the default first
hunk to the second; a click after it wraps from the second to the first. The
DOM-count readiness check does not establish the current navigation position.

Give this retained navigation case representative hunk/scroll-root geometry and
join its initial measurement before re-clicking, preserving the assertion that
it advances to the second hunk. Do not add a sleep, widen a timeout, or weaken
the selected-hunk assertion. This needs its own fixture repair rather than a
change to CSS dead-code detection; no production navigation code was changed.

Evidence (local, ignored):
`.artifacts/design-tour/191-comparison/logs/{workspace-pass,workspace-hunk-failure,commit-browser-focused}.log`.

The subsequent full rerun passed all 7,333 client tests (136.18 seconds) and
7,256 server tests (150.92 seconds), without changing this test or navigation
implementation. The race remains open; a passing schedule does not remove it.

Found 2026-11-10 while implementing CSS ownership plan 191 step 1.
