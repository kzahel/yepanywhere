# Local-first draft synchronization

Status: implemented in source on 2026-09-29, following the maintainer's explicit
end-to-end implementation request. The durable contract and exact rollout,
retention and verification details now live in
[Draft synchronization](../../topics/draft-synchronization.md). This completed
plan is retained as the design record; its illustrative wire shapes are
superseded by that contract and the shared types.

The implementation deliberately treats project hiding/archiving as reversible,
not context deletion. There is no permanent session/project-delete action to
hook; externally missing contexts become inaccessible and remain quota-bounded.
Account deletion purges owned draft state.
## Motivation and accepted direction

A draft started on a phone currently stays in that browser. Moving to a desktop
should recover the same draft, while offline typing must remain immediately
durable on the originating device. Concurrent changes may be combined
conservatively; perfect collaborative editing is unnecessary, but silently
discarding typed text is unacceptable.

The agreed design is:

- Keep localStorage persistence on every accepted edit. Add background server
  synchronization; do not replace local persistence with network saves.
- Unify persistence and synchronization behind a reusable draft service for
  every important currently persisted input surface, with typed adapters for
  their different payloads and lifecycles.
- The server owns the order of accepted snapshots. Clients retain their last
  acknowledged base, detect stale writes through revisions, and reconcile
  conflicts without last-write-wins text loss.
- Retain both texts on a genuine overlapping conflict; simple concatenation is
  acceptable. No CRDT, editing locks, or general diff3 library is required.
- Keep attachment uploads immediate. Sync completed attachment references with
  the draft; upload progress itself does not create draft revisions.
- Never replace active input underneath typing, selection, undo, or IME
  composition. Synchronization must not sit on the keystroke path.
- Use the existing SQLite infrastructure. When unavailable, preserve the
  existing local-only behavior. Advertise the exact draft capability only when
  its service and storage are ready.
- On capable servers this is ordinary built-in behavior, not a new opt-in.
  The maintainer explicitly selected this default during the original
  discussion; carry that bounded exception into the owning topic contract.
- Ordinary nonempty drafts remain until sent, manually cleared, or their owning
  context is deleted. Bound recovery history and synchronization bookkeeping.

The [roadmap](../roadmap/README.md) still owns priority. This plan does not
reprioritize the release-delivery work or implement multiplayer Live Share.

## Existing work and boundaries

Start from these documents rather than introducing parallel behavior:

- [Draft attachment staging](028-pre-session-attachment-staging.md) implements
  staged files and draft envelopes, but explicitly excludes text draft sync.
  This plan extends that boundary; it does not imply sync already exists.
- [Source registry](027-client-summary-source-registry.md) establishes source
  isolation and mentions a future server-authoritative draft migration.
- [Composer input latency](065-session-composer-input-latency.md) requires
  immediate local persistence without transcript rendering on keystrokes.
- [Unconfirmed-send loss](../../gaps/unconfirmed-send-loss-across-reload.md)
  remains a distinct open gap. Draft synchronization is not proof of durable
  provider delivery and must not claim to close it.
- [Attachment storage](../../topics/attachment-storage.md),
  [project storage](../../topics/project-directory-storage.md), and
  [SQLite](../../topics/optional-sqlite.md) own file placement and storage
  lifecycle. Draft state stays in app data, never in the selected checkout.
- [Capabilities](../../topics/server-capabilities.md) and
  [hosted compatibility](../../topics/remote-hosted-compatibility.md) own rollout.
- [Security](../../topics/security.md) and
  [principals and grants](../../topics/principals-and-grants.md) own authority.
  Reuse the current acting account; add no feature-local identity system.
- [Architecture mandates](../../topics/architecture-mandates.md) govern bounded
  subscriptions, retry work, and cleanup. The
  [Live Share sketch](../../topics/relay-origin-and-share-gating.sketches.md)
  is related future work, not permission to expose personal drafts to guests.

Before runtime work lands, create `topics/draft-synchronization.md` as the
durable owner of the observable rules below. Keep this tactical for sequencing
and remaining work; migrate durable content before eventually retiring it.

