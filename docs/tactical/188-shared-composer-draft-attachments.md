# Shared composer draft attachments

Topic: typescript-module-boundary-refactor

Status: planned 2026-11-09.

Three screens keep their own copy of the same attachment machinery:

- **The session page** has it in `hooks/useSessionComposerAttachments.ts`
  (the list, the saved-draft write, the batch, the navigation guard, and
  `useDraftAttachmentHydration`) and `hooks/useSessionAttachmentUploads.ts`
  (uploads and remove). Both were moved verbatim out of `SessionPage.tsx`
  by plans 181 and 187.
- **New Session** has an inline near-copy in
  `components/NewSessionForm.tsx` (3,120 lines): lines 561 to 940 for
  the saved-draft write, the batch, hydration, the sibling-tab listener
  and uploads; 1539 to 1560 for remove; 1645 to 1719 for materializing;
  2170 to 2182 for the guard. It also has a `PendingFile` union in
  `lib/newSessionAttachments.ts` that `lib/newSessionStart.ts` builds on.
- **The Project Queue inline editor** has a third copy in
  `components/ProjectQueueAttachmentEditor.tsx` (386 lines), with no saved
  draft.

The copies drifted. The session page checks staged files twice on load
and can show the failure notice twice. New Session re-checks its staged
files whenever a sibling tab saves the draft, even when only the text
changed. The session page can split one draft over
two staging batches. Only some copies make file names unique, and only
some let an upload be cancelled.

This plan replaces the three copies with one hook,
`useComposerDraftAttachments` in
`packages/client/src/hooks/useComposerDraftAttachments.ts`. It owns:

- the attachment list and its ref;
- the in-flight uploads, with their progress and promises;
- the staging batch;
- writing the staged refs into the saved draft;
- hydration from the saved draft, including the sibling-tab event;
- uploading, cancelling an upload, and removing an attachment;
- revoking previews;
- the navigation guard.

Each screen keeps what is its own: when and how it sends, the chips it
renders, the incoming share, and the edit blocker. The text draft is
already shared through `useDraftPersistence` and is not part of this
plan. The gap this addresses is the duplication named in
[the session page hub gap](../../gaps/session-page-react-hub.md) and
doc 058's open seam inventory.

## One model

The hook keeps finished attachments, uploaded or staged, as
`ComposerAttachment[]`. In-flight uploads are kept apart, as
`UploadProgress[]`, with a map from upload id to its
`Promise<ComposerAttachment | null>`. This is the shape the session page
and the Project Queue editor already use. The session page's send path,
`collectComposerAttachmentsForSubmission`, the correction draft hook and
`MessageInput` all consume it.

New Session's three-kind `PendingFile` list (local, uploading, staged)
goes away:

- **Uploading** entries become in-flight uploads.
- **Staged** entries become `ComposerStagedAttachment`. Both are
  `StagedAttachmentRef` plus an optional `previewUrl`.
- **Local** entries come only from the audio memo. The other branch that
  makes them is dead, because `ensureDraftAttachmentBatchId` always
  returns an id. The memo now uploads when it is committed, as it does on
  the session page (below).

## Every difference, and the one behavior kept

The labels below are S (the session page), N (New Session) and Q (the
Project Queue editor).

1. **Shape of the list.** One list (N) or finished plus in-flight (S, Q).
   Kept: finished plus in-flight.
2. **Where a finished upload lands.** It replaces its uploading entry in
   place (N), or it is appended when it finishes (S, Q). Kept: appended.
   On N, chips with several uploads now appear in the order they finish.
3. **Preview while uploading.** N shows the picked file's preview on the
   uploading chip. S and Q show none until the upload finishes, and then
   use a preview made from the prepared file. Kept: no preview until
   done, made from the prepared file (`uploadComposerAttachmentFile`, as
   now). On N, an image chip shows its picture once it is uploaded rather
   than at once.
4. **Progress and the uploading chip.** S keeps `UploadProgress[]`
   (name and `percent`) and draws a plain progress chip. N keeps a record
   of uploaded and total bytes. Q keeps `percent` and treats a size of
   zero as 100. N and Q draw the uploading chip with `AttachmentChip`,
   using the file's type and a "Remove <name>" button. Kept:
   `UploadProgress[]` with Q's zero-size rule, plus `mimeType`, so N and
   Q keep drawing the same chip.
