# Nested rendez upload watcher intermittently misses a file after restart

An exploratory whole-server test run on macOS / Node 26.7.0 failed
`RendezWatchService.test.ts`'s nested-file scenario at the assertion that one
upload was delivered. The test stops and restarts the observer, replaces the
latest-session pointer with an unrouted directory, waits for pointer repair,
then creates two nested directories and renames a completed upload into them.
No delivery was observed within the existing eight-second wait.

The same case passes in an isolated Node 22.23.3 five-file run and in the full
Node 22 workspace suite. This does not establish whether the cause is runtime
watch behavior, restart readiness, load or an existing test race. No watcher
source or timeout was changed. Investigate event/subdirectory registration
and the repair-to-ready boundary if it recurs; preserve the actual nested
upload contract rather than masking it with a larger timeout.

Found 2026-10-26 while verifying the unrelated managed-checkout lane removal
in [plan 160](../docs/tactical/160-remove-managed-checkout-lanes.md).


2026-10-27: a full Node 22.23.3 workspace run during synthetic-heartbeat
removal missed the second delivery at line 364, after restarting the nested
observer and changing an already-observed file. The watcher source and test
were unchanged. An immediate isolated rerun passed all four runnable cases
in 5.97 s. This extends the evidence beyond Node 26; runtime alone does not
explain the restart/event-registration race. No timeout or assertion changed.

2026-10-30: the HTTP API bootstrap phase 3 whole-workspace run on macOS /
Node 26.7.0 again missed the second delivery at line 364 (1 observed, 2 expected).
The immediate isolated file rerun failed at the same assertion: 3 passed,
1 failed, 1 skipped, 12.83 s. This is not a passing isolated recheck. No watcher
source, assertion, retries or timeout changed. Evidence is retained in ignored
`tasks/http-api-v0/phase3-final-tests.log` and `phase3-rendez-recheck.log`.

Later on 2026-10-30, two complete server runs on Node 22.23.3 passed the case
(including one full workspace run). The final HTTP API eval cleanup verification
then missed the first nested delivery at line 353 on Node 22: 6,587 other server
tests passed. Earlier green runs do not resolve this intermittent watcher defect
or establish that changing Node versions fixes it. Evidence: ignored
`tasks/http-api-v0/phase4-reviewed-tests.log`; watcher code/budgets remain unchanged.
The immediate final Node 22 isolated rerun passed all four runnable cases in
5.76 s. That disagreement is retained as intermittent evidence, not a green
replacement for the failing full run.

The compact conversation phase 2 workspace run on 2026-10-30, macOS / Node
22.23.3, again missed the first nested delivery at line 353: 6,597 other server
tests passed. Watcher source, budgets and assertions were unchanged. Evidence:
ignored `tasks/http-api-v0/167-phase2-root-tests.log`. This run remains red; no
retries or timeout changes were used to replace its result.


The final compact conversation/commands workspace run on 2026-10-30, macOS /
Node 22.23.3, missed the second nested delivery at line 364 (1 observed, 2
expected): 6,615 other server tests passed. No watcher source, assertion,
retry or timeout changed. Evidence: ignored
`tasks/http-api-v0/167-phase5-root-final-tests.log` (125.36 s server run).
All new API/native lifecycle regressions passed in that run. The workspace
result remains red; no isolated watcher rerun replaces it.


2026-10-31: final Server Connections workspace verification on macOS /
Node 22.23.3 missed the second delivery in the top-level prepared-image case
at line 231 (1 observed, 2 expected), after stopping/restarting the observer
and replacing the already-observed screenshot. This extends the symptom
beyond nested files. 6,692 server tests passed, one failed, 74 skipped; all
7,063 client tests passed. The preceding workspace run passed all 6,691 then
present server tests. The changed connection/auth tests, source and UI do not
touch RendezWatchService, RendezObserver or this watcher fixture. No watcher
source, assertion, timeout or retries changed. Evidence is retained in ignored
`tasks/server-connections/tests-commit.log`; the earlier green run is
`all-tests-final.log`. The latest run remains red, not replaced by a retry.

