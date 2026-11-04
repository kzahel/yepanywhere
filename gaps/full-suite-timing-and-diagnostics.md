# Full server suite has timing failures and unasserted diagnostics

2026-11-04: native-provider expansion passes the full workspace (6,939 server
cases, 140.99 s). The 22-case Codex OSS services/cold-resume group passes in
3.38 s but retains existing negative-fixture diagnostics: `Codex exited with
error` for exit 7 / `controlled exec failure`, and `Process terminated` for a
finite provider iterator. Native executable scenarios pass without these
warnings. Assert diagnostics in their owning negative fixtures; suppressing the
shared logger would hide unrelated provider failures. Evidence is in ignored
`tasks/native-provider-implementation/{oss-focused,workspace-core}.log`.

2026-11-03: retiring the mock-only Process queue passes the full workspace
(6,926 server / 7,081 client; server 142.36 s). The comparable Process group
passes without warnings before and after removal: 207 cases / 1.69 s before,
205 cases / 1.59 s after, with two retired-path assertions removed. These are
single local samples, not a CI performance claim. The expanded 263-case group
also includes native identity/media/resume fixtures that log `Process terminated`
for finite iterators and intentional termination/API-error paths. Evidence is in
ignored `tasks/legacy-path-retirement/` under `process-before.log`,
`process-after-comparable.log`, `queue-focused.log` and `queue-workspace.log`.
Asserting each intentional diagnostic or changing iterator lifecycle belongs to
those individual fixtures; blanket interception in the shared fixture would
hide unexpected failures. No logger or production warning policy is changed by
the queue retirement. The full run retains the independent negative-fixture
diagnostics recorded below.

During issue #121 validation, `pnpm test` on macOS completed the server suite
with 4,689 passing, 53 skipped, and three failing tests:

- `test/supervisor.test.ts`: `probes provider status for long-silent active
  sessions` exceeded 5,000 ms; `emits a public remap when init follows the
  provisional ID timeout` failed at line 6656 with `Timers are not mocked`.
- `test/api/codex-compact.test.ts`: `rejects direct compaction during a turn
  without replacing the process` returned 200 instead of 409 at line 332.

An immediate focused rerun of both files passed all 13 Codex compaction tests,
while the supervisor file again timed out on the active-liveness probe and on
`requires verified idle liveness before queueing a synthetic turn`. It also
reported unmocked timers in the provider-retention test and an ownership
assertion failure in `keeps an idle owner registered until provider abort is
verified`. The shifting failures suggest timer interference but do not prove
its cause. The active probe fixture advances 330 seconds while its provider
iterator polls every 10 ms; investigate a deterministic deferred iterator and
ensure timed-out work cannot restore real timers during a later test.

The full run also emitted these unasserted warning diagnostics:

- `SESSION_DETAIL: slow request`, in the Grok redirect fixture used by
  `test/routes/sessions-metadata.test.ts`: 314.4 ms total, 309.8 ms augmentation.
  This is an observation under suite contention, not benchmark evidence.
- `Codex CLI update failed` in `test/services/CodexUpdateChecker.test.ts`, for
  permission denial, stale installed version, and failed production probe.
- `[WS Relay] Replay/old encrypted sequence rejected: seq=0, last=1` during
  encrypted transport coverage.
- `Resynchronized Codex turn id from provider notification` for the
  `compact-session` fixture (`message-1` to `compact-2`).
- `[Voice] ya-grok requested but YEP_STT_XAI_API_KEY is not set` and the
  corresponding `ya-deepgram` / `YEP_STT_DEEPGRAM_API_KEY` warning in
  `test/services/voice-registry.test.ts`.

On Linux (2026-09-27, 16 cores, load average about 18 from peer sessions), one
root `pnpm test` failed `test/scripts/provider-host-system.test.mjs` with
`Assembled provider-host barrier timed out` at its first barrier, the 60 s wait
for the assembled server's `/version`, although that server's log reports
startup complete in 205 ms. The run before it passed that test, and two isolated
reruns passed in about 9 s. Whether the probe reached the logged port, or the
server stalled after startup, is undiagnosed; do not raise the budget until one
of those is shown.

