# Testing

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Test Value And CI Cost

Keep CI latency and runner load stable over time by judging tests on the
regressions they can reveal relative to their ongoing runtime and maintenance
cost. Agents are authorized to avoid writing, remove, consolidate, or replace
low-value tests without separate permission. This includes shallow mocked/local
tests that merely restate the implementation or assert mock wiring whose
correctness is readily established by reading the code. Like redundant comments,
such tests can add upkeep without protecting useful behavior. Test count and
coverage percentage alone do not establish value.

Apply the same retention decision to tests used to prove a feature during
implementation: keep them when they protect likely future regressions or
meaningful failure modes; their usefulness during development does not by itself
justify permanent CI execution. A test can be valuable during exploration and
be removed before landing, or later when its continuing value no longer pays
for its cost.

Prefer scenarios exercising real integration boundaries, specific regression
risks, tricky interactions, or fragile-seeming code. Small unit tests remain
valuable for subtle algorithms and state transitions. Mocks are useful for
controlling a real failure or interleaving; they are weak evidence when they
replace the behavior being claimed. Tests capable of exposing rare races or
unexpected scheduling failures have lasting value even when they rarely fail.
Preserve that detection capability when making them faster. Investigate an
intermittent failure before deciding it is expendable test noise.

For a removal or replacement, identify the plausible regression the test could
catch and whether surviving coverage still catches it, or explain why the
assertion adds little beyond code inspection. Do not require a replacement for
every deleted trivial assertion. Do not delete a failing test merely to make CI
green or remove unique security, persistence, transport, or real-input coverage
without preserving its contract.

When retaining tests, reduce their duration in seconds where practical: remove
fixed sleeps, unnecessary services, repeated setup and duplicate scenarios;
use controlled clocks or interleavings where they preserve the failure under
test. Keep enough real scheduling coverage to expose races. Compare relevant
before/after case or suite times on comparable runs, including setup, teardown,
retries and total runner time. More parallel workers can reduce wall time while
increasing load; report both. A single local sample is diagnostic, not proof of
a sustained CI improvement. Avoid adding expensive measurement machinery for a
trivial deletion. [E2E testing](../../topics/e2e-testing.md) owns browser-boundary
choices and detailed cost measurement; [test time budgets](../../topics/test-time-budgets.md)
owns timeout evidence. Raising timeouts, retries or resource allocation does not
count as accelerating a test.

## After Editing Code

After editing TypeScript or other source files, verify your changes compile
and pass `pnpm lint`, `pnpm format:check`, `pnpm typecheck` (no emit), and
`pnpm test`. For UI changes, run the relevant focused browser checks. The full
client E2E suite remains a CI gate; run it locally when the affected browser
scope cannot be bounded reliably. [E2E testing](../../topics/e2e-testing.md)
owns the decision to add a browser case, choose a cheaper test level, and
measure its cost and reliability. [UI testing](../../topics/ui-testing.md)
owns visual QA and captures.

For site changes (marketing pages in `site/`):

```bash
cd site && npm run build   # Astro check + build (or: pnpm site:build from root)
```

Fix any errors before considering the task complete.

Root `pnpm typecheck` includes `pnpm e2e:typecheck`, which checks all client
Playwright specs, configurations and support modules through
`packages/client/tsconfig.e2e.json`. Keep fixture and startup changes in that
strict gate; Playwright strips types without checking them.

The general CI unit-test job runs `pnpm test`. Android unit, lint, build, and
instrumentation coverage belongs to the dedicated Android App workflow so its
Gradle work does not contend with the JavaScript workspace test processes.
Android JVM unit-test tasks have a five-minute task timeout and emit per-test
lifecycle output so a stalled worker fails with attributable evidence.

On a dedicated, authorized Android device, `pnpm --filter @yep-anywhere/android
test:live` installs the minified Debug probe and exercises owned direct and local
relay fixtures. Set `YA_NATIVE_PUBLIC_RELAY_LIVE=1` for the separate public TLS
relay check: it registers a uniquely named disposable server, starts native
pairing from Android's Main dispatcher, then verifies the bundled WebView,
streaming, upload and sequential typing. The runner removes its port forwards
and server afterward. Set `ANDROID_SERIAL` when more than one device is attached.
For an attached personal phone, set `YA_NATIVE_ISOLATED=1` and
`ANDROID_HOME` to build a side-by-side `YA Transport Test` package. The runner
verifies both APK application IDs before installation, refuses to replace an
existing test package, removes only packages it installed and leaves the primary
app's profiles untouched. The isolated package claims no launcher/deep-link
intent filters; instrumentation launches its activities explicitly. Select route
modes with `YA_NATIVE_LIVE_MODES=direct,mux` and a focused class/method list with
`YA_NATIVE_LIVE_CLASSES` (comma separated, Android runner `Class#method` syntax).
An app-data sandbox does not bypass secure keyguard: physical sleep/wake cases
need manual unlock. Use emulator sleep/fault runs while the handheld is locked, then non-locking
physical foreground/background cases after manual unlock; do not describe a
keyguard-blocked run as a product regression or passing lifecycle acceptance.

