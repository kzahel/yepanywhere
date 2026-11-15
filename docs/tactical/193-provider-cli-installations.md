# Provider CLI installation selection and execution verification

Status: implemented and verified, 2026-11-15. Packaged GUI release qualification
is retained separately.

Motivation: Windows selected a versioned Codex executable missing its code-mode
host. The original gap is fixed; [packaged GUI qualification](../../gaps/provider-cli-packaged-launch-qualification.md)
remains a separate release boundary.
A version response does not prove that a harness can execute tools. The same
discovery boundary is used on macOS and Linux. Implement the shared lifecycle
with Codex first; validate reuse against both Antigravity `agy acp` and standalone
ACP launch descriptors without expanding its supported platforms.

## Selected behavior

- Store installation selections by family in the target server profile's
  `server-settings.json`. Environment overrides remain authoritative and appear
  as managed configuration. Auto is the default. Explicit paths fail visibly
  without falling back when removed or broken.
- Separate inventory/version checks from execution verification. Startup and
  status reads do not run shell tools. Before a new Codex runtime launches, use
  cached execution verification or run one bounded probe against a local scripted
  model endpoint, with private home/config/workspace and synthetic credentials.
  Verify a unique shell output marker and successful exit through the production
  app-server launch path. This does not verify account or real-model access.
- Cache successful verification on disk against the launch descriptor and
  installation fingerprint, including helpers, symlink targets and relevant
  environment. Check identity before new launches. Deduplicate concurrent probes;
  retain failures briefly, and allow explicit retesting. No periodic inference.
- Auto rejects candidates that fail verification and tries the next ranked
  candidate. Existing runtimes retain their executable when selection changes.
- Reuse the existing installation coordinator for probes and update convergence.
  Keep package discovery, ranking, launch arguments and probe recipes in provider
  adapters. Unsupported offline verification is distinct from failure.

## Implementation sequence

### 1 — Shared installation descriptors and verification lifecycle

Add a small adapter-driven service for inventory, selection, fingerprints,
bounded verification/cache ownership and diagnostics. Exercise both Antigravity
launch forms as a second consumer of the descriptor boundary. Keep provider
protocols in their existing implementations rather than designing a new one.

### 2 — Codex discovery and offline execution

Discover fnm's configured default without sourcing shell profiles or choosing
unused Node versions. Preserve package layouts. Resolve one descriptor for
production and probing. Reuse the native harness's applicable Responses-wire
recipe and existing production app-server client/cleanup. Keep lightweight
catalog reads separate from launch-time verification.

### 3 — Server settings and installation operations

Persist family selections; expose inventory, selection, rescan and test actions
through administrator-only routes. Carry effective selection into provider-host
workers and invalidate dependent catalog facts when selection changes. Bound
requests and retain actionable failures.

### 4 — Provider installation settings controls

Use shared fields/buttons for Auto, detected installations, a custom path,
managed overrides, source/version/full path/verification status, Rescan and
Test execution. Draft typing stays local and independent of async results.
Use an additive capability for these routes and hide the controls without it;
older servers receive no unsupported reads or writes. Preserve the current
provider settings and session behavior on those servers. The compatibility
corpus is the latest two stable releases plus releases in the prior 14 days;
record the inspected versions and capability evidence before landing.

### 5 — Native and browser regression evidence

Retain integration coverage for version-success/tool-failure, automatic
fallback, missing explicit paths, helper/replacement invalidation, persistent
cache, concurrent probes and timeout cleanup. Run actual Codex with a local
model endpoint. Verify settings typing/focus during scans/probes, and capture
desktop/phone results through the artifact facility.

### 6 — Machine qualification, contracts and commit

