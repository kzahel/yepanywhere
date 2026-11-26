# Android lifecycle hardening: second experiment round

The maintainer requested emulator-first investigation, matched web comparisons,
recorded gaps and repairs before physical-device handoff. Runtime baseline is
`b317cf7f6`; [the first study](source-lifecycle-study-2026-10-07.md) records the
preceding request/subscription/recovery repairs. The extended harness first
landed in `0f24af3ad`. Native remains the app's only SRP owner. Standard web
reconnection policy remains unchanged.

This round repairs four user-visible problems: draft attachments disappearing or
showing false warnings after interrupted validation, offline notification taps
losing their destination, unreadable Android status icons, and connection
failures being described as rejected login credentials. Each repair has a
regression at its owning layer and a real-app emulator check. All seven extended
Android lifecycle cases pass; the matched browser results retain their failures
below. The remaining Android passive-recovery delay and physical-device checks
are explicit limits of this evidence. Internal Play build `0.1.2-ci.513.1`
(code `61301`) is now available after the complete hosted Android gates passed.

## Method and acceptance

The [lifecycle runner](../../packages/client/e2e/lifecycle-study/README.md) uses
owned fixture servers, a TCP fault gate and the production minified Android
Kotlin/Rust/WebView path. The API 35 emulator is disposable; no physical phone
was used. Runs retain source, harness and APK identities, page observations,
input timing, captures, logs and cleanup outcomes beneath ignored
`tasks/android-hardening-round2/`. Failed attempts remain separately recorded.

Acceptance requires automatic page catch-up, route/draft retention, a fresh
sidebar, every sequentially typed character acknowledged within 100 ms, and no
observed error/login/post-render blank transition. Session cycles additionally
require exactly one copy of each missed message; resource observations check
that subscriptions do not accumulate. Recovery timings are observations, not
performance promises or cross-host benchmarks. The fixture has one project,
one session and 50 starting messages; it does not establish large-data typing
performance.

Process-death preparation exits instrumentation before backgrounding and killing
the app with Android `am kill`. The runner proves the old process absent and
uses ordinary launcher startup. It does not simulate process death by reloading
a page or by force-stopping YA, which changes push-delivery policy. Separate
cleanup restores saved profiles/tabs and retires owned push subscriptions.

Mobile Chrome comparisons use Chrome 124.0.6367.219 on the same emulator.
Its installed Google WebView is also 124.0.6367.219, so the native/browser
comparison uses the same engine generation; it is not proof of current
phone WebView/Chrome versions. Stock Chrome adds only first-run
suppression and a debugger socket. Its normal background policy stays enabled;
Playwright's automated launcher additionally disables some background throttling.
A browser restart may need explicit navigation to the saved URL; results record
that distinction rather than claiming the tab restored automatically.

## Experiment findings

| Scenario | Android native app | Standard web comparison |
| --- | --- | --- |
| 75-second direct silent traffic stall | Pass; catch-up about 1 s after restoring bytes | Desktop Chromium passes, about 1 s |
| Cold process restart, service available | Pass; new PID, same route and draft | Desktop document close/reopen passes |
| Cold process restart during outage | Pass; draft available offline, full catch-up about 11 s after restoration | Automated emulator Chrome passes after about 50 s; temporary Host Unreachable notice |
| 75-second relay silent traffic stall | Pass; catch-up about 1 s after restoration | Emulator Chrome passes, about 1 s |
| Eight direct session sleep/outage cycles | Pass; draft and one copy of each missed message retained; subscribers remain 17 | Automated emulator Chrome passes; subscribers remain 17 |
| Eight relay Inbox cycles with a new title every time | Pass; subscribers return to 17 each cycle | Stock emulator Chrome passes; same stable subscriber count |
| Three-minute forced deep idle, restore service and wake | Pass; catch-up about 0.8–1 s after waking | Recovery succeeds in about 36–38 s; the final stock-Chrome case fails initial typing before sleep, detailed below |
| Full Android reboot with both radios disabled | Actual Release retains its unsent draft and selected session offline; after radio restoration, transcript appears in the 4.84 s observation | No full-browser/device-reboot comparison; cold-tab and same-device connection-failure controls are separate |
| Draft-sync notice after a silent stall | Clears within the extended 30-second healthy observation | No stuck-sync defect established |
| Real FCM, absent app process, asleep screen, online tap | Pass with corrected observer; opens the session and retains its draft | Web Push delivery/service-worker routing not exercised |
| Same notification tapped while server sockets are refused | Fails 2/2 before repair: Inbox recovers but the destination is lost for the entire three-minute window | Cold URL reopening during outage is a partial comparison and recovers |
| Attachment validation interrupted in flight | Pass after repair, with complete fixture and validation targeted specifically | Connection rejection is a raw `WebSocketCloseError`; the existing raw page-error gap also reproduces |

