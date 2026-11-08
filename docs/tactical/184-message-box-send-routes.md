# Message box send routes

Topic: typescript-module-boundary-refactor

Status: done 2026-11-08 (slices 0 to 2); `MessageInput.tsx` went from
4,023 to 3,185 lines, with the decisions in `lib/composerDelivery.ts` and
the effects in `hooks/useComposerDelivery.ts`.

Item 8 of the
[session page React hub gap](../../gaps/session-page-react-hub.md)'s
burn-down plan, owned by
[doc 058](058-typescript-module-boundary-refactor.md) priority-queue item 2.
[Plan 179](179-session-composer-send-decisions.md) made the session page's
side of sending plain decisions; this plan does the same for the message
box's side, in `packages/client/src/components/MessageInput.tsx`.

About 880 of the box's 4,023 lines (at `c14c5c86a`) send things. There are
eight send functions, one per button or shortcut, and three wrappers around
them:

| Function (line) | Sends to |
| --- | --- |
| `handleSubmit` (1463), Send and steer | `onSend` |
| `handleQueue` (1610), Queue and topic shift | `onQueue`, or `onSend` when Queue is the main action |
| `handleForkSummarySubmit` (1266) | `forkSummaryMode.onSubmit` |
| `handleForkWithoutSummary` (1331) | `forkSummaryMode.onSubmitWithoutSummary` |
| `handleProjectQueue` (1779) via `submitToProjectQueue` (1712) | `onProjectQueue` |
| `handleProjectQueueNewSession` (1810), same | `onProjectQueueNewSession`, with the chosen target |
| `handleSyntheticDoneSubmission` (1393) | `onDone` |
| `handleQuestionAsideSubmission` (1431) | `questionAside.onAsk` or `onSave` |

- **Delivery while dictating** (`deferSpeechDelivery` 1205,
  `runPendingSpeechDelivery` 1848, `restorePendingSpeechDeliveryDraft`
  1833). A press while speech is still settling sets the draft aside and
  empties the box, so the user can type the next message; when the
  transcript lands, the matching send function runs with the set-aside
  draft.
- **Touch delivery** (`runComposerPointerDelivery` 1965 and seven
  variants). On a coarse pointer it blurs the box and replaces the editing
  host so late Android keyboard events stay out of the next draft.
- **Voice auto-send** (`handleSmartTurnSend` 2897).

Every send function repeats the same tail (clear the box, reset the typing
times, clear the speech preview, close the question aside, send, use up the
speech attribution, focus or blur), and each decides its text, checks and
metadata inline, so none of those decisions can be tested without
rendering the box. The copies have drifted apart.

## The maintainer's direction

Settled 2026-11-08: where the copies differ by accident, prefer one simple
rule over keeping each permutation; questions that need a decision may stay
open. So, unlike plans 178 and 179, this plan changes behavior where a
difference has no reason behind it. Each change is listed below (C1 to C9),
lands with a unit test (C6 has none: nothing a user or test can see
changes), and is named in the slice's landing note.

## What changes

The eight functions become one synchronous `deliver(route, options)` that
returns whether the press was taken. A route is one of send (with an
optional explicit action, send or steer), queue (optionally a topic shift),
Project Queue (this session, or a new session with an optional chosen
target), fork with summary, and fork without summary. The main action
(Enter, the Send button, voice auto-send) picks its route when pressed: fork
with summary in fork mode, queue when Queue is the main action, otherwise
send with no explicit action, whose intent is decided at delivery (K5) and
which tries the question aside (K1).

