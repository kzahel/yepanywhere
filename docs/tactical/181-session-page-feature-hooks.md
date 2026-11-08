# Session page feature hooks

Topic: typescript-module-boundary-refactor

Status: in progress 2026-11-08. Slice 0 (the pins) landed: 37 cases in
`session-page-fork-paths`, `session-page-queue-paths`,
`session-page-title-attachment-paths` and `session-page-navigation-paths`
(with `e2e/support/session-page-harness.ts`), passing at `e770fca38` and at
the slice tip. Cases already covered elsewhere are not repeated: recalling
a sent message (`queued-message-recall`), the `searchMatch` jump
(`all-sessions-search`) and rename typing (`session-header-responsive`).
Pinning found two existing defects, recorded as gaps: keys typed while a
session loads appear only when its transcript arrives
([gap](../../gaps/session-early-typing-waits-for-transcript.md)), and the
retitle "ready" state, accepting a ready suggestion and the caret
insertion cannot be reached
([gap](../../gaps/session-retitle-accept-paths-unreachable.md)), so they
have no pin; the reachable failed-proposal path (Enter does nothing,
Ctrl+Enter saves) is pinned. A cancelled unconfirmed steer's recall is not
pinned: the fixture provider never sends a steer from the composer. No pin
uses route retention, so that slices 5 and 6 read the page's `location`
rather than the router's is checked by review and the `rg` check, not by
the pins.

Proposal 4 of [the session page hub gap](../../gaps/session-page-react-hub.md):
move the remaining self-contained features out of `SessionPageContent` in
`packages/client/src/pages/SessionPage.tsx` (6,560 lines at `e770fca38`),
one feature hook per commit. Unlike plans 178 to 180 nothing is
consolidated or rewritten: each slice moves code verbatim into a hook and
calls the hook where the code stood. These are ordinary doc 058 Phase 2
move-only slices; this plan exists because most of the moved behavior has
no test today, so it lists the pins first, and because a few slices move
state or effects to a new place in the hook order, which it declares.

## Contracts these moves carry

- **Handler identity.** `MessageList` is memoized and the page re-renders
  every second; the fork, queue and jump handlers it receives are
  `useCallback`s for that reason (the comment above
  `handleCancelForkSummary`). Each moved `useCallback` and effect keeps
  its body. Its dependency list gains only the refs and state setters that
  were in scope in the page and are now parameters, which lint requires (as
  in slice 2.14). They never change identity, so neither the `MessageList`
  callbacks nor an unmount-only effect is rebuilt; each landing note lists
  them. If an added dependency could change identity, the slice stops and
  records it instead. The title handlers are plain functions today and stay
  plain, so their identity changes every render exactly as now.
- **Hook and effect order.** React runs effects in declaration order. A
  moved block that contains effects is called where the block stood, so
  their order is unchanged, except where a slice says otherwise below.
  Moving a `useState`, `useRef`, `useMemo` or `useCallback` to a later
  position changes nothing a user can see.
- **The location the page reads.** `location` is `routeLocation ??
  useLocation()` (route retention), so hooks take `location` and
  `navigate` as inputs instead of calling the router hooks. `t` and
  `showToast` come from `useI18n` and `useToastContext` inside the hook,
  as `useSessionBangCommands` (slice 2.14) does; they return the same
  values the page reads. The one exception is `useIncomingShareFiles`,
  which calls `useLocation` and `useNavigate` itself today; its call moves
  unchanged and keeps reading the live router location.
- **Keystroke latency** (AGENTS.md). Two moved paths handle typing: the
  rename field's handlers (slice 3), and the early-typing handoff that
  holds keys typed before the composer appears and replays them in order
  (slice 5). Both get keystroke checks (below). The composer's own typing
  path does not move.

## What moves

Line numbers are at `e770fca38`.

