# Hosted macOS native-app startup and replacement exceed case budgets

[Run 42081724289](https://github.com/kzahel/yepanywhere/actions/runs/42081724289),
macOS job 127436238859 at `06c549a79`, fails seven of ten app cases at their
unchanged 30/40-second guards. No browser case runs because the preceding app
step fails. Linux job 127436239368 passes all ten app and three browser cases;
the separate provider run passes all 69 cases. Do not call this a full passing
app/browser matrix or a demonstrated browser/typing regression.

The macOS runner is a three-CPU Apple M1 VM with about 7 GiB memory. Retained
fixture phase reports put initial API readiness at 12.909–20.585 seconds,
consuming much of each case budget before native turns and replacement. Several
cases reach replacement/model requests when their guard expires; no semantic
assertion failure is reported. The start/end host summary reports maximum load
per effective CPU 18.33 and minimum effective available memory about 1.23 GiB.
CPU busy and swap measurements are unavailable. These sparse samples do not
establish the cause of contention or attribute a product performance regression.
Cold whole-app startup is distinct from a warm session-detail request.

The one-worker control, run 42085703995 at the same `06c549a79` source,
passes Linux but supplies no macOS timing evidence. macOS job 127450094472
was cancelled with zero steps and no log: GitHub reports that no hosted runner
acquired it after multiple attempts and identifies macOS arm64 capacity
constraints. This is not a one-worker test failure or acceptance. The original
two-worker case timeouts remain. Limits/assertions stayed unchanged; a future
pass alone would not erase those failures or establish a sustained speedup. Attribute cold startup/replacement, compare prior qualified capacity,
and choose measured budgets or a qualified capacity/worker setting before
claiming macOS acceptance. Do not weaken the 100 ms typing limit or rerun only
to manufacture a green result. Owning evidence/limits belong in
[native provider testing](../topics/native-provider-testing.md).

Found 2026-11-05 while qualifying repeated native tool-result delivery.


## Copy-aware source qualification

At `a71daaa9d`, [run 42104700612](https://github.com/kzahel/yepanywhere/actions/runs/42104700612)
again fails macOS (job 127516338539): nine of ten app cases exhaust the unchanged
30/40-second guards, so its browser step never runs. The app duration is 214.37
seconds, with 374.37 aggregate test seconds. Linux job 127516338059 passes all
ten app cases (94.70 wall / 168.80 aggregate seconds) and all three browser cases
(1.6 minutes); the separate provider job passes all 69 scenarios.

The macOS capacity key remains the three-CPU/7-GiB arm64 runner. API readiness
ranges from 11.593 to 25.002 seconds. Sparse start/end samples report maximum
load per effective CPU 18.653 and minimum available memory 998,981,632 bytes;
CPU busy and swap remain unavailable. These observations do not establish the
cause or qualify a warm-detail performance regression. The same-source one-worker
control [42108868835](https://github.com/kzahel/yepanywhere/actions/runs/42108868835)
actually runs on macOS (job 127530827997) and passes all ten app cases with the
same guards, in 226.23 wall / 222.20 aggregate seconds. Its browser step passes
two cases and fails the Claude case before typing: the initial composer is not
mounted within 15 seconds while cold Vite modules are still loading. The
[separate browser bootstrap finding](hosted-macos-native-browser-bootstrap-timeout.md)
owns that failure. Linux also passes its app/browser steps. This qualifies one
app-worker setting for this source; it does not prove a sustained speedup or a
cause for the two-worker failures. That control changed no budget, assertion
or worker default. The workflow's subsequent `auto` selection now chooses the completed one-worker macOS app
configuration; explicit worker controls remain honored. This does not qualify
the two-worker profile or erase its timeouts. The earlier unacquired control
is still not a test result.

At `ddda13a4a`, one-worker [run 42115449136](https://github.com/kzahel/yepanywhere/actions/runs/42115449136),
macOS job 127553758255, passes all twelve app cases with the same case guards
in 311.47 seconds. Both reload browser cases also pass; the grouped-input case
then fails its separate 100 ms acknowledgement gate at 126.2 ms. The
[typing finding](hosted-macos-native-input-acknowledgement-over-100ms.md) owns
that unresolved failure. This is app acceptance, not full browser acceptance.

## One-worker current-source replacement guard

At `b2e2ac950`, automatic worker selection in
[run 42121264200](https://github.com/kzahel/yepanywhere/actions/runs/42121264200)
uses one macOS worker (job 127573920717). Eleven of twelve app cases pass in
312.67 wall / 305.16 aggregate test seconds. The Codex tool/approval reload
case reaches its 30-second guard during the second API replacement. Its owned
phase report records API readiness at 12.477 seconds, first replacement
acceptance at 18.331, reattachment at 26.286 and second acceptance at 26.989;
cleanup starts at 30.027, before that reattachment completes. This locates the
unfinished work; it does not establish the cause of slow startup/replacement.
The browser step is skipped, so it supplies no readiness or typing result.

That shared tool/approval case now has a 90-second guard, three times the
observed 30-second lower bound. Native inner barriers, semantic assertions and
typing requirements remain unchanged. The other case guards are unchanged.
The earlier one-worker passes remain valid evidence for their exact sources,
not a promise that every later source stays below 30 seconds. Keep this gap
until the changed source is qualified; neither worker selection nor a later
pass explains the historical two-worker failures.
