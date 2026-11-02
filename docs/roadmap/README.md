# Roadmap

On-device Android hosting is authorized as a separate incubation effort
(2026-10-17), not a blocker or replacement for the published mobile companion.
The [Android host contract](../../topics/android-host.md) owns the scaffold,
shared Alpine runtime, disabled external desktop observers and the remaining
lifecycle/authentication work. Reliable remote access, including a bounded wake
path, is important product work; host push enrollment and recovery remain
unimplemented. Native setup shortcuts and focused shared YA sign-in pages now
form the onboarding baseline:
the user completed both Claude and Codex subscription sign-ins on the Pixel 9.
Refresh, sign-out and restart persistence remain separate validation work.
Explicit Open now starts a stopped Android host, waits for authenticated local
readiness and offers native recovery after process loss. Unattended wake,
overnight/Doze survival and interrupted-provider resume remain incubation work;
see the [lifecycle investigation](../testing/android-host-lifecycle-2026-10-18.md).
Native controls now share explicit lifecycle and applied-mapping state across
processes, show permission/provider/folder status, and confirm interruption.
The foreground notification adds lifecycle, private working/attention counts
and Open/Host controls/confirmed Stop actions. The
[control-state acceptance](../testing/android-host-controls-2026-10-18.md)
records verification and its limits; unattended lifecycle and credential-renewal
qualification remain separate incubation work.

