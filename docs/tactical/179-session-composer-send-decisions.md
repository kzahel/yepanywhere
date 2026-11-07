# Session composer sending as plain decisions

Topic: message-control-steer-queue-btw-later-interrupt

Status: done 2026-11-07. Slices 0 (the pins), 1 (the submission
decision), 2 (send and queue decisions), 3 (Project Queue decisions) and 4
(the send module, `lib/sessionComposerSend.ts`) landed 2026-11-07. Slice 0
pins fourteen cases in `session-send-paths.spec.ts`, including both handoff
notices (the built-in message and the routed one), `compactQueued`, the
retried resume's request (same temp id and client time, no
`showThinking`), a turn-effort command sent while correcting, and a
command the page runs itself ending correction mode. Not pinned
there, with the reason and the substitute:
- The attachment-only refusal: with the version mocked as an old server
  (version 0.7.1, the capability's bit cleared) the attached draft did not
  submit at all, and the cause was not established. Slice 2 pins the
  refusal with unit tests on `planSend` and `planQueue`.
- Project Queue's legacy start-now: pinned separately before slice 3, in
  `session-send-paths.spec.ts` (the version mock clears the
  creation-admission capability, an optional bit no version implies).
- Queue promoted versus queued: already pinned by
  `queued-message-recall.spec.ts`.
- Beacon states and toast severity: `composer-beacon.spec.ts` pins the
  plain send's beacon states (it runs its own server process, so extending
  it to every outcome costs a server per case); the slice 2 unit tests pin
  the outcome each path maps to its beacon state, and slice 1's the
  refusal severities.

Proposal 2 of the
[session page React hub gap](../../gaps/session-page-react-hub.md), owned by
[doc 058](058-typescript-module-boundary-refactor.md) priority-queue item 2.
Commits carry `Topic: typescript-module-boundary-refactor` and
`Topic: message-control-steer-queue-btw-later-interrupt`.

Sending from the session page is four plain functions inside
`SessionPageContent` (`pages/SessionPage.tsx` at `c37af7168`):
`prepareComposerSubmission` (2537, about 125 lines), `handleSend` (2841,
about 390), `handleQueue` (3414, about 220) and `queueComposerForProject`
(3690, about 380). Each mixes deciding what to do (which text, which
settings, which request, which outcome) with doing it (requests, toasts,
draft updates, attachment state, traces). No unit test renders the page, so
none of those decisions can be tested without a browser. This plan moves the
decisions into plain functions with unit tests and the effects into one thin
module that runs them in today's order.

[Unconfirmed send loss across reload](../../gaps/unconfirmed-send-loss-across-reload.md)
and [live user turns missing until reload](../../gaps/live-user-turns-missing-until-reload.md)
describe `handleSend`'s pending row; this plan does not change it.

This is not a move-only refactor, so it follows the rules of
[plan 177](177-session-launch-service.md) and
[plan 178](178-shared-composer-dictation.md):

- Each slice keeps every path's behavior, including the order of its
  effects, and lands on its own with its budget ratchet and doc 058 row.
- Before a slice changes a path, a browser check pins what that path does
  today where coverage is missing (slice 0).
- Where the paths differ, the difference stays as it is: a named option when
  deliberate; an open question below when a user could see it or its intent
  is unclear. A harmless difference is only removed in its own commit with a
  test.
- The four functions are plain arrows today, rebuilt every render and reading
  that render's closure after their awaits. They stay that way: no
  `useCallback`, so neither identity nor staleness changes.
- No change to request bodies, toasts and their keys, traces, draft recovery,
  beacon states or navigation state.

## Contracts these paths carry

- [Message control](../../topics/message-control-steer-queue-btw-later-interrupt.md)
  (104-131): the composer clears optimistically before these run
  (`MessageInput` calls `clearInput` before `onSend`, `onQueue` and the
  Project Queue handlers); acknowledgement only confirms that clear; a failed
  request restores the recovery copy; a send already observed as delivered
  confirms without retrying, restoring or resetting activity.
- [Composer beacon](../../topics/composer-hotkey-beacon.md) (79-101): the
  invocation is captured before uploads or network delivery; only acceptance
  sets `a`.
