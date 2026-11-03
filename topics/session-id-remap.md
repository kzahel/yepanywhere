# Session ID Remap Events

Status: implemented.

This owns retained provisional-id reconciliation and supported older-server
client behavior. [Permanent YA identity and common creation admission](session-identity.md#creation-consolidation--november-3)
now govern every production native new-session path, including copies: native
allocation binds N to permanent public P and does not remap P. The superseded
new-session route/Queue remap and metadata-writer duties are removed.

Retain application remap observers for existing legacy histories, receipt/peer
and Source Review associations, SDK test scaffolding, and supported older-server
events. Removing those consumers is a separate compatibility decision, not a
reason to reintroduce public remapping on new admission. Historical Claude
incidents below predate chosen-id and permanent-identity migration.

## Problem

A newly launched session can briefly render as two sidebar rows for one logical
provider session when YA publishes a temporary startup ID and the provider
reports the canonical ID immediately afterward. This is a session identity bug,
not a duplicate-title display problem. It has occurred through both Project
Queue and the normal New Session flow.

The duplicate rows can expose different amounts of metadata: the optimistic
temporary row may identify only Claude while the canonical row already
identifies the Fable model. They previously disappeared only after summary data
caught up; identity now reconciles as soon as the canonical ID arrives.

## Evidence

Server log evidence for the observed `mclone` session:

- `2026-07-06T10:20:19.202Z`: `session_registered` emitted for temporary ID
  `5f84842d-6f10-4b5d-92c9-929b99b922bd` and forwarded as `session-created`.
- `2026-07-06T10:20:19.229Z`: the Claude SDK reported canonical ID
  `42042f7a-30d8-4eba-8b52-59fb8683846f`.
- `2026-07-06T10:20:19.230Z`: Supervisor logged
  `session_id_mapping_updated` from the temporary ID to the canonical ID.
- The adjacent activity forwarding after the remap included
  `session-status-changed`, `project-queue-changed`, `file-change`, and later
  `session-updated`; it did not include a public remap event.
- The canonical session JSONL and SDK raw stream identified the model as
  `claude-fable-5`, matching the Fable tooltip row.

The normal New Session reproduction from July 24, 2026 followed the same race:

- `18:08:38.318Z`: the five-second wait expired and YA published temporary ID
  `92e12bac-9971-4aba-a8c6-cc1963d35621`.
- `18:08:38.348Z`: Claude reported canonical ID
  `8de8ddcf-fbd3-43c7-8cbd-8a1f78283ccf`, only 30 ms later.
- Both IDs mapped to process `6903e5c7-e76f-412c-986a-a6581d01443e`; there was
  one JSONL transcript and one provider process, which explains why both rows
  showed the same live response.
- The duplicate disappeared before the first turn completed. The summary
  store's 60-second preservation window for an event-created row, followed by
  a replacement snapshot, explained the eventual cleanup; turn completion was
  not the identity-reconciliation mechanism.

This also rules out the "missing session id" theory. The provisional row had a
real YA-generated UUID. The issue is that the client never learned that the
temporary UUID and canonical UUID were the same logical session.

## Current Flow

For launch paths that still remap, the startup path is:

1. `ProjectQueueScheduler.dispatchNewSessionItem` calls
   `supervisor.startSession` for new-session queue items without staged
   attachments.
2. `Supervisor` constructs a `Process` with a generated temporary session ID.
3. `Process.waitForSessionId(timeoutMs = 5000)` resolves with the current
   temporary ID if the SDK init message has not arrived by the timeout.
4. `Supervisor.registerProcess` records `process.sessionId` and emits an
   optimistic `session-created` activity event using that temporary ID.
5. The SDK init message then updates `Process._sessionId` and emits the
   internal `session-id-changed` process event.
6. `Supervisor.observeProcessEvents` handles the internal event by adding a
   `sessionToProcess` mapping for the canonical ID, keeping the old mapping,
   emitting ownership for the new ID, and scheduling initial reconciliation.
7. If the old ID was already publicly registered, Supervisor emits a
   `session-id-remapped` activity event. An init ID received before registration
   needs no public remap because clients never saw the temporary ID.
8. The client summary store applies the remap as an identity merge before
   later canonical updates or snapshots arrive.

Relevant code surfaces:

- `packages/server/src/services/ProjectQueueScheduler.ts`
- `packages/server/src/supervisor/Process.ts`
- `packages/server/src/supervisor/Supervisor.ts`
- `packages/client/src/lib/activityBus.ts`
- `packages/client/src/lib/clientSummaryState.ts`
- `packages/client/src/lib/clientSummaryStore.ts`
- `packages/client/src/hooks/useGlobalSessionsFeed.ts`
- `packages/client/src/components/Sidebar.tsx`

## Invariant

If YA exposes a temporary public session ID and later learns the canonical
public session ID, every client-facing identity surface must be able to
reconcile the two IDs. Provider-native IDs must not silently replace
YA-visible session IDs; when the public ID changes, the mapping must be
explicit in the event contract and client stores.

## Observable Contract

When YA has exposed a temporary session ID and later learns a different
canonical ID:

- The activity stream emits `session-id-remapped` with:

  - `oldSessionId`
  - `newSessionId`
  - `projectId`
  - `processId`
  - `provider`
  - `timestamp`

- After reducing that event, normalized client state has one entity under the
  canonical ID and no provisional ID in query lists, inbox tiers, draft
  decorations, provider-runtime status, Project Queue targets or origins,
  recovered queues, or parent-session links.
- If both records exist, identity is canonical but data authority is decided
  independently for content, metadata, project, lifecycle, and unread field
  groups. The record with the newer group observation wins that complete
  group; canonical wins ties, and the other record only backfills fields the
  winner does not carry. Observation timestamps take their maxima and the
  earliest creation event remains retained. A stale canonical lifecycle
  snapshot therefore cannot overwrite newer provisional activity merely
  because its ID is canonical.
- Later activity events and collection snapshots that still name a retained
  old ID resolve to the canonical entity and cannot recreate the duplicate.
- List projections contain a canonical ID at most once. Inbox tier priority
  remains `needsAttention`, `active`, `recentActivity`, `unread8h`,
  `unread24h` if stale memberships collapse across tiers.
- Server lookups by the old ID continue to resolve to the process for in-flight
  clients.

## Implementation

Supervisor translates the internal process `session-id-changed` event into the
public `session-id-remapped` event only when its old ID is already registered.
It still retains both server-side process mappings.

The source-scoped client summary reducer:

- merges and rekeys the entity;
- rewrites every normalized session-ID collection;
- keeps the latest 256 old-to-new aliases, flattened across repeated remaps;
- resolves IDs through those aliases on subsequent event and snapshot writes
  and on direct session/runtime selectors.

The alias limit bounds source-runtime memory without adding a timer-driven
cleanup path. The focused session stream's existing `session-id-changed`
handling continues to replace an open temporary URL, while the server alias
supports in-flight requests.

## Tests

Focused coverage includes:

- Server emits a public remap event when a process changes from temporary ID to
  canonical ID.
- Activity bus accepts and dispatches the new event type.
- Client summary reducer merges a temporary `session-created` record into a
  canonical record without leaving the old ID in query lists or inbox tiers.
- Group freshness survives the merge when a provisional lifecycle observation
  is newer than the canonical content snapshot.
- Provider runtime / activity maps keyed by the temporary ID move to the
  canonical ID.
- Recent/inbox projections do not show two rows for the same remapped session.
- A late old-ID event after remap does not recreate the duplicate row.

## Non-Goals

- Do not solve this by hiding duplicate titles in the sidebar. Title-based
  hiding can mask real parallel sessions, forks, helper sessions, or owned
  active sessions.
- Do not delay every `session-created` until a canonical ID is available. That
  would hide useful startup feedback and still would not cover providers that
  remap after initial display.
- Do not change Project Queue dispatch semantics as part of the identity fix.
- Do not broaden this into the larger client source-runtime refactor.

## Decisions

- The public event is `session-id-remapped`; `session-id-changed` remains the
  focused process-stream event.
- Client aliases are count-bounded at 256 entries rather than time-bounded.
- Focused routes keep their existing automatic canonical-URL replacement, and
  the server retains its old-ID process mapping as a compatibility layer.
