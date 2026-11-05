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
