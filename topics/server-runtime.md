# Server runtime and remote upgrade guidance

Topic: node-22-builtin-sqlite

## Runtime contract

**Security baseline (2026-10-21):** deploy Node 22.23.4, 24.22.1 or
26.12.1, or a newer patched release on a maintained line. Node's
[October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
fixes Brotli decoder remote code execution and DNS/TLS validation issues.
Prefer 24.22.1 for existing Node 24 installations. The functional engine
floor below is not a security endorsement of older runtimes. Upgrade the
runtime used by every service and restart the wrapper, provider host/workers
and relay; a backend-only reload deliberately retains provider processes.

New standalone server releases require Node.js `^22.16 || ^23.11 || >=24.10`,
or Bun `>=1.3.14`. Recommend a maintained Node LTS for new installations.
Prerelease runtimes are not included in these ranges. Root and server engines,
the generated npm manifest, and the dependency-free shared runtime check agree;
boundary tests enforce their alignment.

The CLI and direct server index reject unsupported runtimes before importing
application dependencies, opening storage, launching provider processes, or
binding listeners. Rejection prints the observed runtime, accepted range and
official runtime upgrade link, then exits nonzero. Help/version use the same
preflight. Bun identity wins over its Node compatibility version.
On supported runtimes, CLI help and version exit before application dependency
loading or environment migration. They work in the assembled npm distribution
before its runtime dependencies are installed and do not create a data directory.

Node uses `node:sqlite`; Bun uses `bun:sqlite`. The core adds no native SQLite
package, installer, compiler requirement or sidecar. The Node experimental
SQLite warning remains visible: it is an accepted upstream runtime diagnostic,
not a reason to suppress warnings globally. Runtime eligibility does not imply
that SQLite successfully opened. SQLite is required: a server that cannot open
it does not start, under the [storage startup policy](required-sqlite.md#startup-policy).
Feature enablement remains separate.

Desktop uses its exact hash-pinned private Bun from `runtime-versions.json`.
Updating Node or a user-installed Bun does not update Desktop's runtime.
Standalone Bun execution uses `bunx --bun yepanywhere`: without `--bun`, Bun
respects the CLI's Node shebang. Platform verification and exclusions are
recorded below. Managed runners retain their separately tested Node 20.12
execution-target contract; relay and push broker retain their own database
ownership. Android JavaScript CI uses the root workspace floor; Android native
runtime requirements and provider execution targets do not change.

Relay and push broker use the runtime's built-in SQLite through
`@yep-anywhere/shared/sqlite`, as the core does. They briefly used
`better-sqlite3` 13's Node-API addon, after its older V8-bound addon aborted
during statement garbage collection in the Node 24 browser integration
harness; the builtin removes that class of failure along with the native build
itself. Both services retain their existing database ownership and schemas,
and now require the same Node floor as the core because they depend on
`node:sqlite`.

### Cross-platform file persistence

Settings, Source Review state/captures/submission manifests, and project-storage
transition journals flush their written file contents before atomic publication.
Their directory-metadata flush uses the same platform fallback as public-share
storage: only Windows `EISDIR`, `EINVAL`, and `EPERM` from opening or syncing the
directory are tolerated. File-write, file-sync, rename/link, close, and other
directory failures remain errors. Linux and macOS directory failures propagate.
Windows saves therefore succeed without claiming Unix directory-fsync durability.

If a genuine settings error occurs after file replacement, YA adopts the saved
settings, notifies its listeners, and the settings route completes runtime
callbacks and any storage transition before returning an explicit durability
error. Later partial updates retain those committed values. A failure before
replacement leaves the previous settings active. Startup migration failures
after replacement abort initialization instead of silently loading defaults.

The `persistence-native` CI job exercises settings, review persistence and storage
transitions on Linux, macOS and Windows. Fault-injection tests separately enforce
the narrow directory fallback and the before/after-replacement behavior.

### Opened-file response lifecycle

Artifact and mutable-file byte responses retain the descriptor that passed
file authorization. They read at most 64 KiB per pull with one buffered chunk
of read-ahead, and close the descriptor on the selected range's EOF, error or cancellation.
Small unread responses close their descriptor while retaining buffered bytes. Cancelling
a pending filesystem read waits for descriptor cleanup; late completion cannot
enqueue into a cancelled response. Truncation below the declared response length
fails the body rather than returning a successful short response. This avoids
depending on Node's Readable.toWeb event/cancellation ordering for file bodies;
HTTP range and conditional-response contracts retain their existing meanings.

## Older-server compatibility

The engine floor changes immediately for new server releases. There is no
Node-20 warning-release prerequisite or delayed npm release. Existing servers
remain usable with the hosted frontend, including servers running Node 20.
No frontend minimum version, protocol level or capability meaning changes.

`GET /api/version` adds optional `serverRuntime: { kind, version }`, where
`kind` is `node`, `bun` or `unknown` and `version` is a string or null. It
reports process identity without loading SQLite or writing storage. It survives
legacy and negotiated version snapshots. An absent field means unknown,
never obsolete; `sqlite.state` remains independent initialization evidence.

The approved core corpus on 2026-09-08 is v0.8.1, v0.8.0, v0.7.0, v0.6.2 and
v0.6.1: the latest two stable releases and every stable release within 60 days.
All expose the version route and lack runtime metadata. Older clients ignore
the additive field; new clients make no additional request to older servers.

After connection/authentication, hosted direct and relay clients and local
clients show a nonblocking runtime notice. Settings -> About also exposes it.
Known obsolete Node/Bun gets matching upgrade guidance and the observed
version. Absent/unknown metadata gets check-before-updating guidance, even when
update checking is offline. Supported runtimes get no runtime notice. Higher
severity security/protocol notices retain priority; login/offline/reconnect
screens do not gain a runtime overlay. Snoozes use the existing browser-local
store, scoped to source, runtime/version and requirement epoch.

Because the advisory returns until the runtime itself changes, it offers Remind
me later and no Dismiss, and its floating card sits below the navigation header
rather than over it. Each notice states those two presentation rules and its
sort rank among notices of equal severity; no renderer recognizes a notice by
its id.

The notice is deliberately default-visible, authorized by the Maintainer on
2026-09-08 to let remote operators arrange an SSH/agent-assisted runtime
upgrade while keeping normal access. It changes no provider behavior, submitted
text, update command, or capability check. Existing terminal update instructions
remain available; an unsupported runtime may fail clearly when YA is restarted.

This is one fixed runtime requirement, not a release metadata service. Backend
cache migrations can preserve APIs without frontend gates. New SQLite-backed
product features advertise their exact feature capability and storage readiness.
A future frontend cutoff needs a separate approved compatibility plan, the
core support-horizon review, and at least two weeks' notice before enforcement.
No elapsed timer or this server cutover authorizes removal of old fallbacks or
reuse of permanent capability IDs.

## Upgrading a remote server

On the server host, start with `node --version` (or `bun --version` for a
Bun-launched server). Upgrade to a maintained Node LTS satisfying the range
above, using your existing installation/version manager or the
[official Node installer](https://nodejs.org/en/download). For Bun, use its
[official upgrade instructions](https://bun.sh/docs/installation).

Restart the existing service and check the runtime it actually uses. A shell's
new Node may differ from systemd, launchd, a Windows service or another account's
PATH; adjust the existing service launcher as needed. Newer YA servers show the
observed runtime in `/api/version`; older servers may require inspecting the
service executable. Version-manager upgrades may also require reinstalling a
global YA package into the new runtime's global prefix.

Then update YA using your existing npm/source installation method and restart.
Preserve the same user, `YEP_DATA_DIR`/profile and provider configuration so
sessions, authentication and remote pairing continue to use the existing state.
Desktop users update the application, including its bundled private runtime.

If a YA update exits with the runtime error, upgrading the runtime is the
recovery path; the rejected launch has not opened or migrated storage. v0.8.1
was the last stable release before this change, but reinstalling an older npm
artifact is not a guaranteed rollback: its transitive dependency ranges resolve
afresh. Do not delete the data directory or reset remote pairing to fix a
runtime version mismatch.

## Verification

npm publication additionally requires the
[installed-package acceptance gate](native-provider-testing.md#installed-npm-package-acceptance)
on Linux. It launches the packed CLI outside the checkout with an isolated
home and normal provider-host discovery, then verifies real Claude/Codex
API/tool/stream/history paths against local scripted model APIs. Publishing
uses the same accepted tarball and checks its version and SHA-256; a successful
mock-SDK startup alone cannot qualify a release. The
[release guide](../docs/development/releasing.md#releasing-to-npm) owns commands
and retained evidence.

The Server Runtime And SQLite workflow tests patched Node 22.23.4, 24.22.1
and 26.12.1 on Linux, macOS and Windows. It checks the generated engine
range, CLI/direct-entry rejection, clean npm installation, storage contracts,
and Node/Bun file interoperability. Bun uses Desktop's exact 1.3.14 pin. Fresh-package checks exercise the forced
Bun CLI, HTTP/WebSocket ping, a real child shell/agent CLI and the compiled
math/sanitizer renderer.
Windows smoke teardown terminates the owned launcher process tree (including
the server below `bunx`) asynchronously (avoiding Bun's Windows synchronous
spawn timeout) and waits for its stdio to close before deleting the
fixture. Fixture deletion uses an explicit asynchronous retry loop on both
Node and Bun: Bun 1.3.14 ignores `rm`'s retry options for recursive removal.
The default 2.4-second cleanup deadline is about 3.5 times the failed hosted
Node deletion window (0.69 seconds). Packaged startup uses 9.6 seconds after
[run 38762851482](https://github.com/kzahel/yepanywhere/actions/runs/38762851482)
passed startup but exhausted the 2.4-second post-close removal window. This is
four times that observed lower bound; ordinary removals return immediately,
and persistent locks still fail with the captured server output. The matrix
runs real Windows child-cwd regressions under both runtimes, covering a lock
released after three seconds and a lock held past the default cleanup deadline.
The startup Codex-version advisory respects `ENABLED_PROVIDERS`: it runs for
`codex`, `codex-oss`, or the default all-provider configuration. Excluding that
family avoids unrelated installation/ACL work; checks for actual Codex use remain
unchanged. The Claude-only packaged smoke asserts no Codex coordination state
is created.
Optional ADB PATH discovery uses an asynchronous, shell-free lookup with a
five-second deadline before falling back to SDK locations. A missing or stalled
Android tool lookup must not block the server event loop.
Startup readiness requires a responsive `/api/version` within the same startup
deadline as port publication; transient connection/time-out failures retry that
read-only probe, while any HTTP response still undergoes the full assertions.
The npm bundle rewrites shared-package module specifiers to relative bundled
files, preserving complete nested subpaths and dotted filenames before adding
the compiled `.js` suffix. Static imports, re-exports, dynamic imports and
side-effect imports use the same rule. Workspace resolution alone cannot verify
this boundary: an isolated module-loading regression and clean npm installation
exercise the rewritten imports without workspace links.

Full packaged startup is exercised on Linux, macOS and Windows. The
Windows matrix has a 30-minute job budget for the restored clean-install and
locked-dependency Node/Bun launches; individual startup deadlines remain bounded.
The [restored runtime matrix](https://github.com/kzahel/yepanywhere/actions/runs/34485119811)
passed all twelve OS/Node combinations on 2026-09-10, including every Windows
Node/Bun startup state with both clean npm and locked dependencies. Windows
Desktop manual verification is a separate Maintainer follow-up; this runtime
validation does not claim it. Public standalone Bun platform claims remain limited to verified
artifact behavior; the matrix does not promise every provider on every OS.

Local cutover evidence (macOS arm64, 2026-09-08): clean npm startup passed on
Node 22.16.0, 23.11.0, 24.10.0 and 24.20.0. Pinned Bun passed CLI startup with
Node absent from PATH, child shell/CLI, renderer and shared-file SQLite checks.
The freshly assembled macOS Desktop resource passed bootstrap/authentication
and child CLI smoke. Other OS runtime gates are checked in for CI; local work
does not claim their execution or Windows Desktop manual validation.

Bun 1.3.14's Vitest VM loader currently fails shared-source collection with
`undefined is not an object (evaluating 'z.string')`; the same compiled module
graph works in the packaged server. The
[test-harness gap](../gaps/bun-vitest-shared-zod-loader.md) retains this
limitation. Packaged scripts use Bun's real ESM loader rather than presenting
Node-run Vitest results as Bun runtime evidence.

Lint and i18n checks are warning-free. The console scan stays within its
unchanged budget; workspace package-manager/deployment diagnostics are recorded
in the [tooling warning gap](../gaps/runtime-cutover-tooling-warnings.md).
