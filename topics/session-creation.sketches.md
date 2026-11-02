# Session creation, acknowledgement and navigation — proposal

Status: creation/navigation proposal recorded 2026-11-01; the maintainer then
selected [YA-owned session identity](session-identity.md) as its foundation.
Persist a session before provider startup and keep its public id and failure
history even when no provider session/transcript exists. This reopens the
new-session portion of [plan 150](../docs/tactical/150-ya-owned-session-ids.md#november-1-selected-follow-up),
not its entire fork/clone program. The November 2 ordinary Claude/Codex text
workflow is implemented; broader proposal and release qualification remain
pending. Exact API/capability and evidence boundaries live in
[the identity contract](session-identity.md#qualified-claude-text-acceptance--november-2). The
[roadmap](../docs/roadmap/README.md) records scope and priority.

## Active implementation scope — November 2

The maintainer selected a narrow first milestone: ordinary Claude and Codex text
creation, including routed/account-pinned Claude, saved before provider startup,
a stable session URL, visible startup/failure/uncertainty and prompt access after
refresh. Safe acknowledgement preserves newer drafts. Claude accepts a chosen id;
Codex's native thread id is an explicit binding. [Plan 171's active milestone](../docs/tactical/171-durable-session-identity-and-creation.md#active-milestone--claude-and-codex-creation-november-2)
records the three larger implementation slices and focused/browser qualification.

Attachments, automated retry, other-provider/caller rollout and the optional
background action/shortcut remain later work. The broader proposal below is
retained as direction; it is not a prerequisite to deliver this first milestone.
Use a narrowly gated text-creation contract without claiming the complete
`session-creation-receipts` guarantee. Existing-server fallback remains required.

## Problem and retained legacy behavior

Before this milestone, New Session coupled request submission, provider startup
and navigation. The retained legacy paths below still have that coupling.
`NewSessionForm.handleStartSession` waits for the start response, clears the
draft and opens the returned session. Attachments use a longer sequence:
create a message-less provider session, materialize/upload files, then queue
the initial message before navigation. Failure can leave only part of that
sequence completed.

The ordinary Supervisor launch path waits for provider identity, with a
five-second fallback in `Process.waitForSessionId`. A response and session URL
therefore do not establish successful provider startup or prompt delivery.
New Claude sessions already use a YA-chosen id; other providers can still
replace a provisional id through the explicit
[remap contract](session-id-remap.md). The historical flow in that topic is
qualified by the newer Claude behavior in
[plan 150](../docs/tactical/150-ya-owned-session-ids.md).

On November 1, a routed Claude launch selected its account successfully but
failed before the browser subscribed: the running server retained SDK
0.3.309 after installation replaced its executable with 0.3.312. The SDK
reported “Claude Code native binary not found.” The process error was emitted
before session registration/subscription, and the wrapped message did not
match the fatal-error classifier's `ENOENT` check. YA subsequently showed an
empty session as in-turn, although its provider process was dead.

The original prompt survived in SQLite session metadata as `initialPrompt`,
independently of a provider transcript. That is useful recovery data, not a
durable launch operation or proof that the provider received it.

Existing work to preserve and extend:

- [Session liveness](session-liveness.md): visible attention states and
  recoverable initial prompts even when startup precedes transcript creation.
- [New-session draft acknowledgement race](../gaps/new-session-draft-clear-captures-after-submission.md):
  capture the submitted draft before asynchronous work; acknowledgement must
  not clear newer text from this tab, another tab or another device.
- [Unconfirmed send loss](../gaps/unconfirmed-send-loss-across-reload.md):
  distinguish acceptance, delivery and uncertainty across reload/restart.
- [HTTP v0 creation receipts](http-api-v0.md#creation-and-retry-receipts):
  durable retry identity and admission observations before native startup
  completes. This is a precedent to reuse, not an existing web guarantee.
- [Core house cleaning](core-house-cleaning.md): improve the retained creation
  lifecycle without adding a managed workflow or delegation subsystem.

## Proposed user behavior

Separate durable request acceptance, provider startup and navigation.

| Action | Proposed behavior |
| --- | --- |
| Create and open | Save the request, then open a view showing its startup progress; do not wait for provider readiness to show that view. |
| Create in background | Save the same request, stay on the form, and show confirmation with Open/status access. |
| Command-Enter | Invoke Create in background when that option is enabled. |
| Ordinary submit | Retain the existing intent to open the created session, including existing Enter/newline preferences. |

Provide a visible button/menu alternative for touch and keyboard discovery.
Keep background creation configurable and default-off under
[vanilla defaults](vanilla-defaults.md) unless a later product decision
explicitly changes that default. The maintainer's requested shortcut is
Command-Enter; do not casually reuse Ctrl-Enter, which already serves Project
Queue and full-pane submission. Respect IME composition and do not submit
from unrelated controls.

After background acceptance, retain project/provider/model/options, clear only
the submitted draft and its attachment selection, and focus the composer for
another request. Keep input acknowledgement independent of launch/status work:
every sequential keystroke must appear within 100 ms during concurrent
creation and status updates. A later startup success or failure must never
navigate the user away from newer work. Navigating away or closing the tab
after acceptance must not itself cancel the server-owned attempt.

Before acceptance, failures leave the draft recoverable. If acknowledgement is
lost, display an unresolved submission and recover its original identity;
neither clear the text as successful nor offer a blind duplicate submission.

## Proposed acceptance and recovery guarantees

### Own the session before launching the provider

The durable object is a YA session from the first accepted save. Its permanent
YA id is the URL/API identity; provider-native ids are stored bindings, not
replacement public ids. Startup attempts, including failures before native
identity or transcript creation, belong to that same session. An explicitly
authorized retry after known failure may create another attempt without
creating another logical session. Uncertain effects must be reconciled first.

[Session identity](session-identity.md) owns this selected direction, the
existing-data boundary and the dated compatibility audit. It keeps native
transcripts authoritative for conversation history. This proposal owns the
creation/draft/attachment/navigation behavior built on that foundation.

### Persist the request before acknowledging it

Persist the submitted prompt, exact launch settings, project/provider choice,
caller ownership and durable attachment references before launch side effects.
An acceptance response means YA retained enough information to inspect and
recover the attempt. It does not mean the provider started, received the
message or produced a response.

A receipt alone is insufficient: the current HTTP v0 receipts deliberately
contain no prompt bodies or credentials. Reusing that mechanism must include
an explicit durable owner for the request payload and attachment references.
Do not claim that today's `initialPrompt` metadata preserves the whole launch.
Keep provider/router secrets in their existing private stores.

Validate attachments before acknowledging, retain them while the accepted
attempt needs them, and make retry reuse those references. Avoid leaving a
live empty provider solely because an upload or first-message step failed.
Use existing app-data storage and attachment ownership checks; this proposal
does not authorize new project-local files. Define retention, deletion,
capacity refusal and cleanup ownership before implementing the store.

### Retain one creation identity through startup

Use a caller-generated request identity scoped to the authenticated owner and
YA source. Repeating the same request recovers its original receipt/result;
conflicting payloads are rejected. A lost response or page reload must not
cause a second provider launch merely because the client retried.

Revalidate existing authorization, provider availability, sandbox constraints
and router eligibility at the appropriate admission/dispatch boundaries.
Resolving an authorized existing request must precede deciding whether it
could be newly admitted today. Receipt access conveys no new session or
project authority. Share incumbent launch/admission services rather than
creating an alternate authorization or process owner.

The YA session and its acceptance receipt can exist before a provider-native
id. Record the native binding when established, without renaming the public
session. The ordinary session URL should reopen its saved startup state after
reload; detailed route/representation choices remain pending. Preserve the
existing explicit remap behavior for legacy paths and older servers until
their replacements are qualified and their compatibility code may retire.
Do not migrate existing public ids or require the deferred fork/clone redesign.

### Keep saved, starting and delivered distinct

Expose durable startup progress/errors in the startup view, session page and
relevant list/confirmation surfaces. Useful descriptions include saved,
waiting for capacity, starting, failed and uncertain. Provider readiness and
first-message admission/delivery are separate observations; a running process,
optimistic user bubble or ordinary HTTP success is not delivery proof.
Finalize names and their mapping to the shared receipt state machine before
implementation rather than silently redefining HTTP v0's existing states.

Detect fatal startup failures even when the provider SDK wraps an underlying
spawn error. A dead provider must not appear in-turn or continue accepting
messages into a dead process queue. Preserve the failure for clients arriving
after the original event, including after server restart; a transient toast or
live-only error event is insufficient. Keep transport reconnect failures
distinct from provider/session failures.

Show a concise explanation and recovery action, with safe technical details
expandable. For the observed failure, explain that Claude's executable could
not be found and the server needs reloading. Say “Your prompt is saved” only
when durable payload evidence supports it, and provide Restore prompt/Copy.
Do not expose credentials, token-bearing spawn arguments or raw stderr.

Explicit retry after a known failure must preserve the original settings and
committed router account pin; it must not silently choose direct credentials
or another account. Distinguish retrieving/retrying the original request from
deliberately starting another attempt after a definitive failure. If a launch
or first-message delivery may already have happened, reconcile the existing
attempt and show uncertainty; do not automatically launch or send again.
Restart recovery is not permission to replay ambiguous side effects.

Use bounded server-owned dispatch and existing activity/status subscriptions.
Do not add a poller per attempt or keep an idle provider alive just to watch
creation. See [architecture mandates](architecture-mandates.md).

## Compatibility boundary

Propose one named capability, provisionally `session-creation-receipts`, for
durable web request acceptance, retry identity, recoverable status/errors and
the eventual session result. Allocate its id from the live ledger only when
implementing. Use `version-implied` if every official release from its
introduction supplies the contract; source builds advertise early support
explicitly. Use an optional bit instead if support deliberately varies by
build/configuration. No protocol-version bump is currently proposed.

| Peer combination | Required behavior |
| --- | --- |
| New client, capable server | Use the new acceptance/status contract for both navigation choices. |
| New client, older server | Use today's endpoints and wait for their ordinary response. Background creation only suppresses navigation afterward; it adds no durable retry guarantee. |
| Older client, new server | Preserve the existing endpoints' response shape and meaning, including their session/process fields. |

The navigation choice and Command-Enter are client-only and need no server
capability. Safely optional error fields may use absence as their fallback;
they must not become prerequisites for unsupported writes or retries.

Do not send new creation requests, request fields or status reads before the
new capability is established. Prefer a new route or explicitly negotiated
mode; never unconditionally replace a session/process response with a pending
receipt. Do not broaden `agent-api-management`, whose default-off agent API
authorization is independent of ordinary web creation. Share implementation
underneath while preserving those public boundaries.

The [November 1 identity audit](session-identity.md#compatibility-research--2026-11-01)
inspected the core release corpus and records legacy creation responses,
filename-derived refresh assumptions, transcript-less reads and upgrade risks.
It recommends this gate/fallback without claiming passing skew qualification.
Before editing the runtime contract, refresh that corpus if releases changed
and settle the actual routes/fields/semantics, support check and absent-support
behavior under the
[capability review rules](server-capabilities.md#minimum-compatibility-horizons)
and [hosted compatibility](remote-hosted-compatibility.md). Track fixed fallback
retirement under the repository's 90-day rule. Existing advertised capability
meanings remain unchanged.

## Suggested implementation order and acceptance evidence

[Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md) expands
the identity/creation foundation into reviewed implementation slices with an
owned standalone profile. Optional background creation follows that foundation;
the numbered outline here describes the broader product sequence.

1. Fix fatal startup classification/state and retain a safe failure snapshot
   for late subscribers. Exercise failure before subscription and after
   refresh/reconnect, including the wrapped missing-executable case.
2. Implement [YA-owned session identity and startup lifecycle](session-identity.md)
   through shared admission services: persist session/payload/receipt ownership
   before dispatch, bind native ids without public renames, and make saved or
   failed sessions readable without transcripts. Prove response-loss retry,
   conflicting request reuse, discovery deduplication, existing-link continuity,
   restart at side-effect boundaries, capacity refusal, router pin continuity
   and ambiguous-outcome handling without duplicate launch or delivery.
3. Bring attachment creation through the same acceptance boundary. Exercise
   interrupted staging/materialization and first-message failure, retaining
   the correct user's files without an unintended empty running session.
4. Add open/background presentation and draft capture/clear behavior. Cover a
   delayed acknowledgement with intervening local, sibling-tab and remote
   edits; failure/reload recovery; and no late navigation after source/page
   changes. Reproduce real sequential typing under expected data volume and
   concurrent updates with the unchanged 100 ms bound.
5. Qualify the new/old client-server matrix, capability advertisement and
   absence fallback. Verify desktop/phone layouts and startup recovery through
   the repository's artifact capture facility when implementing the UI.

These are proposed slices, not approval to implement or a claim of existing
coverage. Endpoint/schema shape, receipt/payload retention and bounds,
provider qualification, startup-view routing and failed-attempt retry
semantics need concrete decisions before code changes. Cancellation and
automatic restart policies are separate work. Permanent ids for new YA-created
sessions are selected; bulk replacement of existing public ids, the full
fork/clone redesign, a new scheduler, cross-account continuation and managed
delegation are not required by this proposal.