## Coverage and reusable ownership

Inventory all local draft writers before implementation. The initial map is:

| Surface | Existing owner | Adapter obligation |
| --- | --- | --- |
| Session composer | `useDraftPersistence.ts`, `sessionDraftStorage.ts`, `draftEnvelope.ts` | Text, completed attachments, source/session identity, send recovery. |
| New-session and project composers; seeded/handoff forms (the floating composer was removed 2026-11-07) | `NewSessionForm.tsx`, `RestartSessionModal.tsx`, `useDrafts.ts` | Preserve existing separate slots and any existing project scope; audit custom draft keys. |
| Tool-approval feedback | `useDrafts.ts` | Adapt its separate string persistence; retain its current session-scoped behavior. |
| Question-panel Other answers | `useDrafts.ts` | Preserve per-question fields rather than concatenating unrelated answers. |
| Async-question replies | `asyncQuestionRecords.ts` | Sync draft text by question identity without treating reminder flags, answers, or edit counters as draft text. |
| Session file-comment drafts | `sessionFileComments.ts`, `useSessionFileComments.ts` | Preserve comment IDs, anchors, quotes and individual submit/remove behavior. |

These paths are relative to `packages/client/src`, under `hooks/`, `lib/`, or
`components/` as appropriate. `useReviewCommentDraft.ts` already uses a
server-backed source-review accumulator; do not create a second store for those
accepted review records. Any remaining browser-local editor around that
accumulator belongs in the inventory. A missing surface is added to this plan,
not silently excluded because it does not use the main hook.

Unify the machinery, not every payload into one text string. Surface adapters
define a stable slot, schema, content predicate, merge policy, and submission
boundary. The common service owns local durability, acknowledged base,
outstanding operation, scheduling, remote changes, and recovery. Cursor,
selection, upload progress, and other transient view state stay with the editor.
This is draft synchronization, not blanket localStorage/settings replication.

A server slot belongs to `(acting account, scope, resource identity)`, within
that server's data profile. Device IDs identify writers, not owners. Use YA
session identities and existing question/comment identities. Client caches also
include the source and account, but browser-local saved-host IDs must never
become cross-device server identifiers. Direct and relay access to the same
account/server must converge. Switching account or source must hide the prior
draft immediately, and late responses remain bound to their original owner.

Authorize reads, lists, mutations, attachment access, and notifications against
the acting account and applicable resource grants. Generic draft routes require
explicit slot-aware checks; current path-based project authorization must not
be bypassed by putting project/session IDs in a request body. Public shares
receive no draft content or presence. An unscoped legacy local draft must not
be automatically uploaded into an account whose ownership cannot be established.

## Local persistence and synchronization

Persist an envelope containing the current payload, last acknowledged server
snapshot/revision, local edit generation, and any outstanding immutable save
operation. Keep post-submit recovery distinct from the next editable draft.
The local edit generation is not the server revision.

Every accepted edit saves locally immediately, including edits while offline,
reconnecting, uploading, or waiting for a previous save. Network failure never
disables typing. A successful sync updates the base but retains the local copy.
Storage failures must not erase in-memory text or falsely report durable local
save; browser eviction/private-storage limitations remain real limitations.

Initial scheduling targets are a 3-second quiet debounce and a 10-second
maximum interval during sustained edits while connected. These are tunable
implementation defaults, not performance evidence. Attachment completion and
removal request a prompt save; multiple completions can coalesce. Focus,
reconnect, and returning to the app refresh the server snapshot. Blur or app
backgrounding may attempt a flush, but correctness never depends on the browser
completing a final request before suspension.

Maintain one in-flight save per slot per client; coalesce later edits behind
it. Retry with bounded backoff, stop network work while disconnected, and tear
down listeners/timers with their owner. Reuse source-scoped transport and
connection readiness rather than adding independent reconnect loops. A shared
source/account owner manages synchronization demand across mounted inputs and
pending local drafts. Do not scan every localStorage key on each keystroke or
fetch every full draft body to decorate session badges.

## Revisions, acknowledgements, and reconciliation