The WebView probe also checks native tabs, internal/external links, warm launcher
resume, draft/scroll identity, rotation and cold route restoration. Add
`YA_NATIVE_NETWORK_LIFECYCLE=1` on an authorized phone to disable both Wi-Fi and
mobile data during warm resume; the probe restores each radio's original state
in teardown. Its tab records and selected profile are restored after the run.
These instrumentation probes preserve extra shared test APIs; separately verify
the actual Release login form before uploading a store bundle. A background
instrumentation caller or plaintext fixture cannot prove UI-initiated TLS login.
The typing probe taps the WebView editor through Android accessibility and
requires window focus, an active input connection and stable viewport before
injecting sequential hardware keys. Input-readiness failure must fail setup,
including on emulators; it must never continue into a partial typing sample.
Live fixture hosts have unique display names so a previous interrupted run
cannot redirect a later host-picker tap to a stopped server. On UI failure,
the probe captures the screen, accessibility hierarchy and window/power state
before teardown. The live runner retains these under
`packages/android/app/build/reports/native-live/` for the existing CI artifact
upload. These captures use the owned fixtures; inspect any local device
captures before sharing them. Hosted run `37219989321` established that a
Pixel Launcher ANR dialog was hiding an otherwise connected YA page from
accessibility. CI compiles its minified probe APKs before starting the emulator,
then uses the same minification property for ordinary and live
instrumentation. This avoids rebuilding/shrinking a different variant
beside the running emulator. Fixtures use loopback through adb reverse, which
every build's network policy permits; no build opts into broader plain HTTP.
The UI probes can close that exact
system-owned Pixel Launcher dialog once per test, on emulators only, and retain
its evidence. They never dismiss YA ANRs or relax input-readiness/latency gates.
Link probes resolve the accessible name from either WebView text or content
description, then perform real taps/long presses. Hosted run `37223303403`
exposed the external anchor only as a content description; the external VIEW
intent, unchanged document identity and tab count remain required assertions.

Actual provider executables against scripted loopback model APIs are the primary
integration evidence for native scheduling, tools and persistence. Run
`pnpm test:providers`; these inference-free scenarios also run in the ordinary
server suite/CI. [Native provider testing](../../topics/native-provider-testing.md)
owns the action/assertion recipe, executable pins, isolation, capability matrix
and current qualification limits. Replay and fake peers do not replace that
current-native evidence.

Captured provider regressions run offline in the normal server suite:
`pnpm --dir packages/server exec vitest run test/captured-provider.test.ts`.
The [corpus README](../../packages/server/test/fixtures/captured/README.md)
owns the capture/import recipe, coverage limits, and manifest format. These
tests use production readers/adapters and require no provider credentials or
private histories. Root typechecking includes their helpers and importer.

Environment-dependent subprocess tests must control both the child environment
and relevant process descriptors. In particular, Bash `BASH_ENV` probes use
ignored stdin rather than inheriting a test runner's socket-backed stdin. See
[subprocess environment boundaries](../../topics/subprocess-environment.md) for the
runtime and hermetic-test contract.

Full server-app tests import `test/setup/create-app.ts`, rather than the
production constructor directly. The wrapper gives each app its own storage
under the test file's hermetic data root, as well as empty provider histories.
The production constructor reads its `dataDir` option, not `YEP_DATA_DIR`;
setting the environment alone does not isolate these fixtures. Pass an
explicit `dataDir` only when the test needs an owned persisted profile, such
as a restart or shared-storage scenario. Dispose app services before removing
their fixture directories. The wrapper drains all registered app services at file teardown before removing
the file's storage root, including supervisor maintenance and artifact readiness
writes. Repeated explicit app disposal joins the same cleanup promise.
Restore fake timers before leaving a test that admits asynchronous maintenance
work, so teardown can drain its promises rather than wait on a frozen clock.
The wrapper injects an offline latest-version lookup. Browser server processes
use a fixture preload that supplies the update endpoint's real 204 no-update
response while forwarding other HTTP traffic. Version-route contract tests own
their explicit update responses; general tests never require public update
service availability. Client unit setup clears local/session storage before
invalidating preference caches, so earlier cases cannot choose later defaults.

## Native App CI Cadence

Main CI and Server Runtime And SQLite still run on every pull request and
`main` push. Native application workflows use matching path filters for both
events: platform code, tests, resources, manifests and build scripts trigger
their platform immediately. Shared Rust mobile-core changes trigger both
mobile apps. Native web-host adapter, crypto and binary-framing changes also
retain immediate Android/iOS coverage.

