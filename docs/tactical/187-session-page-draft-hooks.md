# Session page draft hooks

Topic: typescript-module-boundary-refactor

Status: done 2026-11-08 (slices 0 to 4); `SessionPage.tsx` went from
3,903 to 3,621 lines. Doc 058 rows 2.44 to 2.47.

The next step for [the session page hub gap](../../gaps/session-page-react-hub.md)
after [plan 182](182-session-page-header-and-footer.md), taking two of the
three `SessionPage.tsx` follow-ups named in doc 058's open seam inventory:
the correction draft, and the composer attachment state with its draft
hydration. The third, the transcript region, is not part of this plan.

`SessionPageContent` in `packages/client/src/pages/SessionPage.tsx` (3,903
lines at `a13515c25`) keeps both features in pieces spread over 1,600
lines: the correction state at 1023, the attachment state at 1064 to 1226,
the correction actions at 1717 to 1767, the recall at 2155 and the
hydration at 2474 and 2591. Slices 1 to 3 move them, verbatim, into two
hook files. Slice 4 then makes the two ways of starting a correction one
step, the only behavior change in this plan.

## Contracts these moves carry

Slices 1 to 3 follow [plan 181](181-session-page-feature-hooks.md)'s
contracts. In short:

- **Bodies move verbatim.** A name the moved code reads from the page
  becomes a hook input of the same name. `t` and `showToast` come from
  `useI18n` and `useToastContext` inside the hook.
- **Dependency lists** in moved code gain only refs and state setters that
  were in scope in the page and are now inputs, which lint requires. They
  never change identity, so no callback or effect is rebuilt more often.
  Each landing note lists them.
- **Page code that stays** reads refs and setters the hooks now return
  (the session reset reads the batch and hydration refs, the submission's
  attachment collection reads `attachmentsRef` and `pendingUploadsRef`,
  and so on). Lint treats only the page's own `useRef` and `useState`
  results as stable, so each new hook that returns refs or state setters gets a
  `stableResult` entry in `biome.json` naming them, as
  `useComposerSpeechState` has. Those values are stable, so the page's
  dependency lists stay as they are.
- **Hook and effect order.** A block containing effects is called where
  its effects stood. A `useState`, `useRef`, `useMemo` or `useCallback`
  may move later; the slice says which, and that nothing in between reads
  it. Where an effect is split or moved, the slice says why no one can
  tell.
- **Checks.** A script compares each moved range with the hook file, with
  whitespace removed, and lists every difference; the only differences
  allowed are the dependency lists and the effect splits declared below.
  The TypeScript checker lists the free names of each range, so the hook
  inputs are exactly those names, with the page's own types.

## Slice 0: pins

New `packages/client/e2e/session-page-correction-attachment-paths.spec.ts`,
on the shared session page harness, passing at `a13515c25`:

1. A correction sets the draft and its staged image aside; a second Edit
   latest message keeps the first set-aside draft; Cancel correction brings
   back the text and the image, whose preview still loads (it was not
   revoked). The check loads the chip's object URL into a new image,
   which fails once the URL is revoked; the chip's own image could still
   draw it from the image cache, and a fetch of an object URL fails in
   these tests either way. With `revokeRemovedPreviewUrls: true` forced
   into `handleCorrectLatestUserMessage`, the case fails at that check.
2. A correction that is sent forgets the draft it set aside: a later Edit
   latest message and Cancel leave an empty composer.
3. An upload in flight asks before the page is left (`beforeunload`).
4. A staged attachment comes back after a reload. A failed check keeps
   the chip and says so. A file the server no longer holds is dropped
   quietly, and the saved draft in `localStorage` forgets it. The test
   server has no draft sync, so these are the local-draft rules; the
   draft-sync branch is not pinned (see Open).
5. A staged attachment added or removed in one tab follows in a sibling
   tab (the draft storage event).

