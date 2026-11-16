# An unconfirmed New Session request can block later submissions indefinitely

The November 16 work-MacBook report shows New Session refusing both changed
prompts and provider/project changes with “Check the earlier unconfirmed
creation before submitting another request.” Repeated Check saved session
actions show only “Creation is still unconfirmed. Keep this draft and check
again.” The original request failure was not captured.

`packages/client/src/lib/sessionCreation.ts` writes a pending request to
localStorage before POST. A different later intent is refused locally. Only
HTTP 400 with `reason: creation-not-accepted` clears the pending record on
failure; other failures attempt a read and retain it if recovery fails.
`NewSessionForm.tsx` catches every Check saved session failure and replaces its
status/message with the same generic toast, without another recovery action.
Consequently a request rejected before durable admission can leave the form
blocked, although later launches would otherwise work. Some creation-route
validation responses lack that explicit non-admission reason. This is a
code-level failure path, not proof of which response began this incident.

Read-only investigation found:

- The configured work peer's v0 API and SSH over Tailscale were reachable.
- The work checkout was `43b0e9cb5`, with a clean working tree.
- At investigation time, its latest pre-diagnostic saved creation was at
  16:53:25 UTC; the screenshots were around 17:14–17:15 UTC. Its creation store
  contained no November 16 payload matching the displayed question.
- A new v0 Claude/Opus creation at 17:20:37 UTC proved native input consumption
  and returned the exact requested smoke-test reply. This qualifies that API
  path, not the affected phone's hosted-browser transport or pending request.
- No server errors were recorded after 17:00 UTC. Browser diagnostics had no
  log directory. The initial HTTP/transport error was unavailable.

## Physical-phone diagnosis and local recovery

With the operator's authorization, Wi-Fi ADB and Chrome DevTools reached the
Pixel 9's Android Private Space Chrome, separately from its ordinary Chrome
process. The affected New Session tab had exactly one pending creation record:
an unacknowledged November 13 request containing the short prompt “Push to
remote,” rather than the question in the November 16 screenshot. Its record
had no receipt. An exact request-key lookup across the work server's creation
store returned no rows. The pending key covered the source/account's New
Session draft, so changing provider or selected project could not bypass it.

The operator-authorized local recovery backed up that record and the New
Session draft storage privately, then removed only the stale pending key. A
reload showed zero pending creation records, no unconfirmed warning, and the
normal empty New Session form. No other draft or login storage was cleared;
the old prompt was never replayed. The operator subsequently navigated the tab
to existing work, so a new phone-form submission was not performed. The API
smoke's successful answer and verified process shutdown remain separate
evidence. This local reset does not repair the product's recovery workflow.

## Original outage and causal limits

The retained browser timestamp is November 13 at **19:40:35.402 UTC**. The
work server's rotated log establishes this sequence:

- 19:40:24: the phone reconnects and advertises client build `95ce327`.
- 19:40:27.262: the server receives an API restart request, then shuts down.
- 19:40:29.091 and 19:40:29.975: both replacement starts fail in
  `ApiReceiptStore.recoverInterrupted()`. Its receipt decoder rejects a
  persisted command kind outside the then-current schema.
- 19:40:35.402: the browser records the pending creation.
- November 16 at 06:50:01: the next startup appears in the retained log.

Commit `576e60a91` independently diagnoses that server-startup defect: old
`sendMessage` receipts outlived the rename to `prompt`, and a strict decoder
let one legacy row abort app startup. It added tolerant startup/list reads.
Subsequent `ae9a16cd1` makes v0 receipts process-local and drops their SQL
table. That backend repair is already in current source. The browser lock
survived server recovery.

The outage is established and closely precedes the pending request. The exact
first browser transport exception was not retained, so its wording and
dispatch phase remain unknown. The missing request-key row and outage timing
strongly support a request that never reached durable admission; they do not
turn arbitrary future GET 404 responses into safe replay permission.

## Current-code reproduction and affected paths

A temporary diagnostic invoked the actual `acceptSessionCreation` helper with
controlled transport failures, without starting a provider or changing source.
It established:

