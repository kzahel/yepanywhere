# Shared composer dictation

Topic: mic-button-speech-ui

Status: done 2026-11-07. Slices 0 (the test pins), 1 (speech state),
2 (speech handlers), 3 (keys, paste and speech field), 4 (attachment
upload) and 5 (the floating composer) landed 2026-11-07. At the
maintainer's request the floating composer was then removed (2026-11-07),
so slice 5 and the F rows describe code that no longer exists. Proposal 1
of the [session page React hub gap](../../gaps/session-page-react-hub.md),
owned by [doc 058](058-typescript-module-boundary-refactor.md)
priority-queue item 2.

The new-session box (`NewSessionForm.tsx`) and the in-session box
(`MessageInput.tsx`) each hold their own copy of the dictation code: 14 and
15 speech state declarations and a dozen handlers that track where dictated
text lands, commit recognizer results, and react to the voice button's
pending states. Most of the copies match line for line apart from names. The
in-session copy has since grown a detached-delivery path and failure
handling the new-session copy lacks. The per-file attachment upload step is
copied the same way. This plan gives both boxes one implementation of each.

This is not a move-only refactor. Each slice replaces copies with one
implementation, so it sits outside the
[module-boundary contract](../../topics/typescript-module-boundary-refactor.md)'s
move-only rule and follows these rules instead:

- Each slice keeps both boxes' current behavior and lands on its own, with
  its own budget ratchet and doc 058 row.
- Where the copies differ, the slice keeps the difference as a named option
  when it is deliberate, removes it in its own commit with a test when it is
  harmless, and keeps it while asking the maintainer when a user could see
  it or its intent is unclear. The table below lists every difference found
  and its handling.
- Effects stay in each box at their current position (a hook's effects run
  where the hook is called, which would reorder them against the box's other
  layout effects). The hook returns the function the effect calls.
- Callback identity does not change. `VoiceInputButton` re-runs its
  follow-up-listening effect when `onListeningStart` changes
  (`VoiceInputButton.tsx` around line 560) and rebuilds its result handler
  and imperative handle from the other callbacks, and `MessageInput`'s
  `draftControls` (which fires `onDraftControlsReady`) depends on the edit
  bookkeeping through `replaceDraftRangeUndoably`. So hook options are
  destructured, every option a box passes is a stable `useCallback` (the
  session vocabulary's `heard` method is wrapped, since it uses `this`),
  each moved callback keeps exactly today's dependency set, and functions
  that use only refs have empty dependencies.
- Lint cannot see that a custom hook's refs, setters and ref-only callbacks
  are stable, so `biome.json` lists them as the hook's stable results rather
  than adding them to every dependency list. Lint then also drops them from
  existing dependency lists, so a declared result that stopped being stable
  would leave stale closures rather than churn. Only refs, state setters and
  callbacks that read nothing but refs are declared.
- No new prop, setting or copy. No change to `VoiceInputButton`,
  `lib/speechDraftTransaction.ts` (`commitSpeechTranscript`) or the speech
  topics' contracts ([mic button](../../topics/mic-button-speech-ui.md),
  [streaming capture](../../topics/streaming-speech-capture.md)).

## What is copied

Measured at `277e2cec3`. Line counts are new-session / in-session.