These need focused fixture/diagnostic assertions rather than blanket log
suppression. They are deferred because fixing the timer lifecycle and auditing
provider/auth failure diagnostics crosses independent behavioral boundaries;
it cannot be safely bundled into a successful-file response serialization
repair. The issue #121 focused file/relay/public-share suite passes all 159
tests without warnings, and lint, formatting, and source type checks pass.

2026-09-29: the Codex compaction fixture now waits for both YA's in-turn state
and the provider's recorded `turn/start`. A full Linux suite exposed the
opposite ordering from the original failure: rejection correctly returned 409,
but the pending provider request had not yet reached the fixture log. This
closes that assertion race without changing provider behavior or time budgets;
the other timing and diagnostic findings above remain open.
Contributing-model: 6-Astra.

Found 2026-09-08 while validating issue #121 relay file downloads.

2026-10-03: router recovery validation's full `pnpm test` passed (6,316 server
and 6,655 client tests), but still emitted unasserted WARN diagnostics from
negative project-queue dispatch, clearloop launch/reconcile, transcript fork,
CUDA-unavailable voice registration, gateway readiness timeout and malformed
pi registry fixtures. Router recovery's focused service/component/browser
checks were warning-free. Those unrelated fixture diagnostics remain here
because asserting their intentional failures crosses queue, provider and
gateway test ownership; changing or suppressing them in the router recovery
patch would obscure the behavior under review.

2026-10-27: bounded restart-compaction extraction and observer cleanup passed
workspace tests (6,589 server / 7,058 client after cleanup), but full runs
still emitted intentional fault-path warnings: project-queue dispatch refusals,
clearloop launch/reconcile, voice backend availability, gateway readiness,
malformed Pi registry and `HIGHLIGHT: worker failed` (stalled/boom fixtures).
The 130 focused restart/metadata cases and 80 SDK cases were warning-free.
Auditing those diagnostics crosses independent scheduler, provider and
highlight-worker test contracts; it cannot safely be folded into the move or
its narrow resource-lifetime fix. No logs were suppressed in this work.

2026-10-27: the helper-target removal's full workspace run passed all 6,536
server cases but timed out the client capture CLI case `discovers delivery
through the inherited URL without --ya-url` at its unchanged 30 s limit
(`packages/client/scripts/capture-artifact.test.ts:81`). The capture command
uses bundled headless Chromium, a temporary directory and an isolated local
fixture server. All 13 cases passed immediately in isolation in 3.61 s; the
full run had 7,045 other passing client cases. No capture, browser or timeout
code is changed by this cut. The exact full-run stall remains undiagnosed;
keep the budget and assertions intact rather than assuming load is its cause.

The immediate full rerun instead failed the Gateway loopback-family fixture:
`pins localhost to the address family that answers` expected its IPv6 listener
but received the same port on IPv4 (`56438`). Its helper binds only `::1`,
leaving the IPv4 port available to unrelated concurrent listeners. This is
evidence of a potential fixture port collision, not proof of its cause. All
27 launcher cases passed isolated in 518 ms. Gateway resolution and this
fixture are unchanged by the removals; repair the fixture's address-family
isolation separately rather than weakening the endpoint assertion.

The final removal-series workspace run passed in 139.06 s (6,536 server /
7,046 client); neither the capture CLI timeout nor the loopback-family
assertion recurred. This is verification of the removal series, not a
diagnosis or closure of either intermittent fixture failure.

2026-10-29: AAR speed selection's full workspace rerun passed (6,548 server /
7,010 client), retaining the fault-path diagnostics listed above. An initial
Node 26 run timed out the unchanged capture CLI case `runs from another working
directory and emits parseable JSON plus Markdown files` at 30 s; its 13 cases
passed in isolation in 3.99 s, then the complete Node 25 workspace run passed.
Neither capture assertions nor timeouts changed. The separate live Codex
0.165.0 cold resume completed and preserved its pin, but logged turn-id
resynchronization first on `thread/tokenUsage/updated`, then `turn/started`.
This repeats the existing diagnostic category; its event-order ownership is
outside tier selection and remains unaddressed here.

