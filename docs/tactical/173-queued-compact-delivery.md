# Queued compaction followed by input

Status: implemented and independently accepted, 2026-11-03. The maintainer selected the bounded
existing-session workflow and one Opus 5.5 High implementation review through
the AAR Work pool with bypass permissions, followed by a commit.

## Outcome and stopping point

While Claude or Codex is working, queue `/compact`, then queue a message.
YA waits for the selected delivery boundary, runs compaction, waits for its
terminal readiness evidence, and delivers the next message once. Compaction
is a distinct identified entry, never joined or steered as prose. Cancellation
before dispatch removes only that entry. Failure holds later work visibly;
unconfirmed execution is never retried automatically or released by a timeout.

Use Process's existing regular/patient queues and the existing AgentSession
provider owner. Preserve patient readiness and ordinary queue durability.
Pending patient commands survive paused recovery; started operations are not
silently replayed. No new core package, provider refresh, wake migration,
Project Queue migration, restart-helper unification or remote placement.
The archived plans 158/159 are evidence, not a continuation sequence.

## 1 — schedule compact at an existing session boundary

Keep the command envelope and queue identity, isolate it from joining,
interrupt drains and steering, and reserve later input until the provider
reports both compaction outcome and turn completion. Preserve failure and
uncertainty explicitly. Use controlled provider protocol and Process tests.

## 2 — preserve composer queue intent

Queue submission bypasses the immediate compact handler only on servers
advertising `queued-session-compaction`. Existing message/deferred endpoints
and queue projections carry the operation; ordinary manual compaction remains.
The additive summary identifies compact and whether cancellation is safe.
Older servers retain manual compact and refuse delayed compact locally, without
sending an unsupported write. Core stable review corpus on November 3 is
0.8.1, 0.9.0, 0.9.1, 0.9.2, 0.10.0, 0.10.1, 0.10.2 and 0.11.0;
none implements this scheduling contract. No existing capability is broadened.
The requested explicit Queue action changes scheduling only when invoked.

## 3 — qualify and review the completed workflow

Retain meaningful completion-versus-boundary, failure, ordering, cancellation,
patient and retained-owner regressions. Verify the actual composer with real
sequential typing under concurrent updates at desktop and phone sizes. Use
owned profiles, bundled Chromium and repository artifact captures. Run required
workspace checks and one requested implementation review; address material
findings before committing. Record measured verification and remaining limits.

## Verification checkpoint

The focused Process/patient/native protocol group passes 59 cases in 6.42 s.
The native protocol tests distinguish boundary from terminal completion, prove
changed thinking settings do not replace the compacting provider, and retain
failed work until explicit cancellation. The portable native matrix now runs
the compact protocol, Process and Supervisor cases on Linux, Windows and both
macOS hosts. That expanded hosted matrix has not run for this local commit.

The owned worker/browser case uses 1,000 native transcript records, a real
production UI, pending queue reload, and an older-server advertisement with
zero unsupported POSTs. The final case passes in 13.3 s (45.9 s with builds/setup/teardown), without
retries. All 43 sequential keys appear within 23.7 ms while metadata updates and
compact completion overlap. The viewport captures assert both queue entries
are on screen after a real scroll gesture, including after phone resize. Desktop and phone captures are in
`.artifacts/ui-testing/2026-11-03-queued-compact/`.

The actual pinned Claude CLI with exact catalog model `claude-haiku-5-5`
passed in an owned AAR Work-claude profile: prior assistant reply at transcript
position 22, one compact boundary at 24, then the unique follow-up reply at 41.
An initial alias-model launch failed before this workflow; no alias repair or
provider refresh was attempted. Owned integrations are revoked at teardown.

Root lint, formatting, typecheck and console scan pass. Full workspace tests
pass: server 6,928 with 74 skips; client 7,081; shared 967; relay 139; push 45.
The final full workspace run includes all review repairs.
Existing negative-fixture diagnostics remain tracked in
`gaps/full-suite-timing-and-diagnostics.md`; focused touched cases are quiet.
The requested Opus 5.5 High implementation review ran through the AAR
Work-claude pool, weekly-pace, bypass permissions, in owned profiles. The
initial findings and bounded correction check belong to this same logical
implementation review; the corrected implementation received **ACCEPT**.

## Implementation review and repairs

Opus 5.5 High reviewed the implementation through AAR Work-claude, weekly-pace,
bypass permissions. Its report is retained in ignored
`tasks/queued-compact-delivery/opus-review.md`. It found two blockers: native
refusal did not release the operation and retrying Codex frames incorrectly
failed successful compaction. Both have direct and real-adapter regressions.
A broken dispatch transport remains uncertain; only definitive native refusals
become cancellable. The pinned `rust-v0.166.0` compact handler was inspected:
its JSON-RPC error paths precede accepted compact submission. No provider
version, protocol schema or supported runtime was refreshed.

The same review identified bounded retention/recovery holes. Repairs prevent
Claude compact dispatch during retained work and ignore pre-consumption results,
allow late success after an unconfirmed deadline, apply pending effort on failed
compact cancellation, restore pending compact through no-input reactivation after
hard abort, and exclude started compacts from restart preservation. The focused
repaired group passes 31 cases in 6.26 s without warnings. Stop remains available
while a compact reservation is unconfirmed. These extend the selected workflow;
no archived architecture was restored.

## Final acceptance

The correction check accepted B1/B2, all five bounded follow-ups and the
self-audit repair, with no remaining material defects. It read source and
relied on the author's focused execution evidence rather than rerunning full
suites. Its report is in ignored
`tasks/queued-compact-delivery/opus-review-followup.md`. Both reviewer
allocations verified Opus 5.5 High, bypass permissions and Work-claude with
weekly-pace; their integrations were revoked and owned servers disposed.

After the corrections, the actual pinned Claude CLI workflow passed again,
with one compact boundary and the following answer, and complete cleanup.
Codex qualification uses the real YA adapter against controlled protocol
fixtures; a live Codex model/compaction run is not claimed. The full workspace,
static gates and final browser case pass. Focused desktop and phone captures
were inspected separately; compact, its waiting follow-up, input and Stop are
visible at both sizes. Final SDK checks pass 80 cases with four environment-gated skips in
17.59 s. Exact-file checks and E2E TypeScript checking also pass. Project Queue and the archived general core remain outside this cut.