| # | Today | After |
| --- | --- | --- |
| C1 | Fork mode leaves other routes open. In a busy session the toolbar still shows Queue and Steer: Queue queues the fork instructions to the session, and Steer reaches `handleSubmit`, which does nothing (dropping a dictated draft set aside on the way). Ctrl+Enter without a no-summary fork reaches `handleQueue` or steer the same way. With an empty box and an answer that can be saved, Enter saves the Q+A while the button reads Save Q+A but forks. Enter and voice auto-send reach a fork already submitting, whose buttons are disabled. | Fork mode delivers only on the fork routes, and not while a fork is submitting. Its Queue and Steer buttons are hidden, and an empty box does not offer to save the Q+A. |
| C2 | Send, queue and Project Queue set a dictated draft aside before checking that they can deliver at all (the box disabled, no queue or Project Queue handler), then drop it when speech settles. The forks check first. | Every route checks that it can deliver before setting anything aside; if it cannot, nothing happens. This is the rule [the mic button topic](../../topics/mic-button-speech-ui.md) already states: "Action eligibility is checked before speech ownership transfers and again before a deferred typed action runs." Text is not checked then: while dictating, the words may all still be in speech. |
| C3 | `!!` runs locally only from Send and steer; Queue, topic shift and Project Queue send a plain `!!…` draft to the agent. (The leading-space escape, ` !!`, already reaches the agent as `!!…` on every route, since the prefix helper trims.) Only the main button's speech cue knows about `!!`, so Steer already shows a prefix while running the command locally. | `!!` runs locally from every route but the forks, as the [bang commands topic](../../topics/bang-commands.md) says: a bang command "runs immediately regardless of session state … with no steer/queue/defer semantics". Every control's speech cue drops the prefix for it. |
| C4 | An attachment-only send right after speech sends the bare speech prefix as its text, and so does a no-summary fork with an emptied box; the fork with summary never prefixes empty text. | Empty text is never prefixed, and no cue shows a prefix for it. |
| C5 | The forks do not close the question aside; every other route does. | Every delivery closes it. |
| C6 | Queue reads the speech attribution after clearing the box; the others read it before. The attribution is time-based and lives in its own hook, so the result is the same. | Every route reads it before clearing. |
| C7 | A dictated draft remembers only the kind of press: a topic shift comes back as a plain queue (no patient metadata or threshold; pinned in slice 0). A delivery refused or throwing when speech settles restores the set-aside draft for the forks only; send, queue and Project Queue drop it (an `onSend` throw is lost in `handleSubmit`'s promise). | The set-aside draft remembers the whole route, and any refused or throwing delivery puts it back in front of whatever the user typed since, for every route, as the mic button topic requires ("rejection or an exception restores that draft"). The draft is released before delivery, so a settlement reported again during delivery cannot send it twice, and restored from the released copy. |
| C8 | Voice auto-send always calls `handleSubmit`, so with Queue as the main action it sends through `onSend` with deferred intent instead of `onQueue` with the patient settings; and it reports a send as taken whatever `handleSubmit` did. | It takes the main action's route, like Enter, and reports exactly whether the delivery was taken, so a refused auto-send does not start follow-up listening (the mic button topic). |
| C9 | A bare `!!` is sent to the agent from Send (the guard meant to stop it never fires) and from every other route but the forks. | A bare `!!` does nothing on those routes, as the bang commands topic says ("a silent no-op"), and no cue shows a prefix for it. |

The fork functions' positional flags, which come in different orders
(focus, speech, keep the box for one; focus, keep the box, speech for the
other), become one options object.

## What stays

- K1: the question aside is tried first on send without an explicit action
  and on queue, never on a set-aside draft (which must not touch the box
  holding the user's next message), Project Queue or the forks.
- K2: `/done` is caught on every route but the forks, only without
  attachments or uploads.
- K3: the forks accept empty text and refuse attachments and uploads; every
  other route needs text or attachments, checked once the draft is known.
- K4: a set-aside `!!` command that fails is not restored, as today: its
  outcome arrives after the set-aside draft has been released. Open.
- K5: metadata. Send's intent comes from its action at delivery (steer,
  direct, or deferred when Queue has meanwhile become the main action);
  queue's is patient or deferred with the patient source and compaction
  threshold; Project Queue's is deferred; the forks carry none.
- K6: the touch delivery wrapper, the key handler's order and every
  keystroke path (typing, slash and bang completion, recall, paste, the
  speech handlers) are unchanged; the key handler calls `deliver` with the
  route it calls a function for today. Full-pane Ctrl+Enter stays a direct
  send (or the fork with summary in fork mode), as
  [full-pane editing](../../topics/composer-full-pane-editing.md) says, and
  the file view completion's submit stays a send with no explicit action:
  `/v` is a local command that never reaches the agent and that Project
  Queue refuses ([view command](../../topics/view-command.md)), so it must
  not take the queue route when Queue is the main action.
- K7: the order of effects for a delivery: resolve the prefix and build the
  metadata, clear the box (unless the draft was set aside), close the
  question aside, send, use up the speech attribution, focus or blur. A
  `!!` command clears, runs, then confirms or restores and focuses, as
  today.
- K8: the no-summary fork sends its text as typed, untrimmed unless a
  speech prefix applies: [fork from turn](../../topics/fork-from-turn.md)
  says it submits the text "verbatim" and "must not rewrite the typed text".

Open: a Project Queue new session aimed at another project runs a `!!`
draft in this session's project, like every other route.

## Target shape

- `lib/composerDelivery.ts`, no React: the route type,
  `resolvePrimaryDeliveryRoute`, `canDeliverOnRoute` (C1, C2, and the
  forks' half of K3), `routeTriesQuestionAside` (K1) and
  `planComposerDelivery`, which returns ignore, done, a bang command, or a
  delivery with its text, intent and patient settings (C3, K2, K3, K5, K8).
  Unit tests cover each branch.
- `hooks/useComposerDelivery.ts`: `deliver`, setting a draft aside and
  replaying or restoring it, the question aside submission, the touch
  delivery handlers and voice auto-send. It is called where
  `deferSpeechDelivery` stands today, after the speech state and the
  composition metadata it reads and before `useComposerSpeechHandlers`,
  which takes its replay, restore and auto-send functions. The replay and
  voice auto-send are read through refs assigned during render, so the
  voice button's callbacks keep their identity however often `deliver`
  changes; the other returned functions keep `useCallback` identities, so
  typing creates no new handlers.

## Slices

0. **Pins.** In `MessageInput.test.tsx`, a dictated draft settling after a
   press on steer (Enter while the agent works), explicit Steer (Ctrl+Enter
   while Queue is the main action), topic shift, Project Queue, and Project
   Queue new session, both plain and in a chosen project: the callback
   receives the set-aside draft with its speech prefix, metadata and
   target, and the box keeps what the user typed meanwhile. Send, Queue and
   both forks already have these cases. In `speech-caret-insertion.spec.ts`,
   a browser check: Send pressed while dictation finalizes; the user types
   the next message while the transcript is held; it lands halfway and
   typing goes straight on, overlapping the set-aside draft's delivery;
   every key shows within 100 ms, none joins the sent message, and the
   draft is sent. Test-only.
1. **One route.** `lib/composerDelivery.ts` with its tests; the eight
   functions become `deliver` in place, with C1 to C9 and their tests.
2. **The hook.** `deliver` and everything listed for
   `hooks/useComposerDelivery.ts` move there. Move-only apart from turning
   closure reads into parameters; reviewed with `git diff --color-moved`.

Each slice lands on its own with its budget ratchet, doc 058 row and
landing note.

## Checks

- Per slice: Tier 2, and Tier 3 with the client browser tests, including
  slice 0's browser check and the existing keystroke checks
  (`speech-caret-insertion`, `bang-command`, `composer-recall-drawer`) and
  the send specs (`session-send-paths`, `session-page-queue-paths`,
  `session-page-fork-paths`, `session-page-composer-footer-paths`,
  `project-queue-new-session-options`, `queued-message-recall`,
  `composer-beacon`).
- Opus 5.5 review of this plan and of each slice.

## Not in scope

- The session page's side of sending (plan 179) and the new-session box's
  start and queue paths
  ([new-session start and queue differences](../../gaps/new-session-start-and-queue-differences.md)).
- Button labels and icons, and the toolbar beyond C1 (hiding Queue and
  Steer in fork mode) and C3, C4 and C9 (the speech cues); the key handler
  beyond the calls it makes; the speech handlers hook.
- K4, and the open question above.
- Two sends that do not go through these functions: the prompt
  suggestion's click (always a direct send) and the audio memo's commit
  (its own prefix and route).
