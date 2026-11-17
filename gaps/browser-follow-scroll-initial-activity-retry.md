# Follow-scroll activity test sometimes misses its initial bottom assertion

In [CI 36911014222](https://github.com/kzahel/yepanywhere/actions/runs/36911014222),
`packages/client/e2e/selection-during-activity.spec.ts:384` failed its initial
following-state assertion: `fromBottom` was 252 px rather than below 4 px.
The failure occurred before the held-button action, and the retry passed.
All 24 CI jobs passed, but this run was not free of browser retries.

The native-webview desktop/phone typing tests passed on their first attempts.
This separate follow-scroll finding is outside the iOS CI repair. Diagnose
the activity update and scroll acknowledgement ordering before changing its
oracle; the existing held-selection scroll-jitter gap concerns a later state.

The same 252 px initial-bottom miss recurred in
[October 7 CI](https://github.com/kzahel/yepanywhere/actions/runs/37688149167/job/113021178853)
at line 401 after intervening test edits. Its retry passed; a focused local
run passed without retries. The recurrence remains unresolved.
[CI 37691081022](https://github.com/kzahel/yepanywhere/actions/runs/37691081022)
also required a retry, with a 294 px initial gap.

The November 16–17 reports show five more retry passes in 13 runs with
reports. The held-button case now sends controlled batches, waits for a
grown tail to reach the bottom before pressing, and checks both scroll
position and the text under the pointer after each batch while held.
Releasing the button must still return to the tail. Hosted verification of
the fixture change is pending after six passing local repetitions with two
workers and retries disabled.

Found 2026-10-01 while checking hosted iOS and main CI results.