One server revision covers the complete persisted payload, including text and
completed attachment references. Local keystrokes, upload chunks, progress, and
presence do not advance it. An accepted changed snapshot advances it once;
no-op saves and duplicate requests do not. Revisions include a non-reused slot
generation so deletion/recreation cannot make an old base current again.

Illustrative save shape, to finalize in the compatibility review:

```ts
type DraftSave = {
  slot: DraftSlot;
  baseRevision: DraftRevision | null;
  operationId: string;
  payload: DraftPayload;
};
```

The server checks the base and commits the payload, revision, and operation
receipt in one short SQLite transaction. A successful acknowledgement includes
the operation ID, accepted revision, and accepted snapshot. A stale base returns
the current revision and snapshot without overwriting them. `null` is only for
a never-synchronized initial create, not a way to bypass a stale/deleted base.
Notifications are published after commit and are scoped to authorized owners.

The client remembers its base, so responses need not carry previous data:

1. Both devices read revision 12.
2. Phone saves against 12; server accepts revision 13.
3. An unchanged desktop adopts 13. An edited desktop saving against 12 gets a
   conflict, reconciles against 13, and submits a new operation based on 13.
4. The server may reject again if another write intervened. Retry work remains
   coalesced and bounded; conflict does not freeze local editing.

Acknowledgements apply to the snapshot sent. If `Hello` is in flight and local
typing reaches `Hello there`, acknowledging `Hello` advances the base and leaves
`Hello there` dirty. A late acknowledgement cannot roll the observed server
revision backward. Persist the outstanding operation before sending it so reload
and lost-response retries use the same ID and exact payload. Reusing an ID with
different content is invalid.

Clients converge through server-ordered snapshots, not replay of all keystrokes.
Use revision-aware snapshot notifications or invalidation plus a coalesced read;
finalize that choice before the wire review. Reconnect fetches current state.
Ignore stale notifications within a generation; an unknown/new generation
requires reconciliation, not numerical comparison with the previous one.

Reconciliation rules:

- Equal current payloads produce one copy.
- When only one side changed from the acknowledged base, adopt that side,
  including an intentional clear or field removal.
- Merge independently changed structured fields by their stable identities.
- For conflicting text in the same field, preserve both versions separated by
  a blank line. Prefer deterministic server-text-then-local-text ordering.
  Do not require clever word-level deletion inference or fuzzy substring dedup.
- Keep unresolved inputs and merge-attempt identity long enough that retrying a
  save or receiving its own acknowledgement cannot concatenate the same
  conflict again. Test repeated conflicts, not just one successful retry.
- Missing/expired base evidence is not proof that stale text should become the
  shared draft. Retain it locally and expose explicit recovery instead.

Remote state and editable state are separate. Do not apply a remote replacement
during composition or active typing, even if a recent save made the input
technically clean. Hold it pending and reconcile against the latest local edit
generation at a safe boundary. Initially prefer deferring changes to a focused
editor over attempting automatic range edits that disturb undo/selection. Keep
pending changes discoverable and apply them on blur or explicit acceptance;
unfocused clean inputs can adopt remote snapshots immediately. Never silently
submit unseen concatenated text. Finalize the small pending/recovery indication
under the UI design guide, without modal conflict resolution on ordinary handoff.

## Uploads and attachment ownership

Keep upload scheduling separate from draft scheduling:

| Event | Behavior |
| --- | --- |
| Select a file | Begin upload immediately, retaining existing progress and cancellation UI. |
| Upload makes progress | No draft revision or replicated progress record. |
| Upload completes | Persist its staged reference locally and request a prompt draft save. |
| Type while uploading | Save text locally and sync text normally; only completed refs are shared. |
| Submit | Await the captured submission's pending uploads under existing rules. |
| Remove an attachment | Persist a reference removal and synchronize it; cleanup respects remaining ownership. |

Another device sees completed attachments after their references synchronize.
It does not claim to display the originating device's unfinished upload. Newly
selected offline binary files surviving browser termination would require a
separate browser binary-storage feature; do not promise that from localStorage
text synchronization.