5. **Cancelling an upload.** N and Q let an uploading chip be removed. A
   later result is then deleted from staging and its preview revoked, and
   a later failure says nothing. S cannot cancel. N keeps the cancelled
   upload's promise, so a later legacy start waits for it, gets `null`
   and fails with `sessionDraftAttachmentsUnavailable`. Kept: the hook
   supports cancelling, and N and Q use it. A cancelled upload leaves
   `pendingUploadsRef` at once, so no send waits for it. A send cannot capture an upload
   and then see it cancelled by the user: N disables remove while
   starting, Q cannot save while uploading, and S has no cancel. Item 27's
   key-change cancel can, and is handled there. S's
   progress chips in `MessageInput` stay without a remove button
   (Open).
6. **An upload that finishes after the screen closed.** S and N write it
   into the saved draft, which outlives the screen. Its preview URL is
   made after the unmount revoke ran, so it leaks. Q deletes the file.
   Kept: with a saved draft, keep the ref there and revoke its preview;
   without one (Q), delete it.
7. **Unique names.** N and Q rename a file that has the same name as a
   shown or uploading attachment; S does not. Kept: always rename. N and
   Q then name the attachment after the picked file; S uses the prepared
   file's name, which marks a resized image (`hd-resized.png`), as
   `image-upload-quality.spec.ts` pins. Kept: the prepared file's name,
   which is the renamed picked name unless a resize marks it. (Tier 3
   caught the first choice, the picked name, against that spec.) Two
   images picked with the same name and both resized can still share a
   name, as on S before.
8. **Upload failure.** S shows `sessionUploadFailed` with the file name;
   N shows `newSessionUploadError` without it; Q shows an inline error.
   Kept: `sessionUploadFailed` on S and N; Q passes its own inline
   handler.
9. **Composer history.** S records the picked file with the session's
   project, name and title; N records the prepared file with the
   project's name; Q records nothing. Kept: the picked file, with the
   context each screen passes (Q passes none).
10. **Preview cache.** S caches the picked file; N caches the prepared
    file; Q caches nothing. Kept: cache every finished image upload, with
    the prepared file, which is what was sent.
11. **Staging.** All three always stage: S's `stagedBatchId` is never
    empty, N calls `uploadStagedAttachment` itself, and Q always passes
    its batch. The direct-upload branch of `uploadComposerAttachmentFile`
    is dead. Kept: one staged-only upload helper; the dead branch is
    deleted.
12. **The batch after the last staged file is removed.** S forgets the
    batch at once, and so does hydration on both screens when the checked
    refs come back empty. N's list write keeps the batch while an upload
    is in flight, so that upload and later ones share one batch. Q seeds
    the batch from its item and never forgets it. Kept: N's rule,
    everywhere the batch is forgotten, and the hook seeds the batch from
    the first staged ref in `initialAttachments`. Under S's rule the
    saved draft can hold refs from two batches while its `batchId` names
    only the first. An ordinary send still works, because validation and
    materializing group refs by batch. What breaks: queueing a new
    session from S refuses mixed batches (`sessionComposerSend.ts`, about
    line 1143), the navigation guard stays on, and Q refuses to save. Q
    must use its item's batch, because the server files added refs under
    the message's `batchId`.
13. **An update that changes nothing.** N skips the update when the
    updater returns the same list; S does not. Kept: skip.
14. **Hydration with no saved state.** S empties the whole list; N drops
    only staged chips. Kept: drop only staged chips. The saved draft
    describes only staged files, so it should not remove a
    session-uploaded file that a recalled correction brought back.
15. **Hydration replacing chips.** S replaces the whole list with the
    saved refs; N keeps the other entries and puts the saved refs after
    them. Kept: N's rule, as in item 14.
16. **The draft storage event.** S hydrates only when the saved refs
    differ from the shown staged refs. N hydrates on every event for its
    key, so a sibling tab's text-only save makes N check its staged files
    with the server again. Kept: S's filter.
17. **The busy guard without draft sync.** Without draft sync, N skips
    hydration entirely while it shows any staged or uploading file. Kept:
    no separate guard. Item 16's filter covers the case it protects:
    while an upload is in flight, an event that does not change the saved
    refs leaves them equal to the shown ones, so nothing is replaced.
    This is a behavior change on N without draft sync: like S, it now
    follows a sibling tab's staged-file changes while it shows staged
    files.