2026-11-01: CI repair's full Node 25 macOS workspace run passed (6,710
server / 7,064 client), but repeated the existing fault-path diagnostics above
and emitted two jsdom `Not implemented: navigation (except hash changes)`
errors. The same navigation diagnostics appear in hosted unit job
124792013338. Attribution to the initiating link fixture needs a verbose
client run; suppressing navigation globally would hide unrelated regressions.
The touched peer/bootstrap tests pass without runtime warnings in focused
runs. This repair changes only their measured time budgets and a capability
registry reference, so the independent diagnostic-fixture audit remains open.


2026-11-02: Pi durable-creation validation's first full Node 22/macOS run failed
`provider-host-system.test.mjs` at the post-replacement `waiting-input` barrier
(line 234), after both native runtimes reattached and the separately delayed
initial input was confirmed. Replacement Hono had already bound HTTP; this is
a different barrier from the September startup timeout above. Shutdown also
logged instruction restoration `write after end`. The same unchanged assembled
case passed an isolated rerun in 8.08 seconds. The earlier native-API/OpenCode full
runs passed it. This is an ordering/retained-approval finding with unknown cause,
not evidence that a larger timeout is needed. Keep its actual runtime/callback
barriers and inspect host/controller pending-input projection before changing
budgets; Pi-only creation gates do not establish a fix. The first full run had
6,895 passing server/7,067 client cases; no green aggregate is claimed for it.
Evidence is retained under ignored `tasks/session-identity/pi-full-test.log` and
`pi-assembled-host-focused.log`; the final full-run result is recorded in plan171.

The final full run passed the assembled case and all 6,896 server/7,067 client
cases (server 143.14 seconds). That passing run does not establish a fix for the
first run's retained-approval ordering failure.

2026-11-03: CI recovery again exposed the assembled host case on macOS/Node
24.22.1 at its post-replacement `waiting-input` barrier. A full run and an
isolated rerun exhausted the unchanged 60 s barrier; subsequent isolated Node
26.7.0 and Node 24.22.1 runs passed in 9.13 and 9.26 s. Diagnostics now retain
the last creation response and provider barrier events beside wrapper output.

CI 41626829224 then supplied the missing distinction: the separately delayed
input was already `bound/consumed`, but the original worker had been aborted
with `Provider runtime ended: server request`. Its old controller's normal
iterator completion during reload entered managed terminal teardown, racing
the intended detach and denying the retained approval. `Process` now treats
completion/error during a supported intentional detach as controller retirement,
while unexpected managed exits still verify provider teardown. Deterministic
completion/error regressions preserve closed old input and uncertain pending
creation state without calling provider abort. The existing assembled-worker
case remains the real callback/ownership proof; its limit stays unchanged.
Other timing and diagnostic entries above remain open. Evidence is retained in
ignored `tasks/ci-recovery-2026-11-03/final-unit-ci.log` and
`retained-failure-evidence.json`.

The retirement slice's full existing managed-identity file also emits its
negative-fixture diagnostics (`Process terminated`, stale creation attempts,
conflicting native ids, `Provider teardown remains unverified`, and closed
worker sockets). The 99 identity/termination/host checks pass. The new detach
regressions and assembled callback/HTTP success paths are checked separately
without those fault-path diagnostics. Auditing each older negative case's log
expectations spans binding, failed abort and native API error contracts; it is
not safely replaced by a logger-wide suppression in this ownership fix.


2026-11-03: the native provider integration foundation's corrected workspace
run passes 6,941 server / 7,092 client cases (143.46 seconds server), retaining
the existing deliberate fault-path Process/ACP/queue/clearloop/voice warnings
and jsdom navigation errors. The eight new real-executable scenarios pass
without warnings or errors and assert clean native shutdown. Their only
production change handles an explicitly requested Claude SDK classified abort;
blanket interception of independent fixtures would hide their real failures.
Evidence: ignored `tasks/batching-investigation/native-workspace-final.log`
and `native-nested-final.log`. No unrelated diagnostics were suppressed.
