# Desktop V0

> Desktop v0 is one stable, self-contained YA installation that uses
> externally managed provider software and starts without an onboarding gate.

Topic: desktop-v0

## Distribution Contract

The signed desktop installer owns one tested release unit:

- the Tauri shell;
- a private JavaScript runtime that is not added to the user's `PATH`;
- the server and client artifacts built from the same commit; and
- a manifest that identifies the independent desktop release version, exact
  bundled YA Git build, source commit, and runtime versions.

First launch must not download or install YA, Bun, Claude Code, Codex, or a
package manager. A desktop update replaces the shell, runtime, and bundled YA
artifact together. Provider software remains externally managed.

The [agent command runtime sketch](agent-command-runtime.sketches.md) records a
candidate that must preserve this distribution contract.

The desktop release and bundled YA build remain independently versioned. In a
desktop-created dashboard, **Settings → About** reports both values as
**Desktop** and **Bundled YA**. The native package metadata is authoritative
for the desktop version; the runtime manifest's Git description is
authoritative for the bundled YA build. Ordinary browser and remote dashboards
retain the existing server/client version presentation.

Release CI prepares that runtime as an explicit packaging input before Tauri
runs, verifies the pinned Bun archive hash, and retries transient archive
download failures within a bounded attempt count. Tauri packaging must not
silently rebuild or replace the already-smoked runtime input. Temporary-tree
cleanup tolerates only bounded platform sharing violations, and a preparation
failure reports its final output in the CI annotation.

macOS Tauri packaging retries one failed build or upload attempt to absorb
transient runner-level DMG assembly failures. The retry is bounded: a second
failure remains a failed job and reports whether an app bundle existed without
the required DMG.

When the bundled server contains Mach-O native modules or shared libraries,
signed macOS packaging signs each `.node` and `.dylib` binary with the release
identity and a secure timestamp before Tauri assembles and notarizes the app.
CI verifies every nested signature it creates; an unsigned nested module or
library must fail packaging rather than reach users.

The hardened macOS Bun sidecar carries only the
`com.apple.security.cs.allow-jit` runtime exception required by
JavaScriptCore. It must not receive unsigned-executable-memory, executable-page
protection, or library-validation exceptions. Tauri 2.11 applies one
entitlements plist to its executable signing targets, so the native Tauri
executable receives the same `allow-jit` exception even though YA does not use
it there. Remote dashboard JavaScript remains isolated in WKWebView and gains
no Tauri command capability from this executable entitlement.

Release CI starts the packaged server with `Contents/MacOS/bun` and the server
resource from the final signed and notarized `.app`, before the release action
uploads artifacts. The smoke verifies the Bun signature, requires
`allow-jit=true`, rejects broader executable-memory/library-validation
exceptions, and exercises readiness, health, bootstrap exchange, and
authenticated API access. Unsigned pull-request builds run the same final-app
runtime smoke without requiring a release entitlement.

Desktop application files and user data have separate lifecycles. Update,
reinstall, and ordinary uninstall preserve sessions, settings, auth state, and
provider configuration unless the user explicitly chooses a data-removal
operation.

## First-Launch Contract

A clean installation starts the bundled server and opens the dashboard. It
does not require a Welcome, provider selection, component installation,
provider login, or Ready step.

Provider presence and provider authentication never gate installation, server
startup, or access to the dashboard. If neither Claude nor Codex is detected,
the running app shows non-blocking platform-appropriate guidance to the
official installers. A coarse application detection result is advisory and
must not be presented as proof that a provider is authenticated or launchable.

The existing provider catalog may include optional `applicationDetected`
booleans while `desktopRuntime` is active. Older clients ignore the field.
New clients treat an absent field as the existing `installed` signal, so they
do not require a new route or capability from older supported servers. The
notice refreshes when the browser regains focus and through an explicit retry;
it does not add a polling loop. Dismissing the notice is browser-local and
survives reload or WebView recreation on the running desktop server origin.

Provider readiness has three independent signals:

- `applicationDetected` means provider-owned desktop application or data was
  found. On macOS, Codex detection recognizes the current `ChatGPT.app` and the
  legacy `Codex.app` names in both system and per-user Applications folders.
