# Android can take almost a minute to notice silent service restoration

The October 7/8 final attachment-wake experiments recover automatically and
retain the route, text and staged file, but take about 57 seconds after the
fixture starts accepting connections again. The matched stock emulator Chrome
case recovers in about two seconds. The ordinary five-case native acceptance
matrix also records roughly 49–57 seconds for passive outage recovery.

This is a known consequence of the approved native quick-attempt budget and
visible 60-second backstop, not the old permanent-failure defect. The fault gate
restores the server path without changing Android's default network. Therefore
it supplies no new platform network-available signal; the separate real
Wi-Fi/data restoration test exercises that signal and passes. Typing, waking
or changing networks would measure a different recovery trigger.

Keep this as a UX follow-up rather than claiming that eventual recovery is
instant recovery. Before shortening the interval, measure attempts and recovery
latency on direct and relay routes. The relay's circuit-open budget and native
quick retries constrain a safe passive probe rate. Preserve one recovery owner,
signal coalescing, terminal authentication handling and no automatic write
replay. A unit timing regression must protect any agreed policy change; do not
alter the standard web client's policy merely to make the timings match.

Reproduce with the [lifecycle runner](../packages/client/e2e/lifecycle-study/README.md)
using Android session `wake-outage`, `--attachment=true`, no activity injection,
and `--verify=true`. See the
[second-round report](../docs/testing/android-lifecycle-hardening-2026-10-07.md)
for the final build and comparison evidence.

Observed again 2026-10-08; the existing 60-second policy was retained deliberately.

## Matched Android and Chrome relay reproduction

On 2026-11-25, the minified Android probe and stock Chrome used the same
Android 15 emulator, Chromium 124 WebView/browser generation and bundled web
build. In the mux wake-outage case, the native app caught up 56.6 seconds after
the path reopened, versus 17.1 seconds in Chrome. With service restored before
wake, the native app caught up in 0.6 seconds. After a foreground relay restart,
the app took 48.4 seconds versus 23.2 seconds in Chrome. The fixture took about
14.6 seconds to re-register on both runs. Both slow native traces recorded about
60 seconds from recoverable `FAILED` to the next connection attempt.

The bundled app releases its foreground connection lease when it sleeps.
On wake, native acquisition retries briefly and can exhaust that budget while
the route is still unavailable. After native exhaustion, the WebView's
[`NativeSourceTransport`](../packages/client/src/lib/transport/NativeSourceTransport.ts)
schedules the visible 60-second backstop. Restoring the relay path leaves
Android's default network up, so it supplies no new network-available signal
to advance that retry. Chrome uses its own WebSocket backoff and was still
retrying when the path reopened. The foreground restart reproduces the native
wait without a sleep/wake transition.

The session route and draft survived and the missed message appeared once.
The page observer saw a continuous reconnect indicator in the slow native runs.
Frame-level flicker on a physical phone still needs a capture. Pre-outage
typing exceeded 100 ms once in the native wake-outage run (129 ms) and once
in the matched Chrome run (103 ms), with every character retained.

Prepare the APKs and an owned API 35 emulator with stock Chrome as described in
the [lifecycle runner](../packages/client/e2e/lifecycle-study/README.md), then
run from the repository root with that emulator's serial.

```bash
ANDROID_SERIAL=emulator-5554 YA_LIFECYCLE_SUITE=relay-comparison \
  pnpm exec node packages/client/e2e/lifecycle-study/verify-android.mjs
```

`wake-outage` wakes the emulator before reopening the gated path.
`relay-restart` replaces the listening relay and retains its username registry
and the YA fixture. The suite sends no user activity during the passive
observation window. Compare `firstHealthyAt - restoredAt` in each
`result.json`, `relayRegisteredAt` for the restart, and the native phase
interval from `FAILED` to `CONNECTING` in `native-phases.json`. The capture
directory and `matrix.json` location are printed at the end of the run.

## Where the policy now lives

Since 2026-11-26 the 60-second backstop and five-second signal cooldown are
`RECOVERY_POLICY` in
[`RecoveryScheduler.ts`](../packages/client/src/lib/connection/RecoveryScheduler.ts),
the one policy the browser also uses; see
[one exhausted-recovery scheduler](../topics/source-transport.md#one-exhausted-recovery-scheduler).
That change kept the native timings and removed the browser's slow-probe
jitter. Its conformance test is where an agreed policy change gets its unit
timing regression.

The shared scheduler only decides when the WebView asks native for another
cycle. This gap's cause is upstream of it: native's cycle is four attempts in
about four seconds (`retryDelaysMs` in `YaServerConnectionManager.kt`) before
it reports exhaustion, against the browser's ten attempts over about three
minutes. The harness also showed that a native probe with no reply holds
recovery for the bridge's 30-second command timeout before the 60-second wait
restarts, so probe starts on a silent path can be 90 seconds apart.
