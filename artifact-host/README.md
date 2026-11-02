# Managed artifact content host

The first-party hosted YA client supplies this viewer automatically when its
server advertises `artifact-relay-preview` and no custom public artifact host
is configured. The static host carries no artifact storage or YA credentials.
The real file viewer captures its source transport and forwards bounded reads
through an authenticated, principal/session-bound preview lease.

## Delivery

`artifact-<32 lowercase hex digits>.yepanywhere.com` is a fresh origin for one
viewer. First-level labels fit ordinary wildcard TLS. Only the fixed
`/__ya/1/bootstrap.html`, `bootstrap.js`, `worker.js` and `frame.js` are served;
all artifact and API network paths return inert failures. A worker scoped to
`/v/` synthesizes document/asset responses from the parent broker. Its CSP
allows local assets and scripts while restricting ordinary external resource
loads, workers, nested frames, forms and top-level escape. This is credential
and API isolation, not network containment: artifact scripts can read every
non-dot file granted under the entry directory and exfiltrate it through
WebRTC STUN/TURN, their own frame navigation or DNS side channels. Source bytes remain inert
on the authenticated YA API origin.

The hosted assets allow only `https://yepanywhere.com`,
`https://latest.yepanywhere.com` and the exact store extension origin
`chrome-extension://dgeameddpnggdeenoekpiaacfghdodch` to embed or connect the
bootstrap. The extension uses the same source-bound preview leases and needs
no additional host permission. Release this host policy together with an
updated extension client; published extension 0.1.4 predates this path. The APK
generates a separate copy allowing only its appassets parent. The client and bootstrap both validate exact source,
origin, protocol and viewer identity. Content receives an entry name and theme
and widget state, never a server credential, grant API path or general fetch
interface. The server rechecks file authority even if content forges messages.

The small fragment adapter exposes `openai.theme`, `widgetState`,
`setWidgetState()` (64 KiB), and `sendFollowUpMessage()` (8,000 characters,
eight insertions per viewer, requiring transient user activation and viewer-frame focus in the trusted
parent). Follow-ups insert undoably into the current
session draft and never send automatically. State belongs to one source,
session and artifact; it is not durable across closing the viewer. The fixed
frame helper also supports the existing file-viewer find protocol.

Version `1` is the message/asset compatibility family. Compatible changes keep
its URLs and protocol working for existing viewers. A future incompatible
family must retain version 1 assets while its active viewers can still run.
New viewers always get a fresh origin. Viewer documents are no-store; the host
never caches file bytes. Network fallback is always safe if worker control is
lost. Parent cleanup cancels readers/ports and releases the server lease; the
bootstrap unregisters on explicit close and pagehide.

## Build and deploy

Build shared first so the generated, existing find agent is available:

```bash
pnpm --filter shared build
npm ci --prefix sharing-worker
node --test artifact-host/host.test.mjs
cd artifact-host
# Use the project's credentialed Wrangler installation.
../sharing-worker/node_modules/.bin/wrangler deploy --config wrangler.jsonc
```

The route uses `*.yepanywhere.com/*`. DNS must provide a proxied wildcard
record. Existing explicit service records remain DNS-only and bypass the
Worker; a non-artifact hostname reaching this Worker returns 404. Review that
constraint before proxying any additional first-party service hostname.
Private account/zone records, credentials and actual deployment receipts live
in the dotfiles runbook, not public source. Logs/observability are disabled.
This is the real HTTPS content host, not a separate YA staging environment.

## Acceptance

The explicit manual runner uses a temporary YA profile and a fresh, random
identity/password on the public TLS relay. It loads the **actual newly built
YA client** from the owned worktree into an intercepted first-party-origin
page in a separately identified Playwright Chromium profile. The content
origin's DNS, TLS and responses are real network requests to this deployment;
the first-party parent build is temporary, not the public site's deployed
client. It needs no browser insecure-origin, resolver, TLS or LNA overrides.
Third-party cookies are blocked in the disposable browser profile.

