# Provider Installation Updates

> A provider installation that YA mutates is a shared runtime dependency, not
> an isolated settings command. Detection, catalogs, launches, live runtimes,
> update execution, and every cache of those facts must observe one ordered
> installation lifecycle.

Topic: provider-installation-updates

Related topics:

- [provider-refresh](provider-refresh.md) — maintainer compatibility audits
  after an upstream release; this is separate from mutating a user's install;
- [provider-authoring](provider-authoring.md) — provider discovery and launch
  contracts;
- [windows-codex-cli-detection](windows-codex-cli-detection.md) — Codex
  candidate selection across PATH and desktop/npm installs;
- [reload-safe-provider-runtimes](reload-safe-provider-runtimes.md) and
  [provider-host-api](provider-host-api.md) — live worker ownership and launch
  snapshots; and
- [hard-development-rules](hard-development-rules.md) and
  [vanilla-defaults](vanilla-defaults.md) — explicit update choices remain
  authoritative and no new provider is silently enrolled in auto-update.

## Scope And Current Inventory

This topic covers a command run by YA that can install, update, replace, or
remove a provider executable or its package files. Merely checking a release
feed or reporting a copy-pasteable command is not an installation mutation.

As of 2026-11-09, Codex is the only provider installation YA can mutate. With
`codexUpdatePolicy: "auto"`, or when an administrator selects **Update now**,
the server runs the updater that owns the detected executable: `npm install -g
@openai/codex@latest` for an npm-global install, or that executable's own
`codex update` for a standalone install, whose real path lies under
`<CODEX_HOME>/packages/standalone/releases/` (the CLI's own detection rule).
Other current mechanisms are separate:

| Mechanism | Mutates a provider install? | Coordination owner |
|---|---|---|
| Codex npm update | Yes | This topic; first implementation target |
| Codex standalone `codex update` | Yes | This topic; same `codex-cli` family |
| Codex Homebrew/cargo hint | No, YA only displays a command | External mutation recovery below |
| Codex bundled in a desktop app | No, it updates with ChatGPT/Codex | External mutation recovery below |
| Claude SDK dependency refresh | No runtime package-manager command | YA release/provider-refresh process |
| Gemini, Grok, OpenCode, Pi detection | No current updater | Must register here before gaining one |
| Tauri desktop updater | No, it updates the YA shell | `desktop-v0.md` |
| Yep server update notices | No provider mutation | Version/remote compatibility topics |

Provider rows are not installation identities. `codex` and `codex-oss` share
one `codex` CLI installation. If YA later updates Gemini, `gemini` and
`gemini-acp` likewise share one Gemini CLI installation. Coordination is keyed
by a stable **installation family** such as `codex-cli`, with an explicit set
of affected provider names and one resolved package/install identity. A
versioned realpath is not a stable key because the updater may replace it.

## Installation Lifecycle Contract

### One ordered owner

Every YA-owned mutation is admitted by one installation coordinator before a
package-manager child starts. Per installation family, the coordinator owns a
monotonic generation and the state machine:

```text
idle -> checking -> waiting-for-safe -> installing -> verifying
                                      -> succeeded | failed
```

`checking` is read-only and does not block provider use. `installing` begins
before the updater can rename or remove a public command path. Concurrent
automatic and manual requests join one operation; they never start two package
managers against the same installation. A later result cannot overwrite a
newer generation.

The coordination boundary spans all YA processes and profiles owned by the
same user, not only one Hono generation. A stable per-user lock identity and
verified stale-owner cleanup prevent two servers from updating one global
package concurrently. Reader/runtime leases and writer intent must close the
race where a new provider launch begins after the updater checked for readers
but before it replaces the command. Project directories and Git metadata are
never used for these locks.

The short admission gate is itself an identity-bearing renewable lease. Its
owner record carries PID and process-start generation, and a heartbeat remains
active for the entire critical section, including stale lease probes. Another
process may recover the gate only after both the heartbeat deadline and owner-
generation check prove the recorded process is gone. Windows obtains that
generation from the process creation time and refuses to create new
coordination records when it cannot obtain one; PID liveness alone is never
sufficient there because Windows can reuse a PID.

Every abandoned gate shape must be recoverable without operator intervention.
A claim exists briefly before its owner record does, and releasing the record
is not the same act as releasing the claim, so a process death or a failed
write can leave a claim carrying no owner identity. Such a claim is recovered
on its own age once it exceeds the heartbeat deadline, because no record
exists to probe and a live claimant crosses that window in adjacent
statements. Releasing the gate always drops the claim, including when the
owner record has already vanished. A gate that no live process holds must
never require deleting app-data by hand: an unrecoverable claim wedges every
provider read, launch, and update for every YA process owned by that user,
not only the update that created it. An admission timeout names the recorded
holder, or reports the missing owner record, rather than only the path.

An external package manager or provider-native self-updater cannot be required
to honor YA's lock. Detection therefore still needs typed transient failures,
bounded retry, and short negative retention, but YA must not pretend it can
serialize an unrelated terminal's `npm`, Homebrew, cargo, desktop-app, or
self-update operation.

### Provider reads and launches

All operations that need the installation join the same family boundary:

- command lookup and version probing;
- authentication and installed-state probes;
- dynamic model/command catalog subprocesses;
- new, resumed, helper, and auxiliary session launches; and
- provider-host workers that retain the launched runtime.

Short probes/catalog reads hold bounded reader leases. A live provider runtime
holds a runtime lease until its process and queued/provider-retained work have
actually ended. The provider host must report the same lease even when Hono is
replaced. The coordinator must not infer safety merely from the absence of an
in-Hono `Process`.

The first preparation of an installation-family directory in each coordinator
process sweeps abandoned reader and runtime lease records while holding that
family's admission gate. This bounds crash residue without putting a directory
scan and owner-liveness probes on every catalog read or session launch. A live
record remains authoritative through the same PID and process-start-generation
checks used before an update.

Automatic updates do not interrupt active, waiting-input, queued, or retained
provider runtimes. They remain `waiting-for-safe` and acquire writer intent
only when affected runtime leases have drained. The first slice also does not
force-terminate a runtime for a manual update: it returns or displays the
concrete blockers and permits retry/update-when-safe. A future explicit force
operation would require its own product and recovery contract.

Once mutation begins, a new launch must wait behind it or fail with an explicit
retryable `provider updating` result. It must never reach a temporarily missing
path and misreport `ENOENT`, `not installed`, or an authentication failure.
Warm status/catalog callers may retain a last-verified display row during the
bounded mutation; a cold or forced caller joins the verified completion. A
temporary YA-owned replacement window is never published as proof that the
provider was uninstalled.

### Verification defines success

A zero package-manager exit code is necessary but not sufficient. Before the
writer completes, YA resolves the same launch descriptor used by production,
executes its version/usability probe, and records the resulting path, version,
and installation fingerprint. Provider-specific verification may add a
bounded no-token catalog or protocol handshake when ordinary launchability
requires it.

Only a verified result is `succeeded`. If the updater exits successfully but
the production descriptor cannot launch, the operation is failed and the
provider is not advertised as healthy. A failure distinguishes:

- package-manager failure with the previous installation still usable;
- verification failure with a usable previous installation;
- installation unavailable after mutation; and
- coordinator/lock ownership lost or indeterminate.

The first two retain the last verified provider display fact but expose the
update failure. The unavailable case publishes a fresh unavailable result with
short retention. No stale `installed: true` row authorizes a launch after
verification proved the installation unusable.

## Catalog And Cache Convergence

One verified installation generation invalidates every server-side dependent
cache as one ordered transition:

- all affected provider-route rows (`codex` and `codex-oss` together);
- provider-owned model, command, version, auth, and launch-descriptor caches;
- update-checker installed version/path metadata; and
- model observations derived from the superseded catalog.

The server generation/fingerprint participates in the provider catalog source
key, so an accepted pre-update computation cannot publish after verification.
The post-update refresh uses the ordinary provider-route single-flight owner;
the updater does not create a second independent catalog cache.

The client that requested a manual update immediately forces the existing
provider refresh path and publishes the result to all mounted consumers for
that source. A catalog request that begins during an automatic mutation waits
for verification and therefore cannot cache a replacement-window negative.
A client that already holds a healthy pre-update catalog may retain it until
the existing TTL or a later refresh; it is stale display data, not launch
authority. Immediate automatic invalidation of every connected client would
require a new activity event or response field and remains an optional,
compatibility-gated optimization. A seven-day display snapshot is likewise
never treated as current launch authority.

Negative provider facts use a materially shorter retention than verified
successes. `not found`, lookup failure, probe timeout, empty output, and
nonzero exit are distinct diagnostic results; the provider boundary may map a
settled unusable result to `installed: false`, but it must not erase the reason
before logging and retry policy are chosen. A path that exists but cannot be
launched is not advertised as installed merely to hide a probe failure.

## Update Notices

A newer upstream release is not an incompatibility. YA gates
version-sensitive Codex behavior per feature and explains a missing feature
where it is used, so an available release is reported only passively:
Settings → Providers names the executable the server uses and what installed
it, shows installed → latest, and offers **Update now**, a command to copy, or
plain guidance for an app-bundled or unrecognized install.

- The server declares the oldest Codex release its integration works with
  (`CODEX_CLI_MINIMUM_SUPPORTED_VERSION`), or none. Only an installed CLI
  below that declared minimum opens a dialog, and only for a host
  administrator under the `notify` or `auto` policy. A client that receives
  no minimum from an older server never opens it.
- Dismissing the dialog is stored on the server per minimum version
  (`codexRequiredUpdateDismissed`), so it holds on every device and browser
  until a higher minimum is declared. A dismissal after a failed update is not
  stored; that incompatibility is still unresolved. `off` suppresses the
  dialog entirely; Settings keeps reporting the version either way.
- Updating from the dialog does not opt into automatic updates; its
  "update next versions too" choice starts unchecked.

## Configuration, Security, And Observability

- Existing `auto`, `notify`, and `off` choices remain authoritative. The
  default remains `notify`. `auto` applies to every installation the server
  can update itself (npm and standalone); the Settings control offers it only
  for such an installation. Adding an updater for another provider is a new
  configurable, default-off product decision; Codex's stored choice does not
  opt another provider's installation into mutation.
- Explicit provider paths remain authoritative through updates. An updater
  must prove that its package manager owns the configured install; otherwise it
  remains manual and does not drift to a different candidate.
- Package-manager execution uses an argument-vector launch descriptor rather
  than interpolating a discovered package name into a shell command. Package
  identity is allowlisted by the provider update adapter. A standalone update
  runs the detected executable with the single argument `update`, from the
  temporary directory so no project configuration reaches the updater.
- Locks, status records, and bounded raw output live in private user runtime or
  YA app-data storage. They contain no credentials, environment dumps, auth
  files, or project paths beyond the minimum resolved executable evidence.
- Structured logs record installation family, operation id, phase/duration,
  update reason, prior and verified versions, wait/blocker counts, command exit
  class, probe failure class, affected provider names, and cache generation.
  Logs do not wait until the final success line to reveal that a mutation is in
  progress.
- Shutdown/reload does not casually kill a package manager mid-replacement.
  The mutation owner and shared lock survive a replaceable Hono generation, or
  replacement startup observes the live owner and waits. Full shutdown has a
  bounded, explicit completion/recovery policy and never launches a competing
  updater while ownership is uncertain.

## Provider-Onboarding Rule

Before any provider gains an in-app install/update command, its change must:

1. declare the stable installation family and every provider alias/dependency
   affected by the mutation;
2. use the shared coordinator for checks, mutation, verification, launches,
   runtime leases, and cache generations;
3. define active-runtime and failure behavior for each supported platform and
   package manager;
4. preserve configured-path authority and a manual fallback;
5. add the race/failure/cross-process tests in the tactical plan; and
6. update this inventory and the provider's own topic.

Copying `CodexUpdateChecker` and changing the command is not a supported
provider-update architecture.

The Windows owner-generation probe reads process creation ticks directly through
`System.Diagnostics.Process`, avoiding `Get-Process` module auto-loading. Its
15-second cold-start deadline is bounded.

The probe reports a failed lookup the same way for every PID and on every
platform: it raises the underlying failure, and answers "no identity" only when
the platform replied without a usable one. Which of those two outcomes is
tolerable belongs to the caller, not the probe. For this process, where the
platform requires an identity, either outcome blocks admission, and the report
retains the probe's own error as the startup cause when there was one — the
running process is alive by definition, so a missing identity is a broken probe
rather than a dead PID. For a recorded owner's PID, an unavailable process
generation remains unknown, never proof of stale ownership.
