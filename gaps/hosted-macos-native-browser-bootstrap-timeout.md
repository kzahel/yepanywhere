# Hosted macOS native browser exhausts its initial composer readiness guard

At `a71daaa9d`, the one-worker app control
[42108868835](https://github.com/kzahel/yepanywhere/actions/runs/42108868835),
macOS job 127530827997, passes all ten app cases and two browser cases. The
Claude browser reload case fails its initial 15-second `toBeEditable` assertion
at `native-app-reload.spec.ts:66`: no composer exists yet. No keystroke has been
sent, so this is not a failed 100 ms input acknowledgement measurement.

The retained error context shows only `Loading…`. Its Playwright network trace
contains 885 source/dependency module requests, with lazy session-view modules
still incomplete at teardown. There is no session-detail API request in that
trace. Completed bootstrap API requests succeed; `/api/providers` takes about
1.54 seconds. These observations locate this failure before session-detail
fetch/rendering, in the cold source-development module load. They do not measure
warm navigation or establish a product session-detail regression.

The native fixture's HTML-ready check does not wait for a browser to mount the
source app. Give that genuine cold-start readiness boundary a measured guard
(2–4 times the observed 15-second lower bound), retaining every subsequent
semantic assertion and the unchanged 100 ms sequential typing limit. Alternatively
qualify a built-client fixture if it preserves the real reload boundary. Do not
rerun merely to replace the failure with green or claim that worker selection
fixed the separate browser bootstrap.

Found 2026-11-05 while qualifying durable copy-aware session relationships.

## Local repair, hosted acceptance pending

All three native browser cases' initial composer mounts now have a 45-second guard, three times the observed
15-second lower bound. All later browser assertions, the 120-second overall
case guard and the 100 ms input requirement remain unchanged. A temporary,
owned Playwright route gate holds only the first lazy SessionPage module for
16 seconds: the old guard fails at the initial missing composer, while the new
guard completes the retained native typing/reload/final-history case in 33.2
seconds. The gate is released on early cleanup and is not retained in CI.
This qualifies the targeted readiness change locally; preserve this finding
until the new source also completes hosted macOS browser acceptance.

At `ddda13a4a`, both reload cases pass the old 15-second mount guard in
[run 42115449136](https://github.com/kzahel/yepanywhere/actions/runs/42115449136),
macOS job 127553758255. That run still fails the separate grouped-input
[126.2 ms typing check](hosted-macos-native-input-acknowledgement-over-100ms.md).
This later mount pass does not explain or erase the original cold-load timeout;
the wider mount guard does not repair the typing miss.
