# Browser and Android source lifecycle checks

An **opt-in diagnostic with explicit page acceptance mode**. It runs the built
remote web client or the real minified Android app against an owned fixture,
with the same TCP fault controller and page observer. No runtime application
code is replaced. Android uses its production Kotlin/UniFFI/Rust connection;
Playwright attaches to its actual WebView solely for observation and input.

See [the investigation](../../../../docs/testing/source-lifecycle-study-2026-10-07.md)
for findings, limitations, and the proposed next work. The existing
[conformance sketch](../../../../gaps/sketches/source-transport-lifecycle-conformance.md)
remains the broader scenario inventory.

## Prepare once

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @yep-anywhere/android prepare-frontend
pnpm --filter @yep-anywhere/client exec playwright install chromium
cd packages/android
./gradlew assembleBundledDebug assembleBundledDebugAndroidTest \
  -PyaNativeProbeMinify=true --no-daemon
```

Boot an owned API 35 emulator. The study requires `ANDROID_SERIAL=emulator-…`
and refuses physical devices. Do not run two Android studies or instrumentation
runners concurrently on one emulator. The runner installs the prepared APKs;
it does not silently rebuild them. Rebuild after changing native or bundled
client source. The HTML hash, source revision, dirty paths, and harness hash
are recorded. The finalized runner also records APK hashes, browser/WebView
versions and the emulator build fingerprint; earlier investigation runs predate those fields. Initial execution
evidence is macOS ARM64 only.

## Run matched experiments

```bash
pnpm exec tsx --conditions source packages/client/e2e/lifecycle-study/run.mjs \
  --client=browser --route=direct --surface=session --fault=in-flight --observe-ms=30000

ANDROID_SERIAL=emulator-5554 pnpm exec tsx --conditions source \
  packages/client/e2e/lifecycle-study/run.mjs \
  --client=android --route=direct --surface=session --fault=in-flight --observe-ms=30000
```

Options use `--name=value`:

- `client`: `browser`, `android` or `android-chrome` (same emulator).
- `route`: `direct` or `mux`. Each run owns a fresh relay and username; ordinary
  production relay limits remain enabled. The browser fixture's exact local
  origin is explicitly allowed by its private relay, without changing defaults.
- `surface`: `session` or `inbox`.
- `fault`: `control`, `disconnect`, `in-flight`, `outage`, `relay-restart`,
  `wake-outage`, `silent`.
- `observe-ms`: passive post-restoration observation, default 90000, at most 180000.
  This is an experiment duration, **not an accepted product recovery deadline**.
- `outage-ms`: outage, relay restart, or silent stall duration, default 16000,
  at most 120000.
- `activity`: `none` (default) or `typing` (session only). Typing deliberately
  signals recovery after network restoration and must be compared separately.
- `out`: new, nonexistent output directory. Defaults under ignored
  `tasks/source-lifecycle-study/`.

`disconnect` destroys established client sockets but immediately accepts new
ones. `in-flight` waits until the fixture reports a real delayed API request
before disconnecting. `outage` also refuses new connections. `silent` stalls
both byte streams without announcing closure, preserving order and bounded
stream backpressure. It is an application-path stall, not a packet-level radio
simulator: each half's OS TCP connection remains locally established.

`relay-restart` requires `--route=mux`. It closes the local relay, waits at
least `--outage-ms`, and starts a new relay instance on the same port using
the same on-disk registry. The YA fixture stays up and must re-register on
its own. The timeline records when the relay stops, starts listening and
accepts the fresh YA registration.

`wake-outage` sleeps the emulator (freezes the browser page) for eight seconds,
then wakes it while connections remain refused for another eight seconds.
Freezing is not the same as hiding a tab, Android Doze, or killing an app.
The extended faults below exercise those device boundaries separately.

The server appends a known response and changes the session title/star while
the connection is interrupted. After restoration, the default run observes
without clicking, typing, focusing or injecting `online`. It records a separate
keyboard recovery attempt if the session remains stale or the bar remains.
Sidebar inspection is an explicit interaction **after** passive measurement.

## Verify Android page recovery

After preparing the APKs above, one command runs five owned-emulator cases:
direct/mux session reads interrupted in flight, direct Inbox disconnect, mux
Inbox outage and direct session wake into an outage.

```bash
ANDROID_SERIAL=emulator-5554 pnpm exec node \
  packages/client/e2e/lifecycle-study/verify-android.mjs
