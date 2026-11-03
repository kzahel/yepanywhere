# Remaining creation paths can clear a newer unsent draft

**Impact: high — unsent text loss on the remaining asynchronous clear paths.**

Ordinary durable admission and the dedicated New Session Project Queue action
now capture text/files before asynchronous work and conditionally acknowledge
only that snapshot. Queue checks cover unchanged clearing, acceptance during
real typing/concurrent updates, sibling attachment-only edits, refusal/reload
recovery and publication of the newer draft. Source/account retirement and
pending speech ownership are fenced. A queue ownership race discovered by the
publication check is also repaired: sync-enabled staging copies originals even
before their first draft write completes.

The remaining `NewSessionForm` callers still clear at acknowledgement time:

- Supported older-server `createLegacySession` fallback.
- Custom `launch.submit` forms (such as editable handoff).
- Inline template `onStarted` completion.

Each can receive newer draft/storage changes while its asynchronous work waits.
An unqualified `clearDraft()` then captures/clears the current revision rather
than the text/selection actually submitted. Review those callers against
[draft synchronization — Sending and clearing](../topics/draft-synchronization.md#sending-and-clearing),
using the existing captured-submission owner and preserving each caller's
success/failure contract. Do not reintroduce another creation engine.

The original September reproduction proved that confirming without an ingress
capture can erase another device's newer server draft. Later ordinary creation
and Queue migrations preserve meaningful physical-storage/revision-race tests;
their successful qualification does not close these remaining callers.

The related [unconfirmed send gap](unconfirmed-send-loss-across-reload.md) remains
separate: Queue has no new browser enqueue receipt, and an uncertain response
must not be treated as proof that another enqueue is safe.

Found 2026-09-30 while auditing draft sync after a failed Project Queue enqueue;
narrowed 2026-11-03 after captured ordinary creation and Queue acknowledgement.
