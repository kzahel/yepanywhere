# Draft synchronization

Topic: draft-synchronization

Implemented in source, 2026-09-29. The maintainer approved immediate local
persistence plus default-on synchronization on capable servers. This is a bounded
exception to [vanilla defaults](vanilla-defaults.md), not collaborative editing.

## What follows you between devices

Session composers, global/project new-session composers, the floating composer,
handoff composers, approval feedback, question “Other” fields, async-question
reply drafts, and unsent file comments use the same local draft service. Existing
surface formats are adapted rather than replacing unrelated local settings.
Question IDs and file-comment IDs/anchors remain structured; independent fields
can reconcile independently. Async-question dismissed/seen/answered metadata,
upload progress, cursor/selection/undo state, and recent prompt/upload galleries
are not shared drafts. Existing server-owned review records remain server-owned.

Drafts belong to the current server and acting account. Session/project slots
use canonical YA resource IDs, not the browser's host nickname. Account changes
switch the local cache; a limited account does not import the operator's legacy
drafts. The last known account cache remains available while offline. Server
reads/writes validate the current principal and resource access, independently
of client keys. Missing or inaccessible contexts return no draft contents.
Sharing a session does not share the owner's personal drafts.

Each accepted edit writes localStorage immediately. No request, transcript
render, or reconciliation blocks input. The client retains its local copy after
an acknowledgement. A reload while the server is unreachable restores that copy.
Browser eviction or unavailable/full browser storage cannot provide durability;
the current editor text stays in memory and a storage failure is shown when the
sync service is active. Keep that page open until storage works again.

Background writes use a three-second quiet debounce and ten-second maximum
wait during connected editing. A server change notice does not cut a pending
debounce short for ordinary drafts: that save reads the server anyway. A draft
with rendez captures refreshes immediately so later captures appear during
typing. Preempting ordinary draft saves turned each
tab's save into the other tab's immediate save, so two tabs on one draft
alternated writes on every keystroke (observed 2026-10-05: 682 accepted writes
in an hour on one session draft). Reconnect, window focus and foregrounding refresh
metadata. There is one source/account coordinator, with serialized saves per
slot, coalesced refreshes and a bounded ten-second change long-poll. Stops abort
requests and dispose listeners/timers. Session badges use paginated metadata;
opening a surface fetches its body. A session badge remains present while either
its local draft or known server draft has content. Applying a remote change or
adopting a sibling-tab value updates the local presence marker and same-tab
sidebar state immediately, including a clear deferred until the editor blurs.
No reload, extra server change, or polling is required to remove a cleared badge.
Local body changes that leave combined presence unchanged do not publish another
presence update. Typing does not enumerate all browser keys.

Closing the last editor releases an inactive draft's in-memory entry once its
local contents match the acknowledged snapshot and browser storage holds that
same value. Exact-field and multi-field observers both keep their entries live.
Dirty drafts, in-flight saves/clears, retry operations, pending remote/sibling
changes, unresolved sends/recovery, and storage failures prevent eviction. A
save that finishes after navigation releases its entry only after acknowledging
the latest local edit. Cleanup runs at editor/source lifecycle and sync completion
boundaries rather than adding a periodic sweep or work to each keystroke.

Eviction preserves browser-local draft contents and sync metadata, including the
acknowledged revision/base and recovery copies. Reopening restores that state
even offline and refreshes the remote body when connected. Startup releases
already acknowledged, unobserved entries instead of retaining every persisted
draft body; unsynchronized and unresolved work remains available to the existing
background coordinator. Source shutdown releases the coordinator's entry map
alongside its subscriptions and timers. An unchanged server metadata index emits
no duplicate session draft-presence notifications; remote presence changes still
preserve locally stored drafts, including evicted ones.

## Revisions and conflicts

An accepted changed snapshot advances an opaque UUID revision once, covering
text fields and completed attachment references together. Keystrokes, upload
chunks, duplicate requests and no-op saves do not advance it. Each immutable
write has an operation ID and expected base revision. SQLite atomically checks
the base, accepts the snapshot, and records a retry receipt; owner-scoped change
notifications follow commit. An acknowledgement only covers the submitted
snapshot, preserving text typed while the request was in flight.