18. **When hydration reruns.** Both rerun whenever the callback's
    identity changes: `versionInfo`, `t`, `showToast` and
    `sourceTransport` on both; the draft controls on N; the aside flag on
    S. This is how S checks twice on load and can show the failure
    notice twice. Kept: hydrate when the draft controls become ready,
    when the draft key changes, when the rule of item 26 becomes known or
    changes, when hydration is turned on, and on the sibling-tab event.
    Everything else is read through refs.
19. **When hydration is off.** S skips it while the main composer is
    shown for an aside. Kept: an `enabled` input; N always passes true.
20. **The navigation guard.** S and N use `hasAttachmentNavigationRisk`
    (in-flight uploads, N's local files, staged refs that differ from the
    saved draft). Q warns on in-flight uploads, or on staged files it
    added. Kept: `hasAttachmentNavigationRisk` for all. Without a saved
    draft (Q), it counts only staged refs the screen owns (item 21), so
    Q's rule is unchanged.
21. **Remove.** S and N delete a removed staged file from staging. Q
    deletes only the files it added, because the others belong to the
    saved queue item. Kept: an `ownsStagedAttachment` input that defaults
    to all; Q passes "not in the item it opened with". On Q, a delete
    failure shows its inline error, through the same handler as item 8;
    S and N log it.
22. **Closing the screen.** All three revoke every preview on unmount.
    Q also deletes the files it added unless it was saved. Kept: the
    revoke is in the hook. Q's delete stays in Q and reads the hook's
    list ref.
23. **The audio memo (N).** A committed memo is a local file, uploaded
    when the session starts; Cancel drops it. On S, a memo uploads when
    it is committed, and the send waits for it. Kept: S's way on both:
    - N uploads the memo on commit and starts the session once the
      upload finishes. A failed upload throws `audioMemoUploadFailed`, as
      on S.
    - A start that is refused after the upload leaves the memo as a
      staged chip, saved in the draft. Refusals include a launch, an
      attachment-only start and `turnEffortUnavailable`. Before, it
      stayed as a local chip that was not saved.
    - Committing the same memo again reuses its attachment while it is
      still shown. Committing a different recording first removes the
      earlier memo, deleting it from staging or cancelling its upload, as
      today a new commit replaces the earlier local memo.
    - Cancel removes the memo and deletes it from staging, or cancels its
      upload if it is still in flight.
    - `NewSessionForm.test.tsx`'s memo case, which expects the memo sent
      through `upload`, changes to expect a staged upload.
24. **Counting files on N.** Today an uploading file is an entry in
    `pendingFiles`, so every count includes it:
    - `fileCount` in `newSessionStart.ts` and the check in
      `legacySessionCreation.ts` that `fileCount` equals the staged count;
      a mismatch sends the start to the legacy path on a server without
      full admission;
    - the has-content and attachment-only checks in
      `newSessionStartDecisions.ts`;
    - the launch refusal;
    - `canStart`, the smart-turn check and the template's disabled
      reason in `NewSessionForm.tsx`.

    Kept: every count is finished attachments plus in-flight uploads, so
    each path is chosen as today. If the counts read only the list, a
    server without full admission would take the durable path, which
    does not wait for uploads, and the session would be created without
    the file.
25. **Sending on N.**
    - The durable path awaits the in-flight upload promises it captured,
      under full admission as now (only that case reaches it with
      uploads, by item 24). A failed one stops the start with
      `sessionDraftAttachmentsUnavailable`, as now.
    - The legacy path awaits them the same way, then materializes through
      the shared `materializeComposerAttachmentsForSubmission`.
    - The "files unchanged since submit" checks in `newSessionStart.ts`,
      and the check-saved-creation button's compare with the stored
      `draftFileIds` in `NewSessionForm.tsx`, compare attachment ids as
      sets, not in order. Finished uploads are appended in the order they
      finish.
    - Queue waits until every file is staged. Kept: it waits until no
      upload is in flight, which is the same condition now.
26. **Hydrating before the server's capabilities are known.** Both
    screens pick the rule from `versionInfo` at the moment they hydrate.
    If the version has not loaded yet, a server with draft sync gets the
    local rule. A short answer then drops the chip quietly and clears the
    saved draft's refs, and draft sync spreads that loss to other
    devices. It happened once in five runs of slice 0's New Session
    reload pin. It also happens on S every time: plan 187's reload pin,
    run against the same server, which offers draft sync, pinned a quiet
    drop because the page checked before the version arrived. Kept: the
    check waits until the version has loaded or failed to load. Until
    then the saved files are shown unchecked (`persistDraft: false`), so
    a write in the meantime, such as an incoming share that finishes
    first or `beginCorrection`, keeps them in the saved draft. A failed
    load uses the draft-sync rule, which never drops a file quietly. So
    each load checks once, and a notice shows once.
