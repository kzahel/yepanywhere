# Yep Anywhere iOS

The native shell opens with server name and password. Advanced connection exposes the direct endpoint and custom relay. The host and tab pickers restore each host’s selected page from protected storage. Only the active tab mounts a WebView.
The foreground application is the existing bundled React UI in WKWebView.
The shared [Rust core](../mobile-core/README.md) owns authentication, encryption,
requests, subscriptions, uploads and reconnect. JavaScript receives a
source-scoped document handle; it receives no password or resume/transport key.

## Build and verify

Use Apple Silicon or Intel macOS, Xcode with an installed iOS simulator runtime,
XcodeGen 2.45.3, Node 24 LTS, pnpm and the pinned Rust 1.97.0 toolchain.
The application requires iOS 17 or later, allowing separate persistent WebKit
stores for each native profile. It supports iPhone and iPad.

```sh
pnpm install --frozen-lockfile
rustup target add --toolchain 1.97.0 aarch64-apple-ios aarch64-apple-ios-sim
node packages/mobile-core/scripts/run.mjs rust
node packages/mobile-core/scripts/live.mjs
pnpm exec tsx --conditions source packages/mobile-core/scripts/live-relay.ts
node packages/ios/scripts/run.mjs test
node packages/ios/scripts/run.mjs build
```