```

`YA_LIFECYCLE_CASES` can select comma-separated case names from that script.
`YA_LIFECYCLE_SUITE=relay-comparison` runs the mux session `wake-outage` and
`relay-restart` cases on both the native app and stock Chrome, sequentially on
the same emulator. Use a Google APIs image with stock Chrome installed and
complete Chrome onboarding before measuring.
`YA_LIFECYCLE_SUITE=hardening` selects fourteen matched Android/stock-Chrome
cases: cold restart offline, direct/mux silent stalls, session/Inbox cycles,
three-minute Doze and attachment wake. `YA_LIFECYCLE_SUITE=push` selects three
real-FCM notification cases (online, offline and offline with a second process
death); it requires configured Firebase and
working broker enrollment. These extended suites remain opt-in.
Each case owns a fresh server/relay, records its result and cleans up before
the next. The runner finishes all selected cases and exits nonzero if any
fails; it never retries a failed case. Logs and `matrix.json` share one new
ignored artifact directory. The ordinary Android CI sleep/wake test separately
checks session, primed Inbox and sidebar catch-up using the real native lease.
The larger matrix remains opt-in until its CI runtime budget is agreed.

For a single case, add `--verify=true` to `run.mjs`. Verification observes up to
180 seconds by default (about 3x the measured 49–65 second passive recovery),
but stops after five consecutive healthy seconds. That spans one maximum
managed-stream retry interval. It is an observation/cleanup bound, not a
promise that recovery should take three minutes.

Acceptance requires automatic recovery within that window, the updated title
and missed session message, an unchanged unsent draft, every sequentially typed
character acknowledged within 100 ms, no observed transient error/login/empty
page, and an updated sidebar when opened. It also requires completed native
instrumentation and cleanup. Errors from old subscriptions cannot be excused
merely because the final screenshot looks healthy. The observer still has the
selector/visibility and small-fixture limitations described below.

Every run records `acceptance.passed` and its failure reasons. Diagnostic mode
keeps its existing completion exit status, so the standard browser baseline
can be measured even when it exposes a known transient error. Verification
mode makes those failures affect the exit status. It changes no app behavior.

## Read the evidence

- `result.json`: recipe, source/build identity, host samples, outcomes, page
  transitions and input observations. `completed: true` means the experiment
  completed; **it does not mean the product passed**. A missing `firstHealthyAt`
  means the full recovery condition was never observed within the window.
- `timeline.json`: controller actions, sampled page state, console errors and
  route changes, timestamped by the host/page wall clocks.
- `native-phases.json`, `native-errors.log`, `instrumentation.log`: Android's
  native state and fabricated-response evidence. Native phase times are relative
  to instrumentation setup, not the host timeline's time origin.
- PNG captures are presented through the repository artifact capture helper.
  Emulator checkpoints include both the page and a `-device.png` full-screen
  capture, so native chrome, status icons and system/browser overlays are
  visible. Metadata uses each PNG's actual pixel dimensions. Browser runs also
  retain a WebM recording; Android has no continuous device video yet.

Recovery requires no connection bar, no observed error/login screen, and the
updated title; a session must also show the appended message. Snapshots poll
once per second, so recovery figures are approximate and not paint timings.
Mutation observations retain intermediate states, including short error flashes.
The observer is bounded and uses known error selectors; it is not proof that
every possible error component or visual flicker was detected.
Full-device captures require visual review: page-level acceptance and debugger
input cannot establish that a Chrome onboarding sheet or native dialog did
not cover the page. Complete ordinary browser onboarding on the owned emulator
before treating a Chrome run as foreground interaction acceptance; retain any
overlay capture as a setup limitation rather than hiding it.

The fixture has one project/session and 50 starting transcript messages.
Input is sequential through browser debugging input, including on WebView;
it does not replace native hardware-key/IME acceptance or establish large-data
100 ms performance. The host samples are diagnostic, without benchmark capacity
gating. Do not compare these timings as performance regressions across hosts.

## Lower-level reproduction

```bash
node --test packages/client/e2e/lifecycle-study/network-gate.checks.mjs \
  packages/client/e2e/lifecycle-study/acceptance.checks.mjs
pnpm --filter @yep-anywhere/client exec vitest run \
  --config e2e/lifecycle-study/vitest.config.mjs
