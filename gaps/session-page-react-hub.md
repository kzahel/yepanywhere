# The session page and its message boxes are giant React hubs

The session page and the components it composes are each one huge React
function holding hundreds of hooks. Each change is slow to review and easy to
regress, including the keystroke-latency contract. Moving one small feature
out at a time, as doc 058 Phase 2 has done, takes out only a few hundred lines
per slice and leaves the structure as it was.

Measured 2026-11-07 at `097d8298d` (`packages/client/src`):

| File | Lines | useState | Effects (incl. layout) | useCallback | useRef |
|---|---|---|---|---|---|
| `pages/SessionPage.tsx` | 7,655 | 40 | 33 | 97 | 35 |
| `components/NewSessionForm.tsx` | 5,975 | 40 | 22 | 39 | 41 |
| `components/MessageList.tsx` | 5,710 | 19 | 51 | 55 | 61 |
| `components/MessageInput.tsx` | 4,543 | 20 | 14 | 57 | 30 |
| `components/MessageInputToolbar.tsx` | 3,804 | 8 | 7 | 9 | 12 |

`SessionPageContent` alone is about 7,000 lines and roughly 280 hook calls.

## What makes it worse than size

- **The message boxes were copies.** Fixed by proposal 1 (plan 178,
  2026-11-07): the new-session and in-session boxes now share one
  dictation core, key and paste helpers, the speech field and the per-file
  attachment prepare step, and the floating composer shares the dictation
  core, the Escape pair and the speech field. `MessageInput.tsx` went
  from 4,543 to 4,023 lines, `NewSessionForm.tsx` from 5,975 to 5,535 and
  `FloatingActionButton.tsx` from 739 to 433. The differences found between
  the copies are kept as they were and listed in plan 178 as questions for
  the maintainer. Attachment state stays separate: the session page, not the
  in-session box, owns its uploads.
- **Sending a message is about 1,100 lines of the session page.**
  `handleSend` (about 390 lines), `handleQueue` (about 220),
  `queueComposerForProject` (about 380) and `prepareComposerSubmission`
  (about 130) mix decisions (what text, which settings, which route) with
  side effects, so none of the decisions can be tested without rendering the
  page.
- **Starting a new session is one 572-line callback.** `handleStartSession`
  in `NewSessionForm.tsx`, beside about 600 lines of option pickers (provider,
  model, effort, recap, suggestions, permissions, sandbox) whose state is most
  of the form's 40 `useState` calls.
- **The toolbar's view is one 1,783-line function**
  (`MessageInputToolbarView`), mostly layout.
- **The message list's scroll machinery** (61 refs, 21 layout effects) is
  interleaved with row rendering; doc 058 slice 2.5 marks it high risk.

## Burn-down plan

In order. Proposals 1 to 3 change code shape (consolidation or plain-function
extraction), which the move-only slice contract does not allow. Each needs a
short plan before code, like the session-launch service (plan 177). Under the
maintainer's rule, a difference found between copies that is harmless gets
its own commit with a test, and one a user could see is asked about. Proposals
4 to 6 are ordinary move-only slices recorded in doc 058 Phase 2.

1. **One shared message-box core.** Done 2026-11-07 in
   [plan 178](../docs/tactical/178-shared-composer-dictation.md), which lists
   every difference between the copies and how each is handled.
2. **Sending as plain functions plus a thin hook.** The send, queue and
   project-queue decisions become functions that take inputs and return what
   to do, testable without React. A small hook performs the requests, toasts,
   draft updates and traces in today's order. Planned in
   [plan 179](../docs/tactical/179-session-composer-send-decisions.md).
3. **New-session options and start split.** One hook owns the option state,
   using one reducer where state changes together, plus an options panel
   component; starting and queueing take the plain-function shape of
   proposal 2.
4. **Remaining session-page feature hooks** (move-only): fork, handoff and
   clone (about 450 lines), queued-message actions (about 200), attachment
   upload (about 250), title editing (about 130), then the navigation-action
   consumption and recall wiring named in doc 058's seam inventory.
5. **Message list.** Move the row components and icons defined inside the
   file to their own files (trivial), then, last and with a manual browser
   pass, the scroll machinery (slice 2.5).
6. **Toolbar view sections.** Split `MessageInputToolbarView` into a
   component per toolbar region.

Ownership and slice rows: [doc 058](../docs/tactical/058-typescript-module-boundary-refactor.md),
priority-queue item 2. The broader hub-growth record is
[oversized hub modules](sketches/oversized-hub-modules.md). Delete this entry
when the five files no longer hold unrelated features in one function. Before
that, narrow it as proposals land.

Found 2026-11-07 while landing doc 058 slices 2.13 to 2.15 and surveying what
remained.
