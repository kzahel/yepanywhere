# Provider CLI installations

Topic: provider-cli-installations

YA owns installation selection and verification on the target server. Provider
adapters supply package discovery, ranking, fingerprints and launch/probe recipes;
the shared service owns cached verification and diagnostics. This extends the
[provider launch descriptor](provider-authoring.md#cli-discovery-and-launch-contract)
and [installation lifecycle](provider-installation-updates.md), without imposing
a shared provider protocol or adding provider installation/authentication flows.

## Selection and storage

Settings → Providers offers Auto, detected installations and a custom absolute
path for Codex and supported Antigravity hosts. The selected server profile stores
`cliInstallations`, keyed by installation family, in `server-settings.json` under
its YA data directory. Codex and Codex OSS share one `codex` selection.

An existing environment/embedding override takes precedence over the saved
selection: `YEP_DESKTOP_CODEX_CLI_PATH` for Codex and `ANTIGRAVITY_ACP_PATH` for
Antigravity. Settings shows these as managed and refuses selection changes.
Saving Auto removes the saved path; it does not remove an environment override.
Installation operations require the existing superuser principal, including
reading full server paths. No new principal or grant category is introduced.

An explicit path stays selected when removed, non-executable or broken. YA shows
its failure and does not switch installations. Users can fix the path, select
another installation or choose Auto. Running processes keep their launched
executable; subsequent session launches and resumes use the current selection.
Server-owned provider workers receive the profile and selection in their launch
snapshot. An npm shim may resolve to its own package's native executable, with
the package helpers preserved; it never authorizes choosing a different package.

## Inventory and execution verification

Startup, status, version, authentication and catalog reads remain lightweight:
they do not request model inference or run shell tools. Inventory shows source,
version, full path, selection and execution verification separately. **Rescan**
refreshes discovery, including the npm-prefix lookup, without invalidating an
unchanged successful execution check. Saving a selection immediately verifies
that choice (reusing a valid cached result); a failed check keeps the saved choice
and exposes its error. **Test execution** explicitly retests.

Before a new interactive Codex runtime starts, its installation passes the
shared execution gate. Auto tests ranked candidates until one passes; rejection
reasons remain visible. A version response or app-server handshake alone is
insufficient. Explicit selection tests only the selected installation.

The Codex adapter uses the production app-server client and process-tree
shutdown implementation. In private temporary home/config/workspace directories,
a scripted loopback Responses endpoint requests `echo` of a fresh random marker.
Codex 0.160+ executes it through code mode and its real host, polling a returned
command session until exit and retaining its output; older versions use
the ordinary command tool. Verification requires marker output and a zero exit
in a tool-result message, never merely in the submitted command or model text.
The shared Responses envelope is also used by the native provider harness.

Only shell/process necessities enter the probe environment. Provider/account,
YA session and shell startup credentials/configuration are not inherited.
The probe uses a synthetic key and a local model endpoint, with external proxy
requests denied. This is configuration isolation, not an OS network sandbox.
It neither spends paid inference nor establishes account authentication, remote
model access, model quality, or every project/sandbox/permission-mode behavior.
Its isolated execution policy is `danger-full-access` with approvals `never`.

Each execution attempt has a 20-second abort bound plus joined shutdown and
temporary-file cleanup. Auto also stops admitting candidates after a 60-second
selection window. Timeout/failure paths reap owned processes; Windows temporary
file deletion uses explicit bounded retries for delayed handle release,
including under Desktop's bundled Bun. Persistent cleanup failures still
reject verification.

## Verification cache

Disposable records live in `cli-verification/results.json` under the YA data
directory, separately from the saved selection. At most 64 records retain a
fingerprint, original path, timestamp, success/failure and bounded error text.
Writes replace the file atomically. Corrupt JSON or an absent cache triggers
verification again without resetting the selection.

Keys include the adapter recipe revision, OS/architecture, relevant shell/PATH
configuration, installation-coordinator generation, launch descriptor, link
targets and metadata for the executable/package/helpers. Codex includes both
adjacent and packaged `codex-resources` code-mode hosts. Identity is rechecked
before a new launch; replacement or disappearance invalidates the old result.
Successful checks have no periodic TTL. Failures are retained for 30 seconds;
explicit testing bypasses that retention. Concurrent checks for one fingerprint
within a server/worker process join one promise. Separate processes can perform
the same harmless check; their atomic cache writes may discard another cache
entry but cannot change the saved selection or authorize an unverified launch.

Probes hold the existing installation-family read lease; live Codex runtimes hold
their runtime lease across verification and execution, so YA-owned updates cannot
replace the installation between verification and startup. An fnm installation
outside the current npm prefix remains manual unless its package-manager
ownership can be proved. External package managers remain outside YA's
coordination boundary; changes during a probe fail
verification and permit retry. File metadata checks are reliability checks,
not protection against a hostile same-account filesystem writer.

## Provider-specific discovery

Codex retains platform PATH/npm/common-location discovery and adds fnm's
configured default without shell initialization. It respects `FNM_DIR`; otherwise
it follows fnm's modern data directory, legacy `~/.fnm`, and macOS legacy Apple
data-directory order. Only that root's `aliases/default` is examined, including
the `installation` layout. Unused Node installations are not enumerated. Windows
uses the roaming app-data default; macOS/Linux use XDG data storage. See the
[fnm directory implementation](https://github.com/Schniz/fnm/blob/master/src/directories.rs)
and its [Windows directory strategy](https://docs.rs/etcetera/latest/etcetera/base_strategy/struct.Windows.html),
inspected 2026-11-15. Internal `.codex/.sandbox-bin` fallbacks rank below other
installations; app-bundled prereleases rank below deliberate versioned installs.
Version preferences apply after execution usability at launch.

Antigravity candidates are `agy` executables launched as `agy acp` from their
resolved symlink target. A candidate whose `agy --version` is below the
[supported floor](antigravity.md#supported-runtime) carries an error naming
that version, the floor and the update path. The version query runs without
YA's own credentials and is killed after three seconds. Antigravity launches
do not pass the execution gate, so Auto marks the candidate a launch uses: the
first runnable `agy` on `PATH`, whatever its version. Selection changes, removed files and changed symlink targets are observed on
resolution. Its offline execution recipe is currently **unsupported**, displayed
separately from an execution failure. The selector does not expand Windows
support or claim new Linux/native-model qualification for Antigravity.

## Client compatibility and input

The additive optional `cli-installations` capability gates all installation
controls and routes. Without it, clients retain existing provider settings and
send no installation requests or writes. The 2026-11-15 optional stable corpus
is v0.11.0 and v0.10.2 (latest two; no newer stable release in the prior 14 days);
both lack this capability. No existing capability meaning is broadened.

Custom paths are local drafts saved explicitly. Rescan, verification results
and provider-status refreshes do not replace the input or publish its partial
value. Every sequential character, focus and input identity must survive those
updates with the existing 100 ms controlled-host acknowledgement target.

## Qualification

Native regressions run the pinned Codex 0.169.0 against the local model recipe,
including a versioned copied executable missing its host, automatic fallback,
persisted verification and aborting a hung app-server plus its child. Service
and HTTP cases cover helper replacement, concurrent checks, explicit failures,
managed overrides and server-side persistence. Browser coverage exercises 24
candidate rows and sequential path typing on desktop and phone while probe
results arrive, plus absent-capability requests.

`test/native-provider/cli-installation-smoke.ts` can be bundled for a clean guest.
It sets up a desktop-like PATH, a default fnm alias and an incomplete fallback,
then requires automatic discovery and real command output without an executable
override. The macOS arm64 host, Windows ARM64 testbed and Linux arm64 testbed pass
that boundary. This is native command-driven qualification; GUI-launched packaged
YA and the full installer/CPU-architecture matrix remain separate release checks.