```bash
pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay
```

The public relay sees only normal SRP/NaCl encrypted traffic. The runner stops
its owned YA/browser processes, and leaves secret-free diagnostics/captures
under ignored `.artifacts/managed-artifact/`. No screenshots belong in Git.
It is manual qualification, not a production-dependent CI test. Fast host
security and real-filesystem lease tests run in ordinary unit CI.

The supported v1 file tree is the entry HTML's directory and descendants.
UTF-8 HTML, relative resources, computed modules and linked HTML documents work without asset
rewriting. Absolute OS paths, root-relative web-app routing, external scripts
or APIs, application backends and WebSockets are not supplied by this broker.
Custom artifact hosts, app vhosts and public sharing retain their existing
contracts. Chrome is the initial qualified engine. WebKit keeps its existing viewer;
packaged Android qualification is recorded separately below. Only the two
official parent origins are supported by hosted assets;
`PARENT_ORIGINS` is a diagnostic override, not custom-deployment support, since
the content response CSP also fixes its ancestors.

## Measured qualification — 2026-10-16

Chrome for Testing 148.0.7778.96 passed the real YA-pane/public encrypted-relay
runner with the artifact listener disabled and third-party cookies blocked:

- Native PNG/srcset, imported CSS/background URL, WOFF2 font, classic script,
  static and computed dynamic module imports, and JSON fetch.
- Linked HTML navigation/reload, explicit worker termination/restart, separate
  origins/storage for concurrent viewers, and find (1/1).
- Fragment theme and widget-state restoration on inner reload; a follow-up
  populated the draft without submission.
- Cancellation after the first 65,536 bytes of a 4 MiB stream, followed by a
  successful read; close removed all registrations and a surviving controlled
  frame's next read returned 503. Direct network artifact fallback returned 404.
- All 32 sequential artifact keystrokes acknowledged within 4 ms. All 33
  composer keystrokes acknowledged within 6 ms while 12 transcript updates
  caused 38 DOM mutations. No browser console/page errors.
- Desktop 1000×600 and phone-width 375×812 captures inspected; no screenshots
  committed. Phone-width Chromium is not Android/iOS device qualification.

Selected, secret-free evidence is in [acceptance-results.json](acceptance-results.json).
Server tests separately cover range responses, traversal/symlink denial,
principal/session binding, policy changes and revocation/expiry. Those security
cases are API integration evidence, not additional browser measurements.

## Android emulator qualification — 2026-10-16

The same ten managed-viewer checks passed in stock Android Chrome
124.0.6367.219 on a disposable Android 15/API 35 ARM64 emulator, against the
real public encrypted relay and deployed content host. This covers the actual
Android browser engine, not a desktop viewport simulation. A cross-site cookie
probe confirms both network and script cookies are blocked; the same cookies
are accepted when that probe is top-level. The captured parent is still the
actual worktree build supplied by the harness, not a published hosted client.
Final run: 32 sequential artifact keys acknowledged within 32 ms, and 33
composer keys within 44 ms during live transcript updates; no console/page
errors. An earlier successful run reached 95 ms for an artifact key, still
within the 100 ms requirement.

The separately built bundled Debug app uses `appassets.androidplatform.net`
and intentionally stays on the scriptless fallback: the local PNG does not
load, scripts do not execute, and no managed content frame is created. Opening
and closing that fallback were exercised after a cold resume. Four console
policy refusals (stylesheet, image, and scripts) are expected on this legacy
fallback; unexpected errors remain failures. This is **not** native interactive
artifact support. No production origin allowlist or WebView policy was relaxed.

Fresh native pairing also exposed an independent
[pairing stall](../gaps/android-native-pairing-remains-busy-after-registration.md),
reproduced with the main server. Native viewer observation used the explicit
force-stop/relaunch workaround after verifying real device registration. It
must not be confused with a successful fresh-login flow.

