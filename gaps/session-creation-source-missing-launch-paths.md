# Remaining YA session launch paths omit creation-source metadata

Inbox's **Started via → YA UI** filter excludes sessions actually requested
through YA when their launch bypasses the creation-provenance writer in
`routes/sessions.ts`. The same omission makes API-created sessions disappear
from **API / automation**. They instead match **Unknown / external**, in both
Inbox and Global Sessions. Missing provenance does not prove external creation.

The reported `android-remote-access` session (`01a195a7…db710`) was created
on 2026-11-01 at 05:49:08 UTC. Read-only inspection of localhost:3400 found it
in Inbox's active tier, with no `creationProvenance` in either session metadata
or the Inbox response; its persisted SQLite metadata also lacked the field.
Provider metadata identifies `originator: yep-anywhere`, and server logs
record a new owned session. Project Queue change events immediately bracket
its launch, consistent with the queue path below. No original enqueue request
was retained in this investigation, so those events alone do not establish
which queue UI control was used.

## Project Queue repair — November 2

The Queue omission below is repaired for new enqueues: normalized original
request source is saved with the queue item and committed before native launch,
including worker deferral and staged attachments. Restart, edits, retry and
Start/Force start preserve it; existing-session turns do not relabel their
session, and old queue items stay unknown. See the
[implemented Queue contract](../topics/session-creation-provenance.md#project-queue-origin).
The five other audited paths remain unresolved, so this gap remains open. The
original unmarked session cannot be safely backfilled without its enqueue source.

## Affected paths audited on 2026-11-01

The additional findings below are the original dated audit of production call paths,
not live launches or provider tests. No session data was changed.

| Launch path | Missing handoff and user-visible result |
| --- | --- |
| Project Queue, new-session target | [NewSessionForm](../packages/client/src/components/NewSessionForm.tsx), `handleQueueProjectSession`, and [SessionPage](../packages/client/src/pages/SessionPage.tsx), the composer queue submission, send `createdFrom.client` but no creation provenance. [Queue request/storage types](../packages/shared/src/project-queue.ts) have no provenance field; [queue admission](../packages/server/src/routes/project-queue.ts) does not infer one from headers. [ProjectQueueScheduler](../packages/server/src/services/ProjectQueueScheduler.ts), `dispatchNewSessionItem`, launches through Supervisor; [app.ts](../packages/server/src/app.ts), `onSessionStarted`, saves prompt/model/provider and limited-user ownership but no creation source. UI and API enqueue paths therefore lose their source. Applies to normal promotion, explicit Start/Force start, worker deferral and staged-attachment creation. |
| Source Control → new review session | [review-comments.ts](../packages/server/src/routes/review-comments.ts) calls `startReviewSession` without request provenance. [reviewSessionLauncher.ts](../packages/server/src/review/reviewSessionLauncher.ts) starts directly through Supervisor; its callback records review delivery only. Both submission-aware and legacy review launches lack creation-source writes, including worker-deferred launches. A user-requested review session consequently matches Unknown. Existing-session follow-ups should preserve their original source. |
| Fork after summary, final user session | [sessions.ts](../packages/server/src/routes/sessions.ts), `POST /projects/:projectId/sessions/:sessionId/fork-summary`, creates a generator and then a target fork. The target receives launch settings and is unarchived on success, but neither target creation nor final resume calls `recordCreationProvenance`. The final navigable session matches Unknown. This is distinct from the archived generator's intentional lack of provenance. |
| Native v0 API, including incoming peer creates | [native-session-commands.ts](../packages/server/src/core-api/native-session-commands.ts), `nativeSessionCommandOwner.start`, starts through Supervisor. Its `onStarted` settles the trusted receipt and installs input observation, but never records `{ surface: "api" }` in session metadata. [session-commands.ts](../packages/server/src/core-api/session-commands.ts) retains separate creator/receipt facts; those are not the `creationProvenance` field consumed by Inbox. This affects immediate and worker-deferred native creates; incoming peer requests use the same target owner. |
| Maintenance diagnostic create | [debug-routes.ts](../packages/server/src/maintenance/debug-routes.ts), `POST /debug/sessions/create`, starts directly through Supervisor without a provenance callback. Diagnostic API sessions match Unknown rather than API / automation. This is an optional maintenance surface, not the ordinary UI path. |
| Restart with a transcript fork, failed continuation | [sessions.ts](../packages/server/src/routes/sessions.ts), `POST /projects/:projectId/sessions/:sessionId/restart`, `restartMode === "fork"`, creates the fork before resuming it. It records provenance only after a successful immediate resume. Queue-full and queued-then-cancelled branches return 503 without recording provenance or deleting the fork. A resume exception also bypasses the writer. Any retained/discovered fork can therefore match Unknown despite a known request source. Successful restart is covered. |

## Paths checked without finding the same omission

- Project and detached one-step starts and two-step creates use
  `recordNewSessionLaunch` through `onStarted`, including internal worker
  deferral. This worker queue is distinct from the durable Project Queue.
- Successful restart modes, stale handoff, ordinary transcript fork and
  clone (including the `/btw` clone route) call the writer. The immediate
  new-session composer action uses these ordinary start/create routes even
  though it omits an explicit body hint.
- Direct requests carry the client surface/version in
  [plainFetch.ts](../packages/client/src/api/plainFetch.ts). Relay requests
  carry the surface in [RelayProtocol.ts](../packages/client/src/lib/connection/RelayProtocol.ts),
  and [ws-relay-handlers.ts](../packages/server/src/routes/ws-relay-handlers.ts)
  adds the announced client version. The parser drops a non-HTTP extension
  origin without dropping the valid `web` surface; extension URLs alone do
  not explain this defect.
- [SessionMetadataService](../packages/server/src/metadata/SessionMetadataService.ts)
  retains the first source, preserves it through normal metadata updates,
  and moves metadata across provisional/native ID remaps. Session detail,
  project/global lists, Inbox and the client summary projections carry the
  field when present; no additional projection omission was identified.
- Retitle/fork-summary/recap generator forks are archived helper sessions.
  Their unmarked source is documented in
  [session creation provenance](../topics/session-creation-provenance.md),
  as are external and pre-feature sessions. These are not evidence of another
  user-session recording defect. Resuming an existing session must not relabel
  its original creation source. The topic also mentions routines as unmarked;
  this audit did not establish a separate implemented routine launcher.

## Fix direction and closure

[Plan 171's provenance ledger](../docs/tactical/171-durable-session-identity-and-creation.md#creation-source-admission-and-coverage)
incorporates this audit and the
[admission recommendation](../topics/session-creation-provenance.sketches.md).
It assigns the invariant to shared admission, carries context through deferred
work and tracks targeted fork/helper/maintenance coverage separately from the
full child-id redesign. The Queue source repair is implemented as recorded
above; the remaining caller omissions are not closed.

The [creation admission recommendation](../topics/session-creation-provenance.sketches.md)
develops this fix shape and maps it onto the concurrent durable session
identity/startup plan. This entry remains the audit and closure record.

For the remaining paths, capture normalized request provenance at admission and carry it to durable
new-session creation, including deferred/background work. Project Queue now
persists the original enqueue source across edits, retries and restart;
`createdFrom.client` is not a web/desktop/API classification. An explicit
Start/Force start must not relabel work queued earlier by another surface.
Keep legacy items with no evidence unknown. Native API creates need the API
hint alongside their existing trusted receipts, without treating descriptive
client hints as authorization or replacing those receipts.

The new session's source must describe the request that created it, rather
than copying the source session's provenance for forks/reviews. Record it on
retained forks before subsequent launch steps can fail. Keep helper policy
explicit, preserve existing-session provenance, and emit/update the same
metadata projection as direct creation. Do not backfill all unmarked sessions
from `originator: yep-anywhere`: that identifies YA, not the initiating surface.

Closure should exercise UI/API queue admission through delayed dispatch and
profile restart, staged attachments and worker deferral, review creation,
fork-summary's final target, native local/peer API creation, maintenance create,
and restart-fork failure. Verify the resulting source in persisted metadata
and Inbox/Global Sessions after reload. Older-server queue/request compatibility
needs review before adding fields; this audit does not select a new capability
or API contract.

The original request was an audit and gap capture. The later Queue repair
closes that omission only. Remaining repairs span independent review, fork,
native API and maintenance launch owners; closing Queue does not establish
complete source coverage or justify guessing old records.

Found 2026-11-01 while investigating a YA-created session missing from the
Inbox's YA UI filter and auditing the remaining session-creation paths.