| Piece | Lines | Differences |
| --- | --- | --- |
| Speech state (insertion ranges, active target, retarget, pending final, edited flag, pending selection, interim text, pending kind, preview revision, transaction-has-text, turn id) | 14 / 15 declarations, each in two runs | the in-session box adds transcription ids (D5) |
| `PendingSpeechFinal` type, `createClientSpeechTurnId`, `createSpeechTargetId` | copied | identical; the helpers are already exported from `lib/speechTargets.ts` |
| Textarea `onChange` speech-range remap and edited flag | ~30 / ~30 | names only |
| Pending-selection restore layout effect | 13 / 13 | names only |
| Interim preview calculation (`interimDisplayTranscript`, `interimInsertion`) | 21 / 21 | names only |
| Interim preview markup and status line | ~25 / ~25 | compared in slice 3 |
| `handleListeningStart`, `handleListeningStop` | 27+14 / 30+14 | names and line wrapping only |
| `clearPendingSpeechFinal` and its unmount effect | 6 / 6 | none |
| `handleSpeechSelectionTarget` | 63 / 62 | D1 |
| `clearSpeechSelectionTarget` | 15 / 15 | none |
| `commitVoiceTranscript` | 63 / 104 | D2, D5, smart-turn callback (D7) |
| `handleVoiceTranscript` | 28 / 37 | D2, D6 |
| `flushPendingSpeechFinal`, `handleInterimTranscript` | 7+4 / 7+4 | none |
| `handlePendingSpeechChange` | 36 / 37 | D3 |
| `handleCancelTranscription` | 16 / 15 | D3 |
| `handleTranscriptionSettled` | — / 34 | D4 |
| Escape cancels transcription / stops listening (key handler) | 30 / 30 | the pair matches; the guards ahead of it differ (D11) |
| Desktop Enter-sends rule and mobile newline (key handler) | ~15 / ~15 | the order of the shortcuts ahead of it differs (D8) |
| Voice shortcut in `handleComposerKeyDown` | 9 / 39 | in-session adds the floating new-session options keys (box-specific, stays) |
| Clipboard file extraction in `handlePaste` | 19 / 23 | the attach guard sits inside `handlePaste` in-session and at the call site in new-session; where the files go (both box-specific, stay) |
| Per-file prepare and staged upload | 3 copies in the new-session box (`addPendingFiles`, `resolvePendingAttachmentsForSession`, the start path) / `uploadComposerAttachmentFile` in `lib/sessionComposerSubmission.ts`, used by the session page and the Project Queue attachment editor | A1 to A4; landed in slice 4 |

`pendingTextareaSelectionRef` is not speech-only: the new-session box's
launch seed and prefill also write it. The shared hook only holds it.

Out of this plan:

- **Attachment state.** Pending files, progress and draft persistence differ:
  the new-session box owns them, while the in-session box hands files to
  `onAttach` and the session page owns them. Only the per-file upload step is
  shared (slice 4).
- **Delivery during capture** (`deferSpeechDelivery`,
  `runPendingSpeechDelivery`) and the box-specific send callbacks belong to
  sending; proposal 2 and the new-session start split (proposal 3) take
  them. This plan only routes the shared handlers through them.
- `getTranscriptionContext` (D9) and `attachComposerTextarea`
  (new-session preboot handoff) stay in each box.

## Differences and their handling