Reproduce with an explicitly selected **disposable** emulator, an initialized
stock Chrome profile, SDK `adb` on PATH, and root access only for setting and
restoring that disposable Chrome profile's cookie preferences:

```bash
ANDROID_SERIAL=<owned-emulator> pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay --android

# Build the actual bundled app first (ANDROID_HOME points to the local SDK):
pnpm --filter @yep-anywhere/android build:android:debug
ANDROID_SERIAL=<owned-emulator> pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay --native-fallback --resume-after-pair
```

These emulator modes refuse physical-device serials, restore Chrome preferences,
removes its DevTools forwards and temporary command-line file, and stops its
owned app/browser/server. Native mode clears the disposable app data. The
caller owns emulator shutdown. Selected results are in
[android-acceptance-results.json](android-acceptance-results.json); screenshots
remain ignored. iOS/WebKit and interactive native delivery remain unqualified.

## Physical Android qualification — 2026-10-16

Attached physical Android 17/API 37, Chrome 155.0.8059.79: all eleven checks
pass against the **final main-checkout client/server**, public encrypted relay
and deployed HTTPS host. The actual client build is temporarily supplied by the
harness; the public hosted client has not been published by this test.
In addition to the earlier graph/lifecycle checks, this verifies 24 simultaneous
reads, exact JSON whitespace and integers above 2^53, invalid JSON, binary wasm
bytes, empty JS/CSS and six 4-byte range reads from a 64 MiB file. Range status,
Content-Range, Accept-Ranges and byte counts survive the relay. This is range
transport qualification, not video seeking or long-media playback acceptance.
Artifact/composer sequential keys peak at 22/30 ms during live transcript
updates; no console/page errors. The default isolated Chrome context allows
third-party cookies; the desktop/emulator runs separately prove blocked-cookie
behavior. No phone browser settings were changed.

The physical bundled Debug app (WebView 154.0.8037.106) successfully pairs via
its **fresh native UI**, opens the scriptless fallback, and tears it down. No
cold-resume workaround was needed on this phone. The fallback intentionally
loads no local PNG and executes no scripts. This does not implement native
interactive artifacts. The APK uses an isolated application ID, no app-link
claims, unchanged native transport sources, and Firebase disabled for this
viewer-only test. It was removed afterward; the user's installed app and data
were preserved. Captures were inspected and remain ignored.

```bash
pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay --physical-chrome
YA_ARTIFACT_TEST_APK=<isolated-test-apk> pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay --physical-native
```

These explicit physical modes select the authorized handheld through the
machine-control Android adapter. Chrome uses an ephemeral context in the
existing DevTools connection and closes only that context; it never resets,
roots or force-stops the user's browser. Native mode verifies the isolated
`com.yepanywhere.mobile.artifacttest` application ID before installation and
refuses to replace an existing installation of that test package. The test APK
must remove MainActivity intent filters to avoid claiming production app links.
No device selectors, credentials, APKs or screenshots belong in source.
Selected evidence: [physical-acceptance-results.json](physical-acceptance-results.json).

## Review hardening

YA API launched Claude Opus 5.5 at high effort for a source/security review.
No security blocker was found. Its functional findings were addressed: bounded
FIFO admission (64 waiting per viewer / 256 per tab, eight active per viewer, 32 per tab), byte-exact
relay download streams, range-header forwarding and response-byte budgets,
late admission cleanup, explicit lease-expiry/unavailability Retry, immediate
static fallback while version is unknown, and server slots reserved before
filesystem awaits. Follow-ups require transient user activation; reserved
content hosts are excluded from the extension's session-tab trust lookup.
The scriptless link listener is shared with the configured viewer. A follow-up
review accepted all fixes without blockers. Its additional recommendations
were applied: server read headroom (16/64), 64 queued reads per viewer, and
viewer focus as well as user activation for composer insertions.

