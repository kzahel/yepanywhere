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