A 30-second Chrome capture initially looked stuck on Host Unreachable; the
longer observation proved automatic recovery. No permanent-failure defect is
claimed from that capture. Initial Inbox-cycle runs reused one title and were
insufficient proof of catch-up on every cycle; the repeated runs above change
the title each time.

## Escapes and corrected diagnoses

### Fixture omitted attachment-validation routes

Android CI [498](https://github.com/kzahel/yepanywhere/actions/runs/37679085281)
and internal-release [499](https://github.com/kzahel/yepanywhere/actions/runs/37680945484)
failed the same two attachment-toast assertions. The initial interpretation was
that every toast came from an interrupted request. Diagnostic tracing disproved
that: the fixture accepted staged uploads over its native WebSocket but did not
supply `upgradeWebSocket` to `createApp`. Consequently the HTTP upload-route
family, including validation and materialization, was absent. Revalidation after
recovery received a real 404. The release job was skipped; run 499 published no
internal Play release.

The corrected fixture uses one upgrade function for both the full HTTP app and
native socket, as production does. Attachment experiments preflight validation
and wait for a delayed validation request specifically before dropping the
socket. This prevents an unrelated session read from triggering the cut too
early. A missing fixture route must not be hidden by weakening the page-error
assertion or suppressing arbitrary 404s in the client.

### Interrupted validation misreports or clears attachment drafts

A separate shared client defect remains reproducible with the complete fixture:
`SessionPage` and `NewSessionForm` treat rejected validation as proof that files
are unavailable. Synced drafts retain references but show a false notice; the
legacy path clears references. Unit reproductions cover both capabilities and
both native connection replacement and browser socket closure. These fail
before the correction. Keeping the reference without its visible chip is also
insufficient and has its own red/green observation.

The correction retains references and chips after a failed request. Known
recoverable connection interruptions are quiet. Other validation failures remain
visible with an accurate check-failed notice, rather than claiming files vanished.
A completed response confirming missing files still follows the existing missing
file behavior. No transport recovery policy, request replay or server contract
changes. This is a bounded shared UI/data-preservation correction.

The browser's separate [raw socket-error gap](../../gaps/browser-reconnect-shows-raw-websocket-error.md)
still reproduces when page reads are interrupted. It predates this round and is
kept as baseline behavior; attachment validation must not disguise that remaining
page-error failure as a clean whole-page pass. The final desktop in-flight
comparison fails only that raw page-error assertion; its attachment notice is
absent and the file stays present. The final minified Android APK
passes validation interrupted in flight and attachment wake into outage; stock
emulator Chrome also passes the matched attachment wake. The Android wake
needed about 57 seconds of passive recovery in this run, so this is evidence
of eventual recovery, not instant reconnection. That latency was repaired on
2026-11-26 by the
[native recovery ramp](../../topics/source-transport.md#one-exhausted-recovery-scheduler).

### Android discards an offline notification tap

Real FCM delivery succeeds after process death. The app was last on Inbox; after
tapping during an outage, Inbox and the sidebar recover but the notified session
never opens. `MainActivity` consumes the extras and drops the action on its first
failed authenticated lookup. Two independent runs reproduce this failure.

The repair retains the opaque pending tap while the existing foreground native
owner recovers. It resolves only when connected and rechecks the enabled binding
before opening the server-provided destination. Terminal authentication,
revocation and definitive lookup failures stop it. Backgrounding cancels lookup
work and releases its lease; foreground/recreation can resume the pending tap.
A newer tap or host-management choice supersedes it. No new retry timer or
background connection owner is introduced.

Seven Kotlin cases cover exhaustion, disconnect during lookup, typed operation
failure, terminal rejection, revocation during lookup, retired bindings and
cancellation. Both the first candidate and final minified APK pass real online and offline
taps, and a second process death while the offline tap is pending. The latter proves new
PIDs and recovery of the saved action, not merely restoration of Inbox. Final
offline cases open the session about two and three seconds after restoring
service. All 113 Android unit cases pass, including the seven new regressions.

## Interrupted uploads

A further byte-triggered experiment cuts a real 4 MiB file after 256 KiB of
additional client traffic. Both native routes show an explicit upload failure,
retain the typed draft, do not replay automatically, and produce exactly one
completed chip when the original file is explicitly selected again. Native has
no uncaught page exception or fabricated server response. Desktop Chromium and
stock emulator Chrome recover the file the same way on both routes, but all
four web comparisons also emit an
[unhandled socket rejection](../../gaps/browser-upload-interruption-unhandled-rejection.md).
That standard-web issue is recorded without a transport-policy change.

This is deliberately a diagnostic, not a generic no-error acceptance pass:
the expected upload-failed notice remains in the observations. The runner
asserts draft retention and one completed chip after reselection, and records
exceptions separately. It does not establish server-side exactly-once delivery.
Its longer filename also exposed a harness assumption: visible chip text can
be shortened. Attachment identity now uses the full accessible name; an empty
chip list still fails. Eight fault-controller/oracle checks pass and now run
in root `pnpm test`, so ordinary CI also protects the experiment machinery.

## Harness limits and verification

Two initial process-death setup attempts selected a retired instrumentation
WebView or queried the PID before asynchronous launcher startup completed.
Selecting the current PID and waiting for launch completion repaired setup.
The first notification control also lost its observer when native routing loaded
a new document. The observer now reinstalls in subsequent documents.

The early observer measured 11 ms of empty HTML before the new document's first
content. Initial bootstrap is recorded separately from a rendered page becoming
empty; final emptiness and post-render blank transitions still fail. Cold-entry
observers and checkpoint captures do not establish frame-by-frame visible flicker.
Some frames before debugger attachment and replaced-document observations are
unavailable. Those limits are not evidence that a user's draft was erased.

Workspace verification passes lint, formatting, type checking and all unit
packages: shared 955, broker 45, relay 130, server 6,447 and client 6,804 tests.
Android build/lint and 115 unit tests pass (113 before the final login-error regression). The console-warning budget ratchets
down by two. The touched-CSS review defers extraction from the large legacy
SessionPage/NewSessionForm styles; this change does not edit styles.

The harness-only commit's main CI exposed a separate
[Project App handoff failure](https://github.com/kzahel/yepanywhere/blob/72e9428e93bb78e759fadfa98a3c2603ebec24c1/gaps/project-app-session-handoff-misses-pane-in-ci.md)
and two selection retries. A focused fresh local run passes all three without
retries; that does not erase the hosted evidence. The five-case page acceptance suite and full native live suite pass on both
routes. The latter executes 15 direct and 7 relay tests; two host-driven
preparation/cleanup methods and relay-inapplicable cases are skipped by
assumptions (JUnit reports 17/16 methods in total). The relay case includes the
100 MiB upload and unchanged 100 ms sequential-input gate. The fourteen-case
longer matrix finishes 13/14: all seven Android cases pass. Stock Chrome
passes recovery in every case but fails the Doze case's **initial typing**,
three to four seconds before sleep, with four delayed characters (169–299 ms).
None are lost. This is retained as a failed case and an
[open typing gap](../../gaps/emulator-chrome-initial-typing-latency.md); three fresh
Android/stock-Chrome control pairs subsequently pass with unchanged readiness
and limits. Android maxima are 14.1/14.9/71.6 ms and Chrome
16.9/19.3/34.5 ms. These do not erase the original failure. General
[CI 37691081022](https://github.com/kzahel/yepanywhere/actions/runs/37691081022)
passes all 24 jobs on `8610677ef`, with three browser retries: native-fixture
composer readiness, Project App handoff, and initial follow-scroll position.
Their gaps remain open. Later general CI `37698697131` fails the known Project
App handoff after both retries and the recorded fake-Codex shell-probe waiter.
Those failures remain distinct from native acceptance. Final source
`c3d828c98` passes all 24 jobs in [general CI 37704844755](https://github.com/kzahel/yepanywhere/actions/runs/37704844755),
with one Project App handoff retry, and all 12
[runtime/SQLite jobs](https://github.com/kzahel/yepanywhere/actions/runs/37704844623). The fixture correction also passes
[iOS CI](https://github.com/kzahel/yepanywhere/actions/runs/37690486734).
Android [verification 502](https://github.com/kzahel/yepanywhere/actions/runs/37691081079)
passes build/lint/package inspection and the complete hosted WebView
instrumentation gate on `8610677ef`. The manually requested internal-release
[run 503](https://github.com/kzahel/yepanywhere/actions/runs/37694018913) then
timed out preparing its minified live probe and published nothing. The
workflow had prebuilt ordinary Debug, then started another R8 build beside
the running emulator. `7c7a1261c` aligns preparation and ordinary/live tests on
the same minified fixture variant. All 17 standalone instrumentation cases
pass locally on that variant (25 fixture-dependent assumptions); repeated
preparation takes five seconds with both R8 tasks up-to-date. No test,
typing ceiling, job deadline or Release network policy changes. The
[replacement release 505](https://github.com/kzahel/yepanywhere/actions/runs/37698935387)
was deliberately canceled after the actual Release smoke exposed the system-bar
contrast defect below. Its duplicate push-only verification was also canceled.
Manual internal-release [run 509](https://github.com/kzahel/yepanywhere/actions/runs/37703083440)
on `3dcbb7b9a` was also canceled before publication after the additional reboot
setup exposed the native login error-label defect below. Replacement [run 511](https://github.com/kzahel/yepanywhere/actions/runs/37704886933)
on `c3d828c98` passed build/lint/package inspection and pre-emulator shrinking,
then failed before executing app tests because Maven Central returned HTTP 429
for instrumentation-host dependencies. Publication was skipped; the
[dependency-preparation gap](../../gaps/android-ci-instrumentation-dependency-rate-limit.md)
retains the evidence. Attempt 2 cleared dependency setup and passed ordinary
instrumentation and all 17 reported direct live cases (497.575 seconds, including
fixture assumptions). Live preparation reused the APKs in 14 seconds with 62 of
64 tasks up-to-date, confirming the pre-emulator build repair. The job then
reached its 30-minute limit during the relay group and published nothing.
Because that group buffered output until completion, the last running test is
unknown; no relay pass or product-failure diagnosis is claimed. The runner now
streams instrumentation output while retaining it for the unchanged result
checks. The aggregate job allowance is 40 minutes, retaining individual test
deadlines, the 100 ms typing gate and all app assertions.
[Run 513](https://github.com/kzahel/yepanywhere/actions/runs/37712235822) on CI-only
follow-up `a079aa3f9` passes both Android gates: direct live acceptance reports
17 tests in 474.372 seconds and relay acceptance reports 16 in 331.842 seconds
(these counts include fixture assumptions). The complete instrumentation job
takes 29m54s, showing how little margin the previous 30-minute allowance left.
No application hang is established by the earlier cutoff or by an incomplete
live log view. Application code is unchanged from `c3d828c98`. The follow-up passes local lint, formatting, type
checks, eight publication-policy tests and a real-child-process streaming check
(early output, complete capture, quiet capture, failure propagation and cleanup).
The follow-up passes all 24 [general CI jobs](https://github.com/kzahel/yepanywhere/actions/runs/37712171641)
and all 12 [runtime/SQLite jobs](https://github.com/kzahel/yepanywhere/actions/runs/37712171597).
Its first browser shard reports one
[large-draft typing retry](../../gaps/browser-large-draft-typing-latency-in-ci.md):
150.2 ms against the unchanged 100 ms limit, then a passing retry. This is
retained separately from the emulator Chrome observation. The second shard
passes with a [version-route interception retry](../../gaps/browser-right-pane-version-intercept-reset.md)
(`route.fetch: read ECONNRESET`), also retained. The superseded `c33fe7c6f`
general run was canceled after its first browser shard passed with the recorded
native-fixture composer retry. Its runtime/SQLite matrix completed successfully. Three-minute forced idle, debugger-driven input and repeated
wake cycles can falsify important lifecycle assumptions, but cannot establish
real modem handoff, manufacturer battery policy or overnight behavior. Those
remain the final physical-phone checks after emulator defects are repaired.

Run 513 subsequently publishes `0.1.2-ci.513.1` / code `61301` from
`a079aa3f950cd868d8d22d5988eb9efa6e97e367`. The retained receipt reports
`published` on `internal`; the publisher verified Play's returned SHA-256
against the signed candidate (`b10a33dfbadc18b390363c210526cac271e5fd8516016b7dbf070692c3d9db05`).
Google Play confirms **Available to internal testers** for code `61301`. The
receipt and full console capture are retained with the campaign. No public
track or tester membership was changed. Both owned emulators and all owned
fixture processes were stopped; the temporary Release AVD was removed. The
existing CI AVD was preserved, and the attached physical phone was not operated.

## Release smoke exposed missing system-bar coverage

The fully optimized, non-debuggable Release APK passed real native-form login
through the public TLS relay, session entry and process-death restoration on a
fresh owned API 35 emulator. Full-device captures then exposed almost invisible
clock/Wi-Fi/battery icons: the native shell paints dark inset areas, while
`enableEdgeToEdge()` automatically requested dark foreground icons in system
light mode. The earlier WebView-only screenshots excluded those areas.

The owning Activity instrumentation reproduces the wrong appearance flags
before the repair (24 instead of 0). Explicit dark system-bar styles retain
light icons across Activity recreation, without changing layout or web theme.
The regression passes in both system themes. The rebuilt actual Release APK
also passes native-form public TLS login and session restoration after confirmed
process death (PID 9996 to 10429), with readable icons in the final full-device
capture. It is non-debuggable and disallows cleartext; the local debug signature
is only for installation on the owned emulator, never a store upload artifact.
Both focused native live routes pass again, including the 100 MiB relay upload
and unchanged 100 ms sequential-input gate. The lifecycle harness now saves
full-device PNGs alongside page captures, with their actual pixel dimensions.
Fresh stock Chrome has readable icons; its first-run notification sheet also
showed why page-level debugger assertions alone do not establish an unobscured
foreground UI. After declining ordinary onboarding, a new full-device capture
and control run are clean. Native control acceptance also passes with the new
captures and unchanged typing limit.

The clean minified standalone suite passes all 18 executable cases (25
fixture-dependent assumptions; JUnit reports 43). Earlier attempts are retained:
one iframe-load marker timeout passes when isolated, and repeating the whole
suite without resetting test state kills instrumentation when its notification
permission test revokes the previously granted permission. The
[test-repeatability gap](../../gaps/android-control-instrumentation-repeatability.md)
records both; neither is silently converted into a passing attempt. No physical
phone data was cleared or operated on.

## Fresh-login network failures were mislabeled as authentication failures

An additional actual-Release reboot setup failed native-form login twice.
The instrumented login against the same public TLS fixture exposed
`CoreException.Unavailable`. A host browser signed in successfully, while
Chrome on the emulator reported “Failed to connect to relay server.” The
emulator lacked a usable route until its radios were reset; this is not evidence
that SRP credentials or the Release shrinker were broken.

The Android form nonetheless reported “Could not authenticate with this
server,” because its generic catch classified every failure that way. A
controlled repeat with emulator Wi-Fi and mobile data disabled reproduced the
same misleading notice. The owning UI-state unit regression fails before the
repair. Known native unavailable, timeout and closed errors now produce
“Could not reach this server. Check your connection and try again.” Genuine
authentication/verification failures retain their existing treatment; no
password retention, automatic login replay or transport policy is added.

The rebuilt non-debuggable Release form passes the offline-message and
password-clearing checks, then signs in normally after radio restoration.
The standard web client already distinguishes this connection failure, so its
behavior remains unchanged. Before/after captures and underlying native error
are retained in `release-reboot/` and `release-final/` under the campaign's
artifact directory.

A subsequent full Android reboot uses a changed kernel boot ID as proof, with
both radios disabled before restarting. The actual Release opens its saved
session route and displays the unsent draft offline, without returning to
login. Restoring Wi-Fi/data loads the same transcript while retaining the
draft, observed after 4.84 seconds. This includes UIAutomator polling overhead
and is not a timing benchmark. The fixture stays alive across reboot so the
server resume state is unchanged. Final captures include the whole screen.

## Remaining issues by client

| Observation | Android app | Standard web client |
| --- | --- | --- |
| Slow passive recovery when the service returns without a network signal | About 57 seconds in the attachment-wake case; retained policy, separate UX follow-up | Matched stock-Chrome case about two seconds; other Chrome cold/Doze cases take longer |
| Raw socket error shown when an in-flight page read is cut | Repaired native path passes | Existing raw `1006` page-error gap remains |
| Extra uncaught error after an interrupted upload | Not observed on either native route; explicit failure/reselection works | Reproduces on both routes in desktop and emulator Chrome; explicit recovery still works |
| Initial typing exceeds 100 ms | All final Android cases and fresh controls pass | One stock-Chrome case reaches 299 ms before sleep; subsequent controls pass, cause unresolved |

These observations do not justify replacing the native connection or rewriting
browser recovery. Keep the real-app emulator harness, extend owning-layer
regressions for each new escape, and use physical testing for the remaining
hardware and platform-policy boundaries.

## Physical-device handoff

1. Update through the internal Play track and confirm saved hosts, unsent text
   and staged attachments survive the update.
2. Switch real Wi-Fi/cellular connections while viewing Inbox and a session,
   including waking before service returns. Check sidebar catch-up and that
   recovery does not require login or a page refresh.
3. Leave the phone locked for hours under its normal battery policy; receive
   and tap a notification, including a tap while temporarily offline. Confirm
   the intended session opens when service returns.
4. Check ordinary phone-keyboard typing and file selection during active output.
   Hardware/IME input and current phone WebView versions need this final check.

No physical device was operated during this investigation. The emulator results
establish a strong Android recovery baseline, not a claim about overnight modem
behavior or every vendor's process/battery policy. The shared transport-unit
conformance factory remains useful follow-up; a JVM/desktop bridge harness is
not required to reproduce or protect the repairs found in this round.

The larger matched matrix and real-FCM suite are repeatable opt-in commands,
not new per-push CI gates. The owning-layer regressions and native live
sleep/wake checks run in ordinary CI. A useful next automation step is a
bounded nightly or manual run of the larger matrix, retaining failed cases
without automatic retries. Keep its browser failures visible and report them
separately from Android; do not turn a known browser baseline into a blanket
exception that could hide a new Android regression.
