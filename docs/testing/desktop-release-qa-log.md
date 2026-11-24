# Desktop release QA log

This log records end-to-end checks against published desktop artifacts on the
macOS and Windows testbed VMs. Add a dated section for each release exercise so
installer, provider-session, publication, and updater results remain
discoverable after the release is complete.

Result meanings:

- **PASS** — the observable behavior completed as expected.
- **FAIL** — the observable behavior did not complete as expected.
- **BLOCKED** — the check needed a testbed recovery, credential, or consent
  action that was not available during the run.
- **NOT RUN** — the check was outside the completed scope; the reason is noted.

## 2026-11-24 — signed Stable 0.14.1 publication

[Desktop Stable 0.14.1](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.14.1)
published from `aa2e39bfd88638924c9f2b4b8c07f1755be92c27` with the dashboard
sign-in retry. General CI, the runtime matrix and the desktop preflight all
passed on that source before the release tag was pushed.

| Check | Result |
| --- | --- |
| General CI | PASS. The [first attempt](https://github.com/kzahel/yepanywhere/actions/runs/45468006177/attempts/1) failed an Antigravity history replacement assertion. The focused case passed locally and the [unit-job rerun](https://github.com/kzahel/yepanywhere/actions/runs/45468006177/attempts/2) passed on the same source. |
| Server runtime and desktop preflight | PASS. [Runtime matrix](https://github.com/kzahel/yepanywhere/actions/runs/45468006248) and [desktop preflight](https://github.com/kzahel/yepanywhere/actions/runs/45468006134). |
| Tagged desktop publication | PASS. [Desktop CI](https://github.com/kzahel/yepanywhere/actions/runs/45474579295) passed on both Mac architectures and Windows. Windows passed the packaged runtime smoke. The finalizer validated nine release assets and verified all three updater artifacts against the release key. |
| Public Stable delivery | PASS. Apple Silicon, Intel Mac and Windows offer 0.14.1 from Stable 0.14.0 and Latest 0.13.8101, then report current at 0.14.1. All three installer routes resolve to their matching signed release assets. |

## 2026-11-23 — signed Stable 0.14.0 publication

[Desktop CI](https://github.com/kzahel/yepanywhere/actions/runs/45268391983)
published [Stable 0.14.0](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.14.0)
from `24e86fe36ea3163dad157828be316b0b64aa5f88` after the website and npm
releases from the same source. Both Mac installers passed signing and
notarization. Windows passed the packaged-runtime smoke and signed NSIS build.
The finalizer verified the complete installer set and updater signatures.

| Check | Result |
| --- | --- |
| General CI and desktop source preflight | PASS. [General CI](https://github.com/kzahel/yepanywhere/actions/runs/45263381478) and [desktop preflight](https://github.com/kzahel/yepanywhere/actions/runs/45263381573). |
| Runtime/SQLite matrix | PASS. The [Windows Node 22 attempt](https://github.com/kzahel/yepanywhere/actions/runs/45263381384/attempts/1) timed out waiting for the installed server's port file. The unchanged [retry](https://github.com/kzahel/yepanywhere/actions/runs/45263381384/attempts/2) passed. |
| Tagged desktop matrix | PASS. The [first attempt](https://github.com/kzahel/yepanywhere/actions/runs/45268391983/attempts/1) uploaded Windows and GitHub canceled both Mac jobs before runner allocation. The retry retained Windows and completed both Mac builds. |
| Public Stable updater feeds | PASS. Apple Silicon, Intel Mac and Windows offer 0.14.0 from Stable 0.12.1 and Latest 0.13.8101, and report current at 0.14.0. |
| Public installer routes | PASS. All three redirect to their matching 0.14.0 installers. |

Fresh native installation, in-place upgrade and relaunch remain open.

## 2026-11-16 — signed Stable 0.12.1 publication

[Desktop CI 43909798230](https://github.com/kzahel/yepanywhere/actions/runs/43909798230)
published [Stable 0.12.1](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.12.1)
from `de811d52b2d3b3eab5c821f7e247741191d3ee82`. Both Mac architectures passed
signing and notarization; Windows passed its packaged-runtime smoke and signed
per-user NSIS build. The finalizer verified the complete immutable asset set
and updater signatures before publication. All five release jobs passed.
Stable 0.12.1 is newer than both Stable 0.10.0 and Latest 0.11.7401.

| Check | Result |
| --- | --- |
| Exact-source general CI | PASS: all 26 [jobs](https://github.com/kzahel/yepanywhere/actions/runs/43903987109); unit job required one rerun after fixture removal failed |
| Runtime/SQLite matrix | PASS: all nine [jobs](https://github.com/kzahel/yepanywhere/actions/runs/43903987148); macOS Node 26 rerun after GitHub failed to acquire a runner |
| Local lint, formatting, typecheck and console budget | PASS; existing console budget unchanged |
| Local full workspace tests | PASS: includes 7,569 server and 7,430 client tests |
| Local full browser suite | PASS: 618 passed, 14 skipped, no retries |
| Hosted browser shards | PASS: 620 cases passed, 12 skipped; three cases required a retry, reviewed below |
| Initial account-binding sequential typing | PASS: desktop and phone, held account lookup released during real typing, every prefix retained within 100 ms with focus and input identity preserved |
| Apple Silicon and Intel Mac source/signing/notarization | PASS |
| Windows source/signing/packaged-runtime smoke | PASS |
| Complete immutable asset set and updater signatures | PASS: nine assets, both DMGs, Windows NSIS, updater archives/signatures and latest.json; no MSI |
| Public latest.json | PASS: 0.12.1 with all four signed updater targets and immutable release URLs |
| Stable feeds from 0.10.0 and Latest 0.11.7401 | PASS: HTTP 200 offering 0.12.1 for Apple Silicon, Intel Mac and Windows, with matching signatures/URLs and Stable channel confirmation |
| Stable feeds from current 0.12.1 | PASS: HTTP 204 for all three platforms |
| Public installer routes | PASS: all three redirect to the matching 0.12.1 installer |
| Fresh native install/update/relaunch and long-idle acceptance | NOT RUN: this exercise qualifies hosted packaging and public distribution; existing native acceptance remains open |

The initial `desktop-v0.12.0` candidate was canceled before any installer assets
were uploaded or published. Failed-attempt review found that the first acting
account lookup could erase input already typed into New Session. The tag is
retained and its empty private draft is marked canceled/prerelease. Version
0.12.1 preserves fresh editor text and staged files during initial account
binding, while retaining isolation for legacy and already-owned account drafts.
The deterministic hook regression failed before the repair; the desktop/phone
browser cases also qualify the forced race and exact submitted prompt/files.
The clean local full run observed maximum acknowledgements of 13.6/17.4 ms in
those two cases. These are gate observations, not a comparative host benchmark.
Both viewport captures were inspected and presented through the repository
artifact capture facility.

Failed-attempt review retains the existing
[frozen-share boundary](../../gaps/relay-large-public-share-create-flake.md) and
[phone transcript follow](../../topics/scrollback-view-stability.md#what-the-implementation-does-today)
findings. The third retry missed the
[sibling attachment durable-publication check](../../gaps/queue-sibling-attachment-draft-publication-timeout.md)
before queue acknowledgement; ten focused local repetitions passed without
retries. The unit rerun follows a
[reload-fixture ENOTEMPTY cleanup failure](../../gaps/dev-reload-fixture-enotempty.md),
not a relaxed process-ownership assertion. No typing threshold or failure
assertion was weakened for publication.

Publication does not close
[packaged provider CLI qualification](../../gaps/provider-cli-packaged-launch-qualification.md)
or [manual-update/long-idle acceptance](../../gaps/desktop-manual-update-long-idle.md).
Desktop remains beta.

## 2026-10-24 — coordinated Stable 0.6.0 publication

[Desktop CI 40109396596](https://github.com/kzahel/yepanywhere/actions/runs/40109396596)
published [Stable 0.6.0](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.6.0)
from `bcdd87c0f0a87193b81c8f7b5f52262960ffb4b0`, the same source as npm
0.11.0, Chrome extension 0.1.4 and Android internal `0.1.3-ci.567.1` / code
`66701`. Both Mac architectures passed signing and notarization; Windows
produced its signed per-user NSIS installer and passed the packaged-runtime
smoke. The finalizer verified the complete asset set and updater signatures
before publication.

| Check | Result |
| --- | --- |
| All three platform build/source gates | PASS |
| macOS signing/notarization and Windows signing/runtime smoke | PASS |
| Complete asset set and updater signatures | PASS |
| Public `latest.json` | PASS: 0.6.0, both Mac architectures and Windows NSIS, all four updater targets |
| Stable feed from Latest 0.5.5101 | PASS: HTTP 200 offering 0.6.0 for Apple Silicon, Intel Mac and Windows |
| Public installer routes | PASS: all three redirect to the matching 0.6.0 installer |
| General CI / runtime matrix on the shared source | PASS: 24 / 9 jobs, without retries |
| Fresh native install/update/relaunch and long-idle acceptance | NOT RUN: this publication exercised hosted packaging gates and public metadata; existing native qualification follow-ups remain |

Stable 0.6.0 overtakes the published 0.5.x Latest builds, so selecting Stable
can offer an update. The release contains both signed DMGs and the per-user
Windows NSIS installer; no MSI was published.

## 2026-10-20 — signed Stable 0.4.1 publication

[Desktop CI 39469339008](https://github.com/kzahel/yepanywhere/actions/runs/39469339008)
published [Stable 0.4.1](https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.4.1)
from `e65db78de294a50b9941836f042bbd7940e7edc6`. Both macOS architectures
passed signing and notarization; Windows produced the signed per-user NSIS
installer. The finalizer verified the complete asset set and all three updater
signatures before publishing the private draft. No MSI was published.

| Check | Result |
| --- | --- |
| All platform build/source gates | PASS |
| Windows packaged runtime smoke | PASS |
| Apple Silicon and Intel signing/notarization | PASS |
| Complete immutable assets and updater signatures | PASS |
| Public `latest.json` | PASS: 0.4.1, both Mac architectures and Windows NSIS |
| Stable update feed from 0.2.2 | PASS: HTTP 200 offering 0.4.1 for Apple Silicon, Intel Mac and Windows |
| General CI / runtime matrix | PASS: 24 / 12 jobs on `bd309cd6e`, which only adds test repairs to the application source |
| Fresh native install/update/relaunch and long-idle acceptance | NOT RUN: this publication exercised hosted packaging gates, not a fresh testbed installation |

The general CI pass includes one native-phone browser retry, retained in
[the duplicate-character gap](../../gaps/native-phone-browser-duplicate-first-character.md).
The earlier Windows dev-wrapper cleanup failure passed its isolated rerun and
the fresh main run; [its cause remains open](../../gaps/windows-dev-reload-process-identity.md).
The initial 0.4.0 release was canceled before publication to include the newly
published markdown-it 15.0.2 security patch. Existing tags were not moved.
The distribution catalog still identifies desktop as beta; publication does
not close the remaining native acceptance work below.

## 2026-10-03 — native updater implementation verification

Update state, startup/daily scheduling, manual coalescing, dismissal and progress
now belong to Rust. macOS uses an AppKit window, Windows a Common Controls v6
Task Dialog, and neither renders release notes. Local About checks use a
cookie/origin/socket-gated fixed action over the existing private server pipe.
Packaged YA identity comes from the immutable runtime manifest; desktop servers
skip standalone update discovery. Older shells give explicit menu guidance.

A separately identified macOS QA app used the current source, private data root,
and the existing release signing procedure for its Bun and Mach-O native modules.
The first local bundle omitted the CI native-module signing step and failed
library validation; applying that existing step and verifying the complete
bundle restored readiness. No signing entitlement or production profile changed.
Native interaction used Computer Use against that QA app. The available offer
came from the real Latest feed; no installation was requested.

| Check | Result |
| --- | --- |
| macOS application-menu manual check | PASS: native window foregrounded, Stable 0.2.2 current |
| Native Latest offer | PASS: 0.3.3001, installed version, Update and restart/Later, no changelog |
| Switch back to Stable | PASS: offer discarded, explicit up-to-date result |
| Minimize and manual check | PASS: same native window restored and current result visible |
| Native window close | PASS: dismissed without exiting the desktop process |
| Actual packaged About Check for Updates | PASS: authenticated Settings request foregrounded the native window |
| Real network failure and retry | PASS: process-scoped unreachable proxy yielded visible error, channel selector and retry; retry returned to the same error surface |
| Final signed bundled runtime smoke | PASS: private Bun agent-self, readiness, auth, manifest version, rejected unauthenticated action and exactly one authenticated pipe action |
| Browser Settings regressions | PASS: desktop/phone handoff, failure guidance, older shell fallback and unchanged standalone checking; no page errors |
| Rust unit tests | PASS: 34, including manual/automatic joining, stale dismissal and install guards |
| macOS Cargo Clippy (Apple Silicon and Intel) and Apple Silicon debug app build | PASS |
| Windows x64 cross compilation and Clippy (all targets) | PASS using the Windows SDK through cargo-xwin |
| Required repository checks | PASS: lint, format, typecheck, full workspace tests (serial workspace execution), console scan |
| Windows native interaction/install/relaunch | NOT RUN: configured Windows testbed unready |
| macOS install/relaunch, sleep/wake and hours-idle history | NOT RUN: Mac VM exclusively claimed; host smoke did not install or reproduce those histories |

The first concurrent root test run hit five timeouts in unrelated server suites;
a repeat recovered four, the isolated Codex suite passed all 127 enabled tests,
and the complete serial workspace run passed. Existing negative-path log warnings
remain tracked by `gaps/unit-failure-path-log-warnings.md` and the client warning
gaps; no diagnostic suppression was added. The About CSS ownership check deferred
extraction because its shared legacy rules have 24 coupled edges.

Reviewed native captures are under
`.artifacts/ui-testing/2026-10-03-native-updater/{current,available,failure}.jpg`;
reviewed Settings captures at 1000×600 and 375×812 are under
`.artifacts/ui-testing/2026-10-03-native-updates-settings/`. They were presented
through the artifact facility and inspected individually. Native controls and
error text fit without clipping; phone build/status text wraps without overflow.
The VM long-idle gap remains open. This is source verification, not a new Stable
release or acceptance of Windows native presentation/install behavior.

## 2026-10-03 — stable update routing and bundled version

The public Stable feed advertises desktop 0.2.2; the previous Stable is 0.2.1.
Both untouched published Apple Silicon app archives matched their GitHub asset
SHA-256 and passed strict recursive macOS code-signature verification:

| Release | App archive SHA-256 | Bundled YA manifest |
| --- | --- | --- |
| 0.2.1 | `70833526c77d5d7d4926a3c1a39e8e1d149e8930ba3db4acdc580b0232cd8d6e` | `v0.9.0-6-g7a241eaa0` |
| 0.2.2 | `b00d92d1ad06d9b5c92357f29a9dc970286169ddb27cc2cd3cceb2e6e6daad8a` | `v0.9.1-56-g1002ac1c9` |

The packaged Bun/server ran on the controller with a disposable data root and
working directory outside a Git checkout. The real bundled client ran in
Playwright Chromium with the native runtime labels supplied through the same
metadata shape as the dashboard initialization script. This exercises actual
release server/client bytes, but is not a native Tauri-window or VM test.
Desktop (1000×600) and phone (375×812) captures were presented through the
artifact facility and inspected individually. Each About view shows the correct
desktop/build labels and a Check for Updates button, with no result after its
request completes. The build label wraps on phone without horizontal overflow.
An unrelated host Codex update dialog was dismissed through its ordinary
**Not now** action; no provider installation was performed.

| Check | 0.2.1 | 0.2.2 |
| --- | --- | --- |
| Authenticated bundled `/api/version` identity | FAIL: `dev`, `source` | FAIL: `dev`, `source` |
| Bundled runtime identity | PASS: Bun 1.3.14 | PASS: Bun 1.3.14 |
| Desktop Stable feed | PASS: offers 0.2.2 | PASS: HTTP 204, current |
| About Check for Updates reaches desktop updater | FAIL: only server version request | FAIL: only server version request |
| About check gives completed-result feedback | FAIL: no result | FAIL: no result |
| Reported source-version popup in clean local dashboard | NOT REPRODUCED | NOT REPRODUCED |
| Fresh native menu-bar check on VM | BLOCKED: target exclusively claimed | BLOCKED: target exclusively claimed |

Both server API responses report `latest: null`, `updateAvailable: false`,
`installSource: "source"`, `current: "dev"`, and `desktopRuntime: true`.
The server package retains `0.0.1` and tries Git discovery instead of using its
accurate immutable runtime manifest. About's button refreshes that standalone
version API even while displaying native desktop labels. The standalone
`/version/dev` endpoint independently returns HTTP 400. These defects are corrected by the native updater implementation below.

Machine Control doctor found the Mac VM ready, but exclusive claim acquisition
was refused because another active test session owned it. That session renewed
its claim during the investigation. Isolated workspaces were unavailable.
No guest operation, claim takeover, or host UI input was attempted. The
September 28 native results below remain the existing tray-check evidence;
this run adds no native menu, install/relaunch, sleep/wake, or long-idle result.
The then-current renderer regression harness passed, including
manual/automatic overlap, channel switching, stale dismissal, error recovery,
explicit installation, and simulated six-hour idle. Its native boundary is
controlled, so it does not establish behavior in signed Stable releases.

Ignored release probes are retained in `tasks/desktop-update-investigation/`;
reviewed packaged-client captures and observations are under
`.artifacts/ui-testing/2026-10-03-desktop-updates/{0.2.1,0.2.2}/`.
No application fix or release was made during the baseline investigation.

## 2026-09-28 — manual update feedback and hidden windows

The common Machine Control CLI resumed the claimed macOS VM normally. The
previous suspended-state restore blocker did not recur. All application input
and capture used guest-native routes; no host pointer or keyboard input was
needed. Stable `0.2.2` was installed from its published Apple Silicon app
archive and passed strict recursive code-signature verification.

| Check | Signed 0.2.2 | Patched local app |
| --- | --- | --- |
| Ordinary manual check reports current Stable | PASS | PASS |
| Manual check after six real minutes with no visible windows | PASS | PASS |
| Manual check after application hiding | PASS | PASS |
| Manual check after minimization | PASS | PASS |
| Manual check after native window close/reopen | PASS | PASS |
| Manual check while startup discovery is pending | FAIL: no checking feedback | PASS: checking surface appears |
| Pending startup request fails after the manual click | FAIL: silent failure | PASS: visible failure with retry |

The native reproduction used a guest-local HTTP CONNECT proxy to hold update
traffic without intercepting TLS or changing endpoints. Eight seconds after
launch, the guest AX route invoked the real **Check for Updates** tray item.
The signed app exposed neither checking text nor a failure after the held
connection was closed. An ad-hoc signed debug app built from the patched
worktree exposed both. This validates the interaction correction, not release
signing, notarization, or download/install acceptance.
During direct executable launch for fault injection, the debug bundle reported
an unresolved server resource path and exposed its recovery surface; its native
updater still ran. A subsequent normal app launch without the proxy also
reported the current Stable version successfully.

The renderer had discarded every manual request while any check was busy.
Manual requests now make an existing check visible and expose its result;
dismissal continues to suppress late results. The focused updater harness
also covers periodic overlap, repeated clicks without duplicate requests,
close/reopen during a pending request, current-channel feedback, channel
switches, Stable catch-up, errors, and explicit installation. Desktop and
narrow captures were inspected: status text and actions remain readable and
do not overflow. This surface has no free-text input path.

The maintainer clarified that the original symptom also occurred after hours
of runtime, so the startup race is not a complete diagnosis of that report.
An additional signed `0.2.2` run closed the dashboard and waited six real
minutes. No app windows remained after the dashboard unload delay, but the
manual tray action still surfaced the up-to-date result. This run did **not**
reproduce the maintainer's long-idle failure.
The unresolved report remains tracked in
[`desktop-manual-update-long-idle`](../../gaps/desktop-manual-update-long-idle.md).

The native tray action now shows the trusted window before emitting its event
specifically to `main`. This removes its dependency on a hidden renderer
waking itself; Tauri's pinned WebView documentation describes suspension of
hidden/minimized views after roughly five minutes. This is defensive native
window handling, not proof that suspension caused the reported failure. The
repeatable `packages/desktop/scripts/updater-macos-idle-smoke.py` check covers
real idle, application hiding, minimization, and native window close/reopen.
The patched app passed all four with visible current-version feedback and an
active application; its complete native smoke took 378 seconds. The signed
baseline's six-minute idle check and its separate window-state checks also
passed. No test claimed an actual multi-hour or sleep/wake soak.

Lint, formatting, TypeScript checking, desktop script tests, the renderer
harness, 30 Rust tests, Clippy, and local macOS packaging passed. The renderer
also verified manual no-update feedback after six simulated hours and manual
requests during the 24-hour periodic check. After rebasing onto current main,
lint, formatting, types and the renderer harness passed again; root `pnpm test`
again encountered the same five
unrelated server sandbox failures recorded in
[`macos-sandbox-test-assumptions`](../../gaps/macos-sandbox-test-assumptions.md).
The existing [tsx loader warning](../../gaps/tsx-loader-deprecation-warning.md)
also remains. Windows native verification and an installed Stable-to-Latest
upgrade were not part of this check; macOS upgrade acceptance is still pending,
but no longer blocked by the old VM restore failure. No release was published.

## 2026-09-08 — nightly delivery and same-app channels

### Scope and current evidence

This exercise adds scheduled, signed Latest publication and persistent
Stable/Latest selection in the existing desktop application. Publication uses
the exact successful general-CI commit, skips unchanged packaged inputs, and
keeps an incomplete release private until every platform artifact and updater
signature passes validation.

- Implementation: `b38d162a0`, with updater dismissal and CI concurrency
  hardening in `741bc6d3d`.
- Exact-source [general CI](https://github.com/kzahel/yepanywhere/actions/runs/34195316810)
  passed on `da9db6aa0235f05d917b3521730316a36ab32ee4`: 9,896 unit tests
  and 192 browser tests passed, with 34 unit and six browser cases skipped.
  Lint, formatting, types, dependency audit, site build, and both performance
  checks also passed. Browser fixture isolation, readiness, and teardown fixes
  were needed before this whole-CI publication gate became green.
- Exact-source [Desktop CI](https://github.com/kzahel/yepanywhere/actions/runs/34195316788)
  passed for Apple Silicon macOS, Intel macOS, and Windows on the same commit.
  An earlier Windows build required a successful retry after the external
  signing command failed; this run passed without a retry.
- Local verification passed: desktop script tests, 29 Rust tests, Clippy,
  desktop build, and the updater interaction harness. Final desktop and phone
  captures were inspected. The harness covers channel persistence errors,
  stale checks, dismissed windows, download/install progress, and returning to
  Stable while the installed Latest version is newer.
- The published `0.2.0` Windows updater artifact passed Minisign verification;
  a modified copy was rejected with the same public key.
- The update service advertises both channels. Its existing Stable routes and
  the stable versions of all ten configured products were unchanged after
  deployment of the desktop channel configuration.

### Installed baseline and testbed limits

The Windows 11 ARM64 VM started from the existing per-user `0.2.0` NSIS
installation. Its native ARM64 Bun passed the isolated packaged-runtime
startup/authentication smoke test. The launcher initially reported a server
startup timeout; explicit Retry started the bundled server, and Open Dashboard
showed the existing project and session. Project and session metadata hashes
were recorded before upgrading. All desktop observations and actions used
target-internal Machine Control routes without host input interference.

The macOS VM could not restore its suspended state: the hypervisor returned a
permission error. Cloning that suspended base was also unavailable. The VM
was left unchanged and its claim released; discarding saved RAM and cold
booting requires maintainer approval because unsaved guest work may be lost.
Installed macOS upgrade acceptance remains **BLOCKED**. Signed macOS CI and
packaged-app smoke checks do not substitute for that installed upgrade check.

### First published nightly and Windows bootstrap

[`desktop-latest-v0.3.101`](https://github.com/kzahel/yepanywhere/releases/tag/desktop-latest-v0.3.101)
was published by [Nightly Desktop](https://github.com/kzahel/yepanywhere/actions/runs/34196075016)
from `da9db6aa0235f05d917b3521730316a36ab32ee4`. The scheduler's branch head
had advanced, but selection correctly retained the successful CI source.
Both Mac builds passed signing, notarization, and packaged-app smoke checks;
Windows passed its build and smoke checks. Finalization verified all three
distinct updater artifacts with Minisign before publishing the prerelease.

During construction, the draft's Mac assets were unavailable through Latest.
After publication, the public Latest feed advertised `0.3.101`, confirmed
`channel: latest`, and selected the signed NSIS executable. Stable remained
`0.2.0`, and GitHub's overall latest release remained `v0.8.1`.

The Windows VM downloaded the public installer, verified Authenticode, and
matched GitHub's SHA-256:
`214841f96432a609878e4fc674a2f341f8ae9bd473fb27e443bc0b8d249e8592`.
Quiet installation over `0.2.0` completed with one `0.3.101` per-user
registration and no observed consent prompt. The installed executable's
signature was valid; project and session metadata hashes were unchanged.
No channel preference existed, retaining the default Stable selection.

The installed nightly launched the native ARM64 Bun runtime and returned HTTP
200 from its health endpoint. A target-window capture showed the existing
project and session. An initial empty accessibility document did not reflect
the rendered dashboard. One machine-control identity lookup failed during a
health probe; target status and the repeated probe succeeded.

The installed updater initially showed Stable's waiting-to-catch-up message
and offered no downgrade. Selecting Latest through the native desktop UI
saved the preference and reported the installed nightly current on that
channel. Explicit tray Quit removed all ten recorded app/server/WebView
processes; the app was then relaunched with the saved preference intact.

### Signed Latest upgrade and unchanged-source skip

[`desktop-latest-v0.3.201`](https://github.com/kzahel/yepanywhere/releases/tag/desktop-latest-v0.3.201)
was published by a [forced QA run](https://github.com/kzahel/yepanywhere/actions/runs/34199313407)
from `fb909d664b81f9d01a08fc63498edb9fb747fe95`. That newer source had passed
general CI; the adjacent readiness-check test needed one retry, as recorded in
`gaps/project-queue-readiness-test-startup-budget.md`. Both Mac builds, Windows,
and verification of all three updater signatures passed without release-job
retries.

The restarted `0.3.101` app offered `0.3.201` without another channel change,
proving that Latest persisted across restart. **Update and restart** downloaded
the signed installer and handed off to NSIS. The actual updater download had
valid Authenticode and matched the public SHA-256:
`96013ff1efa687e33d029d16a119bd287ca27c9f491d6ab2757ed2a8f6bf06d0`.

The installer automatically relaunched `0.3.201`. The installed signature was
valid, exactly one per-user NSIS registration remained, and the native ARM64
Bun process started. All recorded old app/server/WebView processes exited.
Both project and session metadata hashes remained identical to the original
`0.2.0` baseline, and the final dashboard capture showed the existing project
and session. No consent prompt was observed during the update.

The relaunched runtime's health endpoint returned HTTP 200. Switching back to
Stable replaced the saved preference successfully on Windows and displayed
the waiting-to-catch-up message. The installed version remained `0.3.201`;
no downgrade was offered or performed. The final dashboard and updater
captures were inspected, and the test installation was left on Stable.

An [ordinary nightly run](https://github.com/kzahel/yepanywhere/actions/runs/34202521718)
then succeeded with its release job skipped: the newest verified packaged
inputs matched the last published Latest. Newer unverified branch work did not
cause a release or replace the selected successful source.

Final tray Quit left no recorded app/server/WebView processes running.
Temporary test installers and process records were removed. The Windows VM,
which had been off before this exercise, completed a clean shutdown; its
powered-off state was verified and its claim released. The Mac VM remained
suspended and unchanged.

## 2026-08-31 — `desktop-v0.2.0`

### Scope and release identity

The run exercised the existing public `desktop-v0.1.3` application, published
`desktop-v0.2.0`, and completed signed automatic upgrades on the macOS and
Windows testbed VMs.

- Previous release: `desktop-v0.1.3`
- New release: `desktop-v0.2.0`, commit
  `8ee821313dbac129f55219fd1aeff68234a602b4`
- Release page:
  <https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.2.0>
- Release workflow:
  <https://github.com/kzahel/yepanywhere/actions/runs/33385313018>
- Post-release updater hardening: commit
  `c970af7fa6ec682303bc93134baa14b70d3de00a`
- Test hosts: dedicated Apple Silicon macOS and Windows 11 ARM64 VMs; Windows
  exercised the published x64 shell and its native ARM64 bundled runtime

All guest inspection, capture, input, installation, and protected-desktop
consent used target-internal Machine Control routes. Accepted desktop actions
reported `hostInterference: none`; no host display or input route was used.

### Result summary

| Check | macOS | Windows |
| --- | --- | --- |
| Public signed `0.1.3` baseline | PASS | PASS — primary per-user NSIS |
| Signed feed advertises `0.2.0` | PASS | PASS |
| Automatic update window foregrounded | PASS | PASS |
| Signed download, install, and relaunch | PASS | PASS after feed repair |
| Installed app reports `0.2.0` | PASS | PASS |
| Packaged runtime starts; dashboard returns HTTP 200 | PASS | PASS |
| Native runtime selected on ARM64 | PASS | PASS |
| Existing project and session state preserved | PASS | PASS |
| Windows remains a non-elevated NSIS install | N/A | PASS after feed repair |
| Explicit Quit removes the app and bundled runtime | PASS | PASS |
| Tagged release workflow | PASS | PASS |

### Release construction and CI

The release candidate incorporated a contributor's latest pushed changes
before the version commit and tag were created. Local release checks passed
with no warnings: desktop script tests, 24 Rust tests, Clippy, repository lint,
and formatting. Desktop CI passed for Apple Silicon macOS, Intel macOS, and
Windows. The general CI run's single FileViewer timing failure passed ten
isolated repetitions and its failed job passed on rerun.

The post-release metadata fix added three normalization tests, bringing the
desktop script suite to five passing tests. Repository lint and formatting
remained clean. Both general CI and Desktop CI passed on the exact hardening
commit:

- <https://github.com/kzahel/yepanywhere/actions/runs/33390280466>
- <https://github.com/kzahel/yepanywhere/actions/runs/33390280467>

### Published artifact checks

| Artifact | SHA-256 | Guest validation |
| --- | --- | --- |
| `YepAnywhere_0.2.0_aarch64.dmg` | `e4feaa1caed8f2d45ce6bdcd4e38f2817df0ea64ae613f11303b11abf6d9035b` | Gatekeeper acceptance, strict code signature, automatic update |
| `YepAnywhere_0.2.0_x64-setup.exe` | `e4c8d82d8075f7f216deae74e8b4a72d30fcbcdf5841d4106ab93c0d880a323f` | Valid Authenticode-installed app, signed automatic update |
| `YepAnywhere_0.2.0_x64_en-US.msi` | `5c6c016c1fac96491bda54ab41bcd6428943016e1f9fe7bc5f1b198e3f59115e` | Initially published; removed after it exposed the elevated feed path below |

The public updater route returned version `0.2.0`, a nonempty signature, and
the matching platform artifact. After repair, canonical
`windows-x86_64` metadata is identical to `windows-x86_64-nsis` and resolves
to the setup executable. A follow-up maintainer decision removed the MSI asset
and updater record entirely so the release has no elevated installer path.

### macOS automatic update

The public signed `0.1.3` application passed Gatekeeper and strict code-sign
verification, launched one bundled runtime, and served the existing Projects
dashboard. Its automatic update window offered `0.2.0`; selecting **Install
and Restart** downloaded the signed updater archive and relaunched a new app
process at `0.2.0`. Gatekeeper and strict signature verification still passed,
the dashboard returned HTTP 200, and the existing project and session were
present. Explicit target-internal Quit left zero app and bundled-runtime
processes.

### Windows updater finding and repair

The first `0.1.3` NSIS-to-`0.2.0` update selected Tauri's canonical
`windows-x86_64` entry, which pointed to the all-users MSI. The MSI required
UAC and installed a healthy signed `0.2.0` application, including the native
ARM64 Bun fix, but it left both a stale per-user `0.1.3` NSIS registration and
a machine-wide `0.2.0` MSI registration. This violated the primary per-user
NSIS installation contract.

Commit `c970af7fa` first normalized generated updater metadata so the canonical
Windows entry copied the signed NSIS entry. After the maintainer confirmed
that no elevated installation path was desired, Windows packaging became
NSIS-only, release finalization began rejecting MSI artifacts and metadata,
and the MSI was removed from the public `desktop-v0.2.0` release. The public
`latest.json` asset was repaired in place. No application binary or signature
changed.

The mixed test installation was then removed without touching desktop data,
and the public `0.1.3` NSIS baseline was installed again. Its installer and
installed app had valid Authenticode signatures and exactly one per-user
`0.1.3` uninstall registration. The automatic updater again foregrounded
`0.2.0`; **Install and Restart** completed while eight consecutive internal
desktop observations remained on the ordinary `Default` desktop, with no UAC
transition.

The relaunched application had all of the expected release properties:

- app version `0.2.0` with a valid Authenticode signature;
- exactly one app process and one bundled Bun process;
- `bun-windows-aarch64.exe`, SHA-256
  `c48ea01208766207606927a320d640371140dca51e9963367779b32d18460716`;
- dashboard HTTP 200;
- exactly one `0.2.0` per-user NSIS uninstall registration and no MSI
  registration; and
- the existing project and session still visible after relaunch.

Explicit target-internal Quit then left zero app and bundled-runtime
processes. This completes the automatic download/install portion that the
`desktop-v0.1.2` QA run had left as required follow-up.

## 2026-08-01 — `desktop-v0.1.2`

### Scope and release identity

The run began from the then-current public release, `desktop-v0.1.1`, and
exercised a fresh install, launch, session creation, publication of a new
release, and the update path on the macOS and Windows VMs.

- Previous release: `desktop-v0.1.1`, commit
  `02856e2cbe0edae579309ddb747ca8164a0682d3`
- New release: `desktop-v0.1.2`, commit
  `ea22d209170437d0b417504777d7dfad010d5eb1`
- Release page:
  <https://github.com/kzahel/yepanywhere/releases/tag/desktop-v0.1.2>
- Release workflow:
  <https://github.com/kzahel/yepanywhere/actions/runs/30698924933>
- Test hosts: macOS 26.2 arm64 in Tart; Windows 11 Pro
  `10.0.26200` arm64 in UTM, running the published x64 build under Windows on
  ARM emulation

The shared source checkout contained concurrent work. The release commit was
made with an exact path list, checked from a detached temporary worktree,
pushed, and tagged by exact commit so unrelated worktree changes were not
included.

### Result summary

| Check | macOS | Windows |
| --- | --- | --- |
| Existing app and desktop data absent before test | PASS | PASS |
| `desktop-v0.1.1` artifact digest and publisher signature | PASS | PASS |
| Fresh primary install | PASS | PASS |
| First launch starts the bundled runtime | PASS | PASS |
| First-launch dashboard visually verified | PASS | PASS |
| Create a session record from the dashboard | PASS | PASS |
| Receive a live provider response | BLOCKED — Claude OAuth was expired | BLOCKED — Claude OAuth was expired |
| Publish `desktop-v0.1.2` from the exact release commit | PASS | PASS |
| Release CI build and finalization | PASS | PASS |
| Signed updater feed advertises `0.1.2` to `0.1.1` | PASS | PASS |
| Automatic `0.1.1` to `0.1.2` upgrade | FAIL — no updater window surfaced | FAIL — no updater window surfaced |
| Manually install and launch published `0.1.2` artifact | PASS | PASS |
| `0.1.2` manual update check foregrounds its result | PASS | PASS |
| About distinguishes desktop and bundled YA versions | NOT RUN | PASS |

### Current-release installation details

On macOS, `/Applications/YepAnywhere.app` and the desktop data directory were
absent before installation. Generated desktop data, WebKit state, caches, and
application-support state from an initial probe were moved to the recoverable
guest backup
`/Users/admin/QA-Backups/desktop-0.1.1-pre-clean-20260801T1200/`; `0.1.1` was
then relaunched from a clean desktop state. Existing external `~/.claude`
provider history was deliberately preserved. An old, inactive
`com.yepanywhere.plist` launch-agent file was also left untouched.

The macOS `0.1.1` DMG matched SHA-256
`758039b5a04fdfdc6842df396d05330570e99e360607a374b0a7a16e3f696d95`.
Gatekeeper accepted the installed app as a notarized Developer ID build,
strict deep code-signature verification passed, and the bundled Bun retained
only the required `com.apple.security.cs.allow-jit=true` entitlement from the
checked set. The app launched its bundled server and opened the Projects
dashboard.

On Windows, the app, its installation directory, and the desktop data
directory were absent before installation. The `0.1.1` NSIS installer matched
SHA-256
`d8fa22f36bc0dd6b6a25cb637d7fa1a4ae427e3f461b0933e05354b357c04ff8`,
had a valid Kyle Graehl Authenticode signature, completed a quiet per-user
install with exit code zero, and started the desktop shell and bundled Bun
runtime. After the disposable guest was unlocked, the dashboard rendered and
showed the external provider history that was deliberately preserved outside
the clean desktop data directory.

Both installed `0.1.1` apps reported desktop version `0.1.1`, bundled YA
version `0.7.0`, commit
`02856e2cbe0edae579309ddb747ca8164a0682d3`, and Bun `1.3.14`.

### Session check

The clean macOS dashboard created and opened a new session record. The prompt
was submitted, but the provider turn returned `Failed to authenticate: OAuth
session expired and could not be refreshed`. A direct
`claude auth status --json` check had reported a logged-in CLI, making the
failed refresh an environmental credential issue rather than a desktop
installer or session-record failure. No credential was requested or entered by
the QA driver.

The Windows dashboard also created, opened, and persisted a new session record.
Its provider turn reached the same explicit `Failed to authenticate: OAuth
session expired and could not be refreshed` result. The installed Windows
Claude command had also failed to provide usable authenticated status during
the noninteractive preflight.

### Release construction and publication

The `0.1.2` release contains the two desktop fixes already staged under the
changelog's Unreleased heading: foregrounding updater results in a trusted
native window, and distinguishing desktop release identity from the bundled YA
build in About.

The exact release checkout passed:

- frozen dependency installation;
- lint with zero lint warnings;
- workspace typecheck;
- workspace tests, including 348 client files and 2,866 client tests;
- desktop script tests;
- packaged-runtime preparation and smoke (`protocol 1`, dynamic port);
- Rust `cargo check` after packaged-runtime preparation; and
- the existing client console budget at 110/110 with no increase.

The packaging preparation emitted existing dependency deprecation notices, a
Vite chunk-size notice, and a pnpm warning about creating a Vite binary link in
the deployed server tree. These did not prevent packaging or the packaged
runtime smoke, but they remain QA noise worth tracking.

All tagged workflow jobs passed: Intel macOS, arm64 macOS, Windows x64, and
release finalization. Both guest VMs independently fetched updater metadata
advertising version `0.1.2` with a nonempty signature and the expected
platform artifact URL.

### Published `0.1.2` artifact checks

| Artifact | SHA-256 | Guest validation |
| --- | --- | --- |
| `YepAnywhere_0.1.2_aarch64.dmg` | `9d4dcc0430315d527043bcc7cc33c8b97792eb2de5cabdc4f0d8584e92556944` | macOS digest, notarization, strict deep signature, Bun JIT entitlement |
| `YepAnywhere_0.1.2_x64-setup.exe` | `a1f7cf4a8a199524b0f3177d257440fdade495478080817d2299405853837379` | Windows digest and valid Authenticode signature |
| `YepAnywhere_0.1.2_x64_en-US.msi` | `7b3352346436acc42ea8678de443369536ae96a32997658b719a87d02205d1a7` | Windows digest and valid Authenticode signature |

The primary per-user NSIS installer was exercised. The secondary all-users MSI
was validated but not installed because that managed-deployment path requires
an elevated installation and was not needed for the requested application QA.

Because the `0.1.1` macOS update UI did not surface, the published `0.1.2` DMG
was installed manually after preserving the old app at
`/Users/admin/QA-Backups/desktop-0.1.2-manual-install-20260801T1230/`.
The app launched, retained the session record, and reported desktop version
`0.1.2`, commit `ea22d209170437d0b417504777d7dfad010d5eb1`, bundled YA
`v0.7.0-346-gea22d209`, and Bun `1.3.14`.

Windows exhibited the same `0.1.1` updater failure. The signed `0.1.2` NSIS
installer was therefore run as the documented quiet per-user recovery path.
It exited zero, updated the registered and executable version to `0.1.2`,
retained the new session record, and reported the same exact release commit,
bundled YA build, and Bun version. Settings → About visibly distinguished
`Desktop: v0.1.2` from `Bundled YA: v0.7.0-346-gea22d209`.

### Updater finding

The macOS `0.1.1` app was tested after the `0.1.2` feed became live in two
ways: a tray-menu manual check and a full app quit/relaunch followed by the
five-second startup-check interval. The guest could fetch the `0.1.2` updater
JSON directly, but neither attempt exposed an updater window or install
control. Only the dashboard remained in the accessibility window list. This is
a failed `0.1.1` to `0.1.2` user upgrade path on this host, not a successful
automatic update.

After the manual `0.1.2` install, the same tray action immediately foregrounded
a second native window containing `Updates` and `You are running the latest
version.` This verifies the visible effect of the `0.1.2` foregrounding fix,
but does not retroactively make the `0.1.1` to `0.1.2` upgrade successful. The
download-and-install portion of the corrected `0.1.2` updater must be exercised
against a later release.

Windows produced the same result. Both a direct `0.1.1` tray check and a full
quit/relaunch with the live feed exposed only the dashboard. After the manual
`0.1.2` install, the tray check foregrounded a second native window with the
same latest-version result.

### Follow-up required

- Reauthenticate Claude directly in each guest before requiring a successful
  live provider response.
- Treat the macOS and Windows `0.1.1` updater results as a release-distribution
  defect and decide whether users need explicit manual-upgrade guidance.
- On the next desktop release, test the corrected `0.1.2` updater through
  signed download, install, relaunch, version verification, and state
  preservation.