Leases do not renew automatically. Expiry or server lease loss exposes Retry,
which admits the original entry through the captured trusted source. Missing
individual files remain resource failures. Current source uses a 120-second
progress-based idle deadline, bounded by lease expiry, a 256 MiB per-file limit
and 1 GiB of produced bytes per viewer. Cancelling a range charges only bytes
produced, preserving headroom for repeated video seeks. Linked PDF/download
navigation remains outside this qualification. Other file bytes are transported
verbatim; HTML needs UTF-8. The currently deployed hosted worker still has its
earlier 64 MiB file limit until separately published; the generated APK copy
uses the source limits.

Qualification limits: queued response heads still have the worker's 15-second
limit; slow cellular/resource bursts can time out. Server read caps are shared
across clients, so overload can still return 429. The expiry notification uses
the server timestamp against the client clock; clock skew may show Retry early.
Lease expiry intentionally tears down in-page state after 30 minutes; dashboard
renewal and durable widget state are not supplied by v1.

## Packaged Android acceptance

The bundled shell uses the same worker/frame sources, generated with an exact
appassets ancestor list. Native interception supplies only the four fixed shell
assets; the parent obtains all local artifact bytes through the captured native
encrypted connection. See the [security contract](../topics/active-content-security.md#bundled-android-fixed-shell)
and [in-progress qualification](../docs/tactical/156-android-secure-transport-and-artifacts.md).

Build an owned side-by-side test APK; it has no production app-link filters and
never replaces or clears the installed app:

```bash
pnpm --filter @yep-anywhere/android prepare-frontend
packages/android/gradlew -p packages/android \
  --init-script scripts/isolated-test-app.init.gradle \
  -PyaTestApplicationId=com.yepanywhere.mobile.artifacttest \
  -PyaFirebaseEnabled=false -PyaNativeProbeMinify=true assembleBundledDebug
YA_ARTIFACT_TEST_APK="$PWD/packages/android/app/build/outputs/apk/bundled/debug/app-bundled-debug.apk" \
ANDROID_SERIAL=<owned-emulator> pnpm exec tsx --conditions source \
  artifact-host/acceptance.mjs --native --native-managed --public-relay \
  --skip-build --large-media
```

Use `--physical-native` instead of `--native` for the unlocked attached phone;
the Machine Control adapter supplies its private selector. The runner verifies
the APK identity, refuses an already installed test package, then removes only
its owned installation/forwards/processes. Large-media mode needs local ffmpeg;
it generates a real 600-second H.264 movie and twenty distinct PNG charts in
temporary data. It checks a 96 MiB prefix with bounded digest buffering, exact
bounded/suffix/open-ended ranges and 416 metadata, actual decoded frames and
seeking, a 65-second pause/resume, and per-key event/input/paint times within
100 ms during live chat updates. Android CDP command RTT is reported separately.
Whole-device captures include hardware video textures.

Chrome 124's built-in video controls register an orientation listener even
when sensors are denied. The acceptance runner records that exact policy
diagnostic separately, without granting sensors or accepting other console
errors. The explicit invalid-range probe similarly records only its exact 416
resource diagnostic. Native runs exercise sequential fresh viewer origins and
worker removal; the desktop runner's concurrent newPage/surviving-frame tests
are not treated as native coverage. Physical large-media and bad-network
qualification remain pending. No screenshots, movie files or APKs belong in Git.


The packaged API35/WebView124 app now passes the full public-relay baseline and
an owned-relay movie/fault run. A focused run also verifies twenty image reads
queued during each fault. The [measured report](../docs/testing/android-artifact-streaming-2026-10-16.md)
records successes, failed attempts and unqualified boundaries, including the
103.2 ms emulator frame miss and pending connection-wide tail accounting.

For repeatable native socket faults, replace `--public-relay` with
`--local-faults`. This starts an owned local relay behind a TCP gate and an
owned ADB reverse; SRP/NaCl still encrypts the file traffic. Add `--faults-only`
for the focused fault/image/typing matrix; it explicitly omits the already
separate large-prefix/65-second-pause qualification. The seed and action
timeline, exact image hashes, UI edges and cleanup result are retained in the
ignored receipt. Covered transcript catch-up is checked after parking the
viewer, then restoring the same document; the existing modal freeze is not
mistaken for a native subscription failure.

Add `--native-resume` to the managed native invocation for three actual
HOME/launcher cycles. The runner requires OS evidence that the app left the
resumed Activity, retains parent/artifact document identity and composer draft,
checks a fresh asset read, and permits at most one reconnect interval with no
terminal-disconnected banner per cycle. It records DOM visibility separately;
some WebViews still report visible while the OS app is backgrounded. This does
not simulate phone sleep/wake, process death or Activity recreation.

For the separately scoped slow-link diagnostic, use `--native --native-managed
--local-faults --large-media --slow-link-probe --skip-build`. It requests eight
16 MiB movie ranges, reads one chunk from each response and retains the bodies
for a 20-second observation at 128 KiB/s per downstream TCP connection. It
records passive relay message-size/physical-close counters and sampled main-app
PSS (excluding isolated WebView renderers), then cancels the burst and requires
a fresh artifact read. It omits full movie transfer/pause and seeded faults.
Before connection-window repair it reproduced circuit closures and exited
nonzero. The repaired mode requires all eight 206 first chunks, no relay closure
and a fresh read after cancellation before continuing through typing/teardown.
This is opt-in qualification, not a new product 20-second deadline. Relay limits
remain unchanged. The gate
holds one input chunk/timer per direction and releases all sockets on teardown.

`--trace-native-setup` requires the owned local relay and records passive mux
snapshots before pairing, at the paired home, after the harness's explicit full
session-document navigation, and at first artifact readiness. This separates
intentional pairing/document teardown from later artifact or fault activity.
It records counts and message sizes only, without credentials or payloads.

`--native-document-reload` requires the managed native pane. After normal close
qualification, it reloads the whole parent document eighteen times with an
admitted artifact, requires a new parent/document origin and working modules on
each restoration, then closes the modal before checking the transcript. The
initial app failed after fifteen successful restorations: the server returned
429 “Too many open previews,” despite old worker removal. Source-bound lease
recovery now passes eighteen restorations. This is separate from the eighteen
explicit-close cycles. Real-browser concurrency checks additionally preserve a
live owner while its peer reloads and reject cleanup of a different source or
an arbitrary API path. See the security contract for storage/lock fallback and
the remaining admission-response crash window.

`--native-tab-cycle` requires the managed native pane. It uses observed native
accessibility labels to create a same-host tab, then makes eighteen round trips
between Projects and the session. Each selection must close the old DevTools
page; the next WebView must have a new parent identity. The session route and
draft must return, and explicitly reopening the artifact must get a fresh origin
and a successful asset read without changing the app process. This follows
[plan 146](../docs/tactical/146-android-tabs-and-warm-resume.md): inactive tabs
retain navigation metadata, so the inline file pane is reopened explicitly.
The runner rebinds observations to each actual replacement WebView; it does not
create extra Playwright pages inside the native app or retain a hidden viewer.
The new target's worker observations are diagnostic, not a complete global
service-worker inventory after the old target has been destroyed.

`--native-process-restart` requires the managed native pane. It leaves a 64 MiB
file response unread after the first chunk, force-stops only the owned test app,
and cold-launches it with ACTION_MAIN and no credentials or deep-link data.
A different process and parent document must restore the route/draft, reuse the
saved native pairing, and explicitly reopen a fresh artifact with a successful
asset read. It reattaches to the replacement process's DevTools endpoint. This
is one abrupt process-loss case, not a full 64 MiB transfer or proof of every
server queue/descriptor's state at the instant of termination.

The full `--large-media` matrix also fetches and verifies all twenty image files
while the real movie remains paused for 65 seconds, then resumes/seeks and
checks presented pixels. This guards native shared-credit isolation between a
paused body and other admitted readers; it does not prove total process memory.