- [Project Queue](../../topics/project-queue.md) (406-407, 551-556):
  new-session delivery confirms only after the server accepts; invalid
  queueable commands restore the draft.
- [Queued messages](../../topics/queued-messages.md) (84-87): recall never
  unqueues, hence the "queued" recall record.
- [Edit turn](../../topics/edit-turn.md) (69-80),
  [session context actions](../../topics/session-context-actions.md)
  (350-354) and [view command](../../topics/view-command.md) (152-159): local
  commands end correction mode and confirm or restore the draft themselves.

## What each path does today

Line numbers are at `c37af7168`.

**`prepareComposerSubmission(text, queueIntent)`** (2537-2662). An error
refusal is `setDraft(text)` (the raw composer text), an error toast and
`null`; only the "no changes" correction restores the candidate it framed,
with an info toast.
- A slash command while correcting ("issues a slash command") skips
  correction framing and ends correction mode.
- A custom slash turn: a queued `/compact` refuses on an old server or with
  attachments, else returns `{queuedCompact}` unframed. Otherwise the session
  operation resolver refuses a blocked one; a session boundary, `/title` or
  `/v` (when supported) ends correction first, then dispatches the local
  command and returns `null`; `/btw` without support refuses (hardcoded
  English); `handleCustomCommand` runs, and if it handled the command,
  correction ends after it and `null` returns; otherwise the text is framed
  and returned as `{outgoingText}` only (no thinking, slash command or turn
  effort, and only a truthiness check).
- A slash error refuses; turn effort on an unsupported server refuses.
- Otherwise the slash turn's text is framed. Framing a correction with no
  changes restores that text with an info toast and returns `null`. Empty
  framed content returns `null` silently. Otherwise it returns `{outgoingText,
  thinking, slashCommand, turnEffort}`.

**`handleSend(text, metadata, {preserveComposer, preserveScroll,
localControl})`** (2841-3229).
- Local-control and preserve-composer callers skip prepare. A turn-effort
  turn while in-turn or waiting-input is rerouted to this render's
  `handleQueue` with the raw text (so prepare runs again, with queue intent).
  Turn-effort metadata defaults to `direct`, the caller's intent wins and
  `steerNow` is kept. A `/goal` command with a goal present is local
  control. A send that is not preserving the composer and is
  attachment-only to an old server toasts and returns `false` without
  restoring the draft.