- `installed` means YA resolved and validated a runtime it can launch. The
  exact `Contents/Resources/codex` executable inside either recognized macOS
  OpenAI bundle is a version-dependent fallback candidate, not an assertion
  that the desktop application is logged in.
- `authenticated` means the selected runtime's ordinary authentication probe
  succeeded. Application presence and runtime launchability never imply it.

For ordinary local providers, an installed runtime remains selectable in New
Session when authentication is false or cannot yet be confirmed. Starting the
session exercises the provider's normal authentication behavior and reports a
real authentication failure through the existing session error surface. An
application-only detection with no validated runtime cannot launch. Claude may
report a launchable runtime without Claude Desktop because YA bundles the
Claude Agent SDK runtime; its auth probe and login guidance use that resolved
runtime rather than assuming an unqualified `claude` command exists in Finder's
environment. [Provider sign-in](provider-sign-in.md) owns the login command
format and the in-app sign-in routes.

The server provider catalog remains authoritative for actual provider
availability. Provider launch and authentication failures use the ordinary
provider/New Session error surfaces; they do not reopen desktop onboarding or
mutate provider installations.

An unavailable bundled server opens a bounded diagnostic surface with the
startup error, recent redacted output, Retry, and Quit. It must not fall back
to downloading runtime components.

Desktop startup is single-flight. Rapid cold launches join the same server
startup attempt and open at most one dashboard. A second operating-system
launch while the server is starting waits for that attempt; it does not spawn
another server or reveal the hidden recovery surface. A second launch while
the server is running focuses a retained dashboard without reloading it, or
recreates an intentionally unloaded dashboard at its saved route. Concurrent
callers receive the same startup failure and do not turn a failed attempt into
an implicit retry. A later explicit Retry may start a new attempt, while a
launch queued during shutdown must not resurrect the server.

The packaged launcher is a recovery surface, not an ordinary application
window or onboarding step. It stays hidden during normal startup and repeat
launches. `starting`, `running`, `stopping`, `stopped`, and `error` are
distinct supervisor states; the launcher must not describe an in-progress
startup as stopped.

## Dashboard Close And Resource Contract

Dashboard close behavior is an explicit three-way choice:

- `unload_after_delay` (the default) hides the dashboard immediately and
  unloads its WebView after five continuously hidden minutes while the tray
  app and bundled server continue running;
- `keep_loaded` hides the dashboard and retains its WebView; and
- `quit` stops the bundled server and exits the desktop application.

Configs containing the legacy `run_in_background: true` migrate to
`unload_after_delay`; `false` migrates to `quit`. Tray-only startup cannot be
combined with `quit` because that would start an application with no durable
surface.

The unload delay is one cancellable timer owned by the dashboard window
lifecycle. Reopening the dashboard or changing its close behavior cancels the
timer, and repeated close/reopen cycles do not accumulate dormant timers. An
unloaded dashboard releases its client connections, subscriptions, and WebView
memory without stopping server-owned provider sessions.

Before unloading, native code retains only the current dashboard path, query,
and fragment in process memory. It never retains a bootstrap URL or code.
Reopening mints a new single-use bootstrap code and passes the saved route
through a bounded, same-origin-only return target. Invalid, cross-origin, or
oversized return targets fall back to `/`. Route memory ends when the desktop
process exits.

Tests may shorten the delay only when `YEP_DESKTOP_TEST_MODE=1` and
`YEP_DESKTOP_TEST_UNLOAD_DELAY_MS` contains an unsigned millisecond value.
Without both values the release default remains five minutes, and the override
never mutates saved configuration. The same explicit test mode may pair with
`YEP_DESKTOP_TEST_DATA_DIR` to isolate a smoke run from the installed desktop
profile; the override is ignored outside test mode.

## Stable And Development Coexistence

The signed app uses its own immutable runtime resources, desktop data root,
owned process tree, and random loopback port. It does not attach to an
unrelated server because a familiar port is in use.

A server launched separately from a checkout remains independent. Desktop
start, restart, quit, update, reinstall, and uninstall must not terminate or
modify that development server or an unrelated Bun process.