Already pinned elsewhere and not repeated: the correction framing on send,
the refused unchanged correction and the commands that end correction mode
(`session-send-paths`), ↑ recalling a sent or queued message
(`queued-message-recall`, `session-page-queue-paths`), a failed upload,
removing a staged attachment and an incoming share
(`session-page-title-attachment-paths`), the edit blocker an attachment
raises on a queued message's Edit (`session-page-queue-paths`), file
drops (`attachment-drop`), and a delivered attachment send clearing
sibling drafts (`session-attachment-send-draft`).

## Slice 1: attachment state

New `packages/client/src/hooks/useSessionComposerAttachments.ts` exporting
`useSessionComposerAttachments`, called where the edit-blocker effect
stood, right after `attachmentQuality` (1086).

Moves:

- The attachment state and refs (1064 to 1069): `attachments`,
  `attachmentsRef`, `draftAttachmentBatchIdRef`,
  `draftAttachmentHydrationRef` and `uploadProgress`. They move later in
  the hook order, past the draft signal, the edit availability and
  transcript position stores and `attachmentQuality`; none of those reads
  them.
- The edit-blocker effect and `pendingUploadsRef` (1087 to 1100).
- The navigation guard (1137 to 1146), `writeDraftAttachmentState`,
  `setComposerAttachments`, the unmount-only preview cleanup,
  `ensureDraftAttachmentBatchId` and `materializeComposerAttachments`
  (1148 to 1226).

The two callbacks between them, `updateTranscriptDisplayObjectsForSession`
and `rememberSentSubmission`, stay in the page and now stand after the
hook call; they are `useCallback`s, so their place is not observable. The
moved effects keep their order relative to each other, and no page effect
stood between them.

Inputs: `composerEditAvailabilityStore`, `draftControlsRef`,
`preCorrectionDraftRef` (until slice 2), `projectId`, `sessionId` and
`sourceTransport`. Returns the five state values and refs, `setUploadProgress`,
`pendingUploadsRef`, `setComposerAttachments`,
`ensureDraftAttachmentBatchId` and `materializeComposerAttachments`;
`writeDraftAttachmentState` stays inside.

## Slice 2: correction draft

New `packages/client/src/hooks/useSessionCorrectionDraft.ts`, called
where `handleCancelCorrection` stood (1717), right after the page's
session-change reset effect.

Moves:

- `correctionDraft` and `preCorrectionDraftRef` (1023 to 1031). They move
  later, past everything from 1032 to 1716. The only readers there are the
  unmount cleanup in slice 1's hook and the session reset's
  `setCorrectionDraft(null)` (1705); both halves move here (below).
- `handleCancelCorrection`, the effect that drops the set-aside draft
  when a correction ends, the effect that cancels an untouched recalled
  correction when the page is parked, and
  `handleCorrectLatestUserMessage` (1717 to 1767).
- `handleRecallLastSubmission` (2155 to 2194). It moves earlier, past
  `useSessionQueuedMessageActions`; it is a `useCallback` and its inputs
  (`deferredMessages`, `lastComposerSubmissionRef`) are declared long
  before.

Two effects are split, each half verbatim:

- **The unmount cleanup** (1192 to 1199) revokes the composer's previews
  and then the set-aside draft's. The second call becomes its own
  unmount-only effect in this hook, so slice 1's hook drops its
  `preCorrectionDraftRef` input. React runs unmount cleanups in
  declaration order, so the composer's previews are still revoked first;
  both only revoke object URLs after the page is gone.
- **The session reset** (1703 to 1715) starts with
  `setCorrectionDraft(null)`. That line becomes this hook's reset effect,
  right after its unmount cleanup, keyed on `sessionId`; it runs right
  after the page's reset in the same commit. `SessionPageContent` is keyed
  by `sessionId` (343 to 346), so `sessionId` never changes within one
  instance and both effects run only on mount (and on StrictMode's
  development re-run), when the correction is already `null`. The original
  effect's other dependencies, `resetBtwAsides` and
  `setComposerAttachments`, are stable, so keying the new half on
  `sessionId` alone runs it exactly as often.