- Then, in order: `recordSessionInteraction`; `addPendingMessage`; the
  beacon starts (unless preserving the composer); in-turn and a scroll
  (unless local control; the scroll also unless `preserveScroll`); the
  start trace; collect (with the pending row's upload status) and
  materialize attachments; `updatePendingMessage` with the uploads.
- No owner: `resumeSession` (with `showThinking`), a clock sample, a trace,
  `setStatus` from the result. Otherwise `queueMessage`, a clock sample, a
  trace, `setIsCompacting` when `compactQueued`, and `setStatus` plus
  `reconnectStream` when `restarted`.
- Confirm: beacon `delivered`; then, unless preserving the composer, the
  "sent" recall record (raw text), `confirmInputClear`, preview revoke, end
  correction, clear quote anchors; `true`.
- Failure, in stages: already delivered confirms and returns. Otherwise log
  and trace; on a stale redirect, `staleHandoffSession`, then remove the
  pending row, set idle (unless local control), confirm, and either a
  "queued" toast (no new session) or a "started" toast and navigation; if
  the handoff fails its error becomes the final error and the stages go on.
  Then, if the original error's message includes "404" or "No active
  process", a resume retry (without `showThinking`), a clock sample, a
  trace, `setStatus` and confirm; its error becomes the final error. Then:
  beacon `error`, remove the pending row, restore the draft and attachments
  (unless preserving the composer), set idle (unless local control), and the
  final notice: handoff required opens the handoff modal (unless routed) and
  toasts the routed, 409 or raw message; otherwise `sessionSendFailed`.
  `false`.

**`handleQueue(text, metadata)`** (3414-3634).
- Prepare with queue intent; turn-effort metadata forces `deferred` and
  clears `steerNow`; the same attachment-only refusal.
- Then: `recordSessionInteraction`; a local `temp-…` id (no pending row, by
  design); the beacon starts; a scroll; the start trace; collect (no upload
  status) and materialize; deferred `queueMessage`; a clock sample; a trace;
  `setDeferredMessages`; a promoted result records "sent", otherwise a
  non-empty text records "queued"; `confirmInputClear`, revoke, end
  correction, clear anchors; beacon `delivered` (promoted) or `queued`.
- Failure: log and trace; unless a queued compact, a resume retry when the
  status is 404 or 410 or the message names "No active process" or "Process
  terminated" (without `showThinking`; no clock sample), then `setStatus`,
  "sent", the clears and beacon `delivered`. If there is no retry, or the
  retry fails (its error becomes the final error): restore the draft and
  attachments, beacon `error`, and the final notice with
  `sessionQueueFailed`.

**`queueComposerForProject(text, targetType, metadata, target)`**
(3690-4068).
- Classifies queueable YA commands and refuses the invalid ones (restoring
  the draft); a queueable command refuses for a new session or with
  attachments. Otherwise prepare without queue intent. Turn-effort metadata
  defaults to `deferred`, the caller wins, `steerNow` cleared (later
  overwritten). Resolves the target project, provider and model; decides
  canonical creation (start now, new session, admission capability); an
  unresolved creation principal restores the draft silently and returns.
- No interaction record, beacon, pending row or scroll.
- Captures the creation view and (canonical) the accepted draft; collects
  attachments (not detached when canonical); a lost creation view returns
  silently. For a new session, stages the attachments; canonical replaces
  the composer's attachments with the staged ones (persisting the draft) and
  recaptures the accepted draft if nothing changed.
- Start now: canonical admission (building the staged refs, which throws
  for unstaged files, inside the `try`) or the legacy route; canonical then
  confirms the accepted draft only if nothing changed, settling the creation
  and clearing attachments, or records creation recovery and returns
  silently; legacy confirms the clear. Then revoke, end correction, clear
  anchors and navigate (navigation state without `recapAfterSeconds`). No
  toast.
- Project Queue: uploads or splits staged attachments, the start trace,
  `createProjectQueueItem`, `reportProjectQueueCollectionSnapshot`, the
  result trace, the clears, and one of three success toasts.
- Failure: log and trace (with the page's project); canonical: a lost view
  returns silently, a pending creation records recovery, and the draft is
  restored only if empty (attachments untouched); otherwise restore the
  draft and attachments. Toast `newSessionStartError` or
  `projectQueueSubmitFailed`.

## Differences between the paths

| # | Difference | Handling |
| --- | --- | --- |
| S1 | Success order: send completes the beacon, then records recall and clears; queue clears, then completes the beacon. The beacon's completion does not read the composer. | Named per path; invisible. |
| S2 | Failure order: send completes the beacon with error, removes its pending row, restores and sets idle; queue restores, then the beacon. | Named per path; invisible. |
| S3 | Resume retry predicate: send checks the message for "404" or "No active process"; queue checks status 404 or 410 or the messages "No active process" or "Process terminated", and never for a queued compact. | Kept; open question Q1. |
| S4 | Retried resumes omit `showThinking`, which first attempts send. Current servers ignore it (`thinkingOptionToConfig` no longer reads it), so no current user sees a difference. | Kept as an explicit flag in the request settings. Not visible on current servers. |
| S5 | Queue neither checks whether a failed request was already delivered nor handles a stale-session redirect, both of which send does. | Kept; open question Q2. |
| S6 | Project Queue skips the attachment-only server check. | Kept; open question Q3. |
| S7 | Turn-effort metadata: send defaults to `direct`, the caller wins, `steerNow` kept; queue forces `deferred` and clears `steerNow`. Project Queue's variant is equivalent to queue's, since `deliveryIntent` is overwritten before every request. | Two named variants, send and deferred. |
| S8 | Project Queue's start-now navigation omits `recapAfterSeconds`, which the stale handoff includes. | Kept; open question Q4. |
| S9 | Telemetry: the queue retry records no clock sample; the Project Queue error trace logs the page's project. | Kept; not visible. |
| S10 | Project Queue never records a session interaction, which orders the sidebar; send and queue do. | Kept; open question Q5. |
| S11 | Response fields: queue ignores `restarted`/`processId` and `compactQueued`, which send acts on (reconnecting the stream after a restart); send ignores `deferredMessages`, which queue mirrors. | Kept; open question Q6. |
| S12 | Optimistic UI: send adds a pending row, sets in-turn and scrolls (skipped for local control and `preserveScroll`); queue mints its own id, shows no row (by design, per its comment) and always scrolls; Project Queue does none of these. | Named per path. |
| S13 | Project Queue has no handoff-required notice. | Kept; it does not deliver to a Claude process. |

Behaviors to keep that are not differences: prepare's refusals with English
strings (`/btw` unsupported, the session-operation and slash resolvers),
which slice 1 records as a new gap,
`gaps/session-composer-refusals-untranslated.md`;
the silent returns (empty framed content, an unresolved creation principal,
a lost creation view, a canonical creation accepted but not cleared); the
attachment-only refusal that does not restore the draft; and the reroute
running prepare twice.

## Open questions for the maintainer

Q1 Should send retry a 410 or "Process terminated" as queue does (S3)?
Q2 Should queue treat an already-delivered failure as success and follow a
stale-session redirect as send does (S5)? Q3 Should Project Queue refuse an
attachment-only message to an old server (S6)? Q4 Should start-now
navigation carry `recapAfterSeconds` (S8)? Q5 Should a Project Queue
submission move the session up the sidebar (S10)? Q6 Should queue reconnect
after a server-side restart, and send mirror deferred messages (S11)?

## Target shape

New `lib/sessionComposerSendDecisions.ts`: decisions only, no React and no
I/O. It sits beside `lib/sessionComposerSubmission.ts`, which keeps the
attachment collect, stage and materialize helpers and
`PreparedComposerSubmission`.

- `resolveComposerSubmission(text, queueIntent, context)` returns one of:
  - `refuse { message, severity, restoreText }`, including the "no changes"
    correction (info, restoring the candidate text), since
    `buildCorrectionText` is pure;
  - `local { operation, endCorrectionFirst }` for a session boundary,
    `/title` and `/v`;
  - `custom { command, argument, endCorrectionIfHandled, fallback }`, where
    `fallback` is worked out in advance (refuse, drop, or submit the framed
    text only);
  - `drop` (empty framed content);
  - `submit { prepared }`, with a queued compact unframed.
  The page applies it in today's order: refuse restores and toasts; local
  ends correction first, then dispatches; custom runs `handleCustomCommand`
  and, when handled, ends correction, else applies the fallback.
- `planSend` and `planQueue` (slice 2), then `planProjectQueue` (slice 3):
  the pre-request decisions (prepare skip, reroute, the S7 metadata variant,
  local control, the attachment-only refusal, Project Queue classification,
  target project, provider and model, canonical creation). One builder
  covers the resume settings, with S4 as an explicit flag; the positional API
  calls, and the Project Queue and navigation objects (see slice 3), stay at
  their call sites.
- Failure handling in stages: `firstSendFailureStep(err, delivered)` returns
  delivered, stale redirect or continue; `shouldRetrySendWithResume(err)` and
  `shouldRetryQueueWithResume(err, queuedCompact)` apply each path's
  predicate to the original error; `finalFailureNotice(finalError, provider,
  routedSession, genericKey)` picks the handoff modal and toast, shared by
  send and queue.

New `lib/sessionComposerSend.ts`, `createSessionComposerSend(deps)`: a plain
function, not a hook, that returns `handleSend`, `handleQueue` and
`queueComposerForProject` and runs each path's effects in today's order. The
page calls it every render where `handleSend` stands today (2841), after
the declarations it reads (`setShowHandoffModal`,
`collectComposerAttachmentsForSubmission`, `handleSyntheticSessionBoundary`,
`closeFocusedBtwAside`) and before `handleSendRef` (3230), so the result is rebuilt each render as now and `handleSend` still
reroutes to the same render's `handleQueue`. The callbacks the page declares
later (`handleCustomCommand`, `handleFileViewCommand`,
`handleLocalTitleCommand`, `clearQuoteAnchors`) are passed as wrappers such
as `(command, argument) => handleCustomCommand(command, argument)`: created
before those constants and called only after render, each resolves to its
own render's binding, as today. These stay in the page unchanged:
`handleSendRef` and `handleQueueRef`, `executeComposerSend` and
`executeComposerDefer` with the semantic UI harness registration,
`handleProjectQueue` and `handleProjectQueueNewSession`, every ref consumer
(`useSessionBangCommands`, the question aside's `sendToMain`,
`handleFocusedBtwSend`, the async questions `send`,
`handleSessionViewerCommentSend`), and `GoalFlag`, which calls the returned
`handleSend` directly.

## Slices

0. **Pins.** A new browser spec, `session-send-paths.spec.ts`, over the
   mocked session, stream and `/api/version` the existing send specs use,
   pinning today's request bodies, toasts, composer state and beacon state
   for: a send to an owned process whose queue request fails with a 404 and
   resumes; a queue request failing with a 410 that resumes; queue promoted
   versus queued; a stale redirect that hands off and navigates, and one
   that only queues; handoff required on send and on queue (modal, the 409
   message, and the routed variant); the attachment-only refusal (composer
   stays empty); a turn-effort turn while the stream reports in-turn,
   rerouted to the deferred queue; send's `compactQueued` and `restarted`
   (reconnect); correction framing on send (framed body; "no changes" keeps
   the draft with an info toast; a slash command goes unframed and ends
   correction); Project Queue existing-session success (body and toast), a
   refused composer-only command (draft kept), and the legacy start-now
   without the admission capability (navigation state). Test-only: no budget
   change; a status line here.
1. **Prepare as a decision.** `resolveComposerSubmission` with a unit test
   per branch, including both correction-end orders, the stripped custom
   fallback, and the raw-text `restoreText` of the turn-effort refusal; `prepareComposerSubmission` applies it.
2. **Send and queue decisions.** `planSend`, `planQueue`, the resume
   settings builder and the staged failure functions, with unit tests on the
   planners and failure functions; the page's two functions call them and
   keep their effects in place.
3. **Project Queue decisions.** `resolveProjectQueueCommand`,
   `planProjectQueue` and `projectQueueQueuedMessage`, with unit tests; the
   staged-ref throw stays inside the `try`, after the creation-view check.
   The target, message and navigation builders were dropped: each object is
   built once, at its single call site, from values the effects produce
   (uploaded and staged attachments, the creation result), so a builder
   would only restate the call; slice 4 moves them with the rest.
4. **The send module.** The three functions and prepare move into
   `createSessionComposerSend`, which the page calls where `handleSend`
   stands today.
   Move-only apart from turning about 60 closure reads into parameters (as
   the boundary topic allows) and the four wrappers; reviewed with
   `git diff --color-moved`.

## Checks

- Unit tests on `resolveComposerSubmission`, the planners and the failure
  functions, one case per branch and per S3, S5 and S7 variant. Builders get
  no separate tests (per [test value](../development/testing.md#test-value-and-ci-cost));
  the slice 0 spec checks their output in request bodies.
- Browser, per slice: slice 0's spec and the existing send specs
  (`session-send-recovery`, `session-attachment-send-draft`,
  `composer-beacon`, `queued-message-recall`, `queued-compaction`,
  `async-questions`, `question-aside`, `slash-command-argument-completions`,
  `file-view-command`, `project-queue-new-session-options`,
  `project-queue-session-creation`, `session-resume-settings`,
  `sidebar-ordering`).
- Typing: these run after the composer clears, but acknowledgements land
  while the user may be typing the next draft (`confirmInputClear`, and
  Project Queue's canonical re-reads of the draft). `composer-beacon` and
  `project-queue-new-session-options` cover typing during an in-flight
  request and run per slice.
- Tier 2 and Tier 3 per slice; Opus 5.5 review of this plan and of each
  slice.

## Not in scope

- Answering Q1 to Q6 or translating the English refusals.
- The new-session form's start and queue paths (proposal 3).
- `MessageInput`'s side of submission (clearing, metadata stamping).