Use Machine Control's configured testbeds and owned claims, preferring guest
commands. Qualify Windows's desktop-like PATH/fnm/fallback case without an
executable override, plus available macOS/Linux environments. Distinguish native
platform evidence from simulated discovery cases and record any unavailable
qualification. Update owning topic contracts and roadmap status. Close the gap
only when its acceptance evidence is satisfied. Run lint, format verification,
typecheck, full workspace tests and focused browser checks, then commit the
authorized change with the required model trailer.

## Implementation and evidence

- Shared `CliInstallationService` and provider adapters own selection, bounded
  per-process single-flight verification and disposable profile cache records.
  The existing installation coordinator owns update/read/runtime leases. Cache
  records include both adjacent and packaged code-mode host resources.
- Codex uses its real app-server/client and code-mode shell tool with a local
  scripted Responses endpoint. The test harness shares the response envelope.
  A native copied binary answers `--version` and fails execution without its
  host; Auto accepts the complete runtime. A real hung peer and child are reaped
  on abort. The first probe accidentally used the ordinary shell tool; the
  missing-host regression exposed that bypass and now requires code mode for
  the reproduced 0.160+ installation family.
- Default fnm discovery follows its upstream root/alias rules, including Windows
  roaming app data. Command-driven smoke passes with fnm absent from PATH and
  no executable override on macOS arm64, Windows ARM64 and Linux arm64, Codex
  0.169.0. Windows also covers paths containing spaces, explicit cmd launch and
  bounded retry of delayed SQLite handle release. Both VMs were restored to
  powered-off state and their task claims released; the Mac VM was left untouched.
- Both Antigravity forms use one symlink-aware descriptor and shared profile
  selection. Offline execution remains explicitly unsupported; its platform and
  authentication policy is unchanged.
- The optional stable corpus is v0.11.0 and v0.10.2; both checked-in tag capability
  ledgers lack the new bit. New clients make no installation request without
  `cli-installations`. No existing contract is broadened.
- Focused provider checks pass 201 cases (two existing skips). Browser checks
  pass the new CLI case and six existing provider layout cases; initial measured
  path acknowledgement maxima are 15.0 ms desktop and 14.9 ms phone. The 24-row
  scenario retains every character, focus and input node while results arrive.
  Final source-scoped API controls record 15.5/16.4 ms maxima, with stable
  post-save desktop/phone captures reviewed after pending actions settle.
- Full workspace tests pass, including 7,561 server cases (97 existing skips).
  An existing Codex OSS native-identity test reached its 15-second guard during
  its two app/profile cycles; complete controls took 13.56–14.71 seconds. Its
  guard is now 45 seconds (3× the observed timeout lower bound), with every
  native identity, persistence, failure and cleanup assertion preserved.
- Final behavior is owned by [provider CLI installations](../../topics/provider-cli-installations.md),
  with the Windows/provider/update topic links updated. Screenshots are captured
  and presented through the repository artifact facility; packaged GUI launch
  qualification is retained in the narrowed gap rather than claimed from shell
  commands. The complete browser suite remains a CI gate; local browser scope
  is limited to the affected provider settings and layout boundary.

The final review also records the mandatory optional-bit allocation, verifies
that the capability audit has zero errors/warnings, and scopes installation API
calls to the selected server runtime. An existing jsdom navigation diagnostic in
the broad client unit suite remains recorded in the existing client-warning gap;
the new browser case emits none. The completed plan remains for the requested
implementation record; durable behavior lives in the owning topic.

Selection saves immediately verify the newly selected installation using the
same cached gate as session startup; failed verification preserves the saved
explicit path and returns its actionable error. The HTTP regression checks that
inventory/rescan do not execute tools, saving a valid choice does, and a removed
saved executable remains selected. This preserves the agreed probe-on-selection
behavior alongside explicit retesting and launch-time invalidation.

The probe retains actual bounded tool errors (including the missing-host reason),
reports watchdog timeouts as timeouts, and polls asynchronous command sessions
before accepting a zero exit. The final native/service/HTTP check passes ten
cases, including these execution and selection boundaries.