Development overrides must be explicit and visible. A signed stable app must
not silently become checkout-backed because of an ambient machine-level
development variable.

## Local Dashboard Authentication

The desktop dashboard may use loopback HTTP in v0, but JavaScript must not own
the long-lived desktop credential.

The native supervisor and server establish a versioned private startup
protocol:

1. native code creates a per-process master secret and sends it through a
   private inherited pipe;
2. the server reports readiness and its selected loopback port;
3. native code mints a short-lived, single-use bootstrap code;
4. navigation consumes the code and establishes a host-only, HttpOnly,
   SameSite=Strict desktop session cookie; and
5. fetch, SSE, and WebSocket requests use that cookie.

The bootstrap/master-secret route is available only through the loopback
listener. It is not accepted by optional LAN, relay, or internally forwarded
requests. Codes are short lived, single use, rate limited, and invalidated on
server restart. Credentials never appear in renderer JavaScript, URLs after
the bootstrap redirect, environment variables, command lines, files, health
responses, or logs.

Reload, dashboard close/reopen, and server restart must recover without a 401.
Password, LAN, and relay authentication keep their existing boundaries.

The shell treats the dashboard as ready when its WebView finishes the
same-origin bootstrap redirect. If the WebView finishes on the rejected
bootstrap page, the shell opens a fresh code once and keeps the requested
dashboard route. If the retry fails or navigation times out, the launcher
offers another Open Dashboard attempt. These attempts use the running server
and keep its provider sessions active. Opening an already ready dashboard
focuses the existing window.

Bootstrap v1 holds at most 16 active codes for 30 seconds, allows at most 30
invalid attempts per minute, and keeps at most 32 in-memory desktop sessions
for 30 days. The browser cookie itself has no persistent expiry and therefore
also ends with browser cookie-state removal. Plain loopback HTTP cannot use a
`Secure` cookie because browsers would not return it; the v0 cookie remains
host-only, HttpOnly, SameSite=Strict, and path-rooted.

The legacy `DESKTOP_AUTH_TOKEN` header/query contract remains server-side only
for the approved old-shell support window. A new shell never falls back to
returning the master secret to JavaScript when bootstrap v1 is absent.

## Tauri Boundary

Packaged Tauri-origin windows receive only the native commands required by
their surface. The loopback dashboard window receives no custom Tauri command
capability. Remote content must not be able to install software, spawn a shell
or PTY, read desktop secrets, control the server, or change desktop settings.

The native shell may inject immutable, non-secret desktop and bundled-build
metadata into the top-level loopback dashboard document for version reporting.
That injection is limited to `http://127.0.0.1` or `http://localhost`, conveys
no credential or native function, and does not add a server route, response
field, capability, or Tauri command permission.

Packaged pages and server-served pages each carry an explicit CSP appropriate
to their origin. Release builds do not expose development tools by default.

The private pipe protects against accidental disclosure through renderer code,
URLs, child environments, and diagnostics. It does not protect against a
malicious same-user process able to inspect YA or Bun process memory.

## Windows Lifecycle And Install Contract

The NSIS executable is the only v0 Windows installer and supports quiet
installation. It is a current-user install, and `/S` does not require
elevation. Windows releases must not publish an MSI or another installer that
requires administrator access.

The x64 Windows package runs on native x64 and Windows ARM64. It carries both
hash-pinned Windows Bun architectures as private immutable resources. The
native shell uses the adjacent x64 runtime on x64 Windows and selects the
bundled native ARM64 runtime when the x64 shell is emulated on Windows ARM64;
it does not execute x64 Bun under ARM64 emulation or download a runtime on
first launch.

The server and every descendant belong to an app-owned Windows process group
or Job Object. Quit, restart, update, and uninstall attempt graceful shutdown
and then terminate only that owned tree within a bounded deadline. No
unqualified `bun.exe`, provider, shell, or PowerShell process kill is allowed.

Opening any packaged window from the tray or a native command leaves the tray,
the new window's close button, and every other window responsive. On Windows,
creating a WebView inside a synchronous Tauri command or event handler
deadlocks the event loop, so window creation always runs from an async command
or a spawned task. Closing Server Output, Diagnostics, or the recovery window
hides it; a failed hide is logged.