Ordinary web UI, server, shared-code and root lockfile changes do not trigger
native application builds by themselves. Android runs the full build and
WebView instrumentation workflow daily at 04:17 UTC; iOS runs its full Rust,
simulator and unsigned-device workflow at 04:47 UTC. Both scheduled runs check
the current default-branch source, including bundled web changes. Push and
scheduled Android runs verify without publishing. An explicit manual main
run with `publish_internal=true` can publish its verified bundled AAB after
[delivery setup](../distribution/mobile/README.md#android-ci-internal-delivery).
Superseded Android verification runs on the same ref are cancelled; explicit
release runs use a separate group and finish even if new pushes arrive.
iOS still does not publish store releases. GitHub may delay scheduled starts.

Desktop retains its existing 02:37 UTC Nightly Desktop release, which selects
verified main source and skips unchanged packaged inputs. Its per-change
workflow covers the desktop package, packaging inputs and scripts, dependency
manifests for bundled packages, patches and workflow changes. Desktop release
tags and reusable release calls retain full packaging regardless of paths.

All three native workflows support manual dispatch for targeted acceptance or
release preparation. Native package Markdown-only changes do not start builds.
The workflow path lists are authoritative; before a release, obtain passing
platform acceptance for the source being released even when its changes only
received scheduled coverage.

## Cross-Platform Behavior And Tests

Treat Linux, macOS, and Windows as supported development targets. Code and
tests must not assume that the current host's filesystem, descriptor, process,
or shell behavior is portable. Pay particular attention to path syntax and
case handling, symlinks, `/proc` and `/dev/fd`, permissions and file locking,
signals and process trees, executable discovery, temporary directories, and
shell availability.

For every OS-sensitive change, either use portable APIs and cover all three
platforms, or make the narrower capability explicit: document it, gate native
tests by platform or capability, and test the supported fallback on the other
platforms. Passing on one contributor's OS is not sufficient evidence. When
other-OS validation is unavailable, state that limitation in the handoff.
Never weaken a security boundary merely to make another platform pass.

## Device Control Testing

Use the Android emulator only when testing the device-control/device-bridge feature. Check with `source ~/.profile && adb devices` and deploy/test on the emulator for changes that touch device streaming, `/api/devices`, `deviceBridge`, or `packages/device-bridge`. For general client, server, web UI, provider, relay, or rendering changes, do not require emulator testing.

## ChromeOS Debugging

For Chromebook testing and debugging (screenshots, input, diagnostics), use the chromeos-testbed CLI — NOT the browser control skill (which is for local headless Chromium).

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # saves screenshot, prints path
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # saves to output.png
~/code/chromeos-testbed/bin/chromeos help                    # full command list
```

Requires SSH access to `chromeroot`. See `~/code/chromeos-testbed/CLAUDE.md` for details.


## Standalone YA process profiles

For identity/startup/protocol qualification, reuse the E2E process helper's
`startYaServerProcess({ standalone: {}, ... })`, restart and disposal functions.
The opt-in standalone mode composes the lifecycle-free configuration scrub
inventory with private home, XDG, Windows app-data, temporary, native provider,
data and scratch roots. Only explicit fixture inputs supply credentials;
inherited provider/agent/host authority and shell-startup bridges are removed.
Filtering and protected-root collisions compare names case-insensitively so a
plain environment object cannot bypass Windows semantics. Owned roots and host mode
win over input overrides. Provider hosting defaults off for this mode; select
`standalone: { providerHostEnabled: true }` for separately owned host scenarios.
This fixture switch does not change product hosting defaults or availability.

`serverExecutable` selects an absolute Node or Bun executable and survives
restart. Keep the coordinator under Node on macOS so the existing process
identity/cleanup implementation can reclaim a Bun server. Do not weaken the
production process-identity support matrix to run a fixture. Standalone process
records live in the owned profile even outside a Playwright invocation; the
existing registry and host recovery remain the only lifecycle owners.

The retained `test/scripts/standalone-session-profile.test.ts` check spawns a
real config/native-path probe under poisoned parent settings and exercises
ordinary mock creation, native history, same-profile restart and cleanup.
Its ignored-stdin Bash probe also proves an owned outer startup file cannot
restore foreign credentials or a session id. The checks cost about five seconds
on the Node development runtime; native Linux/Windows execution remains part of
final platform qualification. Run it through
`node scripts/run-with-safe-home.js --temporary-home pnpm --filter
@yep-anywhere/server exec vitest run test/scripts/standalone-session-profile.test.ts`.
Set `YA_STANDALONE_TEST_RUNTIME` to an absolute alternate-runtime executable
for the same checks; the coordinator still runs on Node. No real model calls,
primary provider history or localhost:3400 lifecycle changes are involved.
These are fixture/legacy-baseline checks, not durable-creation acceptance or
hosted-worker continuity qualification.