Existing building blocks are `StagedAttachmentRef`, `DraftAttachmentState`,
`draftAttachmentStaging.ts`, and server `AttachmentStagingService`. Preserve
uploaded bytes and authenticated/account-owned access. The current one-batch
envelope and validate/materialize routes must be extended behind the new gate
to support completed references from multiple batches of the same account.
Each reference already has a batch ID; do not duplicate or re-upload files just
to combine drafts. Never widen an older staging capability's meaning.

Merge additions by attachment ID. Infer removals relative to the acknowledged
base, not by unconditional union: a stale unchanged list cannot resurrect a
removed ref. For ambiguous same-attachment conflicts, prefer retaining valid
content and reporting the conflict. Validation failures leave text intact and
expose the unavailable attachment; never silently submit as though it existed.

Persist draft-to-attachment references so live drafts protect files from the
current seven-day unreferenced staging cleanup. Removing a chip must no longer
immediately destroy a file still referenced by another retained draft,
bounded recovery copy, or in-flight submission. Make staging deletion and GC
consult the ownership records, including legacy delete routes from older
clients. In-flight ownership must expire or settle; it cannot be a permanent
leak after a crash.

Session materialization currently copies staged files; Project Queue can move
their ownership. A queue transfer cannot steal files still needed by a newer
synced draft. Reuse an existing durable owner or copy at that ownership boundary
when necessary. SQLite changes and filesystem moves are not one transaction:
use recoverable preparation/commit/cleanup steps, following the existing queue
rollback pattern. Verify crashes between these steps before enabling cleanup.

## Send, clear, and recovery

Submission bypasses the debounce and captures exactly the visible text and
completed attachment set intended for that action. Typing the next message
continues immediately. Do not wait for unrelated clients to converge before
accepting a valid ordinary send, or substitute a newly merged server snapshot
for the user's captured payload.

Associate the submission with the exact synchronized revision when available.
The server clears only that revision after the normal acceptance boundary; a
newer revision survives. If synchronization conflicts or fails, preserve the
captured submission and do not clear an unrelated current draft. Keep the
post-submit recovery snapshot separate from newer editable content. A failed
send restores or offers that snapshot without overwriting subsequent typing.

Define the exact send metadata and acknowledgement boundary for each existing
delivery family before implementation: ordinary send/steer/queue, new-session
start, seeded handoff, approval feedback, question reply, and comment submission.
Use their current acceptance contracts; a draft-clear receipt is not a durable
provider-delivery receipt. Retries must not resend a user message merely to
resolve a draft-save acknowledgement. The unconfirmed-send gap stays open.

Manual clear writes a revisioned empty state. An unchanged offline copy adopts
the clear; genuinely new offline edits may be recovered/combined. Pending-send
recovery metadata is not ordinary unsent draft content and must not be imported
as a fresh draft during migration or reconciliation without checking its state.

## SQLite storage and bounded retention

Use draft-owned tables in the existing `discovery.sqlite` connection initially,
via `@yep-anywhere/shared/sqlite` and its server re-export. A separate database
is unnecessary for this scope. Reuse startup status, app-data placement checks,
append-only migrations, shutdown ownership, prepared statements, and the
Node/Bun intersection. Do not add a JSON persistence fallback or a second
storage retry loop. Drafts are durable user data, not rebuildable discovery
cache; migrations and backup/recovery must preserve them.

Store current slot snapshots, attachment references, bounded recovery records,
and idempotency receipts. Do not append a revision row for every keystroke or
retain an unlimited edit log. Bound synchronous transactions, paged enumeration,
payload sizes, receipt counts, and total recovery bytes per account. Refuse new
over-limit server writes with a recoverable error; do not evict live drafts.
Choose explicit numerical payload/byte limits before the route contract lands.

Starting retention defaults to confirm during implementation review:

| Data | Proposed retention |
| --- | --- |
| Nonempty current draft | No age expiry; clear/send/context deletion removes it. Archive alone does not. |
| Recovery versions | At most five per slot and at most seven days, subject to an account byte cap. Preserve conflict/submission recovery, not every autosave. |
| Empty-state deletion markers | 30 days. |
| Operation receipts | 30 days with an account count/byte cap and safe expired-retry behavior. |
| Unreferenced staged files | Existing seven-day grace, starting when the last protected reference is released. |
| Files referenced by live drafts | Retain with the draft; sent/queue-owned files follow their existing lifecycle. |