The client persists its current value, acknowledged base, outstanding operation,
and submission/recovery metadata. Lost acknowledgements retry the same operation.
A stale revision returns the current snapshot. Three-way reconciliation adopts
one-sided changes, deduplicates identical changes, and keeps both genuinely
conflicting nonempty texts separated by a blank line (server text first).
Independent question answers/comments merge separately. A surviving comment
keeps its anchor even when another device removed that comment. Attachment sets
union new IDs and respect removal of a base attachment.

A remote change never replaces a focused input, its selection, or IME input.
Attachment-only reconciliation may apply while focused when the resulting
text fields are identical to the local fields. It preserves the input and
selection while allowing an incoming rendez attachment to appear immediately
after synchronization. The sibling-tab foreground guard still applies.
One-sided remote updates, including a cleared draft after another device sends,
wait quietly while their editor is focused and apply after focus leaves. They
are not conflicts and do not produce a notice. An input counts as focused only
while its window has focus: a window left with its caret in a composer still
takes another window's continuation, so returning to it shows the current
draft. An empty composer with no edits since its last save is filled even while
focused; that is a window opened to continue a draft begun elsewhere, and
holding it left the composer empty and turned the next keystroke into a
conflict. A composer identifies its draft
so focus in another composer does not pause this slot; unmarked text editors
retain the conservative focus protection. Deferred snapshots continue refreshing
on server changes, reconnect and foregrounding, rather than freezing the first
pending version. New local edits always survive a remote clear.

Sibling tabs are not another device. Every tab of an origin shares one browser
storage, so a sibling's write is the newest local value: a tab adopts it, shares
the sibling's acknowledged base, and never merges or writes its draft body or
sync metadata back. Private session presence markers can be repaired separately.
Merging it against a tab's older base and storing the result re-entered every sibling's
storage handler, appending the whole draft again on each keystroke until storage
filled and the browser stalled (observed 2026-09-30). Metadata that an earlier
build stored as a pending sibling merge is discarded on load.

The same holds for the composer above the sync layer. Rehydrating attachment
chips after a storage change restates the stored attachment state, and
restating unchanged refs is no write: the stored value, timestamp included,
stays as it was, and an unchanged value never reaches draft sync as an edit.
Hydration used to store a fresh timestamp each time, so two tabs of one session
echoed each change back and forth. After a send with an attachment, every echo
carried the stored recovery copy back into both composers, and the echo
counted as an edit in the other tab, which began a submission for a send it
never made. The sender's clear was skipped, and the delivered text and its
chip stayed in the composer (reported 2026-10-13; reproduced in
`packages/client/e2e/session-attachment-send-draft.spec.ts`).

One tab saves a shared draft: the one being typed in. A tab that receives a
sibling's keystrokes for a draft leaves its saves to that sibling until fifteen
seconds after the last one, then takes over, so a sibling closed before saving
still reaches the server. The tab holding window focus records that claim in
shared storage, and a background tab never writes server text into shared
storage while a sibling holds it; it keeps the update pending instead. Such a
write lands in the focused tab's composer through its storage event, replacing
the text with one merged from an older copy, dropping keys typed since and moving
the caret to the end (reported 2026-10-08 while typing in New session; the
server's receipts showed two clients saving the new-session slot within a
second of each other).

The tabs also share one acknowledged base, which never moves back: a tab
reconciles against the newest base any sibling stored (by server sequence), a
keystroke never rewrites sync metadata, and a Web Lock per slot serializes
reconciliation across tabs where the browser provides one. A server read older
than that base (by server sequence) is discarded unmerged. Otherwise a slow
tab's read of a prefix typed before a send, merged after the send was cleared,
came back as another device's edit and refilled the sending tab's composer
through shared storage (observed 2026-10-05). Otherwise a tab
still holding an older base saw a sibling's save of the same text as a
three-way conflict. Builds before the review UI then merged it unattended
when no text field held focus, sending the first line twice as "server text,
blank line, local text" (observed 2026-09-30, a new-session prompt typed while
another tab also held the global new-session slot).