1. **Fork, clone, handoff and copy** → `hooks/useSessionForkActions.ts`
   (~470 lines out). The fork-summary draft state and its three refs
   (1187-1194); `submitForkAfterSummary`, `submitForkAfterWithoutSummary`,
   `createDirectTurnFork`, `cloneSession`, the fork-summary cancel,
   auto-open, follow and target-href callbacks and the auto-open effect,
   `beginForkAfterSummary`, `beginForkAfterInitialTurn`, the before/after
   wrappers and `copyUserMessage` (1624-2029); `handoffFromUserMessage`
   (2034-2070), and the module helper `messageKey` (384), used only here.
   Takes: `projectId`, `actualSessionId`, `session`, `messages`,
   `activityRenderItems`, `permissionMode`, `versionInfo`, `basePath`,
   `navigate`, `draftControlsRef`, `attachments`, `uploadProgress`,
   `forkAfterDisabled`, `updateTranscriptDisplayObjectsForSession`,
   `effectiveProvider`, `effectiveModel`, `effectiveModelConfig`,
   `currentGoal`, `project`, `getImplicitComposerThinking` and
   `startNewSessionWithPrefill`.
   Returns: the draft and its setter, `submitForkAfterSummary`,
   `submitForkAfterWithoutSummary` and `beginForkAfterInitialTurn` (the
   fork composer footer); `forkBeforeUserMessage`, `forkAfterUserMessage`,
   `beginForkAfterSummary`, `copyUserMessage`, `handoffFromUserMessage`,
   `getForkSummaryTargetHref`, `handleCancelForkSummary`,
   `handleToggleForkSummaryAutoOpen` and `followForkSummary` (row props);
   `cloneSession` (the session menu); and `createDirectTurnFork`, which
   `useSessionRewindControls` uses for `/fork N` (3833).
   Stays in the page: fork availability, `forkAfterDisabled`,
   `supportsTitleGeneration`, `forkAtEffort` and the long-context effort
   guard (1565-1623), which other features read and which run before the
   guard.
   Order: the hook is called immediately after `activityRenderItems`
   (2030), which stays where it is and is also read at 2076, 4576 and 6271;
   1624-2029 and 2034-2070 move out. The draft state and refs move from 1187
   to that call. The auto-open effect (1900) moves later, past only
   callbacks and a memo, so no effect changes order.
2. **Queued-message actions** → `hooks/useSessionQueuedMessageActions.ts`
   (~345 lines). `handleResumeProjectQueueDispatch`, the Project Queue item
   cancel, edit and steer, `restoreQueuedMessageToComposer`, the deferred
   cancel, edit, steer and send-without-compacting, the unconfirmed-steer
   cancel, the recovered delete, resume and steer, and
   `handleCancelLatestDeferred` (2992-3335), with the module helper
   `isMissingDeferredQueueEntryError` (388), used only here. Callbacks only;
   no order change.
   Takes: `projectId`, `sessionId`, `projectQueues`,
   `projectQueueItemsForProject`, `deferredMessages`,
   `setDeferredMessages`, `setStatus`, `setProcessState`,
   `setPermissionMode`, `removeUnconfirmedSelfSend`, `draftControlsRef`,
   `attachmentsRef`, `pendingUploadsRef`, `lastComposerSubmissionRef`,
   `lastSentComposerSubmissionRef`, `setComposerAttachments` and
   `setCorrectionDraft`.
   Returns: the thirteen handlers (used at 5913-5940 and 6367);
   `restoreQueuedMessageToComposer` stays inside.
   Shared state: the deferred cancel, edit and unconfirmed-steer cancel
   write `lastComposerSubmissionRef`, which `handleRecallLastSubmission`
   (staying in the page) reads; the pins cover recall after a cancel and an
   edit.