Counts and ages above are proposed defaults, not claims of unlimited offline
idempotency. If a receipt/base has expired, reject or return an explicit unknown
operation/base result and require reconciliation/recovery; never blindly replay
the old create or append. Use an expiring server-issued write epoch or equivalent
bounded mechanism so an old `baseRevision: null` create cannot resurrect a
purged slot after both its receipt and tombstone have disappeared. Slot
generation alone does not solve that initial-create case. The protocol tests
must prove this before retention is enabled.

One bounded, indexed cleanup owner purges expired bookkeeping and orphaned data;
no timer per draft and no scans of all transcripts. Context deletion removes
its drafts and releases references while preserving the necessary stale-write
fence. Explicit restoration of old local text cannot recreate deleted projects,
sessions, or revoked authorization. Account deletion also removes owned drafts.
Database freed pages may be reused; do not vacuum on each save or cleanup tick.
Physical file compaction, if needed, is a separate maintenance operation.

## Capability and compatibility review

Proposed capability: `draft-sync-v1`, a new permanent global ID with
`optional-bit` advertisement because availability depends on SQLite and service
readiness. Allocate the next unused ID during implementation; this document
does not reserve a number. A general SQLite status or existing attachment/
queue capability is insufficient proof of the draft contract.

Advertisement must cover snapshot reads/writes and conflict responses,
revision/generation semantics, conditional clear and send integration,
attachment batch/ownership behavior, and notifications. Avoid advertising the
complete contract while only the first surface or ownership path works.

Proposed API family for review: authenticated draft snapshot read/write,
bounded presence/index enumeration, and source/account-scoped notifications.
Exact route names, event names, schemas, send fields, and recovery operations
must be enumerated together before protocol edits. A typing hint, if included,
is ephemeral and separate from durable saves; it must not advance revisions or
require idle heartbeat loops. It is optional follow-up UX, not a prerequisite
for draft handoff.

Absent capability, disabled/failed SQLite, or an unsupported server:

- Keep existing local drafts and existing upload/send behavior.
- Issue no draft-sync requests, subscriptions, or new send fields.
- Do not reinterpret unsupported routes or silently delete unsynchronized data.
- If a previously capable server loses the service, retain the base and pending
  edits locally until revalidation/recovery; ordinary typing remains available.
- Older clients continue using their existing local draft and staging contracts.

The maintainer approved the design direction and SQLite-dependent fallback in
this discussion. The exact compatibility review is **not yet complete**: inspect
the current latest two stable server releases plus every stable release in the
preceding 14 days for this optional feature. If implementation changes a core
send semantic rather than adding a gated optional field, use the core 60-day
horizon for that change. Record actual versions, absent contracts, every gate,
and proof of zero unsupported requests, then obtain the required review before
editing the wire contract. Never reuse an older capability for new semantics.

## Implementation sequence

### 1 — Specify draft slots and finish compatibility review

- [x] Inventory all persisted input surfaces and their current submit/clear
  semantics, including local legacy formats and account/source binding.
- [x] Create the owning topic; record the approved default and conservative
  conflict behavior, plus precise handling of focused/dirty remote updates.
- [x] Finalize typed payloads, slot identities, routes/events, receipts,
  expired-base handling, send metadata, and numerical resource limits.
- [x] Review the release corpus, exact capability ownership and fallback.

### 2 — Build the shared local draft service

- [x] Add one local envelope/state machine and thin surface adapters while
  preserving local-only behavior before networking is enabled.
- [x] Persist base, current draft and immutable outstanding operation together;
  support reload, cross-tab changes, pending sends, and source/account switches.
- [x] Keep keystroke handling and persistence independent of transcript renders,
  network scheduling, and remote-state application.

### 3 — Persist revisioned server snapshots