A failed browser write shows its own notice; **Retry** writes the tab's current
value and metadata again and clears the notice once storage accepts them. A
sibling's later successful write of the same draft also clears it.
Draft notices appear beside the affected composer, never as a global Inbox or
navigation overlay. Session composers include unresolved drafts for that session's
approval feedback, question replies and file comments. When tool approval replaces
the main composer, its panel exposes the same session review, including while
collapsed. Keyboard activation inside draft review never answers an approval.
Other composers show only their own slot. Notices identify the draft kind. Navigating to another session
hides the former session's notice without discarding its text.

Genuinely overlapping nonempty text edits require explicit review, even when
unfocused. **Review draft changes** shows local and current server text plus
attachment names. **Keep mine**, **Use other version** and **Combine drafts**
affect only that draft. Combining uses the current local text and the existing
three-way field/attachment merge; it never submits to a provider. Each choice
refreshes the server snapshot first. If the server version or local text changed
while the choice was waiting, preserve both and require another review. Offline
or failed refreshes cannot apply a stale choice. **Close review** only closes
the details and preserves all drafts.

Save failures offer **Retry** without implicitly accepting a conflicting version.
HTTP 400, 403, 404, 413 and 422 responses pause automatic slot retries; unchanged
invalid payloads and missing/inaccessible contexts cannot recover by polling.
Local text remains available with the existing failure notice and **Retry**.
Editing a payload rejected with 400, 413 or 422 permits another save and does
not replay the rejected immutable operation. Network errors, rate limits and
server failures retain automatic retries. No draft contents are discarded merely
because its server context is unavailable.
Unresolved submissions offer an explicit **Recover draft** action. Failure and
recovery reviews offer **Discard draft**, which clears only that slot, including
local recovery/submission copies and queued writes. It clears its editor and
persists the discard before retrying server cleanup. Reloads, reconnects, and
sibling tabs retain that decision. Unaffected draft slots remain unchanged.
A conditional server clear retries in the background while offline; it does not
resurrect discarded text or repeatedly show its sync error. New text entered
after discard survives the clear and then synchronizes. An in-flight save cannot
restore metadata replaced by an explicit discard.
A successful server read clears a previous sync error, so a pending review or
recovery is described as such instead of remaining labeled “Sync is waiting.”
Failed reads of empty slots do not claim that a draft is saved locally. An empty
local draft does not require recovery when an old server tombstone expires.
Browser-storage failures remain visible until storage succeeds or the draft is
explicitly discarded.

An expired retry, an acknowledged base whose tombstone has disappeared, or a
reload during an unresolved send preserves local text and pauses automatic
replay. Explicit combination reconciles it against a fresh server snapshot.
Server-signed write tickets expire after ten minutes and bind the account epoch,
slot and revision. Thus an ancient initial create cannot recreate a cleared slot
after both receipt and tombstone expire. Account deletion invalidates its epoch.

## Sending and clearing

Existing action payloads and success boundaries are unchanged. A composer send
captures its exact draft, waits behind an existing draft save in the background,
and continues the existing send independently. On accepted action completion a
separate conditional clear may clear only the captured, acknowledged revision.
Another device's newer revision survives. Starting the next draft while the
send finishes preserves that new text. Failed actions restore the submission
copy alongside any newer text. A crash during an unresolved send requires
explicit recovery rather than treating the submitted text as a fresh unsent
edit automatically.