| # | Difference | Handling |
| --- | --- | --- |
| D1 | `handleSpeechSelectionTarget` takes an event in the new-session box (`event !== undefined` means a manual interaction; `onPointerUp` and `onKeyUp` pass their events) and a boolean in the in-session box. | Harmless: both mean "the user moved the caret". The shared hook takes the boolean, and the new-session `onPointerUp`/`onKeyUp` pass `true` through a stable wrapper, so the same calls stay manual. The pin commit below adds a new-session unit test that pins it with `pointerUp`. A key-up that moves the caret also fires React's `onSelect`, which is automatic in the new-session box (D10), so a keyed caret move there is covered by D10, not D1. |
| D2 | A delivery press during capture detaches the draft and speech target in the in-session box: later recognizer results revise the detached draft, which is sent with the final wording, and the live field clears for the next turn. The new-session box keeps the draft live and sends the text visible at the press, without the final wording (`NewSessionForm.test.tsx` "starts with the visible interim snapshot…" and the two cases after it pin this). | Unclear: [mic button](../../topics/mic-button-speech-ui.md) says final results revise the detached draft in "the active-session, new-session, and floating composers"; only the field clearing is limited to the active-session box. Kept as is and asked the maintainer. The shared hook takes an optional `getDetachedSpeechTransaction()`, supplied only by the in-session box. It returns the detached delivery (its ranges, active id, selection and retarget refs, its `draft` field and its `composition.speechTranscriptionIds`, which the hook updates in place) or null. The hook keeps the in-session box's three checks of whether a result belongs to it verbatim: in `commitVoiceTranscript`, by target id in the detached ranges, else a non-null detached active id; in `handleVoiceTranscript`, by target id in the detached ranges, else the detached range ref; in `handleTranscriptionSettled`, by target id in the detached ranges. A result committed to the detached transaction skips the edit note, Smart Turn and the edited-during-speech check, as today. |
| D3 | A failed or cancelled cycle restores the detached draft (in-session) or drops the pending delivery (new-session, whose draft never left the field). | Follows D2. Option `abandonPendingDelivery()`; each box keeps its current body. |
| D4 | Only the in-session box handles a failed batch transcription (`onTranscriptionSettled`): it forgets the failed target's range, refreshes the preview, and clears pending state when the failed target was active or detached. The new-session box does not pass the callback, so a failed overlapping target's range stays in its map. | Unclear whether a user can see it (a stale range can move a later result). Kept: the hook returns the handler and only the in-session box wires it. Asked the maintainer; wiring it would be its own commit with a test. |
| D5 | The in-session box records transcription ids and edit timing (`onTranscriptionId`, `onEdit`) for its message's speech metadata. The new-session box records neither, and its start request carries no speech metadata. | Kept, with options `onTranscriptionId` and `onEdit` for the live draft (the detached transaction records its own, D2). Asked the maintainer whether new sessions should carry speech metadata; that would be new behavior outside this plan. |
| D6 | The in-session box feeds heard text to the session's speech vocabulary. | Deliberate: a new session has no vocabulary yet. Option `onHeard`. |
| D7 | Smart Turn's spoken "send": the in-session callback checks that the draft has content and the box is enabled, reports whether its action accepted, then arms follow-up listening. The new-session callback (written inline today) arms follow-up listening first and does not report acceptance; it declines only while a background or project-queue delivery owns the draft. | Outside the shared code: each box passes its own `onSmartTurnSend`; the new-session one becomes a `useCallback` over `handleStartSession`. Asked the maintainer, because [mic button](../../topics/mic-button-speech-ui.md) says a rejected Smart Turn send "does not arm follow-up listening". |
| D8 | Enter while listening. In the new-session box, Cmd+Enter's background start runs before anything else, then "listening, so start" runs before the project-queue Ctrl+Enter, so Ctrl+Enter while listening starts the session. In the in-session box, Ctrl+Alt+Enter's fork shortcut stops dictation first, and the Ctrl+Enter actions that exist (fork without summary, the project-queue shortcut, or queue when `onQueue` or a queue primary action is present) run before "listening, so send"; with none of them, Ctrl+Enter while listening sends. | User-visible. Kept: slice 3 shares only the Escape pair and the Enter-sends rule, and each box keeps its order. Asked the maintainer which order is intended. |
| D9 | Transcription context: the in-session box adds the session id and vocabulary terms and keys its draft by session. | Deliberate; stays in each box. |
| D10 | The textarea's `select` event counts as a manual caret move in the in-session box (`onSelect` calls `handleTextareaSelectionTarget`, which passes `true`) and as an automatic one in the new-session box (`onSelect` calls `handleSpeechSelectionTarget()`). A click mid-interim fires `select`, so in the new-session box the fragment still being recognized moves to the new caret at once, while in the in-session box it stays at its first target and only the next fragment moves. The new browser check shows this at `277e2cec3`. | User-visible. Outside the shared code: each box keeps its event wiring, and the browser check pins each box's result. Asked the maintainer; [mic button](../../topics/mic-button-speech-ui.md) describes the in-session behavior. |
| D11 | Held Escape. The in-session box ignores repeated Escape key-downs first, and its bang and slash menus take Escape before the speech pair. The new-session box has no repeat guard, so holding Escape stops listening on the first key-down and a repeat that arrives once the state is "finalizing" cancels the transcription and drops its result. | User-visible. Kept: slice 3 shares only the pair, and each box keeps its guards ahead of it. Asked the maintainer. |

### Attachment upload differences (slice 4)

| # | Difference | Handling |
| --- | --- | --- |
| A1 | Progress: the session page's helper always passes a progress wrapper that calls its caller's callback when there is one; the new-session staging and its post-create upload report into the box's progress state; the new-session start path's staging passes none. | Deliberate per site. `prepareComposerAttachmentUpload` takes an optional progress callback and adds it to the options only when given; each site passes what it passed before. |
| A2 | Preview URLs: the page's helper makes one from the prepared (resized) image and revokes it if the upload fails; the new-session box makes one from the original file when the file is added and stores previews itself. | Not part of the shared step; each site keeps its own. |
| A3 | Staged or direct upload, and the batch id. | Per site; each keeps its own call. |
| A4 | The image profile: the helper's callers (the session page and the Project Queue attachment editor) pass one; the new-session box derives it from attachment quality, provider and model. | Passed in. |

