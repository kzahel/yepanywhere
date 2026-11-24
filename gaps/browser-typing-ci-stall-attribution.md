# Browser typing stalls on shared CI

The November 7–14, 2026 survey of 78 CI runs found additional native key-to-two-
frame samples exceeding the 100 ms responsiveness target:

- `settings-search-navigation.spec.ts`: phone measured 112.8 ms in
  [43080010248](https://github.com/kzahel/yepanywhere/actions/runs/43080010248).
  Desktop/phone measured 189.8/185.3 ms in
  [43474508915](https://github.com/kzahel/yepanywhere/actions/runs/43474508915).
  That is one desktop and two phone first-attempt timing misses in 78
  executions per viewport. The separate duplicate `default-busy-send`
  selector failures are semantic failures, not evidence for a larger budget.
- `durable-session-creation.spec.ts`, background typing during delayed
  acceptance with 200 saved sessions: 105.4 and 142.1 ms on the first two
  attempts of [42970345183](https://github.com/kzahel/yepanywhere/actions/runs/42970345183).
  One of 78 executions needed retries at the timing gate. The native CLI and
  held-acceptance flow, newer draft and concurrent metadata writes are part
  of this scenario's workload.

The observations span changing revisions; these counts are not an unchanged-
source flakiness estimate. Every prefix remained present in the reported
timing failures. The historical failed attempts lack the browser phase
attribution needed to distinguish application work from runner scheduling.
The older [settings-search reconnect finding](settings-search-reconnect-first-key-latency.md)
has a different reconnect/visibility workload and is not this scenario.

On November 14 the maintainer explicitly authorized extending the existing
500 ms shared-CI input ceiling to these observed timing failures. Local runs
retain 100 ms, and `typing-target-miss` annotations keep over-100 ms samples
visible to `scripts/e2e-flake-report.mjs` even when the case passes. The new
JSON attachments preserve the original samples and event/input/frame phases.
Character retention, workload, navigation, acceptance ordering and recovery
assertions remain intact; other timing assertions are unchanged.

This test-policy change does not explain or repair the underlying stalls.
Use the next attributed occurrence before choosing a production change. No
new permanent browser case, retry, global timeout or artificial delay is added.

Focused verification on macOS/Node 22.23.3 passes all three scenarios without
retries in CI mode (31.6 seconds including startup/teardown, maximum 22.9 ms)
and local mode (31.1 seconds, maximum 22.4 ms). The attachments confirm limits
of 500/100 ms respectively and retain all eight search prefixes and twelve
draft prefixes. This local diagnostic control is not hosted qualification or
evidence of a production responsiveness improvement.

Found 2026-11-14 while auditing other observable CI timing failures after the
queued-compaction and field-ownership investigation.

On November 24, [CI 45407566083](https://github.com/kzahel/yepanywhere/actions/runs/45407566083)
recorded 332.0 ms during a stopped Antigravity log append and 221.9 ms during
a live-to-log move. Both passed on retry. With retries disabled,
[CI 45419932464](https://github.com/kzahel/yepanywhere/actions/runs/45419932464/job/138536371143)
recorded 159.4 ms on the live move. Its slow key waited 130.7 ms for dispatch,
its input event followed 1.2 ms later, and the 156.3 ms frame attributed 30 ms
to one React scheduler callback. The browser did not attribute the rest of
the delay to specific scripts. [CI 45420498734](https://github.com/kzahel/yepanywhere/actions/runs/45420498734/job/138538382714)
recorded 213.2 ms in the same case, with 171.2 ms before dispatch. Its
browser attributed 35 ms to the React scheduler callback. These two stalls
affected adjacent keystroke positions about 31–32 seconds after page load.
Every typed prefix remained present. A full local run of `533add9a4`
stayed at or below 18.2 ms across the Antigravity cases.

The append and move cases now use the documented 500 ms shared-CI ceiling
with first-attempt reporting of every 100 ms target miss. The controlled
local gate stays at 100 ms. The browser measurements leave the source of
the dispatch stall open.

The native WebView desktop bridge probe measured 229.9 ms from key dispatch
to the acknowledgement frame in [CI 45467406774](https://github.com/kzahel/yepanywhere/actions/runs/45467406774/job/138705891352)
while receiving 1 MiB frames at 20 Hz. The run kept the final draft and every
input event, but its probe recorded neither intermediate values nor browser
phase attribution. The probe now records each rendered prefix, focus,
native-event timing and browser diagnostics on desktop and phone. It uses the
same 500 ms shared-CI ceiling (2.2 times the observed sample) and keeps the
100 ms controlled-host gate and target-miss annotations. The cause of the
229.9 ms sample remains open.
