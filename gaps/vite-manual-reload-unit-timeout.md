# Vite manual reload browser test can time out in the full unit suite

On 2026-10-14, `pnpm test` on macOS with Node 24.19.0 timed out the
`requires an explicit reload before importing changed source in manual mode`
case in `packages/client/src/lib/__tests__/viteDependencyCache.test.ts` at
its default 5,000 ms budget. A Gradle APK build was running alongside it.
The next manual-reload notification case observed three fetch calls instead
of one. All other client tests and the server suite passed.

The same three-case file then passed alone in 1.28 seconds, with 918 ms of
test execution. An earlier full run on Node 26 also passed. These runs show an
intermittent failure, but do not isolate its cause. The first case starts Vite
and Chromium and exercises navigation plus reload under the same overall
budget. Continued asynchronous work after its timeout may explain the two
extra calls seen by the following test's fetch spy; this remains unconfirmed.

A subsequent full Node 24 run without concurrent Gradle work passed all 6,970
client tests in 114.81 seconds and all 6,558 server tests in 109.30 seconds.
That clean rerun does not establish the cause of the earlier timeout.

This Firebase configuration task does not change Vite reload behavior. Keep
the browser assertions intact; measure startup and test phases under full-suite
load, verify cleanup after a timeout, and follow
[test time budgets](../topics/test-time-budgets.md) before changing its budget.

Found 2026-10-14 while tracking public Android Firebase client configuration.

## 2026-10-29 Source Control retirement verification

A full macOS Node 26.7.0 run reproduced the 5,000 ms reload timeout and
following three-calls-versus-one failure. The same run hit 10,000 ms teardown
hook limits in `FileResourceActions.module.browser.test.ts`,
`markdownPreviewCopy.test.ts` and `browserDebugEval.browser.test.ts`, plus
30,000 ms limits in two `capture-artifact.test.ts` CLI cases. All 6,547 server
tests and 6,997 other client tests passed. Concurrent Rust compilation and
indexing were visible; that observation does not establish the cause.

The five affected files passed alone with one worker: 25 tests in 7.25 seconds.
Keep these startup/teardown and reload assertions intact. This compatibility
cleanup does not alter those fixture owners or their deadlines.

A subsequent full run without other validation commands alongside it passed
all 7,003 client tests in 127.84 seconds and all 6,547 server tests in 121.49
seconds. That clean run does not establish why the earlier teardown and
capture deadlines were missed.


## 2026-10-31 peer enrollment verification

A full macOS Node 22.23.3 run timed out the notification case, `notifies about
source changes in manual reload mode`, at 5,000 ms. All 6,676 server tests and
7,061 other client tests passed. Peer/OIDC changes do not modify Vite or its
fixture. This adds another observed timeout without establishing its cause;
keep the existing investigation and measured-budget requirements above.


The subsequent full run after final peer/OIDC source changes passed all 7,062
client tests in 179.55 seconds and all 6,680 server tests in 162.69 seconds. No
Vite fixture or deadline was changed. This clean run does not establish the
cause of the earlier timeout.


## 2026-11-05 relationship qualification

A full macOS Node 24.22.1 run reproduced the 5,000 ms explicit-reload timeout;
the following notification case then failed its fetch-count expectation.
7,114 other client cases passed. Server/native validation commands were also
running; that observation does not establish the cause. The same three-case
file passed separately in 1.08 seconds (784 ms of test execution).

A later full workspace run passed all 7,116 client cases in 122.06 seconds and
all 7,092 server cases in 147.04 seconds. No Vite fixture, browser assertion,
retry count or deadline was changed. This remains an unresolved finding; the
clean run does not prove why the initial timeout or subsequent count occurred.