The installed app has no sidecar console window. Interactive and quiet
installation, update, reinstall, and uninstall are release-tested from a clean
Windows user profile.

## Update Contract

The app checks the signed Tauri updater automatically and asks before
installing/relaunching. A tagged release fails if its signed updater artifact
or Windows entry in `latest.json` is missing, or if an MSI artifact or updater
entry is present.

The canonical `windows-x86_64` updater entry uses the signed NSIS artifact so
ordinary per-user installations remain non-elevated NSIS installations across
updates. The app does not offer or migrate to a machine-wide installer.

An available update opens and foregrounds the trusted native updater surface
before asking to install and relaunch. A manual check also foregrounds that
surface when the app is current or the check fails, so selecting **Check for
Updates** never leaves its result hidden behind another application. Automatic
checks remain silent when no update is available or when the check fails.

A manual check immediately shows checking feedback, including when a startup
or periodic check is already running. It joins that check without sending a
duplicate request and makes its success or failure visible. Repeated clicks
restore the current updater surface, including during installation. Dismissing
a pending check suppresses its late result; a subsequent manual request still
receives feedback and a fresh check once the dismissed request finishes.

The tray action and macOS application-menu **Check for Updates…** share a
Rust-owned updater controller. Its macOS window uses AppKit controls; Windows
uses a Common Controls v6 Task Dialog. There is no updater webview or changelog.
The controller owns single-flight checks, dismissal, progress and installation.
Hidden, unloaded or suspended webviews cannot discard a manual request. The
startup check runs after five seconds, and periodic checks run every 24 hours
while the process is alive; these are best-effort discovery, not a reason to
suppress explicit user feedback.

Local desktop Settings requests this same window with a fixed
`POST /desktop-bootstrap/check-updates` action. The server requires an actual
loopback socket, its owner desktop session cookie, a same-origin `Origin`, and
`X-Yep-Anywhere: true`. The action travels back through the private child stdout
pipe; it accepts no endpoint, channel or install arguments. The native startup
frame and immutable dashboard metadata advertise support through optional
`nativeUpdates` and `nativeUpdateCheck` booleans. Older shells receive explicit
menu-bar/tray guidance; remote dashboards receive no native capability.

The bundled server reads its YA version from `desktop-runtime-manifest.json`,
reports `release-package`, and does not query the standalone update feed.
Missing or invalid manifests report `unknown` without probing an ambient Git
checkout. Ordinary server version and update checks retain their own behavior.

The v0 recovery path is a manual reinstall of a signed release. Automatic
downgrade and unattended background update installation are not claimed.

## Stable and nightly Latest channels

The same installed application offers **Stable** and **Latest (nightly)** in
its trusted **Check for Updates** window. Stable is the default; choosing
Latest is explicit. Channel selection is persisted in the desktop data root,
survives updates and relaunch, and never changes app identity, server data,
provider configuration, or paired-machine compatibility. Missing or invalid
channel settings fall back to Stable. The remote dashboard cannot select an
update endpoint or invoke native installation.

