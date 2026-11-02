# New-session acknowledgement can clear a newer unsent draft

**Impact: high — unsent text loss across devices or sibling tabs.**

`NewSessionForm.handleQueueProjectSession` captures the request text before
awaiting project resolution/enqueue, but calls `draftControls.clearDraft()` only
after acceptance. The ordinary new-session start paths have the same boundary.
They do not mark/capture the draft submission before the asynchronous action.

`useDraftPersistence.clearDraft` calls `confirmSyncedDraft` and unconditionally
removes the current editor/storage value. With no existing submission marker,
`DraftSyncClient.confirm` captures the draft **at acknowledgement time** and
`beginSubmit` flushes that value. A remote or sibling draft adopted while the
request waits therefore becomes the supposedly submitted snapshot; the clear
can delete it locally and on the server although it was never sent.

The form disables its textarea during startup, but that does not freeze draft
storage subscriptions or prevent a remote update from being adopted after focus
leaves the disabled editor. The main-session composer uses the earlier
`clearInput`/pending-send capture and is not evidence for this form's safety.

## Evidence

A focused `DraftSyncClient` reproduction used the form's call order:

1. Save and acknowledge `sent request` as the common draft base.
2. Begin the external start/enqueue action without marking a submission.
3. Another device saves `other device's unsent request`; normal reconciliation
   adopts it before the action finishes.
4. Confirm the earlier action using `confirm(key)`.

The server draft became empty, rather than preserving the other device's unsent
request. This is a state-machine reproduction plus caller inspection, not a
full-browser reproduction. The existing newer-revision test marks `pendingSendAt`
before confirming, so it covers a different call order.

Owning contract: [`draft-synchronization.md` — Sending and clearing](../topics/draft-synchronization.md#sending-and-clearing).
Relevant code: `packages/client/src/components/NewSessionForm.tsx`,
`packages/client/src/hooks/useDraftPersistence.ts` (`clearDraft`), and
`packages/client/src/lib/draftSyncStorage.ts` (`beginSubmit`, `confirm`).

Capture the exact draft and slot at action ingress without making draft sync
block delivery. Acceptance must clear only that captured submission; preserve
any newer local/remote draft. Add a caller-level regression with a delayed
enqueue/start response and an intervening remote or sibling edit, including
failure/reload recovery. Other callers that confirm without an earlier capture
need the same review before reusing a generic fix.

Not fixed during the attachment-ID repair: this requires a separate client
submission-lifecycle change and its input/concurrency verification.

Found 2026-09-30 while auditing draft sync after a failed Project Queue enqueue.

2026-11-02: qualified ordinary Claude text acceptance captures its draft before
async work. Focused hook and real browser delayed-ack checks preserve newer edits
and slots and avoid navigating away from newer work. A real account-scoped sync
coordinator regression also checks physical storage before clearing when a
sibling storage event is delayed. Recovery retains the accepted operation until
the owning form settles its draft. Legacy attachment, Queue
and other creation paths above remain open; this narrow migration does not close
the gap.