### Floating composer differences (slice 5)

Measured against the new-session box's copy.

| # | Difference | Handling |
| --- | --- | --- |
| F1 | Delivery during capture: the floating composer keeps the visible draft text as its pending delivery and submits it from its own pending-state handler when the cycle ends `completed`; any other end drops it. It has no settled flag, no speech-prefix attribution and no deferred delivery run. | Deliberate (it hands the draft to the New Session page as a prefill). It keeps its own `handlePendingSpeechChange` and passes the shared hook a private settled flag and no-op attribution and delivery-run callbacks, so the hook's writes to them do nothing. |
| F2 | Smart Turn's spoken "send" calls its `handleSubmit` directly: no acceptance check and no follow-up listening (the composer navigates away). | Outside the shared code: it passes `handleSubmit` as `onSmartTurnSend`, as before. Same question as D7. |
| F3 | Cancel leaves `speechPendingRef` as it was and drops the pending delivery after clearing the ranges, where the boxes reset the ref and drop the delivery first. | Kept: it keeps its own `handleCancelTranscription`. Unclear whether anyone can see it; asked with D11. |
| F4 | Its `onSelect`, `onPointerUp` and `onKeyUp` pass their events, so all three are manual caret moves, as in the in-session box (compare D10). | Kept: all three pass `true` through a stable wrapper. |
| F5 | Enter without Shift sends on every device, Ctrl+Enter included, and a plain Escape that the speech pair does not take collapses the panel. | Its own; only the Escape pair is shared. |
| F6 | No failed-transcription handler, as in the new-session box (D4). | Kept. |
| F7 | No voice keyboard shortcut (`handleVoiceInputShortcutKeyDown`), which both boxes have. | Outside the shared code; kept. Asked the maintainer. |
| F8 | Its transcription context sends no project id and no client turn id; the new-session box sends both. | Outside the shared code, like D9; kept. Asked the maintainer. |

## Slices

Each slice is one commit with its doc 058 row, budget ratchet and a status
line here.

0. **Pins.** One test-only commit before slice 1 adds the unit checks below
   that the slices rely on. Test-only, so no budget change and no doc 058 row
   of its own: it gets a status line here, and slice 1's row names it as its
   prerequisite.
1. **Speech state and edit bookkeeping.** New
   `hooks/useComposerSpeechState.ts` owns the speech state, the
   `PendingSpeechFinal` type, `clearPendingSpeechFinal`, the textarea-edit
   remap (`noteSpeechDraftEdit(previous, next)`: drop a held final, map every
   range through the edit, note a manual edit), the in-session
   completion-replacement remap, `restorePendingTextareaSelection(text,
   textarea)`, and a pure interim preview helper both boxes call during
   render. Each box calls the hook at its first run of speech declarations,
   so the second run moves up; the textarea is passed in where needed. Each
   box keeps its layout effect and unmount effect, which call the returned
   functions. The new-session box imports the id helpers from
   `lib/speechTargets.ts`. The browser check below lands here.
2. **Speech handlers.** New `hooks/useComposerSpeechHandlers.ts` owns listening start and stop,
   the selection target and its clear, commit, transcript and interim
   handlers, the pending-final flush, the pending-state handler, the
   settlement handler and cancel. It takes the state from slice 1,
   `getDraft`/`setDraft`, the textarea and voice-button refs,
   `onSmartTurnSend`, `noteSpeechAttribution`,
   `maybeRunPendingSpeechDelivery`, the box's pending-delivery ref and
   settled flag (which the hook checks and clears but never fills),
   `abandonPendingDelivery`, and the optional
   `getDetachedSpeechTransaction`, `onTranscriptionId`, `onEdit` and
   `onHeard`. Each box calls it where its handlers start today. In the
   in-session box `handleSmartTurnSend` moves above the call; in the
   new-session box the inline Smart Turn callback becomes a `useCallback`.
3. **Composer key, paste and preview pieces.** A small `lib/composerKeys.ts`
   with the Escape pair (cancel a pending transcription, else stop
   listening), the desktop Enter-sends rule, the voice shortcut and
   clipboard file extraction. Each box keeps its key order and guards (D8,
   D11) and where pasted files go. The interim preview markup and status
   line become one component; they match. The voice shortcut already
   shares `handleVoiceInputShortcutKeyDown`, leaving a two-line callback in
   each box, so it stays.