3. **Title editing** → `hooks/useSessionTitleEditing.ts` (~320 lines). The
   editing state and refs and `attachTitleInput` (2179-2200), the
   `generatedRetitleRef` sync effect (2227-2229), and the handlers and two
   effects at 4349-4504 and 4606-4710, and the `TitleEditMode` and
   `GeneratedRetitleState` types (405-415), used only here. The hook is
   called at 4349; everything it takes is declared before that. The
   `/title` command's wrapper at 2735 calls `handleLocalTitleCommand` at run
   time, as it does today.
   Takes: `projectId`, `sessionId`, `displayTitle`, `condensedHeader`,
   `titleRowRef`, `setShowRecentSessions`, `supportsTitleGeneration`,
   `routedSession`, `generatedTitleLength`, `draftControlsRef`,
   `setLocalCustomTitle` and `isDomLingerParked`.
   Returns: the editing state the markup reads (`isEditingTitle`,
   `renamePresentation`, `titleEditMode`, `renameValue`, `setRenameValue`,
   `isRenaming`, `generatedRetitle`, `attachTitleInput`,
   `titleEditControlsRef`), `saveTitleValue` (the dialog), and the start,
   generate, `/title`, cancel, blur, save, accept and key handlers.
   Stays: the local metadata state (`localCustomTitle` and its siblings,
   2213-2238), which the archive, star and suggestion toggles also own,
   `quoteFromTranscript` and the `/v` command (4506-4604), and the title
   markup.
   Order: the state moves from 2179 to 4349, and the ref sync effect from
   2227 to 4349, now after the redirect, correction and other effects
   declared between. It only copies state into a ref that
   `setRetitleState`, the only caller of `setGeneratedRetitle`, also writes
   synchronously, and the ref is read only by the response handler and the
   accept handler, so its position is not observable. The pins cover the
   response handler (Generate Title) and the accept handler's reachable
   path (Enter after a failed proposal). The two Escape and parked-cancel
   effects keep their order.
4. **Attachment upload** → `hooks/useSessionAttachmentUploads.ts` (~170
   lines). `uploadAttachedFiles`, `handleAttach`, the
   `useIncomingShareFiles` call and `handleRemoveAttachment` (4105-4275).
   Takes: `projectId`, `sessionId`, `session`, `project`, `sourceTransport`,
   `attachmentQuality`, `currentProviderInfo`, `effectiveModel`,
   `effectiveModelConfig`, `historyScope`, `isDomLingerParked`,
   `ensureDraftAttachmentBatchId`, `setUploadProgress`,
   `setComposerAttachments`, `attachmentsRef` and `pendingUploadsRef`.
   Returns: `uploadAttachedFiles` (6388), `handleAttach` (4984, 6383) and
   `handleRemoveAttachment` (6394).
   Stays: `useAttachmentUploadQuality()` (1217), so no hook moves earlier;
   the attachment state, `setComposerAttachments`, the batch id,
   materializing, collection for submission and draft hydration, which
   are tied to the draft controls' lifecycle and the send module. No order
   change.
5. **Recall and navigation actions** → `hooks/useSessionTranscriptJumps.ts`
   (~165 lines). The composer turn recall cache and entries, the command
   recall, the scroll-to-turn request and `handleGoToRecallTurn`, the
   search-match and non-human-turn navigation hooks, `composerTurnRecall`,
   and the navigation-state actions (prefill, focus, scroll) with their
   early-typing effects (2756-2919). No order change.
   Takes: `sessionId`, `actualSessionId`, `messages`, `location`,
   `navigate`, `loading`, `loadingOlder`, `isDomLingerParked`,
   `pagination`, `loadOlderMessages`, `navState`'s action fields and the
   seed fields it preserves, and the early-typing refs and
   `flushEarlyComposerTyping` (declared at 1050-1056, also read by the
   composer-ready handler at 3756).
   Returns: `composerTurnRecall`, `recordCommandRecall` and
   `scrollToTurnRequest`.
   The navigation-action effect is not gated on parking and keys on
   `location.key`, so it must read the page's `location`, not the router's.
6. **Route sync** → `hooks/useSessionRouteSync.ts` (~85 lines). The four
   effects at 2342-2424: recording the visit, replacing a temporary id
   with the real one, the native-id viewer URL, and the canonical project
   redirect. No order change.
   Takes: `sessionId`, `projectId`, `actualSessionId`, `session`,
   `location`, `navigate`, `basePath` and `isDomLingerParked`. Returns
   nothing.

`SessionPage.tsx` goes from 6,560 to about 5,100 to 5,200 lines (the calls
and returned names add some back); each hook stays well under the
1,500-line threshold.

Not moved, though nearby: the correction draft (`correctionDraft`,
`preCorrectionDraftRef`, `handleCancelCorrection`,
`handleCorrectLatestUserMessage` and `handleRecallLastSubmission`). Its state
is read by the send module, reset by the session-change effect with the
attachments and asides, and revoked by the attachment unmount cleanup;
moving it means splitting those, which is not move-only.