```

The first command checks the fault controller and acceptance oracle; both also
run in root `pnpm test` and ordinary CI. The second retains the original
exhaustion reproduction against Android's explicit recoverability field; its
acceptance checks now also run in the normal `NativeSourceTransport.test.ts`
suite. The fabricated-503 repair has normal Kotlin and TypeScript coverage,
including error/state ordering, abandoned operations, mutation non-replay and
genuine server 503 preservation.

The opt-in Android method `hostDrivenLifecycleStudy` owns pairing, the Activity,
and cleanup. A bounded rendezvous file lets the host run the experiment while
the real app stays alive. Without its explicit instrumentation argument the
method does not run in normal live acceptance.

## Process, idle and repeated-cycle experiments

The second experiment round adds `client=android-chrome` on the same explicitly
selected emulator. Use `--chrome=stock` to retain Chrome's normal background
policy; the default `automated` mode uses Playwright's Android launcher, whose
flags disable some background throttling. Both retain the installed browser
version in the result. Only the owned emulator's Chrome is operated.

Additional faults:

- `process-death`: background the app, kill its process with Android's ordinary
  background-kill command, verify absence and reopen. Android uses the launcher;
  Chrome retains site storage and records whether its prior tab was restored or
  the runner explicitly reopened its saved URL. Desktop browser mode closes
  and reopens a document; it does not claim OS process-death equivalence.
- `process-death-offline`: the same, with service unavailable during reopening.
- `sleep`, `doze`, `cycles`: interrupt service while asleep, append fresh server
  content, restore service and wake. `doze` verifies Android accepted forced
  deep idle; desktop browser mode is refused for that fault. `cycles` repeats
  the operation. `--sleep-ms` defaults to 8000 (maximum 300000); `--cycles` is
  1–20. Each session cycle checks its new message and retained draft. Server
  activity-subscriber counts are recorded to detect accumulating ownership.
- `notification`, `notification-offline`: Android only, using configured real
  Firebase/broker delivery to a disposable host binding. The runner grants
  notification permission temporarily, verifies the app process absent, sends
  the fixture event while the screen sleeps and taps the real notification row.
  The offline variant refuses the native service during the tap. The initial
  page is deliberately Inbox so an ignored session destination cannot pass.
  These cases require the private Firebase build configuration; a missing or
  failed delivery is a failed setup, never replaced by a fabricated push.

Process-death and notification experiments use separate preparation/cleanup
instrumentation invocations. Preparation preserves an owned paired profile and
its navigation after the runner exits; cleanup restores previous profiles/tab
state and retires any temporary push capability. Never run another study before
that cleanup has completed. If the host is interrupted, run
`YaNativeReconnectInstrumentedTest#cleanupHostDrivenLifecycleStudy` with
`yaLifecycleStudy=true` against the owned emulator before starting again.

`--steady-ms=30000` extends healthy post-recovery observation to catch delayed
regressions, including draft-sync notices (allowed range 5000–60000). It does
not turn that duration into a product recovery deadline. New-document observers
start after debugger attachment, so cold-entry screenshots and native state
must supplement the mutation log.

`--attachment=true` uploads a real small text file before a session fault, waits
for its completed chip and requires the attachment to survive. It also subjects
attachment notices to the transient-error acceptance check.

The observer reinstalls in documents opened by notification routing. Initial
empty HTML before a document's first content is labeled `initializing`; it is
recorded separately from an already-rendered document becoming empty. Final
emptiness still fails. Cold-entry observers cannot establish frame-by-frame
paint behavior, and samples from a replaced document before attachment may be
unavailable.

`--web-build=/absolute/build/directory` selects a separately prepared web build
for browser comparisons without replacing the normal bundled assets. Its HTML
hash is recorded; Android always uses the installed APK's bundled client.
Attachment runs preflight the fixture's real validation route. The in-flight
attachment fault waits for a delayed validation request specifically, so an
unrelated page read cannot trigger the disconnect too early.

`--restart-after-tap=true` with `--fault=notification-offline` backgrounds and
kills the app a second time while its tap is pending, then launches normally
before restoring the network. The push suite includes this third case and
records both PIDs. This exercises saved pending navigation, not just saved tabs.

## Interrupted upload diagnostic

`--fault=upload-interruption --surface=session` starts a real 4 MiB file,
then the TCP gate cuts after 256 KiB of additional client traffic and refuses
reconnections. It records the explicit failure, restores service, waits for
page catch-up and reselects the original file through the normal input. It
requires the text draft to survive and exactly one completed chip after the
explicit selection. The gate records its actual byte counter; this is a
mid-transfer cut, not a substituted upload error.

This fault is diagnostic-only and rejects `--verify=true`: an explicit upload
failure is expected, whereas normal page acceptance forbids error notices.
The ordinary acceptance result remains visible and can fail; it is not a
passing no-error case. Inspect `uploadFailure`, `uploadBeforeReselection`,
`uploadReselection` and `pageErrors` separately. It does not test memo capture,
OS file-picker access, server-side deduplication or exactly-once delivery of
ambiguous writes. Attachment identity comes from visible chips' full accessible
names so a shortened filename is not mistaken for a lost attachment.