2026-11-01: the peer-agent default/hidden-control workspace run on macOS /
Node 22.23.3 again missed the second nested-file delivery at line 364 (1
observed, 2 expected). 6,709 other server tests and all 7,064 client tests
passed; 74 server cases remain skipped. The 31 focused peer/core cases pass.
This change touches no watcher source, fixture, assertion or timeout. Evidence:
ignored `tasks/peer-agent-defaults/full-test.log` (132.38 s server run). The full
run remains red; no watcher retry replaces it. Diagnosis stays in this gap
because the restart/event-registration race is independent of the agent-access
default and removal of its Settings control.

The 2026-11-01 compact Server Connections UI workspace run on macOS /
Node 22.23.3 missed the first nested-file delivery at line 353 (0 observed,
1 expected). 6,709 server tests and all 7,064 client tests passed; the server
run took 129.77 s. Evidence: ignored `tasks/peer-list-ui/full-tests.log`.
Watcher source, fixture and budgets are unchanged; this red result is retained
without an isolated retry.


2026-11-01: the standalone identity-fixture workspace run on macOS /
Node 26.7.0 missed the second top-level prepared-image delivery at line 231
(1 observed, 2 expected). 6,728 other server tests and all 7,064 client tests
passed; the new standalone process checks passed. This slice changes only
E2E process/environment composition and its own tests, not the Rendez watcher,
fixture or eight-second wait. Evidence: ignored
`tasks/session-identity/standalone-test.log` (129.77 s server run). This failed
run remains recorded; no watcher retry or budget change replaces it.

2026-11-01: the reviewed legacy session-alias guard workspace run on macOS /
Node 26.7.0 missed the second nested-file delivery at line 364 (1 observed,
2 expected). 6,751 other server tests and all 7,064 client tests passed;
server duration was 135.85 s. The six focused identity files passed 36 cases
in 5.38 s, including merged-root, orphaned-child and shutdown interleavings.
This slice touches no Rendez watcher source, fixture, assertion or budget.
Evidence: ignored `tasks/session-identity/phase-3-alias-reviewed-test.log`.
The preceding version's whole workspace run passed before the review fixes;
that does not qualify the corrected tree or explain this recurrence. The
failed run remains red. An isolated diagnostic and unchanged-tree full repeat
are recorded separately; neither closes this gap or erases this failure.

The isolated diagnostic passed 4 runnable cases / 1 retained skip in 6.14 s
(`phase-3-alias-rendez-diagnostic.log`). An unchanged-source full repeat passed
6,752 server / 7,064 client tests (139.08 s server run), recorded separately in
`phase-3-alias-repeat-test.log`. This disagreement is additional intermittent
evidence; no Rendez code, fixture, assertion, retry setting or budget changed.

2026-11-02: the durable-creation storage foundation workspace run on macOS /
Node 26.7.0 missed the second nested delivery at line 364 (1 observed, 2
expected). 6,802 server tests and all 7,064 client tests passed; server duration
129.99 s. The storage slice changes no Rendez watcher, fixture, assertion or
budget. Evidence: ignored
`tasks/session-identity/phase-4-admission-test.log`. This failed run is retained;
no isolated watcher retry replaces it. The exact restart/event-registration
failure matches the previous observations above and remains unresolved.

The post-type-cleanup run repeated that same line-364 failure: 6,802 other
server tests and all 7,064 client tests passed in 130.43 s. The three helper
fixture annotation changes do not affect Rendez. Evidence: ignored
`tasks/session-identity/phase-4-admission-revised-test.log`. Both failed runs
remain recorded; source, assertions, retries and budgets are unchanged.

2026-11-02: final Saved/Failed session-read workspace verification on macOS /
Node 22.23.3 again missed the second nested-file delivery at line 364 (1
observed, 2 expected). 6,809 other server tests and all 7,064 client tests
passed; server duration 134.48 s. The 231 focused identity/admission/auth and
retained Supervisor regressions pass. No Rendez source, fixture, assertion,
retry or budget changed. Evidence: ignored
`tasks/session-identity/phase-4-saved-reads-test.log`. This full run remains red.


2026-11-02: launch-intent storage verification on macOS / Node 26.7.0 missed
its second top-level prepared-image delivery at line 231 (1 observed, 2
expected), matching the separately recorded restart symptom above. 6,818
other server checks and all 7,064 client checks passed; server duration
128.91 s. The new SQLite/snapshot checks and direct Node 22/Bun probes pass.
No Rendez source, fixture, assertion, retry or budget changed. Evidence:
ignored `tasks/session-identity/phase-4-launch-intent-test.log`. This run remains
red; an additional supported-runtime full run is recorded separately and does
not close this watcher gap or replace the failure.