Inputs: `attachmentsRef`, `deferredMessages`, `draftControlsRef`,
`isDomLingerParked`, `lastComposerSubmissionRef`, `sessionId` and
`setComposerAttachments`. Returns `correctionDraft`, `setCorrectionDraft`
(the send module and the queued-message actions end a correction),
`handleCancelCorrection`, `handleCorrectLatestUserMessage` and
`handleRecallLastSubmission`.

## Slice 3: draft hydration

`useDraftAttachmentHydration`, added to slice 1's file because hydration
writes the same state, called where the two hydration effects stood
(2591).

Moves `hydrateDraftAttachments` (2474 to 2547, later in the hook order)
and the two effects that hydrate on a draft key change and on the draft
storage event (2591 to 2611, in place). `handleDraftControlsReady` (2571
to 2585) calls `hydrateDraftAttachments`, so it moves to just after the
hook call, past the mother-composer transfer effect (2587); it is a
`useCallback`, unchanged, so its place is not observable. The effects
keep their place after the session reset, which on mount clears the
attachments and bumps the hydration counter before hydration first reads
the draft. (`sessionDraftKey` can also change later without a remount,
when the client summary source key changes; then hydration runs with no
reset before it, as now.)

Inputs: `attachmentsRef`, `draftAttachmentBatchIdRef`,
`draftAttachmentHydrationRef`, `draftControlsRef`, `mainComposerForAside`,
`sessionDraftKey`, `setComposerAttachments`, `sourceTransport` and
`versionInfo`. Returns `hydrateDraftAttachments`.

## Slice 4: one way to start a correction

Not move-only. `handleCorrectLatestUserMessage` (Edit latest message) and
`handleRecallLastSubmission` (↑ in an empty composer, or Ctrl+P, which
recalls even over typed text and sets that text aside) each copy the same
four steps: set the draft aside if nothing is set aside yet, put the
message in the composer, clear the attachments, open the correction. The
copies differ in one place: recall clears the attachments with
`revokeRemovedPreviewUrls: true` and Edit latest without it. Neither is
right every time. On a first correction the attachments are set aside
and must keep their previews; on a second one, while a correction is open,
the set-aside draft is kept and the composer's attachments are discarded,
so their previews should be revoked.

Both call one `beginCorrection` step that revokes the discarded previews
only when it keeps an earlier set-aside draft. Effects:

- Edit latest message during an open correction now revokes the previews
  of the attachments it discards; they leaked until now.
- Recall is refused while the composer shows attachments or an upload is
  in flight (`recallLastSubmission` in `MessageInput.tsx`), so its revoke
  never had anything to revoke. Nothing changes for it.
- Edit latest message is not blocked by an upload in flight. That upload
  lands in the correction's composer, not the set-aside draft, so a second
  correction discards it and now revokes its preview too.

Pins: case 1 of slice 0 checks a first correction keeps the set-aside
preview alive. A new case, landing with this slice, attaches an image
during an open correction, runs Edit latest message again and checks,
with the same new-image load, that the discarded preview's object URL no
longer loads while the set-aside image's still does. It fails before this
slice, which is the leak it fixes.

## Tests per slice

Tier 2 (`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`)
and Tier 3 (the client E2E suite without the physical Android cases),
each in a fresh worktree from `origin/main`. Keystroke latency
(AGENTS.md): no typing path moves. The composer keeps its text in its own
state, and the page's values reach it with the same identities.

## Open

- On load the page checks the saved draft's attachments twice (once when
  the composer's draft controls are ready and once from the draft key
  effect), so a failed check shows its notice twice. Found while pinning;
  left as it is.
- The draft-sync branch of hydration (the chip shows before the check,
  and a short answer keeps it with "Draft attachments were no longer
  available.") is not pinned: the E2E server does not offer draft sync.
- The reload pin cannot tell which of the two hydration calls (when the
  draft controls are ready, and the draft key effect) restored the chip;
  either alone would. Slice 3 moves both verbatim, so the move check
  covers them.
- The parked-page cancel of an untouched recalled correction is not
  pinned; it needs a page parked by DOM linger.
- `NewSessionForm.tsx` has its own copy of draft attachment hydration.
  Whether one hydration step can serve both is a question for the
  new-session form's own plan.