The enabled Android host now has a roughly ten-second remote-interactivity target.
Its explicit [battery relay profile](../../topics/android-host.md#battery-aware-relay-liveness)
experiments with probing existing sockets after scheduling gaps while desktop
defaults retain their existing recovery policy. Unplugged Doze, real suspension
and public encrypted-session readiness remain qualification work; this does
not add unattended restart or remote wake.
Protected debug ADB lifecycle controls now avoid foregrounding the phone UI;
the [battery/lifecycle evidence](../testing/android-host-battery-profile-2026-10-18.md)
records physical scheduling-gap results and the remaining demand/sleep limits.

Android 9/API 28 ARM64 is supported for now within the experimental host,
following the [Moto X4 feasibility test](../testing/android-host-moto-x4-2026-10-18.md).
Android 11+ remains the routinely tested baseline. Revisit the older support
floor if it adds upgrade, implementation, testing or release friction; the
[host contract](../../topics/android-host.md#older-android-support) owns that
review trigger. The next compatibility step is to integrate the local changes
into the standard build, which still requires API 30. Unattended lifecycle
acceptance remains unqualified; existing incubation priorities are unchanged.

The [Android guest user/admin environment](../../topics/android-host.md#guest-user-and-administration)
now uses `user@ya-phone`, `/home/user` and passwordless guest sudo. Existing
home paths and private state are preserved. Pixel 7a acceptance covers the
staged runtime, guest administration and two real local-server launches.

The Android storage spike validated a
[durable local workspace](../../topics/android-host.md#durable-user-owned-workspace):
select an ordinary shared folder, explicitly enable optional all-files access,
and map its verified real path to `/workspace` in Alpine/PRoot. Writes are direct;
no synchronization or SAF filesystem adapter is needed. A disposable app on the
explicitly selected Pixel 7a passed both real providers, independent hashes,
separate permission revocation/repair and reset/reinstall recovery. The
[spike evidence](../../packages/android-host/workspace-spike/README.md#evidence)
records filesystem limits and Git compatibility requirements. The experimental
host now implements [multiple folder shortcuts](../../packages/android-host/docs/workspaces.md),
optional direct mappings under `/workspaces`, per-root native onboarding/status,
normal project/provider integration, and explicit `ya saf` CLI operations without
broad storage permission. Both methods use the same registrations and expose
separate health. Mapping changes require an explicit host restart; unavailable
roots fail admission without a private fallback. Internal runtime state stays
private. Running-session/handle revocation, arbitrary-provider qualification and
store-policy acceptance remain open. Pixel 7a acceptance passed both real YA
providers across two roots, SAF without broad permission, independent hashes,
revocation/repair and fixture reset/reinstall recovery; owned test resources were
removed afterward. Optional all-files access now also exposes primary shared
storage at `/sdcard` without selecting a folder. Pixel 9 and Motorola physical
fixtures passed no-picker access, independent hashes, revocation and app-data
reset recovery. The Motorola removable exFAT card now uses production
`/storage/<volume-id>` mappings, with native availability/applied status,
per-launch authority/identity checks, and restart required after media changes.
Existing in-flight I/O is not made safe for unplugging.

The [Android host distribution/assistant research](../../topics/android-host.md#distribution-and-optional-phone-automation)
keeps phone-local coding as the product scope. The maintainer clarified on
October 30 that phone computer use is core, behind an explicit default-off app
toggle, and reliable remote access/wake is important. MC/ADB remains the
preferred control route; actual enable/disable enforcement and platform setup
remain integration work. A separate user-reported Moto helper completed three
automatic ADB recoveries after reboot using initially USB-granted settings
authority and enrolled Wi-Fi; see the [reported evidence and limits](../../topics/android-host.md#reported-moto-automatic-debugging-recovery).
This makes privileged native recovery a concrete candidate to evaluate, with
PIN/first-unlock, other firmware and hosted operation still open. The helper's
source was unavailable in this session and it is not integrated into YA.
The [updated distribution comparison](../competitive/android-host-distribution.md)
finds live Play precedents in UserLAnd, standalone Andronix and AiCLI's
Claude/Codex environment. Next: select phone-owned runtime provisioning and
updates, replacing debug ADB staging; qualify lifecycle/credential recovery;
and design gated device control and authorized wake delivery. Play acceptance
of YA's payload, permissions and background/control behavior remains unproven.
Assistant invocation/context is a compelling optional direction, but
remains research/docs only: no device investigation or implementation spike is
authorized. The companion remains a separate release.

Last updated: 2026-11-01.

This is Yep Anywhere's canonical product-priority overview. Keep initiative
status, the next action, and major blockers here; keep implementation steps in
`docs/tactical/` and durable behavior contracts in `topics/`. Planning stays in
the repository and does not require epics, ticket numbers, or pull requests.

The first-party hosted artifact viewer is implemented and integrated on main;
[plan 155](../tactical/155-managed-artifact-viewer.md) records scoped reads,
managed HTTPS content delivery and compatibility. The fixed Cloudflare host is
live, and real YA-pane acceptance over the public encrypted relay passes in
desktop Chrome, Android Chrome on an Android 15 emulator and the attached
Android 17 phone. Opus 5.5 high-effort review findings are addressed; physical
native fresh pairing and static fallback pass. Desktop 0.6.0, Android
internal build 66701, website 1.12.0 and npm 0.11.0 now carry this work.
iOS delivery and WebKit qualification remain; custom artifact
deployments retain precedence.

The maintainer accepted [Android packaged service-worker delivery and secure
transport hardening](../tactical/156-android-secure-transport-and-artifacts.md).
Native resume races now have controlled regressions and repairs; direct and
mux emulator foundation runs pass. Browser login/SRP/relay protection passes
32 cases, including the repaired startup leading-space handoff. The packaged
API35/WebView124 app renders a real 143 MiB movie and twenty images over the
public encrypted relay, with exact ranges, seeking, pause/resume and typing.
The seeded emulator cut/refusal/stall matrix and eighteen viewer teardowns pass;
a separate burst verifies twenty image reads during each fault. Three real
launcher resumes retain the artifact/draft and show one recovery interval each.
The eight-reader 128 KiB/s diagnostic reproduced a relay circuit queue closure
in three original runs. A native connection window with retained-tail accounting
and reader progress reservations repairs that failure; eight-reader acceptance
passes without relay closure, including on the physical phone. The
[measured report](../testing/android-artifact-streaming-2026-10-16.md) preserves an
earlier 103.2 ms frame miss and the narrower coverage of these passes.
Parent reload recovery now reclaims orphaned preview leases while preserving
live owners; eighteen actual-app restorations and browser concurrency checks
pass. Eighteen same-host native-tab round trips also pass with explicit artifact
reopening and draft/route retention. One forced process loss also recovers saved
native pairing and fresh artifact access without credential injection. Physical
source switching and long sleep/radio acceptance remain. The final emulator and
physical full media/fault/warm/cold/reload matrices pass, along with final
large-media matrices over the public TLS relay on both. The maintainer approved
a coordinated beta native/server connection window without an echo negotiation
or old-Android compatibility layer. The shared 1 MiB body budget includes
completed/cancelled tails until receipt, with spare credit lent while preserving
progress for other native readers.
October 20 publication delivered signed desktop 0.4.1 and Android internal
`0.1.2-ci.550.1` / code `65001` from `e65db78de`. All 24 general CI and
12 runtime/SQLite jobs pass on `bd309cd6e`; one native-phone browser retry
retains an unresolved [duplicate first character](../../gaps/native-phone-browser-duplicate-first-character.md).
The [npm 0.10.2 workflow](https://github.com/kzahel/yepanywhere/actions/runs/39472217467)
succeeded; its registry-processing delay was verified cleared before the
October 24 release.
[Website 1.12.0](https://github.com/kzahel/yepanywhere/actions/runs/39478921330)
is deployed; its browser protocol retains the approved 0.9.2 fallback,
independently of the native-only connection window. iOS publication remains
outside this release request.

The October 24 coordinated release uses source
[`bcdd87c0f`](https://github.com/kzahel/yepanywhere/commit/bcdd87c0f0a87193b81c8f7b5f52262960ffb4b0).
[npm 0.11.0](https://github.com/kzahel/yepanywhere/releases/tag/v0.11.0)
is public through `latest`, with tarball integrity and source provenance
verified. [Desktop Stable 0.6.0](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.6.0)
is signed and published; its Stable feed offers 0.6.0 to the published 0.5.x
Latest builds on all three platforms. The
[Desktop QA record](../testing/desktop-release-qa-log.md#2026-10-24--coordinated-stable-060-publication)
records the validation scope and remaining native qualification.
[Android internal 0.1.3-ci.567.1 / code 66701](https://github.com/kzahel/yepanywhere/actions/runs/40107321514)
is published, with the signed bundle and source receipt verified. The
[Chrome extension 0.1.4](https://github.com/kzahel/yepanywhere/releases/tag/extension-v0.1.4)
is public; the store API confirms version 0.1.4 published with no pending
submission. All 24 general CI and nine runtime/SQLite jobs passed on the
common source, and all four release workflows passed. Android public-beta
promotion remains a separate delivery step.

## 1. Publish the desktop and mobile apps with continuous delivery

**Highest priority.** Make Yep Anywhere available as supported public releases
on desktop, iOS, and Android, with CI covering every distribution and a
**Latest** channel for bleeding-edge builds. Android internal releases are
explicitly requested; desktop Latest publication remains automatic. Desktop
should graduate from its current beta positioning; mobile should reach the
App Store and Google Play, not stop at internal testing.

**Status:** in progress. Mobile release direction selected 2026-09-30:
bundled web UI as the primary foreground, with native login, host selection,
secure SRP/session storage, transport, reconnect, and notifications. Android
now opens the complete bundled UI through its native authenticated transport,
with native host management and no duplicate dashboard/Conversation screens.
The implementation and acceptance evidence are recorded in
[the WebView app plan](../tactical/083-android-bundled-web-native-transport.md).
Native dashboard/Conversation rendering and the experimental Simple Client API
preview are no longer mobile release prerequisites. iOS follows the same shell
boundary; the [iOS/shared-core plan](../tactical/138-ios-native-core-proof.md)
has passed its Rust crypto interoperability and native build experiment,
including iOS simulator execution. A Daybreak Blue engineering review supports
the proof and conditional development use of SRP 0.7; the plan records its
production login gates and accepted limits. The maintainer accepted the shared
Rust core with pinned SRP 0.7.0-rc.3 and unchanged-server compatibility. The
consumer iOS 17+ shell now runs the bundled UI over native Rust SRP,
with Keychain storage, continuity-key registration/check-in/revocation and
foreground lifecycle reconstruction. Owned simulator acceptance covers real
native login, concurrent streaming/typing within 100 ms, route/draft preservation
and Switch Host. Direct/mux/legacy server probes and an unsigned device build
pass, including OS TLS trust/hostname/expiry checks and cancellation across FFI.
Dedicated iOS CI runs independently of physical-device signing. The
[hosted source run 36926705262](https://github.com/kzahel/yepanywhere/actions/runs/36926705262)
passed all 18 simulator tests without skips, including native login, streamed
typing, foreground/relaunch draft preservation and Switch Host, then linked the
unsigned ARM device app. Typing acknowledged all 37 characters with a 26 ms
maximum, zero drops and 342 overlapping transcript mutations. The
[main CI run](https://github.com/kzahel/yepanywhere/actions/runs/36926705404)
passed all 24 jobs and 361 browser cases without retries.
CI uses macOS 15 Apple Silicon / Xcode 26.3 with iOS 18.6, compiles before
simulator boot, and requires CPU/memory headroom before UI acceptance. Its owned
simulator uses a verified background-service profile; local runs remain stock
by default. The Darwin sampler reports available and free memory separately.
Automatic XCTest recording is disabled while six explicit screenshots remain.
Native shell checks use control identifiers, and restored WebKit controls use
current-frame taps. Intel native tests also pass with their Rust simulator
target, but Intel UI remained CPU-bound. The 18 tests and 100 ms typing ceiling
remain intact. Initial physical-phone acceptance also passes: 15 native and both
UI tests on iPhone SE (3rd generation), iOS 26.6.1, with development signing and installation.
Typing peaks at 33 ms over 37 keys, with zero drops and 226 concurrent transcript
mutations; foreground/relaunch and Switch Host pass. Store signing/publication,
tablet acceptance and the broader device/network matrix remain release work.
Embedded viewers/downloads need the
[remaining WebKit adapters](../../gaps/ios-webview-viewers-and-downloads.md).
Native per-host push enrollment and presentation are implemented. The updated
broker is deployed; physical Android acceptance proves foreground/background
FCM, two-host isolation, authenticated session taps and headless presentation.
The iOS sandbox Firebase/APNs setup and signed push provisioning are configured.
Two-host enrollment and real background Apple delivery pass; live notification
tap routing remains under validation in the
[native push plan](../tactical/141-native-push-delivery.md). The maintainer
prioritized [Android/shared transport migration](../tactical/139-shared-mobile-transport-migration.md)
on 2026-10-02. That implementation now uses Rust/UniFFI in Android and common
per-profile source leases on iOS. Shared mux circuits, credential-proven route
fallback, scoped ownership and final teardown pass unchanged-server tests.
Android's R8-minified physical Pixel proof includes two hosts on one relay socket
and a 100 MiB upload with 16.6 ms peak typing latency. iOS simulator acceptance
and the physical iPhone native/UI suites pass; the updated physical typing proof
records 37 inputs, zero drops, 19 ms peak and 294 concurrent mutations.
Release builds and required local checks pass. Store publication, remaining native push acceptance and
the viewer/download gap remain the next mobile release work.

### Current baseline

- The October 7 [browser/Android interruption study](../testing/source-lifecycle-study-2026-10-07.md)
  reproduces visible native synthetic 503s and slow passive wake recovery with
  a real emulator/browser comparison harness. The original permanent-failure
  diagnosis is narrowed: the WebView already retries after 60 seconds. The
  first repair preserves typed operation errors instead of fabricated HTTP
  responses; direct/mux emulator reproductions recover without the error.
  Explicit recoverability, platform network signals, abandoned-subscription
  cleanup and page catch-up acceptance are implemented. The
  [second emulator hardening round](../testing/android-lifecycle-hardening-2026-10-07.md)
  repairs shared draft-attachment preservation after failed validation and
  corrects missing fixture routes. Offline notification taps now survive
  recovery and process death, with unit and real-FCM emulator acceptance.
  The full native live suite and all seven extended Android lifecycle cases
  pass, including direct/relay outages, eight-cycle catch-up, process death,
  real FCM and interrupted uploads. Matched Chrome runs retain an intermittent
  initial-typing failure and an unhandled upload rejection as separate gaps;
  standard web recovery policy stays unchanged. Full-device captures now cover
  Android system icons as well as the WebView. The actual Release retains its
  route and draft through an offline Android reboot, and native login labels
  connection failures accurately. CI prebuilds the exact minified probe before
  the emulator, streams test progress and gives the aggregate job 40 minutes
  with unchanged per-test deadlines and app assertions. The final
  [Android run 513](https://github.com/kzahel/yepanywhere/actions/runs/37712235822)
  passes build and complete direct/relay acceptance, then publishes internal
  `0.1.2-ci.513.1` / code `61301` from `a079aa3f9`. Play confirms availability
  to internal testers. All 24 general CI and 12 runtime/SQLite jobs pass;
  two browser retries remain recorded in the report. The earlier
  [Maven dependency 429](../../gaps/android-ci-instrumentation-dependency-rate-limit.md)
  remains an infrastructure follow-up, with its failed attempt preserved.
  Native remains the sole app connection owner.
  October 8 dependency maintenance reproduced a native lease teardown race
  during repeated refresh. Android retirement now rejects late native calls
  and drains admitted work before destroying its lease; deterministic JVM
  regressions cover owned requests and external direct callers. Fresh
  [hosted Android acceptance](https://github.com/kzahel/yepanywhere/actions/runs/37730248677)
  passes the full minified direct/relay suite, including repeated refresh.
  Dedicated physical-phone acceptance on the same repair passes direct and
  100 MiB relay uploads plus repeated refresh in both modes. Real sequential
  typing acknowledges all 29 characters without drops, with 26.5/25.7 ms
  maxima under the unchanged physical-device 100 ms gate and zero transport
  overflows. Hosted software rendering uses the existing 2,000 ms emulator
  budget; it does not establish the physical typing requirement. The separate
  [CI ADB connection loss](../../gaps/android-ci-live-adb-connection-loss.md)
  remains an infrastructure diagnosis follow-up.
  [Passive service-restoration latency](../../gaps/android-passive-service-restoration-slow-probe.md)
  remains a measured UX follow-up under the retained 60-second probe policy.
  The shared transport-unit conformance factory remains follow-up work;
  physical update, modem, overnight and keyboard checks are the next acceptance
  step using the available internal build.

- Signed macOS and Windows desktop releases already exist. The
  [desktop release QA log](../testing/desktop-release-qa-log.md) records
  installer and updater validation; the
  [public distribution catalog](../../site/src/data/distributions.ts) still
  identifies desktop as beta.
  October 3 fixes move update feedback into AppKit/Windows native controls,
  route local Settings to that controller, and use the immutable bundled server
  version. Host macOS native checks and browser regressions pass; Windows native
  interaction, install/relaunch and the reported hours-idle history remain
  acceptance work before desktop graduation. See the QA log for boundaries.
- The web client and npm server are available. The
  [Latest remote-client workflow](../../.github/workflows/latest-remote-client.yml)
  already deploys the exact successful CI commit after pushes to `main`.
- [Desktop CI](../../.github/workflows/desktop-ci.yml) packages and signs
  desktop releases. [Nightly Desktop](../../.github/workflows/nightly-desktop.yml)
  publishes verified `main` changes to Latest; the first signed nightlies and
  the unchanged-source skip have passed release validation. September 30
  verification repaired stale filtered-run discovery and prevents selecting
  source behind an already published Latest. The selector now reads the workflow
  inventory and filters main pushes locally. Forward-source
  [nightly 36715214551](https://github.com/kzahel/yepanywhere/actions/runs/36715214551)
  published `0.3.2701` at verified `2d2f524d5`, with both macOS installers
  notarized, Windows signing successful and all updater signatures verified.
  The earlier draft-creation 403 did not recur with the existing permissions.
- The website's [desktop downloads page](../tactical/134-desktop-download-links.md)
  is live in `site-v1.11.0`. It suggests the visitor's platform and links to
  current Stable macOS and Windows installers through the update server;
  nightly builds remain separate.
- The [server runtime matrix](https://github.com/kzahel/yepanywhere/actions/runs/34485119811)
  now passes full packaged startup on Linux, macOS and Windows across all four
  Node versions and the pinned Bun runtime, including clean npm installations.
- [Android CI](../../.github/workflows/android-app-ci.yml) tests and builds
  application artifacts, including a bundled Release AAB. Public Firebase client
  configuration is tracked, so fresh checkouts and PR builds support push without
  CI secret injection; an explicit Firebase-disabled build remains available.
  A dependent internal publishing job requires a manual main dispatch with
  `publish_internal=true`, then handles versioning, exact-artifact signing and
  stale-run protection.
  Push/nightly verification does not publish and cancels superseded checks;
  explicit releases finish independently of later pushes. Dedicated Google
  OIDC federation and app-scoped Play testing permissions are verified end to end.
  [Hosted run 37202914083](https://github.com/kzahel/yepanywhere/actions/runs/37202914083)
  passed both Android gates and published `0.1.2-ci.464.1` (56401), confirmed
  **Available to internal testers**. The signed bundle matches the tested
  candidate and retained receipt; main browser CI also passed. Neither native
  mobile app is publicly published.
- Both mobile store records have saved initial metadata. Local uploads now
  use platform-managed final signing: Android's upload-signed AAB passes Play
  internal-release validation, and Xcode uploaded the first iOS archive to
  internal-only TestFlight. Android 0.1.1 is now active for the selected internal
  testers, with its opt-in page verified. iOS build 1 shows Ready to Test after
  completing encryption compliance with France excluded from availability.
  October 4 fixes Android's UI-initiated public TLS login failure: 0.1.1
  (1001) is published and available to internal testers, with Main/public-relay
  and isolated production-R8 Release login acceptance on a physical Pixel.
  Android 0.1.2 (1002) is now available to internal testers with host-switch
  resume and WebView inset fixes; the Play password association is verified.
  Retesting the updated Google Play-signed install remains open.
  French classification/filing is deferred before enabling that market; iOS
  tester enrollment and production iOS push remain open. Android internal
  release delivery is available on explicit request; iOS release automation
  remains open. See [mobile store preparation](../distribution/mobile/README.md).
  October 5 public Android setup saves category/contact, app-access instructions
  and all 11 app-setup tasks, including content ratings and Data safety.
  An isolated synthetic reviewer VM passes
  native relay authentication, sample history, mock replies, restart and network
  isolation checks. The listing now includes actual Android screenshots.
  The publisher's [privacy and deletion policy](https://graehlarts.com/privacy.html#yepanywhere)
  is live on October 6, with all three Play URLs saved against it.
  The maintainer saved an all-ages content rating on October 6; preserve it.
  Source integration is complete. Open testing has unlimited enrollment and
  177 countries/regions with France excluded. Signed code 57901 with the privacy
  link was submitted for Open beta 1 review on October 6. Android
  build/lint/inspection and WebView instrumentation pass for the exact source.
  The maintainer selected and saved a 13+ intended audience; the all-ages
  content rating is unchanged. Play approved and published the release on
  October 6. A later link check found the open-testing track paused. Resume is
  saved, with quick checks completed. A later reload confirms its separate
  activation change is in review despite the earlier confirmation error.
  Public enrollment still reports App not available; await activation
  publication before claiming public testers can install.
- Native app CI now runs on relevant platform, shared mobile-core and packaging
  changes rather than ordinary web/server edits. Daily Android/iOS acceptance
  and the existing desktop nightly retain full shared-source coverage; manual
  checks remain available. See [the cadence policy](../development/testing.md#native-app-ci-cadence).
- Linux remains supported through the server/web distribution. The current
  desktop installer matrix is macOS and Windows; a Linux desktop installer
  would need its own scope and release criteria.

### Release outcomes

- [ ] Establish and meet desktop release criteria, then publish and present
  desktop as a supported release rather than beta. Reuse existing signed
  installer and updater evidence instead of restarting the packaging work.
- [x] Decide the first mobile release scope and its acceptance criteria.
  Native shell/full bundled web UI selected; tactical 083 records the gates.
- [ ] Complete and publish Android on Google Play and iOS on the App Store.
  Automated internal testing is an intermediate milestone, not completion.
- [ ] Give every distribution CI verification and automated release delivery:
  website/web client, npm server, desktop, Android, and iOS. Extend existing
  workflows rather than creating a parallel release system.
- [ ] Publish passing, relevant `main` changes to Latest channels without a
  manual version bump, release tag, or upload for each preview build. Include
  signed desktop updates and internal TestFlight. Android internal testing
  instead uses explicit manual release requests, selected by the maintainer
  on October 4. Broader mobile testing must respect platform review and
  distribution rules.
- [ ] Make each platform's latest available build easy to find, with its
  version, source commit, publication state, and installation path. A failed
  or still-processing build leaves the previous successful build available.

### Latest channel expectations

Desktop starts with nightly publication at 02:37 UTC, skipping unchanged
packaged inputs, plus manual dispatch for recovery and validation. Same-app
Stable/Latest selection and signed nightly publication are available. Windows
installed-upgrade acceptance passed, including channel persistence and data
preservation. The macOS VM resumed normally on 2026-09-28, clearing the earlier
suspended-state restore blocker. Installed macOS upgrade acceptance remains
pending; the manual-check regression was reproduced and locally fixed. See the
[desktop release QA log](../testing/desktop-release-qa-log.md).
Continuous per-commit desktop delivery remains a later extension of this
foundation.

Continuous publication should make builds available as soon as verification,
packaging, signing, and platform processing allow; it is not restricted to a
nightly schedule. Coalesce superseded pending work when necessary instead of
building an ever-growing release queue. Store availability and device update
timing are separate; hourly automatic installation is not a guarantee.

Desktop discovers the available update and offers it through a banner or
equivalent notice. The user approves installation through one Update action;
publication must not silently install or restart the desktop app. Mobile
installation follows the user's platform update preferences.

Stable and Latest remain distinct choices. Latest clients must preserve the
supported older-server fallbacks; joining Latest must not require upgrading
every paired machine together. Versioning, signing, installation, update, and
compatibility checks belong to the release criteria, not just compilation.

### Mobile scope decisions and next action

The 2026-09-30 direction uses the full bundled web interface for ordinary
projects, sessions, transcripts, input and settings. Android owns native login,
reauthentication, host selection, protected SRP/resume credentials, transport,
reconnect and notifications. Saved-host selection enters the web app directly;
Switch Host returns to native management. Management observes connection state
without retaining dashboard subscriptions. The approved
[Android tabs and warm-resume work](../tactical/146-android-tabs-and-warm-resume.md)
adds a native top toolbar and internal-only tabs while preserving the selected
WebView through ordinary multitasking. Implementation and Pixel acceptance are
complete: direct/two-host relay, public-relay radio loss, launcher resume,
rotation, tab/link routing and typing during 100 MiB upload are verified.

The initial mobile release uses server-owner login. Native limited-user login
is explicitly deferred (2026-10-01). Android and the iOS native-login/transport
shell are implemented; iOS has owned simulator, unsigned-device and signed
physical-phone acceptance evidence.

The [WebView app implementation](../tactical/083-android-bundled-web-native-transport.md)
reuses the existing native pairing and multi-host core and the web client's
SourceTransport contract. It adds no server authentication protocol or child
credential. Android now preserves typed request failures and keeps exhausted network
recovery visibly reconnecting, with a native network-restored signal feeding
the existing recovery scheduler. Browser recovery policy stays unchanged;
subscription failures and cancellation now retain native semantics, with
page catch-up acceptance covering session, Inbox, sidebar and retained drafts.
The broader all-transport conformance suite remains follow-up work.
The duplicate native dashboard and Conversation presentation are
removed, with reusable decoder/projection helpers retained.

The [Simple Client API experiment](../tactical/130-simple-client-api-and-three-client-demo.md)
remains separate work: the generated contracts and deliberate-entry web preview
are useful independently, but native Conversation UI and SourceOverview are
not mobile release prerequisites. The previous native preview remains
historical evidence in Git.

**Next action:** finish store signing/distribution, notification enrollment and
tap acceptance, and release-device/network checks for both mobile apps. The
[Android offline recovery repair](../testing/android-offline-recovery-investigation.md)
keeps cold pages navigable and recovers in place; physical Pixel/public-relay
radio-loss and launcher-reopening checks pass locally. Complete
the iOS embedded-viewer/download adapters before claiming full UI parity; a new
SwiftUI transcript/composer design is not required. Desktop release and
continuous-delivery work continue independently.

## Active maintenance focus: core house cleaning

On 2026-10-26 the maintainer selected substantial
[core house cleaning](../../topics/core-house-cleaning.md) before further
session-core expansion. Local `main` was restored to upstream; the expanded
core experiment remains archived rather than serving as the next baseline.
The initial selection was rows **1, 2, 3, 11 and 12** of the numbered proposal:
YA-managed workstream/parallel checkout lanes, both released and managed SSH
executor stacks, the YA Hosts placeholder and Gemini ACP. The Conversation
API/preview is deferred from this implementation pass. This pass focuses
on Kyle/kzahel (`kgraehl@gmail.com`)-led features. Work led by
`graehl@gmail.com` is deferred, including dormant helper targets, synthetic
heartbeat automation, wake turns, recaps and post-compact replay. Mixed rows
identify each contributor's feature separately; shared repairs are not undone
based on authorship. Subsequent row-specific decisions supersede that initial
deferral: on 2026-10-27, row **4**'s dormant helper-target plumbing was authorized
for removal; that cut is now implemented under plan 164. Consider a provider-server-managed,
no-tool in-house provider for prompted UI-helper/text-processing-only access
upon first need; building it is not a cleanup prerequisite. The
[helper-session disposition](../../topics/openai-compatible-helper-sessions.md#disposition)
records the boundary.

Row **5** synthetic heartbeat automation is removed: configured turns,
forced nudges and candidate-driven resurrection are gone. Patient/done-action
maintenance, transport health, provider liveness and shared resume exemptions
remain. [Plan 164](../tactical/164-remove-retired-session-automation.md) tracks
this removal pass and its verification.

Row **6** is resolved as **keep or redesign; do not remove**. Addressed event
delivery and authorized recipient resumption are valuable for multi-session
coordination independently of harness background-job limitations. The ability
belongs at the provider API boundary, with provider-server/runtime ownership;
the YA web server may be a transport adapter. The
[session-wake direction](../../topics/session-wake.md#selected-ownership-provider-api)
preserves the existing path pending migration and requires no periodic
heartbeat machinery. This is a documentation decision, not a landed redesign.

Row **7** is resolved: remove post-compact replay configuration and generation
of its specific quoted-history/`continue.` message, using explicit `/goal` for
sustained-task intent. Preserve post-compact hooks/dispatch, their safety gates,
general hidden injected-message support and historical replay recognition.
The [replay disposition](../../topics/post-compact-replay.md#selected-disposition)
records the implemented removal and retained opt-in runtime action hook;
[plan 164](../tactical/164-remove-retired-session-automation.md) records verification.

Rows **8–9** are retained. Recaps keep their implementation, with a pending
concise, expandable configuration UI and warnings about current fork economics.
Keepalive must become default-off and enforce at most ten refreshes between
real uses, a running net-savings UI log and durable per-session disablement at
a configured net-loss threshold. The [recap disposition](../../topics/recaps.md#house-cleaning-disposition)
and [keepalive contract](../../topics/prompt-cache-keepalive.md#refresh-budget-and-net-savings-log)
record the decisions; UI changes, accounting, limits and the default change
remain implementation work.

Row **14** now defers `/btw` removal because Quick Question's Continue /btw
action supplies a useful continuing conversation. Preserve that transition,
its destination and aside UI/lifecycle, alongside Quick Question and
fork-from-turn. Row **15** still removes unfinished aside report-back while
preserving close/return behavior and the built-in `/done` and `/archive`
commands. A general split-session browser for forks remains a future option. The
[aside disposition](../../topics/provider-agnostic-btw-asides.md#selected-disposition)
records the boundary; the unfinished report-back placeholder is removed under plan 164.

Row **16** retires the obsolete Spark-only plan, not the current broader
compaction implementation; removal of YA idle-threshold policy remains
undecided. Row **17** retains Pi and Grok based on actual use and adequate
functionality. Pi's possible future replacement of the Claude Gateway Copilot
workflow remains a separate evaluation, not a migration decision.

Row **1** is implemented and locally verified: managed lane creation,
selection, scanner grouping and launch plumbing are removed; existing
checkouts remain untouched. [Plan 160](../tactical/160-remove-managed-checkout-lanes.md)
records the verification.

Row **2** removes released SSH/rsync execution and its settings/selector.
Historical executor records are read-only and cannot fall back to local
execution; [plan 161](../tactical/161-remove-ssh-executors.md) records evidence.

Row **3** removes the managed SSH runner, remote workspace/auth/mirroring
stack and placement protocol. Same-host workers remain; plan 161 records
verification.

The nonfunctional YA Hosts placeholder (11), both routes, preload entry and
Developer setting are removed; actual host switching and identity remain.
[Plan 162](../tactical/162-remove-hosts-preview.md) records verification.

**Updated direction, 2026-10-27:** freeze legacy Gemini (row 12) and move
future Google agent support toward Antigravity (`agy`), preferably through its
official ACP runtime. Gemini's current mapping remains unchanged for now.
Retention is conditional: reconsider removing Gemini if it slows the core
refactor, unless it provides useful evidence that the provider boundary works
across genuinely different implementations. Useful controlled regressions may
survive without the legacy runtime. See the
[freeze and retention criteria](../../topics/core-house-cleaning.md#frozen-gemini-and-future-antigravity-support).

Rows 1, 2, 3 and 11 are the completed removal set. The independent review
closed direct-fork and background-candidate SSH boundaries; plan 161 records
the verification. The purpose is a smaller local core that can reliably run
queued `/compact` followed by message delivery. Choose a reduced plan for
that outcome; the archived refactor remains paused. Neither Gemini upkeep nor
shipping AGY is a prerequisite, and API delegation is separate work. Other
Kyle-led candidates remain follow-ups; graehl-led work is outside this pass.
Release-delivery work remains independently required; local sessions,
same-host provider ownership, ordinary queues, direct/relay access and native
client transport remain retained foundations.

[HTTP-independent restart compaction](../tactical/163-http-independent-restart-compaction.md)
is implemented: extracted in `06cff21d6`, with observer cleanup fixed in the
follow-up commit. Workspace checks and independent Opus review passed. This
standalone hygiene work leaves resume compaction, queued compact delivery,
Codex native dispatch and deferred automation changes as separate work.

The [October 28 provider architecture comparison](../competitive/t3code-provider-architecture.md)
records the reduced YA baseline against current T3 source. It recommends
planning shared live-recipient input admission and queued compaction, with
runtime-owned cold wake as a separate migration. It reuses the existing provider
host rather than adding another core runtime. These are recommendations, not
newly selected implementation work or a decision to replace provider-native
history.

For new-session creation, the maintainer selected
[YA-owned session identity and startup lifecycle](../../topics/session-identity.md)
on 2026-11-01: persist a session before provider launch, keep its public id,
and retain saved/failed startup state without requiring a native transcript.
This reopens the new-session portion of plan 150 as the foundation for the
[creation/navigation proposal](../../topics/session-creation.sketches.md), not
the archived general core or full fork/clone program. Concrete schema/API choices, storage bounds and the core release-corpus audit
are recorded; provider/startup implementation and legacy refresh qualification
remain in progress.
[Plan 171](../tactical/171-durable-session-identity-and-creation.md) defines
bounded identity/creation slices, standalone-profile tests, Sol 6.1 High review
after each implementation slice and commits as work proceeds. Plan review is
accepted after corrections; concrete schema/API entry-gate work and runtime
design are now independently accepted by Sol 6.1 High, including bounded attempts,
durable recovery keys and retained-fork source uncertainty. Typed identities,
scoped binding storage and bound Claude/Codex detail/history are implemented and
independently accepted. Claude/Codex discovery/collection projection and scoped
summary sources are also accepted, including native/public-key collisions and
project-membership checks. Focused Claude/Codex watches also translate stored
native sources and cancel abandoned resolution. Retained fork/clone source
translation is independently accepted, including native/public separation,
torn-record tolerance and refusal of unqualified cold-launch namespaces before
copy. Child lineage/account settings remain public. The standalone process fixture is
also independently accepted, with poisoned-parent config/shell checks and
Node-coordinated Node/Bun creation/history/restart/cleanup. Instruction, issue and
Conversation reads are independently accepted with native scope and original
project authority, public observations and catalogue-upgrade recovery. Process and
child-list projections are independently accepted with native source/public
parent separation, empty working-project recovery and standalone Node/Bun
child-content restart evidence. Native vocabulary reads, optional-question
metadata joins and pooled maintenance history comparison are independently
accepted, with Node/Bun native-file and metadata-collision evidence. Claude/Codex
external file observation is independently accepted with bounded source work,
public ownership/project events, native thread/leaf separation and cancellation
before database teardown. Cold/warm/in-flight reader and batch/project-transition
regressions are qualified, along with standalone Node/Bun append/restart
observations. OpenCode native-source migration is independently accepted with
canonical DB/JSON roots, native/public projection, physical project-alias proof,
root-scoped summary computation and focused DB/WAL refresh. Real Node/Bun
HTTP/WebSocket/restart checks retain the YA id; launch remapping is still gated.
Pi source migration is also independently accepted: native-root adoption,
indexed metadata and focused fixed-mtime append refresh preserve the YA id;
terminal reader retirement discards pending results. Node/Bun HTTP/WebSocket,
restart and retirement-race checks pass. Grok native-source migration is
independently accepted: scoped history/metadata, late replay-file observation,
proven child reads and media under an empty working-project move pass focused
and owned Node/Bun restart probes. Canonical native acquisition refuses a
conflicting directory spelling, including after warmed-summary replacement.
Final workspace gates pass. Frozen Gemini native-source migration is
independently accepted: scoped header/hash reads, root enumeration, original
physical aliases, public observation and retirement races pass focused checks
and owned Node/Bun HTTP/WebSocket/restart probes. Qualified missing native
proof is omitted from the catalogue. Warm index edit/create invalidation uses
the retained observation owner and passes Node/Bun probes. Final workspace
gates pass; protocol and launch mapping remain frozen.
Fork-backed retitle, handoff-summary and recap sources are also independently
accepted. Public generator ids resolve once to scoped native inputs; Codex
refuses another returned thread, and actual pinned Claude SDK/CLI probes verify
account-home, directory-alias, long-key and physical-cwd selection using only
owned local fake model endpoints. Unsafe fallbacks and symlink-relative home
resolution were corrected after review; final workspace gates pass.
The durable-creation storage foundation is independently accepted: migration
18 commits exact text, required creator/source, identity, saved settings,
operation and first attempt atomically; metadata mirrors publish after commit.
Request/retry replay, generation fences, uncertainty and deletion tombstones
pass real SQLite/reopen checks on Node 22 and pinned Bun. Wrapped fatal-startup errors now close input admission before synchronous
error callbacks, and established dead owners reject new input while lazy first
input remains valid. Independent review, actual pinned SDK Node/Bun missing-
executable probes and full Node 22 checks pass. Durable runtime creation and
public capabilities are unchanged. Saved/failed records are now readable through
ordinary detail/metadata under existing project/creator access, without a native
transcript or project directory. Their exact source/prompt survive reopen;
saved facts do not borrow native-alias activity, and ordinary unbound resume
refuses. Review, standalone Node/Bun HTTP probes and full Node 26 checks pass.
Collection visibility is independently accepted: Saved/Failed rows appear in both list
implementations, inbox and project cards, and bound records remain readable
before their native transcript exists. An atomic control revision participates
in conditionals and stats invalidation. Hidden projects remain hidden, startup
updates imply no unread provider content, and mixed bound/native counts use
identity union. Focused, standalone Node/Bun and complete Node 26 checks pass;
equal-id Claude integration is next. Native-allocation quarantine is also
independently accepted: dispatch records the selected namespace before effects,
early unknown transcripts cannot become duplicate public sessions, and matching
binding releases only its own claim. Unknown outcomes retain quarantine across
restart/deletion; legacy reads and watches cannot bypass it. A deterministic
watch race and a retained-preview regression were corrected after review;
focused, owned Node/Bun probes and complete Node 26 workspace checks pass.
The additional launch-choice snapshot and independent first-input UUID are also
independently accepted, with real SQLite/replay/reopen and Node 22/Bun checks.
Static gates pass; its two full runs hit the separately tracked Rendez restart
failure, which remains open. A private saved-request Claude dispatcher and
permanent-identity Process boundary are independently accepted, including actual
pinned SDK/CLI input evidence against an owned local fake model on Node 22,
Node 26 and Bun. Verified teardown retains failed owners, normal completion
closes input, and native scopes include symlinked directory leaves. Final
lint/format/typecheck and the complete Node 26 workspace pass; the initial red
Rendez run remains recorded without claiming a watcher fix. Ordinary
caller rollout is independently accepted for qualified project/detached superuser
Claude text requests, including saved startup failure and versioned first-input
metadata. Existing response/queue behavior stays compatible; actual owned Node/Bun
HTTP/SDK/CLI/profile-restart qualification passes using a local fake model.
Deferred starts retain copied values without the full HTTP request. Final
lint/format/typecheck and the complete Node 26 workspace pass.
Default-wrapper consolidation is independently accepted so omitted-provider Claude
requests reach the same owner; an owned Node HTTP/SDK/CLI/profile-restart
probes pass on Node and Bun. Focused and final lint/format/typecheck/full
workspace checks pass. The hosted creation contract and non-enabling startup
handshake are also independently accepted: unsupported workers receive no
launch input, old workers retain their behavior, and owned Node 22/26
deadline/verified-cleanup probes pass. Focused assembled-host and complete
workspace checks pass. Managed worker evidence and attach fencing remain
gated, alongside remaining input shapes and router/sandbox integration.
Fully scoped cold resumes,
remaining provider observation,
released-client qualification and native source consumers are next; durable
admission, split-id launches and release qualification remain gated. This does not displace release delivery or
require queued-compaction work first.

The [creation-provenance admission notes](../../topics/session-creation-provenance.sketches.md)
are incorporated into plan 171's admission/caller slices and six-path coverage
ledger. Original request source must survive deferral/retry and appear on
saved/failed sessions; the [audited source omissions](../../gaps/session-creation-source-missing-launch-paths.md)
remain open until each affected path is implemented and verified.

## Later directions

The [clone and fork settings repair](../tactical/140-clone-session-settings-inheritance.md)
is implemented and locally verified as of 2026-10-02. It preserves source
permissions, model, thinking/effort and service tier across supported providers.
Shared source snapshotting, child persistence, native Codex policy and
first-send/restart behavior have regression coverage. Workspace and focused
browser checks passed on macOS; Linux/Windows evidence remains external.

The separately authorized [project-template implementation](../tactical/132-project-template-implementation.md)
now has a native library composer and opt-in settings for ordered GitHub/local
sources, pinned retrieval and manual updates. Production creation, ready-content
admission and limited-user template grants with project-confined setup are
implemented. Personal-workspace scopes, retained App access, reservations and
project-local identity remain pending. The three default templates are admitted.
The [project service specification](../../topics/project-service.md) now defines
main-pane App access, standardized serving/lifecycle declarations, conditional
vhost association in project Settings and audit-preserving personal removal;
its mockup does not implement those runtime contracts.
This work does not displace release delivery above.

The separately authorized
[Machine Control desktop consumer](../tactical/142-machine-control-desktop-consumer.md)
is complete as of 2026-10-03. Verified discovery and default-off session selection
consume MC's installed Python CLI, sharing discovery with independent native
sudo. Mac/Windows actual Codex native/browser use, live/reloaded media and
close/restart/crash isolation pass; Linux x64 installed CLI/core desktop use
passes its bounded slice. YA's former Windows component installer, updater,
resident supervisor and product controls are retired with bounded compatibility
refusal and exact-instance cleanup. Remaining provider/platform cells are listed
in the owning [topic](../../topics/optional-computer-control.md). This separately
authorized work does not displace release delivery above.

The maintainer proposed an experimental
[Chrome extension client](../tactical/151-chrome-extension-client.md) on
2026-10-13: the full web client served from an extension origin over the
public relay, starting with a stable store id and a relay origin allowlist
entry. The store draft id and public key are reserved, and exact extension
origin admission is deployed on the default public relay with 26 passing
public upgrade/CORS probes. The client builds as an unpacked extension,
reaches the relay, survives reloads and is signed in to a real host in the
maintainer's Chrome. Publication acceptance in a clean Chromium profile now
covers session/Settings reload, saved-login browser restart and sequential
typing within 100 ms during relay transcript updates. A side panel listing the sessions that mention the GitHub or Jira item
in the current tab (exact server lookup across saved hosts), automatic lookup
with a toolbar badge on user-granted sites, and a Browser extension settings
pane are implemented and accepted locally and in the maintainer's Chrome.
A public 0.1.1 listing, actual screenshots, privacy disclosures and an audited
CI ZIP/draft-release workflow are prepared. [Chrome Extension
CI](https://github.com/kzahel/yepanywhere/actions/runs/38405189923) passed the
actual 0.1.1 ZIP and produced its draft release. The exact ZIP, listing, assets,
privacy disclosures and restricted reviewer access were saved in the Web Store
and submitted on 2026-10-13. Public distribution covers all regions, with
automatic publication after approval. On 2026-10-14 the store reports 0.1.1
as **Published — public**. The 0.1.3 update passed
[CI](https://github.com/kzahel/yepanywhere/actions/runs/38604832081) and was
submitted with its new `contextMenus` justification on 2026-10-14. The store
subsequently published 0.1.3; the October 24 read-only API check confirms
**Published — public** and no pending submission.
Future explicit extension tags now have exact-ZIP acceptance, keyless Google
API submission and GitHub release receipts. A newer accepted release supersedes
an older pending submission after confirming cancellation; older runs cannot
cancel newer submissions. Listing/privacy edits and Google review remain
outside CI. The release helper follows the existing tagged
website release pattern. The [live read-only authentication check](https://github.com/kzahel/yepanywhere/actions/runs/40104219485)
passed on 2026-10-24 and confirmed 0.1.3 is published.
Opt-in extension development now rebuilds to a separate `dist-dev`, with a
side-panel update indicator and panel-preserving UI refresh; full worker
reloads attempt to reopen the panel within Chrome's gesture restrictions
([plan 154](../tactical/154-extension-development-builds.md)).
The dev footer always offers **Reload extension** independently of build
detection, alongside the lighter panel refresh when a full reload is not required.
Full dev reload also snapshots and recreates the open extension tabs at their
exact session URLs, preserves tab/window placement, and attempts panel restoration.
The side panel now offers per-site access above its content even when the
current address is hidden or no host is connected; Chrome 133+ handles the
unknown-site request without broader tab permissions. Older Chrome retains
toolbar guidance ([site access contract](../../topics/trusted-client-packaging.md#chrome-extension-client)).
Website 1.13.0 adds a public Chrome extension guide at
`/docs/chrome-extension`, with the store install link, related-session workflows,
setup and current limits, linked from the homepage, download page, catalogs,
docs and footer. This experiment does not displace release delivery.

These remain candidates behind publishing and continuous delivery, not a
ranked or approved implementation queue. Recheck current code and owning
documents before defining work.

The maintainer authorized the
[Agent Auth Router integration](../tactical/143-agent-auth-router-integration.md)
on 2026-10-03. Its manual first slice is implemented in both repositories:
private local pairing, granted account catalogs/quotas, native Claude/Codex
transport overrides and durable same-account pins. Live adapter creation,
continuation and resume passed with temporary YA profiles; full YA HTTP
restart/resume and tool approval also passed. The
[owning topic](../../topics/agent-auth-router.md) records setup and boundaries.
The authorized recovery follow-up adds on-demand reachability, disabled-account
guidance and explicit cancellation/disconnect retry before automatic policies.
AAR owns the SHA-pinned cross-repository regression suite for both providers.
Manual/Round robin allocation and a cached quota/eligibility overview are
implemented. Since 2026-10-13, New Session remembers pool/account/policy per
provider on the server, with silent fallback when unavailable or unsupported;
API-created-session defaults remain deferred. YA respects router-owned pool grants and exposes read-only
management guidance; legacy routers retain their scoped editor. Advanced
balancing, clone/helper inheritance, Windows and constrained sandbox support
remain later work. On 2026-10-03 the maintainer deferred the next
[refresh/admission, Most remaining and inheritance follow-ups](../../topics/agent-auth-router.md#deferred-follow-ups);
they remain recorded candidates. Durable OAuth renewal and cross-account
continuation remain unverified. The maintainer subsequently selected
[router-owned pools, live accounts/grants and a Tauri desktop app](https://github.com/kzahel/agent-auth-router/blob/main/docs/router-owned-pools-and-desktop.md):
correct ownership first, remove restart/re-pair enrollment, then deliver signed
Mac builds with Windows boundaries designed in. YA now implements the
authority/capability boundary; AAR owns desktop acceptance. This work does not
displace release delivery.

| Direction | Existing context / decision still needed |
| --- | --- |
| Session creation acceptance and background creation | [YA-owned session identity](../../topics/session-identity.md) is the selected foundation as of 2026-11-01: permanent public ids, durable sessions before provider launch and retained startup outcomes without native transcripts. The [creation/navigation proposal](../../topics/session-creation.sketches.md) builds durable acceptance, optional Create in background / Command-Enter and safe draft/attachment recovery on it. The dated release-corpus audit records legacy responses, filename-based refresh and transcript-less-read concerns; implementation, concrete schema/API choices, storage bounds and provider/skew qualification remain pending. New-session work from plan 150 is reopened; the full fork/clone redesign stays deferred. |
| Multi-machine experience across the full web and desktop clients | Preserve independent host access and [source runtimes](../../topics/client-source-runtime-topology.md). The Kyle-led alternate Conversation API/preview is deferred from the current removal pass under [core house cleaning](../../topics/core-house-cleaning.md), row 10; retain its current consumers and behavior. |
| Agent API and access across installed machines | Updated direction, 2026-10-30: [unstable server-addressed HTTP v0](../../topics/http-api-v0.md), discoverable caller identity/access and session creation provenance on both ends. Agents manage their workflows; custom delegation/task lifecycles are not prerequisites. [Plan 165](../tactical/165-http-api-v0.md) starts with isolated core/HTTP tests and local/direct profiles before peer-grant UI and production enrollment. Persistent target-owned sessions and directional grants remain the remote direction, with the public encrypted relay as the usual route. The local read-only API/core, launch-bound bootstrap, served help/schema and opt-in documentation evals are implemented ([plan 166](../tactical/166-agent-api-bootstrap-and-documentation.md)); [Plan 167](../tactical/167-agent-session-commands-and-following.md) delivers compact reads/following, opt-in native creation/queued messaging, durable retry receipts and trusted provenance. [Plan 168](../tactical/168-peer-access-and-enrollment.md) implements directional peer routing and an optional enrollment/authentication sequence, with independent Sol and Daybreak Blue design reviews. The first isolated two-peer adapter is implemented and independently reviewed, including create/message/follow, scoped receipts, outbound provenance and revocation; production enrollment now adds owner-only management, distinct expiring SRP credentials, direct/encrypted-relay routing and separately granted native peer leases ([contract](../../topics/peer-access.md)). No managed delegation lifecycle is introduced. Node/Bun protected workflows, a light relay model trial and an owned native Windows enrollment/transport probe pass; packaged-provider/UI and the broader network matrix remain pending. The independently reviewed optional basic fleet service and target consumer now provide key-bound enrollment/session refresh, bounded directory/mailbox, signed/encrypted invitations, explicit manual/fleet credential selection and issuer-bound protected native workflows; a light fleet relay agent trial passes. External OIDC login is implemented and independently reviewed through an owned standards-protocol issuer: PKCE/JWKS validation, browser-only confirmation, live owner/revocation fences and the same protected native workflow ([fleet contract](../../topics/fleet-authentication.md)). [Peer UI direction](../../topics/peer-access.md#owner-ui-direction-relay-pairing-and-audit) now specifies owner-login pairing without a second approval, audit views on both ends, durable pairs across human relay-login changes and optional/changeable bidirectional access. Discovery sharing and full mesh remain future opt-in design work. [Plan 169](../tactical/169-server-connections-ui.md) now implements independently reviewed Server Connections settings, server-side direct/relay enrollment, independent directional renewal/revocation, identity icons/hostname/OS and audit/recent-session views. Isolated real SRP/relay and native create/message/follow workflows pass; browser typing and phone/desktop captures are reviewed. Windows qualification remains deferred. Agent-facing server descriptions now include optional saved names/host details, with no peer probes on listings and current details on individual requests ([contract](../../topics/http-api-v0.md#server-names-and-host-details)). [Plan 170](../tactical/170-peer-authentication-refresh.md) now delivers independently reviewed automatic direct/relay sign-in: short-lived access, a sliding 90-day inactivity deadline, durable lost-reply recovery, bounded quiet-profile scheduling and clear Settings recovery. Explicit fixed grants and each direction's authentication policy remain independent; typing and phone/desktop captures pass. Agent use of paired servers now defaults on without a separate Settings switch; the underlying opt-out remains, and browser-saved host logins stay independent. The Settings page now presents two compact device lists with independent confirmed removal; names open details/audit and connection settings are collapsed. Server Connections is now available by default without a UI enable switch; pairing remains explicit and the optional environment kill switch remains. [Plan 172](../tactical/172-identity-service-naming.md) records the proposed terminology-only rename from fleet to Identity Service; implementation is not authorized. Read-only UI, mesh behavior and live external-provider qualification remain follow-ups. This does not displace release delivery. |
| Authentication and delegated access | [Limited users](../../topics/limited-users.md) delivers local accounts and project grants. [Principals and grants](../../topics/principals-and-grants.md) coordinates the broader proposed invitation/account and issuer boundaries; it does not approve a universal grant protocol. The [2026-10-31 authentication sketch](../../topics/principals-and-grants.md#replaceable-authentication-and-a-basic-local-configuration) supports a basic local username/password configuration, optional OIDC and managed providers around common YA identity/enrollment/grant services; no central service is required. [Session notes and discussion](../../topics/session-notes-and-discussion.md) and [participatory Live Share](../../topics/relay-origin-and-share-gating.sketches.md#participatory-live-share) propose human-only notes/chat, owner-reviewed suggestions, and later explicit session-input grants. These remain later directions, not a newly ranked implementation queue. |
| Related work across repositories | [Issues & PRs](../../topics/issue-session-associations.md) now has experimental, default-off automatic ticket/URL discovery from viewed sessions and a configurable recent-session window, durable evidence, search and correction controls. Conservative URL/known-prefix matching, durable Jira project learning, and session-grouped browsing are implemented and locally validated. SQLite migrations and compatibility gating are implemented. Multi-server issue grouping enters the simple-client demo above. GitHub items show their last-read open/draft/merged/closed state, with independent read-only checks, configurable gh/account use, durable merge facts and an expandable extension Merged PRs section ([plan 153](../tactical/153-durable-github-status-and-extension-groups.md)). Refresh remains demand-driven. Workstream/branch inference, Jira status and tracker synchronization remain deferred. |
| Parallel work within one repository | YA-managed workstreams/lane checkout creation is removed under [core house cleaning](../../topics/core-house-cleaning.md). Do not continue its unfinished scheduler, sync or landing plan. Ordinary user-created Git worktrees and Source Control are distinct retained concerns. |
| Scheduling | [Yacron](../../topics/yacron.md) and its [open gap](../../gaps/sketches/yacron-scheduler.md) remain deferred proposals, not prerequisites for house cleaning or the local core. Synthetic heartbeat and related graehl-led automatic-input policies are explicitly deferred for this pass in the [cleanup table](../../topics/core-house-cleaning.md); preserve their current behavior. |
| Agent command runtime | Opt-in [`ya-agent self`](../../topics/agent-self.md) implements ownership and model/effort evidence reporting. Use operator-managed global instructions initially; defer automatic advertisement, private input, broader session access, and scheduling integration. |
| Node 22 and built-in SQLite | Follow the approved [runtime cutover plan](../tactical/123-node-22-builtin-sqlite-cutover.md): raise the server runtime floor now, retain older-server hosted frontend support with advisory runtime warnings, and gate new SQLite-backed features by their exact capabilities before considering any separate frontend cutoff. Since 2026-10-11 SQLite is required: session metadata lives there and a server that cannot open it does not start ([plan 150](../tactical/150-ya-owned-session-ids.md) stage 1). New Claude sessions keep YA's id from creation, and clones of router-pinned sessions keep their account. On 2026-11-01 the maintainer reopened [durable new-session identity/startup ownership](../../topics/session-identity.md); the scoped identity/read/observation foundation is implemented under [plan 171](../tactical/171-durable-session-identity-and-creation.md), while durable startup ownership and the full fork/clone redesign remain pending. |
| Source workflow depth and traceability | Build on [Source Control](../../topics/source-control.md), [review handoff](../../topics/source-review-to-session.md), and [commit/session attribution](../../gaps/sketches/committed-change-session-attribution.md). Additional Git or terminal controls need a concrete user workflow. |
| Provider maturity and other deferred work | Consult the owning provider topics and [deferred backlog](../../topics/deferred-roadmap.md); its local ordering does not override this product priority. |
| CI browser reliability and cost | The [CI isolation campaign](../tactical/135-e2e-suite-cost-ratchet.md) owns worker profiles, mutable services and joined cleanup. CI exercises two workers per existing shard. The fixed-source pair passed both schedules, with the worker pair's slower job 47.8% shorter and combined jobs 41.2% shorter; each needed one retry. Subsequent worker revisions completed first-attempt E2E repeats. September 30 fixture-home and reload-environment isolation resolved seven reproduced local failures; the full four-worker suite then passed 352 cases without retries. Source CI 36712930735 and follow-up 36715163980 each passed all 353 browser cases without retries, the full unit suite and every native platform leg. October 1 source CI 36799408077 is red on new dependency advisories and Windows computer-control cleanup; its passing browser shards include one retry in the All Sessions reservation assertion. Server Runtime And SQLite 36799408196 also failed Windows Bun package readiness. Local repairs cover audit resolutions, asynchronous cleanup with native regression coverage, port-file publication, measured macOS identity-probe headroom, and the reservation oracle. Final local browser verification passed 360 cases without retries plus 20 reservation repetitions. Repair commit `17a085b59` passed all 24 jobs in [CI 36816545726](https://github.com/kzahel/yepanywhere/actions/runs/36816545726), including 361 browser cases without retries and every native platform leg; [runtime/SQLite 36816545797](https://github.com/kzahel/yepanywhere/actions/runs/36816545797) passed all 12 platform/runtime legs on the first run. The documentation follow-up [CI 36817606854](https://github.com/kzahel/yepanywhere/actions/runs/36817606854) also passed, but exposed a right-pane reload retry: late app metadata made historical output look fresh. A deterministic hook regression reproduced that defect; discovery now remembers initial tool URLs before their mappings resolve. Thirty local browser repetitions then passed without retries, retaining concurrent typing and reload assertions. Source CI 36820386055 exposed a separate Intel macOS assembled-inventory timeout: its one-second status budget was shorter than the three-second native identity-probe bound. That scenario now gives inventory four seconds, derived from the observed CI limit; its lifecycle and process-identity checks remain intact. October 2 repairs vendor the original signed libsodium archive under its unchanged checksum, keep Apps domain rows compact, align desktop/phone quick-hide coverage with the shared-panel behavior, isolate saved defaults, join project deletion, select the current ASR plan after microphone acquisition, cancel transcript restoration frames on unmount, and stabilize resume/audio/copy fixtures. The first viewer popup and complete 200 MiB HTML I/O fixture have measured readiness budgets; content and typing assertions remain intact. Source `3049a2efb` passed all 24 jobs in [CI 36981624484](https://github.com/kzahel/yepanywhere/actions/runs/36981624484), including 370 browser cases without retries, and all 12 [runtime/SQLite legs](https://github.com/kzahel/yepanywhere/actions/runs/36981624522). Documentation follow-up `3a0132625` also passed [all 24 CI jobs](https://github.com/kzahel/yepanywhere/actions/runs/36982022730) and [all 12 runtime legs](https://github.com/kzahel/yepanywhere/actions/runs/36982022718), again without browser retries. The latest applicable [desktop](https://github.com/kzahel/yepanywhere/actions/runs/36981299593) and [iOS simulator/device](https://github.com/kzahel/yepanywhere/actions/runs/36981299572) workflows are green. [Remote deployment](https://github.com/kzahel/yepanywhere/actions/runs/36983665641) passed after a transient Cloudflare asset-fetch 502 cleared. [Android 36981624479](https://github.com/kzahel/yepanywhere/actions/runs/36981624479) passed build/standard instrumentation but still missed the unchanged 100 ms input frame gate at 149.4 ms; four guest cores and the current software renderer alone did not establish acceptance. The probe now establishes the native input connection, loaded fonts and stable viewport before upload/typing, and records frame attribution for further hosted misses. [Readiness source CI](https://github.com/kzahel/yepanywhere/actions/runs/36985655035) and [runtime/SQLite](https://github.com/kzahel/yepanywhere/actions/runs/36985655018) passed all 24/12 jobs. Its one Home-key retry raced a bare DOM scroll write against initial follow work; the fixture now uses a real upward wheel gesture and waits at the boundary, with 20 local repetitions passing. [Android readiness run](https://github.com/kzahel/yepanywhere/actions/runs/36985655022) passed direct/security, then missed only the first relay-upload key at 108.7 ms. Frame attribution exposed unnecessary memo-shortcut visibility and empty reload-stack layout reads; both now avoid ordinary typing work, with regressions that fail on previous code. The fresh bundled app passed physical direct/100 MiB relay at 42.8/33.3 ms with zero overflows; browser audio and streaming-typing checks also passed. Final hosted platform acceptance remains required. Large-catalog typing independently passed 20 repetitions (500 characters) with an 11.1 ms maximum; its 100 ms gate stays unchanged. Focused browser verification retains the typing and row-height limits. The comparable median/p90 window remains the campaign acceptance blocker. The separate initial search-highlight, [live search discovery](../../gaps/browser-suite-artifact-and-search-failures.md), [Windows extraction](../../gaps/windows-archive-extraction-test-timeout.md), and [Codex fake-process waiter](../../gaps/codex-provider-unit-startup-timeouts.md) findings remain open with bounded diagnostics. |
| macOS backend reload continuity | [Provider-host port](../tactical/128-macos-provider-host.md) has verification evidence for live Claude/Codex reload, approval, durable resume, concurrent sessions and terminal cleanup on Node source checkouts. Subsequent test-running sessions showed active-turn interruptions correlated with provider-owner exit, so macOS now defaults to ordinary in-Hono ownership and requires `YEP_PROVIDER_HOST_ENABLED=true` to opt in while the [interruption gap](../../gaps/macos-provider-host-turn-interruptions.md) is investigated. Linux remains enabled by default. Native CI still covers Linux, Apple Silicon/Intel Mac and Windows fallback. The separate [Claude project-alias history gap](../../gaps/claude-symlink-project-transcript-routing.md) remains open. This developer iteration work does not displace release delivery. |

## What changed from the old roadmap

The February 2026 list is superseded. Status/diff browsing, line-review
comments, and signed desktop installers are existing capabilities, not new
feature proposals. Source Control remains deliberately bounded; the old
stage/commit/PR checklist is not an approved expansion. The former blanket
"Not Planned" exclusions are retired rather than carried forward as current
product decisions.

The [T3 Code analysis](../competitive/t3code.md) informs this reprioritization.
Provider-native session continuity remains a central differentiator; release
availability and a coherent multi-machine mobile experience make it easier to
use. Further feature comparisons do not displace the publishing priority.