`prepare` generates the simulator archive, Swift bindings, bundled assets and
Xcode project without running tests. `test` builds these inputs, starts an
unchanged disposable YA server with public fixture credentials, creates its
own simulator after compiling the test bundle, ad-hoc signs the app for
Keychain access, runs XCTest/XCUITest without rebuilding,
adds an ephemeral root only to that simulator for TLS trust/hostname/expiry
checks, and shuts down/deletes the owned simulator and servers. Parallel simulator
cloning is disabled, and Xcode compilation uses at most four host CPU slots.
Host CPU/memory/swap samples are recorded before, during and after execution
in build/host-*.json; compilation does not overlap simulator measurement.
Hosted native tests run first. UI acceptance then requires two consecutive
host samples with at least 20% CPU idle and 1 GiB available memory. First-use
simulator services have up to five minutes to settle; inadequate headroom
fails readiness without skipping or relaxing the input gate.
The input gate is 100 ms locally and on devices. When `CI` is set it is a
250 ms regression ceiling, about 2.3 times the hosted maximum of 108 ms seen
in roughly 40 hosted arm64 runs from November 1 to 26, following
[sequential typing latency](../../topics/ui-testing.md#sequential-typing-latency).
The test always prints its `QA typing report` and emits a `typing-target-miss`
warning above 100 ms. Zero dropped keys and the exact draft remain mandatory.
`build` links an unsigned Release device application;
it does not install, sign for distribution or publish it. Generated projects,
bindings, archives, fixture data and xcresults remain ignored under build/.

A document retains its source across a foreground outage. Rust handles the bounded quick retries. After exhaustion the bundled web client schedules further probes, while native reports network availability and rechecks saved installation continuity before returning to connected. Simulator tests drive this path against real direct and mux servers, checking passive catch-up, route and draft retention through disconnect, refusal, silent sockets, relay restart, wake and offline relaunch.

For an internal phone build see [TestFlight delivery](../../docs/distribution/mobile/README.md#ios-ci-internal-delivery).

The [iOS CI workflow](../../.github/workflows/ios-app-ci.yml) runs Rust checks,
direct/mux/legacy live probes, simulator acceptance and unsigned device linking.
It pins XcodeGen by version and archive SHA-256, Cargo through its lockfile,
libsodium by source hash/signature, and Firebase Messaging through the exact
SPM version and checked-in Package.resolved. It uses the standard arm64
[macOS 15 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
the ambient Apple SDK/runtime is recorded by the build rather than bundled.

## Native storage and lifecycle

One atomic Keychain item owns the host catalog and resume credentials. Writes
read the current protected state; locked/unavailable storage cannot become an
empty catalog and overwrite saved hosts. Passwords are not persisted. Items
use WhenUnlockedThisDeviceOnly and disable synchronization. Continuity keys
are per-profile P-256 SecKey items; this is software Keychain storage, not a
Secure Enclave or attestation claim. Security-client registration/check-in uses
the unchanged capability-gated server contract and native transport context.

A selected host resumes automatically at launch. Each profile has its own
persistent WebKit store and saved application route; React owns draft storage.
Backgrounding immediately retires all foreground native owners and flushes the document's
existing pagehide draft handler before reconstruction. Foreground activation
resumes and checks continuity before handing a fresh document its source.
Switch Host releases the foreground document's lease and opens the native host
list. Other native leases remain connected; profiles on the same eligible relay
share one physical mux socket. The shared runtime owns per-profile sources,
resource scoping and final-owner teardown. Selection still displays one WebView.
Forget first revokes the registered security client on supported servers,
recovering an interrupted registration with the same installation/request/key.
It then atomically tombstones the profile and removes its resume credential
before deleting the route, continuity key and WebKit data. Failed local cleanup
remains retryable and cannot resume. An unreachable server requires the explicit
Forget Anyway choice; local deletion cannot claim remote revocation.

Data frames are bounded to 64 KiB chunks, 32 MiB messages and 64 MiB queued
bytes, with stop-and-wait acknowledgement and a bounded operation count.
Native queue pressure suspends producers rather than dropping a healthy feed.
Incoming data yields a WebKit paint slot between fragments; controls remain
immediate. Upload acknowledgement follows native consumption. Replacement
navigation, renderer termination and host changes retire the document lease.
The privileged bundled document forbids embedded frames with a fail-closed
CSP. Frame checks alone are not claimed to distinguish same-origin parent
proxying. Self-contained HTML previews open in a separate nonpersistent WKWebView with no app bridge or network access. Interactive previews require an explicit Run action. Blob exports use WKDownload and the system share sheet. The simulator verifies the exported filename and bytes and checks that the isolated preview cannot access the bridge.
Speech and device-stream transports retain the native adapter's existing unsupported
fallback, shared with the current Android foreground contract.

## Optional notification configuration

The unconfigured application reports push as unavailable. To configure FCM,
provide private `Config/GoogleService-Info.plist` matching the bundle identifier.
The generated project includes it and enables App/Push.entitlements only when
that file exists. Debug uses development APNs; Release uses production APNs.
An optional ignored `Config/Signing.xcconfig` can provide DEVELOPMENT_TEAM,
PRODUCT_BUNDLE_IDENTIFIER and provisioning settings. Neither private file
belongs in Git. Push capabilities and provisioning must agree in the Apple
Developer account; the build runner's unsigned device check does not prove them.

The native adapter owns OS permission, APNs-to-FCM registration, serialized
FCM-token rotation, bounded HTTPS broker calls and protected management secrets.
Notification payloads can select only a protected opaque subscription binding;
they cannot select a URL or credentials. Native saved-host controls enable,
disable and test one host through the optional native-push-subscriptions-v1
contract. Keychain bindings fence both subscription and current security-client
identity. Session taps resume/check continuity and fetch a safe destination from
YA; project paths never reach Firebase. Partial enrollment is compensated and
failed cleanup remains disabled. QA host catalogs use separate push storage so
acceptance cleanup cannot retire ordinary bindings. Visible lifecycle cleanup attempts at most four
retired bindings without a retry timer. The coarse notificationsEnabled status
requires permission and at least one confirmed, known-host enrollment.
Private development Firebase registration, a sandbox/topic-specific APNs key
in its development slot, and explicit push-enabled provisioning are configured.
The signed iPhone build has the development APNs entitlement. Two disposable
SRP hosts enroll with the public broker, and a real background session event
reaches Notification Center with generic copy. Revocation isolates the second
host without stopping the first; native disable preserves the first host's
saved SRP resume credential. Temporary profiles/subscriptions are retired and
fixture processes stopped after acceptance. First enrollment waits once for
registration, with a 15-second deadline and cancellation/background teardown;
Send test preserves enrollment. Eight focused native push tests pass on simulator
and signed iPhone, including the first-registration and suspension regressions.
Live tap routing remains under validation because system notifications are
non-hittable in the current test controller. Production APNs credentials,
App Store/TestFlight provisioning and publication remain release gates.
Limited-user login remains deferred. Keep the APNs private key and its identifying
metadata backed up securely outside Git; Apple permits one key download.

CI pins macOS 15 Apple Silicon / Xcode 26.3 with its installed iOS 18.6 runtime. The
standard 3-core / 7 GiB macOS 26 host remained saturated throughout the
5-minute readiness window while its fresh iOS 26.5 widgets and indexing
services ran ([run 36887820073](https://github.com/kzahel/yepanywhere/actions/runs/36887820073)).
Only the disposable CI VM disables Spotlight indexing. Local runs use the
newest installed iOS runtime; `YA_IOS_SIMULATOR_VERSION=18.6` selects that
exact installed version and fails if unavailable. Device selection respects
the runtime's supported device types. Both paths retain the native and UI regression suites,
CPU/memory headroom requirement and 100 ms typing ceiling. Simulator
compilation targets the host architecture, matching its Rust simulator library:
`aarch64-apple-ios-sim` on Apple Silicon and `x86_64-apple-ios` on Intel.
Device builds always link `aarch64-apple-ios`. The standard Intel runner has
4 CPUs / 14 GiB; the arm64 VM's 7 GiB still left only about 100 MiB free after
CPU pressure settled ([run 36892794310](https://github.com/kzahel/yepanywhere/actions/runs/36892794310)).
The CPU/memory readiness thresholds remain unchanged. Earlier Darwin samples
reported immediately free pages as available memory. Sampling now uses Node's
`process.availableMemory()` and records free bytes separately, so reclaimable
inactive/purgeable pages count as available, matching the intended 1 GiB gate.

The Intel run [36898374886](https://github.com/kzahel/yepanywhere/actions/runs/36898374886)
also passed all 16 native tests but never reached UI headroom: first boot
produced hundreds of runnable processes, with diagnosticd and Screen Time
extraction among the largest consumers. CI now sets
`YA_IOS_SIMULATOR_PROFILE=input-acceptance` on its newly created device before
boot. This disables a fixed list of simulator diagnostics, Screen Time,
widget updates, photo analysis, media engagement and trial services. Siri,
intelligence and search remain enabled because text input consults them.
App networking, push, Keychain/TLS, WebKit, keyboard,
camera/microphone, Photos storage and file/clipboard services remain enabled.
The runner verifies the booted launchd overrides, records the profile in host
evidence, and removes its per-device store when deleting the owned simulator.
The private store technique is documented in
[simslim's implementation](https://github.com/MobAI-App/simslim/blob/e752a72898ca69f703c74dc79b7b047a4f2093a3/disabled_store.go);
unexpected runtime behavior fails verification. The same 18 tests, 1 GiB/20%
idle readiness gate and 100 ms typing ceiling still apply. Local runs are stock
unless that environment variable is explicitly set. This measurement profile
does not replace stock physical-device release acceptance.

Hosted run [36908114420](https://github.com/kzahel/yepanywhere/actions/runs/36908114420)
passed native tests and readiness, then recorded 370 ms maximum input latency
with zero dropped characters. Every during-UI host sample had no idle CPU;
XCTest's continuous screen-recording encoder consumed substantial CPU. The
scheme now disables automatic capture and selects screenshots, retaining five
explicit UI checkpoint attachments and failure diagnostics. This removes
measurement overhead without changing the workload or 100 ms ceiling. Native
shell assertions use login control identifiers and the Add host button because
iOS 18 uppercases SwiftUI section headings. All 18 local simulator tests pass.

[Run 36915742761](https://github.com/kzahel/yepanywhere/actions/runs/36915742761)
confirmed no recording encoder ran and the shell assertion passed. Intel typing
improved to 176 ms, with zero dropped characters, but the host still had no idle
CPU during typing and measured a 172 ms JavaScript long task. CI returns to the
standard 3-core / 7 GiB Apple Silicon host with iOS 18.6, retaining the service
profile and screenshot configuration. That older-runtime arm64 run had reached
76% idle CPU; its memory rejection preceded the corrected availability sampler.
The same readiness and typing limits apply; subsequent acceptance is recorded below.

[Apple Silicon run 36921363142](https://github.com/kzahel/yepanywhere/actions/runs/36921363142)
passed all 16 native tests and measured 67 ms maximum for 37 characters, zero
drops and 380 overlapping transcript mutations. Foreground and relaunch draft
checks passed, but the default sidebar tap left the drawer closed on iOS 18.6.
The test now uses one explicit center tap from the current element frame,
matching its existing project/session coordinate taps, and captures the drawer
as a sixth checkpoint. All 18 local tests pass.

[Source CI 36926705262](https://github.com/kzahel/yepanywhere/actions/runs/36926705262)
passed all 16 native and both UI tests without skips, including real Switch Host,
then linked and uploaded the unsigned ARM device app. The result bundle retains
six checkpoints and no recording. Typing acknowledged all 37 characters at a
26 ms maximum, with zero drops and 342 overlapping transcript mutations.
The pre-UI readiness samples satisfy the unchanged 1 GiB/20% idle requirement.
This establishes hosted acceptance independently of physical iPhone availability;
physical-device acceptance and distribution signing remain release gates.

## Physical-device acceptance

The native push implementation passes all 21 simulator native tests and both
UI tests. Its signed physical regression build passes 20 selected native tests
(excluding the simulator TLS fixture) and both UI tests: 37 sequential keys,
zero drops, 41 ms peak and 425 concurrent transcript mutations. This build has
no private Firebase iOS configuration, so it does not establish APNs delivery.


On 2026-10-02, a development-signed build installed on an iPhone SE
(3rd generation), iOS 26.6.1, through Machine Control's configured physical
device. All 15 selected native tests and both UI tests passed. Native SRP,
Keychain persistence/resume, continuity registration/check-in/revocation,
cancellation, bridge ownership and protected-state failure handling ran on the
phone. The bundled UI preserved its route and draft across Home/foreground and
process termination/relaunch, then Switch Host returned to native management.
Real sequential typing acknowledged all 37 characters with a 33 ms maximum,
zero drops and 226 overlapping transcript mutations. The six explicit
checkpoints remain in the local result bundle.

Hardware fixtures require an endpoint reachable from the phone, a fresh
server/data directory per acceptance run, and normal approval of the app's
local-network permission. The UI test derives its producer URL from that
endpoint. A fixture may set `externalProducer: true` when its controller owns
the 50 ms append loop: iOS independently blocks local-network access from the
background XCTest runner. In this mode the test requires more transcript
mutations than typed characters during input, while retaining the exact draft,
zero-drop and 100 ms gates. The accepted controller producer completed 1,420
appends with no request failures. Default simulator fixtures continue using
the in-test producer.

Debug acceptance resets only its dedicated QA host catalog at the initial
launch; later launches retain it for the resume/draft checks. Production hosts
are unaffected. The native Add host control has a stable identifier because
SwiftUI exposes it as a cell on iOS 26; WebKit menu controls use their current
frames for one physical center tap.

The simulator-specific ephemeral-root TLS test was excluded from hardware
selection; no phone trust settings were changed. Its full trust/hostname/expiry
coverage remains in simulator CI. This checkpoint proves development signing,
installation and the tested phone flow, not TestFlight/App Store provisioning,
APNs delivery, tablet acceptance or the broader network/media release matrix.
Machine Control cleans its leased XCTest session; the test app remains
installed and opens normally to native login.