27. **A draft key that changes while a file uploads.** On S, the session
    is part of the page's React key, so a session change remounts the
    page and item 6 applies. N's key changes with the source or the
    launch. Its uploading entries survive the change, and their results
    are written into the new key's draft. Kept: on a key change, the hook
    cancels every upload in flight (item 5), so each result is deleted
    and none reaches the new draft. A start in progress may already wait
    on such an upload (N's key changes with the source). Today that
    start finishes its upload and then stops quietly at its
    form-ownership check. Kept: when an upload it waits for comes back
    cancelled and the form is no longer the one that started, the start
    stops quietly the same way, rather than showing
    `sessionDraftAttachmentsUnavailable`.
28. **S's reset on mount.** S's session reset effect empties the list and
    bumps the hydration counter. Because the page is keyed by session, it
    runs only on mount, where the list is already empty. But if the
    composer's draft controls arrive in the same commit, their hydration
    runs before the reset, and the reset throws its result away. Today a
    second hydration covers this (item 18). Kept: the reset no longer
    touches attachments.
29. **Previews on hydration.** Both screens replace a shown staged chip
    with the saved ref, which has no preview. The chip loses its picture,
    and its URL is never revoked, because the id is unchanged. Kept: a
    shown chip keeps its preview when the saved ref has the same id.

## Hook surface

```ts
useComposerDraftAttachments({
  draftControlsRef,          // RefObject<DraftControls | null>; holds null on Q
  draftKey,                  // string | null; null on Q
  hydrationEnabled,          // S: !mainComposerForAside; N: true; Q: false
  initialAttachments,        // Q's item attachments; read once, at mount; seeds the batch
  ownsStagedAttachment,      // Q only, built once from its item; default: all staged files
  sourceTransport,
  versionInfo, versionFailed,  // item 26
  onUploadError,             // Q only; default: the sessionUploadFailed toast
  onDeleteError,             // Q only; default: log
})
```

It returns:

- `attachments` and `attachmentsRef`;
- `uploadProgress` and `pendingUploadsRef`;
- `setComposerAttachments(updater, { persistDraft?, revokeRemovedPreviewUrls? })`
  (unchanged);
- `ensureDraftAttachmentBatchId`;
- `uploadFiles(files, { imageProfile, history })`, which returns
  `Promise<(ComposerAttachment | null)[]>`. The settings come with each
  call, because S knows its provider's image profile only further down
  the page than where the hook is called;
- `cancelUpload(id)` and `removeAttachment(id)`;
- `hydrateDraftAttachments(controls?)`.

The hook raises the navigation guard itself. `biome.json` gets a
`stableResult` entry for the refs and setters it returns, as
`useSessionComposerAttachments` has.

## Slice 0: pins and plan

New `packages/client/e2e/new-session-attachment-paths.spec.ts`, against
the shared e2e server, passing at the base commit:

1. A staged file comes back after a reload, and a failed check keeps it
   and says so. The shared e2e server offers draft sync. A short answer
   is not pinned here, because today its outcome is racy (item 26);
   slice 2 adds it once the hook fixes the race, and both screens' pins
   then count one notice.
2. A staged file added or removed in one tab follows in a sibling tab.
3. Removing a file while it uploads leaves no chip once the upload
   finishes. The staged copy is deleted (a `DELETE` of its staging ref is
   seen), and no failure is shown.
4. An upload in flight asks before the page is left (`beforeunload`).

New `packages/client/src/components/__tests__/ProjectQueueAttachmentEditor.test.tsx`.
It is a component test with a fake transport at the transport boundary,
so it does not depend on the upload helper:

1. An added file uploads into the item's batch and is saved with the
   existing refs.
2. Removing an existing staged file does not delete it from staging;
   removing an added one does.
3. Closing without saving deletes the added files, and only those.
4. Cancelling an upload drops its later result and deletes it.

In `NewSessionForm.test.tsx`, Start while a file is still uploading
sends it once it is staged (item 24), on three servers: full admission
(the durable path), no text creation (the legacy path), and text and
staged creation without admission. The last is the one that picks its
path by the counts; with uploads left out of `fileCount`, it fails.

`ProjectQueueSection.test.tsx`'s paste-and-remove case already pins Q's
batch and the kept existing ref. It mocks `uploadComposerAttachmentFile`
by module, so slice 3 moves it to the transport boundary.

The session page is already pinned by plan 187's
`session-page-correction-attachment-paths.spec.ts` and by plan 181's
`session-page-title-attachment-paths.spec.ts` (failed upload, remove,
incoming share). The New Session memo, file drops and staged creation are
already pinned by `audio-memo`, `attachment-drop` and
`session-creation-attachments`.

## Slice 1: the hook, on the session page

1. Create `hooks/useComposerDraftAttachments.ts` from
   `useSessionComposerAttachments` and `useDraftAttachmentHydration`, plus
   the upload and remove halves of `useSessionAttachmentUploads`, and
   add the staged-only `uploadStagedComposerAttachment` helper beside
   `uploadComposerAttachmentFile`.
2. Delete `useSessionComposerAttachments.ts`. `useSessionAttachmentUploads`
   keeps `uploadAttachedFiles` and `handleAttach`, which pass the image
   profile and history context to `uploadFiles`, and the incoming share.
   The page hands the hook's `removeAttachment` to the footer.
3. The session page keeps its edit-blocker effect and
   `materializeComposerAttachments`, and passes `useVersion`'s error as
   `versionFailed`. Its session reset stops touching attachments
   (item 28).
4. The hook's in-flight records add `mimeType` to `UploadProgress`
   (`ComposerUploadProgress`); `MessageInput` reads them as
   `UploadProgress`.
5. New `hooks/__tests__/useComposerDraftAttachments.test.tsx` pins the
   rules no screen pin reaches directly. Each fails when its rule is
   removed:
   - while the version is unknown, the saved file is shown, and an upload
     that finishes meanwhile keeps it in the saved draft; the check runs
     once the version arrives (item 26);
   - removing the last staged file while an upload runs keeps the batch
     for that upload (item 12);
   - a draft key change drops the uploads started for the old key and
     deletes their results (item 27).

The behavior changes on the session page are items 6, 7, 10, 12 to 16,
18, 26, 28 and 29. Items 18 and 26 change plan 187's reload pin: the
failed check's notice is now counted as exactly one.

## Slice 2: New Session on the hook

1. `NewSessionForm.tsx` calls the hook and renders
   `attachments` then `uploadProgress` as chips. An uploading chip's
   remove calls `cancelUpload`.
2. The memo follows item 23.
3. `newSessionStart.ts` takes `attachmentsRef`, `pendingUploadsRef` and
   `setComposerAttachments` instead of the `PendingFile` inputs
   (item 24).
4. Delete `lib/newSessionAttachments.ts` and its test.
5. The behavior changes on New Session are items 2, 3, 5, 6, 8 to 10,
   16 to 18, 23 and 25 to 27.
6. Pins added:
   - the short-answer step in slice 0's New Session reload pin: with
     draft sync, the chip stays and the page says the file is gone, once;
   - Start after removing a file while it uploaded starts without it and
     without an error (item 5);
   - the template button stays disabled while a file uploads (item 24);
   - a refused memo start keeps the memo chip, a second recording
     replaces it, and Cancel deletes it (item 23);
   - a reload whose incoming share finishes before the version loads
     keeps the saved file in the draft (item 26).

## Slice 3: the Project Queue editor on the hook

The editor passes no saved draft, `hydrationEnabled: false`, its item's
attachments, `ownsStagedAttachment`, no history, and its inline error
handler. It keeps its save and its close-time delete. Item 11's dead
branch is deleted here: `uploadComposerAttachmentFile` loses its last
caller and is removed. `ProjectQueueSection.test.tsx` moves its upload
mock to the transport. Q's behavior does not change, apart from item 10.

## Checks

Tier 2 for each slice. Tier 3 once, on the last slice, together with the
slice 0 pins and plan 187's pins. Each slice gets a doc 058 row, a landing
note, and a budget ratchet for every file it shrinks.

## Open

- S's progress chips in `MessageInput` could gain the remove button that
  item 5 makes possible.
- With draft sync, a short answer keeps the chips and says so, while
  without it the file is dropped quietly. Both rules are kept as they
  are.