4. **Per-file attachment upload.** One function prepares an image and
   builds the upload options (its dimensions, plus a progress callback
   where given), for `uploadComposerAttachmentFile` and the new-session
   box's three copies. Each site keeps its own staged or direct upload call
   (A3), pending state, progress, preview storage and toasts. The slice
   starts by adding each site's differences to this table under the same
   rule.
5. **Floating composer.** `FloatingActionButton.tsx` holds a third copy of
   the speech state and handlers (listening start and stop, the selection
   target and its clear, commit, transcript, flush, interim, pending-state
   change and cancel), the Escape pair and the speech draft field markup.
   The slice 3 review found it; this plan missed it. The slice starts by
   adding the floating composer's differences to this table under the same
   rule, then has it call `useComposerSpeechState`,
   `useComposerSpeechHandlers`, `handleSpeechEscapeKey` and
   `SpeechDraftField`, with the same keystroke check run in it.

## Checks

- **Unit.** `MessageInput.test.tsx` drives in-session dictation (caret moves,
  finals, cancel, failure, detached delivery). `NewSessionForm.test.tsx`
  covers new-session finals, the visible-snapshot delivery and Escape-cancel,
  but not a caret move or a failed cycle. The pin commit (slice 0) adds:
  - With interim text showing, a `setSelectionRange` and `pointerUp` (which,
    unlike `keyUp`, does not also fire `onSelect`) followed by a final, which
    stays at its first target while the next final follows the caret. It
    fails when the wrapper passes nothing.
  - A press during capture followed by
    `onPendingSpeechChange(null, "failed")`, which starts nothing and keeps
    the draft.
  - In each box's test, a check that the `VoiceInputButton` callback props
    (six in the new-session box, seven in the in-session box) keep their
    identity across a typed character, as they do at `277e2cec3`. It fails
    when a callback gains a changing dependency. For it to measure the box
    rather than the test, the new-session test's draft-storage mock now reads
    the draft from a ref, as the real `useDraftPersistence` and the
    in-session test's mock do; its old value-based `getDraft` gave the
    controls a new identity on every keystroke. Every existing new-session
    test passes with the corrected mock.

  No hook-level unit tests: they would restate code the component tests
  exercise.
- **Browser keystroke check** (slice 1, rerun in slices 2, 3 and 5, which
  change code that runs on every keystroke), in `speech-caret-insertion.spec.ts`, for
  both boxes and, from slice 5, the floating composer. The draft is 120 lines
  (about 5,000 characters), and the fake browser recognizer commits 20 finals
  into the open target before the interim shows, since each keystroke maps
  every target's range and each of its chunks through the edit, and each
  mapping scans the draft. Typing at the start of the draft is the slow case,
  since every index then misses the common-prefix shortcut. The caret moves to
  the start, and the user types there one key at a time while the recognizer
  revises the interim every few keys and, in the in-session box, a transcript
  row arrives halfway. Timing follows [UI
  testing](../../topics/ui-testing.md): from each native keydown's timestamp
  to the value two animation frames later, recorded for every typed prefix,
  each under 100 ms. The final then lands where each composer puts it today
  (D10, F4). Browser recognition opens one target at a time; overlapping
  targets come only from server backends, which the browser suite does not
  drive, so the check covers one open target with many chunks over a large
  draft. The remap's cost grows with targets times chunks times draft length.
- **Focused browser specs per slice:** `speech-caret-insertion.spec.ts`,
  `composer-recall-drawer.spec.ts`, `bang-command.spec.ts`, and the
  new-session typing and queue cases in `session-creation-client.spec.ts`;
  slice 4 adds the attachment specs it touches.
- **Tier 2** and **Tier 3** per slice, as doc 058's Phase 2 rows record.
- Opus 5.5 review of this plan before code and of each slice after.

## Not in scope

- Aligning D2, D4, D5, D7, D8, D10, D11 or F2 to F8 before the maintainer
  answers.
- Delivery during capture, send and start callbacks (proposals 2 and 3).
- Attachment state, progress and persistence (see above).
- `VoiceInputButton`, recognizer backends, Smart Turn and speech settings.