| Initial result | Pending retained | Later corrected input |
| --- | --- | --- |
| Transport interruption, recovery missing | Yes | Refused before another POST |
| HTTP 400 without non-admission reason | Yes | Refused before another POST |
| HTTP 403 | Yes | Refused before another POST |
| HTTP 410 | Yes | Refused before another POST |
| HTTP 400 with `creation-not-accepted` | No | Another POST permitted |

An additional check kept the original text/options but changed only
`options.creationProvenance.clientVersion`: the helper rejected the request
locally. `creationIntent()` excludes volatile composition fields but compares
the entire options object, including build provenance. A frontend upgrade can
therefore defeat the helper's otherwise-supported same-intent retry. Recovery
must use the frozen original request rather than require users to reconstruct
its incidental metadata or old settings.

The server's project and detached creation routes have several early validation
responses without an explicit non-admission reason. The helper's narrow clearing
branch consequently does not cover all ordinary refusals. A blanket numeric-status
rule would also be insufficient: earlier concurrent attempts and accepted/deleted
operations need their own evidence.

The same helper serves Session-page Start through `sessionComposerSend.ts`.
`SessionComposerFooter.tsx` exposes a receipt read and the actual error, but no
way to resolve a permanently missing/deleted operation. New Session additionally
hides all recovery failures behind one generic toast. The problem is shared
creation ownership, not one button or one provider.

The two existing helper tests passed in 0.228 seconds. They cover unchanged
same-key retry and an accepted request's lost reply; one deliberately asserts
that changed input stays blocked. Existing browser checks cover lost acceptance
that later becomes readable and explicitly tagged attachment refusals. Those
checks do not establish recovery from never-arrived requests, unavailable or
deleted receipts, or a frontend update while uncertainty persists.

The adjacent [template recovery gap](template-creation-restoration-can-lock-form.md)
has a separate implementation of a similar retained-request/form-lock problem.
The [send-loss gap](unconfirmed-send-loss-across-reload.md) remains a distinct
delivery-proof problem; this investigation does not claim a whole-app audit.

## Recommended repair boundaries

- Preserve unresolved operations independently of the active draft. An old
  uncertain creation must not indefinitely prevent unrelated new work. Offer
  read/open, restoration/copy of saved input, retry of the exact saved operation
  where qualified, and an explicit way to retain that uncertainty while starting
  independent work. Do not silently replay the old prompt.
- Represent accepted, definitively refused, still preparing, unavailable and
  unknown outcomes distinctly. Preserve status/reason/time and the first
  failure, rather than converting every recovery failure into the same toast.
- Add an atomic server resolution/fencing operation if the product promises
  that an absent request can be safely abandoned and replaced. A GET miss can
  race pre-admission work; the fence must serialize with admission and survive
  restart. Reuse the current creation owner, not another launch engine. Any new
  route/semantic needs its own reviewed capability and older-server fallback
  under the existing core compatibility horizon before implementation.
- Validate/version local recovery records, preserve malformed records for
  recovery without letting them lock the form, and review sibling-tab ownership
  and publication. Record bounded nonsecret operation metadata (identity, build,
  phase, time, status/reason) so an outage leaves usable diagnostic evidence.
- Exercise the two meaningful network boundaries: request never admitted and
  accepted request whose reply was lost. Include reload/client update, corrected
  input, delayed admission racing resolution, deleted receipt, source/account
  changes, sibling tabs and malformed storage at the cheapest useful layer.
  Acceptance must prove retained drafts/files, no accidental duplicate launch,
  real sequential typing, and an accessible route back to independent creation.

Preserve the request identity and draft while exposing the recovery failure's
useful status. Audit explicit pre-admission refusals against the durable
[creation contract](../topics/session-identity.md). A recovery operation must
resolve that original identity safely; a missing receipt alone must not cause
automatic replay or clearing while admission may still be in flight. Do not
clear all browser storage as a workaround: that also risks unrelated drafts.

This differs from the remaining asynchronous draft-clear paths in
[the draft-clear gap](new-session-draft-clear-captures-after-submission.md) and
the later-turn delivery uncertainty in
[the send-loss gap](unconfirmed-send-loss-across-reload.md).

Found 2026-11-16 while investigating work-MacBook session creation failures.