The dedicated New Session Project Queue action uses this captured confirmation
for text and staged files. Accepted queued work removes only its submitted
selection; newer edits and uploads survive. Captured cancellation checks the
account/slot and latest physical storage before releasing the submission. It
preserves current text/files exactly and keeps a differing submitted copy in
separate recovery metadata; it does not merge that copy into the live editor.
Queue ownership copies files even
before their first draft write completes, so publication and conditional clear
remain valid without making enqueue wait for synchronization. See
[Project Queue](project-queue.md#draft-acknowledgement).

Approval/question clearing and async-answer completion use their existing
accepted-action boundaries. File-comment fields disappear only when their
existing successful submission/removal updates the persisted comment set.
This feature does not prove durable provider delivery and does not close
[unconfirmed-send loss](../gaps/unconfirmed-send-loss-across-reload.md).

## Attachments

Uploads still start immediately and existing send controls wait for them.
Completed path-free staging references join the next draft snapshot. No draft
request carries file bytes or progress; an unfinished upload stays on its
originating device. Another device can send a completed reference without
re-uploading the file. A snapshot can contain several staging batches from the
same account. Validation and materialization group by batch using existing APIs.

The server validates reference ownership and physical existence before a save.
Files referenced by a current synced draft cannot be deleted by an old client,
a removed chip, or staging TTL cleanup. Released references remain protected
for seven days, covering bounded recovery. Queue transfer copies protected
originals before transferring the copies, so other drafts keep usable references;
rollback leaves originals untouched. Copies remain ordinary indexed staging
records across interruption. No project-local writes are introduced; the
[attachment storage](attachment-storage.md) policy still applies.

A failed validation request retains draft references and visible attachment
chips, including the browser-local fallback on older servers. Connection
replacement and retryable socket closure are quiet; other failures explain that
the check failed and the draft was kept. None proves that a file is missing.
A completed validation reporting a missing file retains the synced reference
and shows an unavailable notice instead of silently erasing it. Sending still validates
attachments; users can remove unavailable references explicitly. Upload bytes
that never completed are not promised to survive a browser reload.

## Storage, limits and lifecycle

Migration 008 uses the existing discovery SQLite database. Draft tables hold
user data, not rebuildable indexing caches: normal upgrades, optional feature
changes, and backups must preserve them. No separate database or JSON fallback
is introduced. Existing [SQLite startup policy](optional-sqlite.md) applies.

| Data | Bound / retention |
| --- | --- |
| Current nonempty drafts | No age expiry; up to 4,096 slots and 32 MiB per account |
| One snapshot | 256 KiB, 256 text fields, 100 attachment references |
| Recovery snapshots | Five per slot, 128 per account, seven days; at most 32 MiB at the snapshot size limit |
| Empty tombstones | 30 days |
| Operation receipts | 30 days, 20,000 per account; under pressure, tickets already expired for ten minutes can no longer replay evicted operations |
| Released file references | Seven-day protection grace |

One minute-based server cleanup owner removes at most 200 expired rows from each
retention table per pass using indexed predicates. Quota refusal retains local
text. Ordinary autosaves do not retain full history. Recovery is preserved when
combining conflicts or conditionally clearing after submission; server reads
include the retained copies for diagnostics/recovery consumers.

Deleting an account removes its snapshots, receipts, recovery and file ownership.
Archiving or hiding a project/session is not deletion and retains drafts. YA has
no permanent session/project-delete action here; missing-resource authorization
prevents reads/writes after an external removal. Such inaccessible records remain
within the account quota rather than guessing that a temporarily missing provider
transcript is permanently deleted. Existing file TTL cleanup reclaims released
bytes. Browser copies follow browser retention and are not remotely erased.

## Capability and compatibility

`draft-sync-v1` is optional capability ID 103, advertised only when the draft
store initialized successfully. The exact owned routes are POST
`/api/drafts/read`, `/write`, `/clear`, and GET `/api/drafts/index`, `/changes`.
Index pages contain at most 100 metadata entries and a continuation cursor;
change sequences and subscribers belong to the acting account. The client checks
capability and verifies the index's acting owner before sending draft contents.

Each index page reports the acting account's sequence captured before reading
its rows and before asynchronous resource-access checks. A complete client
refresh acknowledges only the first page's sequence, after all pages succeed.
An edit or clear during access checks or between pages therefore remains newer
than that cursor; the existing change watch refreshes again without requiring
another edit, focus event or reconnect. A failed or interrupted page does not
advance the acknowledged cursor. Refreshes remain coalesced under one
source/account owner, and stopping that owner aborts the work. This corrects
the existing protocol without introducing a capability, route or field.

Ordinary change-watch catch-up requests the existing index with an optional
`since` sequence filter. Pages contain only account records changed after that
cursor, including clears; they preserve the same access checks and safe
first-page acknowledgement. Partial metadata updates preserve untouched draft
presence and do not trigger reads of untouched editors. A full refresh requested
during partial catch-up waits for a coalesced full scan instead of treating the
partial result as a complete index.

Startup, foreground/focus and reconnect read the full index. A watch cursor
whose last successful refresh was at least a day ago, or whose counter is ahead
of a reset account, also rebuilds from the full index. This keeps recovery
independent of expired clear records. Earlier draft-sync implementations that
ignore `since` return their existing full pages, which can also be applied as
partial updates; ordinary full reconciliation remains available. The optional
filter uses the existing unreleased `draft-sync-v1` support with no new
advertisement. Migration 009 adds an account/sequence index without changing
draft contents, revisions, receipts or retention.

The reviewed stable corpus was 0.9.0, 0.9.1 and 0.9.2 (latest two plus all stable
releases in the preceding fourteen days, as of 2026-09-29). None supports this
contract. New clients send no draft-sync requests without the capability and
retain existing local-only behavior. SQLite off/unsupported/failed initialization
also leaves local-only behavior. Old clients continue their existing sends and
uploads; the server protects files already referenced by synced drafts. No
existing send request gained mandatory fields or changed meaning.

## Design decisions

- **Persist a draft discard** rather than a hidden-notice preference: explicit
  discard means clearing the unwanted draft. Closing review is nondestructive. A durable
  cleanup record prevents offline reload from importing the old server copy.
  The server clear uses a revision check so a concurrent edit survives.

## Verification

Store and route tests cover CAS/no-op/idempotency, persistent receipts, expired
initial creates after tombstone cleanup, account/grant isolation, forged files,
retention and attachment ownership. Client state-machine checks cover delayed
acks, duplicate retry, focused and sibling-tab changes, account mismatch,
serialized submission and a newer remote draft surviving clear. Existing surface
regressions cover their local formats and accepted-action boundaries.
Index regressions cover edits and clears between pages, automatic catch-up
without another change, unread pages after a failed request, coalesced refreshes,
and edits while server resource-access checks are awaiting completion.
Incremental checks cover account isolation, clear records, pagination, untouched
drafts and presence, a full refresh joining in-flight catch-up, old/reset cursor
recovery, and data preservation when migrating the query index.

`playwright.draft-sync.config.ts` runs the production source coordinator,
capability gate and local persistence hook against real draft HTTP routes and
SQLite in two isolated browser contexts. It covers handoff, conflict acceptance,
server-offline reload, reconnect, send/next-draft races, and zero draft requests
to an older server. The handoff runs with 3,000 cleared session draft records.
Its change-watch responses contain only the changed prompt, not the old clears.
History preparation runs before browser interaction in the owned fixture.
CI 36921363093 spent 74.6 seconds performing its 6,000 real save/clear writes,
exhausting the old interaction budget before a page opened. Setup now has a
300-second budget (4x that observation) and yields between 100-row batches.
The interaction budget remains 60 seconds, with the same history and input gate.
[CI 36926705404](https://github.com/kzahel/yepanywhere/actions/runs/36926705404)
prepared that unchanged history in 15.5 seconds and passed the handoff in
22.9 seconds; all 361 browser cases passed without retries.
Sequential key events under 1,000-row concurrent activity
assert every input acknowledgement stays below 100 ms. The phone-send sequence
checks quiet focus protection, clearing after blur, and persistence through reload.
State-machine checks cover latest pending snapshots, stale review choices and
per-draft resolution; component checks cover session isolation, previews and
explicit discard. Desktop 1000×600 and phone 375×812 captures exercise inline
conflict review. Local verification
uses macOS, Node 24 and bundled Chromium; Linux/Windows runtime validation remains
with the existing portable-runtime CI matrix. Native mobile upload suspension
is not simulated by the browser fixture.