- [x] Add append-only SQLite migrations and prepared-statement lifecycle.
- [x] Implement atomic conditional writes, no-op handling, durable bounded
  operation receipts, generations/write epochs, and authorized snapshot reads.
- [x] Add bounded enumeration, owner-scoped notifications, and disposal paths.
  Do not advertise production support until the remaining contract is complete.

### 4 — Connect background sync and conflict recovery

- [x] Implement debounce/max-wait scheduling, one in-flight operation per slot,
  lost-response retries, reconnect snapshots, and pending local draft discovery.
- [x] Implement base-aware text/structured reconciliation and safe application
  to editors. Preserve newer local typing after every acknowledgement.
- [x] Migrate all inventoried local draft surfaces through adapters; preserve
  existing server-owned review records and unrelated local settings.
- [x] Add recovery for unknown old bases and initial local/server collisions.

### 5 — Integrate attachments and submission

- [x] Support multiple same-account staging batches per synced snapshot.
- [x] Protect shared references from stale chip deletions, old-client deletes,
  TTL cleanup, queue transfers, and in-flight submission races.
- [x] Add revision-specific clear at each delivery family's acceptance boundary
  without changing submitted content or claiming durable provider delivery.
- [x] Prove failure recovery across upload, save, send, transfer and restart.

### 6 — Bound retention and enable the capability

- [x] Implement indexed cleanup with chosen caps and safe expired-retry rules.
- [x] Complete old/new client/server fallback and account authorization tests.
- [x] Advertise support only after the whole v1 contract is available; run
  capability auditing and record rollout evidence in the topic.
- [x] Update roadmap status only if this work is separately scheduled; retire
  the tactical after completion and migration of durable content.

## Verification and completion criteria

Use the [testing guide](../development/testing.md) and
[E2E boundary guide](../../topics/e2e-testing.md). Put most combinations in
state-machine/service tests; reserve browser tests for actual input and transport
behavior. Required evidence:

- Base/current/remote permutations: one-sided edits, equality, conflicting text,
  structured fields, clear versus unchanged/offline-edited text, and no-op saves.
- Lost acknowledgements, duplicate/reordered messages, repeated conflicts,
  reload with an outstanding operation, edits after snapshot capture, recreated
  slots, receipt/tombstone expiry, and expired initial creates.
- Server transaction rollback, restart durability, migration from the actual
  historical schema, malformed/newer database refusal, bounded cleanup and
  Node/Bun prepared-statement reuse. Exercise supported OS/runtime coverage.
- Multiple devices/tabs, independent browser-local host IDs, direct/relay access,
  account/source switches, grant revocation, and cross-account attachment abuse.
- Two upload batches, concurrent add/remove, failed/cancelled/late uploads,
  missing files, old-client deletion, queue ownership transfer, and crash-safe
  orphan cleanup. Staging expiry must not delete a live synced draft's file.
- Submit while sync is dirty/in flight/conflicted, subsequent typing, send
  rejection, lost send response, and attachment completion during submission.
  No acknowledged older operation may erase newer text or trigger an extra send.
- Real sequential typing with expected long-session data and concurrent stream,
  sync and upload updates: every keystroke appears within 100 ms, no dropped
  characters, no transcript render caused by ordinary draft edits. Verify caret,
  selection, undo and composition behavior; whole-field replacement is not proof.
- A focused two-browser handoff/offline/reconnect test with isolated server data.
  Include a phone-sized surface and document real mobile suspension/IME evidence
  or limitations; viewport emulation alone does not prove mobile OS behavior.
- Old-server and SQLite-disabled/error cases make zero new draft requests or
  unsupported send fields and retain current local draft/upload functionality.
- Bounded subscriptions, timers, retry queues, retained snapshots, database
  history and file references after inputs close and clients disconnect.

During source implementation, pass `pnpm lint`, `pnpm format:check`,
`pnpm typecheck`, `pnpm test`, `pnpm capabilities:audit`, and client
`pnpm console:scan`, plus the focused browser checks justified above. Follow
[UI testing](../../topics/ui-testing.md) for desktop/phone captures if UI changes.
Documentation-only planning does not claim those runtime checks have run.