## Slices

0. **Pins.** Browser specs, since the page has no unit test harness, over
   the fixture session with routed endpoints, recording request bodies:
   - fork: clone and its failure toast, fork before a later turn, fork
     after a turn (row menu), fork after with summary (request, toast, the
     fork-summary progress row, cancel, toggling auto-open, follow, and the
     auto-open with `window.open` stubbed), fork without summary with
     next-turn text (fork, then queue to the new id), the attachment and
     turn-in-progress refusals, `/fork N`, the composer's fork shortcut,
     copy, and handoff's prefill;
   - queue: edit a deferred message (including the turn-effort prefix) and
     its refusal while the composer holds a draft or attachment, cancel
     (silent on a missing entry, a toast otherwise), steer, send without
     compacting, cancel-latest from the composer, the unconfirmed-steer
     cancel, the recovered resume, steer and delete, the Project Queue item
     cancel, edit and steer, resuming Project Queue dispatch, and ↑ recall
     after a cancel and an edit;
   - title: rename, its failure, Escape, saving and cancelling on blur, the
     menu's generate title, Enter and Ctrl+Enter after a failed proposal,
     and `/title` with and without a name;
   - attachments: an upload failure's toast, removing a staged attachment
     (the delete request), and an incoming share;
   - navigation: the prefill, focus and scroll actions and their history
     clear, keys typed before the session loads landing in order (bounded
     from the transcript load, not the composer appearing; see the
     early-typing gap), go-to-turn from the recall
     drawer, a command recall entry, and the `searchMatch` jump;
   - route sync: the canonical project redirect, the native-id viewer URL,
     the recorded visit, and a temporary id replaced by the real one,
     driven by a session-id-change stream event (or a status response
     carrying a different id), asserting a replace navigation that keeps
     the history state.
   Existing specs that already cover a case are named instead of
   duplicated. Test-only.
1. Fork, clone, handoff and copy.
2. Queued-message actions.
3. Title editing.
4. Attachment upload.
5. Recall and navigation actions.
6. Route sync.

Each of slices 1-6 is one commit: the hook, the page call, a doc 058 row
(2.31 to 2.36) and landing note listing the parameters, returned names and
added dependencies, and the `SessionPage.tsx` budget ratchet. Review with
`git diff --color-moved`.

## Checks

- Browser, per slice: slice 0's specs, plus the existing specs for the
  moved feature: fork (`long-context-effort-warning`,
  `session-resume-settings`, `question-aside`), queue
  (`queued-message-recall`, `queued-compaction`, `recovered-queue-stream`,
  the `project-queue-*` specs, `session-send-paths`), title
  (`session-title-access`, `session-header-responsive`), attachments
  (`attachment-drop`, `session-attachment-send-draft`,
  `image-upload-quality`), jumps
  (`composer-recall-drawer`, `bang-command`, `all-sessions-search`,
  `non-human-user-turn`) and route sync (`session-switch-scroll`,
  `durable-session-creation`).
- Typing: `bang-command.spec.ts`, `composer-recall-drawer.spec.ts` and
  `draft-sync.spec.ts` per slice; `session-header-responsive.spec.ts`
  (rename typing during live updates) for slice 3; slice 0's early-typing
  pin for slice 5.
- Location: `rg "useLocation|useNavigate"` over the new hooks finds
  nothing (the `useIncomingShareFiles` call is the stated exception).
- Unit: the client suite passes unchanged; no new unit tests, since the
  hooks are moved code covered by the pins.
- `pnpm console:scan` for the moved `console.error` and `console.warn`
  calls, and `pnpm i18n:scan` for moved keys.
- Budgets: `SessionPage.tsx` ratchets down each slice.
- Tier 2 and Tier 3 per slice, as in plans 179 and 180; Opus 5.5 review
  of this plan and of the series.

## Not in scope

- The correction draft (above), the attachment state and draft hydration,
  and the title markup, which could follow as their own slices.
- Proposals 5 and 6 (message list, toolbar view).
- Any behavior change. A difference found while moving is recorded, not
  fixed.