The additional launch-intent Node 22.23.3 full run also missed that same
second prepared-image delivery at line 231: 6,818 other server and all 7,064
client checks passed, server duration 134.60 s. Evidence: ignored
`tasks/session-identity/phase-4-launch-intent-node22-test.log`. Both full runs
remain red. No watcher implementation, fixture, assertion, timeout or retry
setting changed; storage/snapshot qualification does not resolve this gap.

The first managed-dispatch Node 26.7.0 full run again missed the second nested
delivery at line 364: 6,829 other server and all 7,064 client checks passed;
server duration 131.03 s. Evidence: ignored
`tasks/session-identity/phase-4-managed-test.log`. This pre-review-correction run
remains red; it changed no Rendez implementation, fixture, assertion, timeout
or retry. Managed ownership and namespace corrections require a fresh full run.

The subsequent final-source Node 26.7.0 workspace run after the reviewed managed
ownership/API-error/stop corrections passed (6,836 server / 7,064 client;
128.51 s server duration), recorded in ignored
`tasks/session-identity/phase-4-managed-final-test.log`. The intervening source
changes justify that fresh qualification; the watcher itself remains unchanged.
This pass qualifies that source snapshot and does not close the intermittent
restart defect or replace the preceding red evidence.


2026-11-02: final reviewed local cold-resume qualification on macOS / Node
26.7.0 again missed the second prepared-image delivery at line 231 (1 observed,
2 expected). All 6,871 other server and 7,064 client checks passed; server
133.51 s. The 232 focused native/host/source/Supervisor cases pass. This cut
changes no Rendez source, fixture, assertion or budget. Evidence: ignored
`tasks/session-identity/phase-3-cold-resume-review-corrected-full-test.log`.
The earlier pre-review-correction source passed 6,870 server / 7,064 client
checks in 131.01 s (`phase-3-cold-resume-final-full-test.log`); it does not
qualify the corrected source or erase this failure. Inspection confirms the
same restart/event-observation boundary remains unqualified; no isolated
retry replaces this result and this gap remains open.


2026-11-02: the first OpenCode cold-source workspace run missed the second
nested delivery at line 364 (1 observed, 2 expected): 6,872 other server and
7,064 client checks passed; server 132.45 s. Evidence: ignored
`tasks/session-identity/phase-3-opencode-cold-full-test.log`. An isolated
instrumented eight-trial restart diagnostic passed without reproducing the
failure (`rendez-watch-diagnostic.log`); it changes scheduling and supplies no
proof for a watcher fix. The OpenCode source then received an independently
reviewed explicit-loopback hostname correction. Its new complete workspace
run passed 6,873 server / 7,064 client cases in 130.10 s
(`phase-3-opencode-cold-final-full-test.log`). That pass qualifies the corrected
source, not a Rendez repair; no watcher source, timeout or assertion changed,
and the initial red run remains preserved.

2026-11-02: provider-variant cold-continuation workspace verification on macOS /
Node 26.7.0 again missed the second prepared-image delivery at line 231
(1 observed, 2 expected). All 6,882 other server and 7,064 client cases pass;
server duration 135.35 s. The 68 focused provider/source/ownership cases and
nine standalone variant/runtime probes pass. This cut changes no Rendez
watcher, fixture, assertion or timeout. Evidence: ignored
`tasks/session-identity/phase-3-variants-cold-full-test.log`. The preceding ACP
cut passed 6,880 server / 7,064 client cases (133.43 s); it does not qualify
this source or repair the watcher. This run remains red without a blind retry.

The final provider-variant source then received the independently reviewed
Gateway autostart-capable refusal-fixture correction. Its new full qualification
missed the second nested-file delivery at line 364 (1 observed, 2 expected):
6,882 other server / 7,064 client cases pass; server 133.09 s. Evidence:
`tasks/session-identity/phase-3-variants-cold-autostart-full-test.log`. This is a
separate red result of the corrected fixture, not an unchanged-source retry or
passing replacement. Watcher source, assertion and timeout remain unchanged.