YA adopts the shared [desktop update channels v1 contract](https://github.com/kzahel/desktop-release-kit/blob/main/contract/desktop-update-channels-v1.md).
The native updater discovers `/desktop/channels` before an explicit channel
request. Stable alone may fall back to its existing endpoint when discovery
returns 404. Latest fails clearly when discovery is unavailable or does not
advertise Latest; it never silently uses Stable. Explicit version responses
must confirm `X-Update-Channel`, and updater candidates must confirm the same
`channel`. Requests without a channel retain Stable semantics.

Changing channel immediately discards the old update candidate. Responses
from earlier checks cannot become installable after a channel change or
window dismissal. Selection and installation cannot overlap. Only an explicit
**Update and restart** action downloads, verifies, installs, and relaunches.
Automatic checks retain the existing startup and daily schedule; they never
install. Manual checks expose failures and provide retry and channel selection.

Returning to Stable persists immediately and never downgrades. An installed
Latest newer than Stable reports that it is waiting for Stable to catch up.
A newer Stable is then offered normally. Immediate rollback is a manual signed
reinstall; users should back up desktop data first, because backward data
compatibility is not guaranteed. Reinstall does not imply deleting provider
sessions or desktop data.

### Nightly publication

Routine web/server changes receive full desktop packaging through the nightly
release rather than every pull request or main push. Desktop/platform code,
packaging inputs and dependency manifests retain immediate builds; release
tags and manual builds remain available. See
[Native app CI cadence](../docs/development/testing.md#native-app-ci-cadence)
for the trigger and release-verification policy.

Nightly Desktop runs at 02:37 UTC, subject to GitHub scheduling delays. A manual
run is available; its explicit force option permits rebuilding unchanged
verified source for recovery or upgrade QA. Scheduled runs skip when no
packaged desktop inputs differ from the last successfully published Latest.
Client, server, shared, desktop, bundled helper and build/dependency changes
qualify; documentation, marketing and test-only changes do not.

The selector reads the workflow run inventory and filters `main` push runs
locally, avoiding GitHub's capped filtered-search results. It chooses the
newest eligible `main` commit whose general CI run passed and pins that exact SHA throughout the existing desktop packaging
workflow. Failed or pending newer commits are not packaged merely because they
are branch HEAD. A missing verified candidate fails rather than publishing
unverified source. Source history must advance from the published Latest:
if CI eligibility falls back to an older ancestor, the nightly skips and waits
for newer verified source. Force may rebuild equal or newer verified source,
but cannot publish older code under a higher nightly version. Divergent release
history fails for review. Signing and native checks cover Apple Silicon macOS, Intel
macOS and Windows x64/ARM64-compatible NSIS. Linux continues through server/web.

For source Stable `M.m.p`, nightly versions are `M.(m+1).S`, where
`S = Nightly Desktop run number * 100 + attempt`. Attempts are 1–99; major and
minor are at most 255 and S at most 65535. Exhaustion fails before packaging
and requires a fresh workflow sequence/release train. For example,
`0.2.0 < 0.3.101 < 0.3.201 < 0.4.0`. A subsequent deliberate Stable release
must use a higher numeric version to catch up. CI applies the version to the
package, Tauri config, Cargo manifest/lock, and bundled runtime manifest without
committing daily version bumps; the source SHA remains a separate build ID.

Nightlies use immutable `desktop-latest-v<version>` GitHub prereleases; Stable
keeps `desktop-v<version>` releases and its existing route/key. Publication is
serialized without cancelling an active signer. Each matrix leg uploads into a
private draft, with serialized metadata writers. Finalization requires both
macOS installers, the Windows installer, all updater targets, matching
signatures cryptographically verified against YA's updater key, and URLs scoped
to that exact release. Only then does the draft become public. Incomplete runs
leave the previous successful build available on every platform; published
releases are never overwritten. GitHub prereleases do not replace its Stable
“latest release” link. Each release page identifies its version, source commit
and platform downloads; workflow state distinguishes pending/failed publication.

## Compatibility Corpus

The bootstrap migration was reviewed on 2026-07-30 against the core 60-day
support corpus:

- server `v0.5.0`, `v0.5.1`, `v0.5.2`, `v0.6.0`, `v0.6.1`, `v0.6.2`, and
  `v0.7.0`; and
- desktop `desktop-v0.0.1` through `desktop-v0.0.5`.

Every release in the corpus uses the legacy desktop token header/query
contract. Bootstrap v1 is a private native-supervisor/server protocol and does
not broaden an existing `/api/version` capability or raise the hosted remote
compatibility level.

Old shells retain the legacy server fallback for this support window. New
shells require bootstrap v1 and fail closed with an incompatible-runtime
diagnostic when it is absent.

## Deferred

- Installing, updating, or authenticating provider software.
- Silent background update installation.
- Automatic downgrade.
- General Linux distribution polish.
- Replacing the server with an in-process Rust implementation.
- Moving the bundled dashboard to a native invoke/Channel transport and
  disabling loopback HTTP when browser/mobile/remote access is off.
