# Passing client suite still emits unasserted React act warnings

[CI 36712930735](https://github.com/kzahel/yepanywhere/actions/runs/36712930735)
passes all 6,536 client tests but emits React's “not wrapped in act(...)”
diagnostic in these fixtures:

- `MessageList.scroll.test.tsx`: parked scroll events before tail reveal.
- `MessageList.rendering.test.tsx`: image-gallery loading and swipe cases.
- `GlobalSessionsPage.test.tsx`: collection-query and filter fixtures.
- `UsersSettings.test.tsx`: expanding granted projects.
- `AppearanceSettings.test.tsx`: preference updates and live specimens.
- `LocalAccessSettings.test.tsx`: enabling session API access.
- `useSessionRightPane.test.tsx`: history, activation and persistence updates.
- `IssuesPage.test.tsx`: asynchronous mention loading and refresh.
- `TemplateProjectForm.test.tsx`: progress before creation completes.
- `FileViewerEmbeddedMedia.test.tsx`: PDF loading and fallback.
- `SessionViewerToolbarController.test.tsx`: close-action updates.

These are independent component, query, store and timer fixture boundaries;
changing them together or wrapping a whole test in act could hide unresolved
asynchronous work. Audit each producer and join the intended update through
React's test boundary, with explicit assertions for any deliberately emitted
diagnostic. Do not suppress console output or change production behavior just
to silence passing fixtures. The touched native-module test's separate Vite
dynamic-import warning is repaired with explicit entry paths.

Found 2026-09-30 while verifying the CI reliability repairs remotely.

The November 6 CI repair's complete client run passed 7,119 tests but also
emitted two unattributed jsdom `Not implemented: navigation (except hash
changes)` diagnostics from `HTMLHyperlinkElementUtils-impl.js`. The workspace's
summary reporter did not identify their fixture; changing or suppressing its
global navigation handling without that attribution could hide a real link
regression. Retained diagnostics: `tasks/ci-recovery-2026-11-06/unit.log`.
The focused creation/router browser checks are separate from those jsdom
fixtures.

Reconfirmed in [CI 36970258142](https://github.com/kzahel/yepanywhere/actions/runs/36970258142)
on 2026-10-02: `MessageList.scroll.test.tsx` emits "An update to
ParagraphQuoteRail inside a test was not wrapped in act(...)" in the held-press
and wheel pending-follow cases, remembered-anchor growth, and parked scroll
before tail reveal. This is separate from the repaired thinking-toggle frame
leak: the quote rail's asynchronous publication needs its own joined fixture
boundary. Changing those producers or globally wrapping/suppressing their
callbacks is outside the bounded scroll-restoration lifetime repair and could
hide the intent/scroll ordering those cases assert. Audit each publication and
join it explicitly; retain the scroll and held-selection assertions.
