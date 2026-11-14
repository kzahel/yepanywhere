# macOS provider-host support

Status: completed for the approved Node source-checkout scope, 2026-09-12.
Native Mac ownership, assembled production-worker replay/callbacks, live Claude
and Codex reload/approval/resume, simultaneous active turns and approvals, and
terminal cleanup are verified. The previous `oauth_org_not_allowed` deferral
is closed. Linux, Apple Silicon Mac, Intel Mac and Windows fallback CI jobs
passed for the tested base commit. Both validation runs are recorded in
[macOS verification evidence](#macos-verification-evidence) below; the
supported-platform contract and the commands that reproduce them are in the
owning [runtime topic](../../topics/reload-safe-provider-runtimes.md#macos-source-runtime-boundary).

Topic: reload-safe-provider-runtimes

## Outcome and scope

Allow a macOS source-checkout development server to replace Hono and Vite while
existing Claude and Codex turns continue in their original provider workers.
Reuse the Linux host/worker architecture and its capability-based routing.
Preserve canonical YA session identity, the original provider connection,
pending callbacks, and ordered output across the replacement.

Start with the non-watch development wrapper under Node on this Mac. Extend
the same platform boundary to foreground `pnpm provider-host` and source-server
attach-or-start, with their distinct terminal ownership tested before declaring
those launch modes supported. Linux must retain its existing guarantees;
Windows remains on the ordinary in-Hono fallback. Bun, packaged npm servers,
and Desktop must have explicit support results rather than inheriting a claim
from a Node source-checkout test. Their enablement is a separate checkpoint.

The existing Safe Reload action and wrapper `SIGHUP` are the reload entry
points. This plan does not enable automatic restart on every file save or
promise continuity for `--watch`. It does not add a machine daemon, launchd
service, provider-native PID adoption, or automatic continuation prompts after
terminal shutdown. Those are different lifecycle products.

This is developer iteration work, not a reprioritization of the
[release roadmap](../roadmap/README.md).

## Existing contracts and adjacent work

Read [architecture](../../ARCHITECTURE.md),
[reload-safe runtimes](../../topics/reload-safe-provider-runtimes.md),
[provider host API](../../topics/provider-host-api.md), and
[architecture mandates](../../topics/architecture-mandates.md) before changes.
The owning topics describe current Linux behavior; update their platform and
observable-behavior contracts as implementation lands, without prematurely
relabeling Linux evidence as macOS evidence.

The task/gap search found no existing macOS host-port plan. Relevant work:

- [Captured provider fixtures](127-captured-provider-fixtures.md) proposes
  independent native captures and offline replay. Reuse its capture provenance
  and replay seams; transcript playback alone cannot prove process continuity.
- [CI platform coverage](../../gaps/ci-platform-coverage-holes.md) records that
  ordinary unit/browser suites run on Linux. A green existing CI run does not
  establish Mac host lifecycle coverage. Add a focused native job for this work;
  do not silently expand the entire CI matrix or close the broader gap.
- [Full-stack degradation injection](../../gaps/sketches/full-stack-degradation-injection.md)
  identifies the existing performance harness as the owner for performance
  fault experiments. Reuse its fixtures where useful; this port does not require
  completing a general fault-injection framework or another benchmark system.
- [Slow sidebar recovery](../../gaps/sidebar-slow-after-server-restart.md) and
  [unconfirmed sends](../../gaps/unconfirmed-send-loss-across-reload.md) are
  separate correctness/latency concerns. Verify the reload boundary explicitly;
  a surviving worker neither fixes nor disproves them.
- Degraded banner overlap was fixed in this implementation: the navigation
  shell reserves notice height. Desktop/phone browser checks exercise sidebar
  and settings controls while the notice is visible. The resolved gap is removed.

## Architecture to preserve

```text
Development wrapper / explicit foreground owner
  +-- Hono generation N                       replaceable
  +-- Vite                                    replaceable
  +-- provider host                           retained
        +-- session worker A -> provider A    retained
        +-- session worker B -> provider B    retained

Hono -> host control socket: launch, claim, release, terminate
Hono -> worker socket: queued input, sequenced events, approvals, RPC
Worker -> provider: original SDK/stdio/socket connection
```

The host manages ownership and cleanup; it does not relay every chat event.
Workers retain the complete provider adapter and live protocol state. Without
a usable host, the real adapter lives inside Hono instead of behind a socket
proxy. Existing ordinary sessions cannot be converted into hosted workers in
place. Resume after losing a provider process is not active-turn continuity.

Safe Reload only updates the replaceable generation. Retained workers keep
their loaded code and launch options; fresh workers load current code. Host
code, worker protocol, or incompatible imported-source changes can require a
host restart. Preserve the existing source/build fingerprint checks, including
transitive imports and dependency resolution. A wrapper reboot stops its own
host, but not a separately owned host to which it merely attached. Test both
cases and make the required restart clear instead of bypassing compatibility.

## Implementation sequence

### 1 — establish the macOS process identity and cleanup boundary

Inventory the native assumptions in `scripts/provider-runtime-discovery.mjs`,
`scripts/provider-runtime-host.mjs`, and `scripts/dev.js`. The current `/proc`
start-time reader is also duplicated in the wrapper. Process identity supports
host discovery, stale recovery, worker/process-group registration, and final
cleanup; removing only `process.platform === "linux"` gates is insufficient.

Introduce one small platform abstraction shared by those owners. Keep Linux's
PID/start-time behavior, and provide a Mac identity source with enough precision
to distinguish PID reuse. Investigate Darwin process metadata such as
`proc_pidinfo` through an appropriate bounded integration. Before choosing a
native helper or dependency, record its Node/Bun boundary, architecture support,
packaging/build requirements, availability probe, and error semantics. Do not
assume installed compiler tools, add an install-time compiler requirement, or
substitute a coarse human-readable `ps` start date without proving its identity
guarantee. The mechanism choice remains an implementation prerequisite.

Distinguish absent, same, different, inaccessible, and ambiguous identity.
An unreadable identity is not proof a process is gone. Never signal a reused or
ambiguous identity, delete its descriptor, or start a competing owner on that
basis. Preserve cleanup of original descendants when a process-group leader
has exited; test that case with native child processes, not only stubbed reads.

Audit `scripts/dev-instance-provenance.mjs` separately: its obsolete-bind
takeover scans `/proc` and environment markers. Keep this Linux-only unless an
equivalent Mac ownership proof is implemented and tested. Mac host continuity
must not depend on pattern-based killing of old development processes. A bind
collision must fail safely without disturbing the live instance.

### 2 — enable private discovery and supported launch modes

Extend `resolveProviderHostPaths`, wrapper host selection, and the server's
`provider-runtime-host.ts` registration/ensure gates through an explicit
capability result. Validate socket creation/connection, ownership, permissions,
identity capture, and cleanup on the selected platform/runtime. An explicit
runtime-directory override remains authoritative. Choose short private default
socket paths that work with macOS temporary-directory and Unix-socket path
limits; test long paths and produce an actionable failure rather than truncation.

Retain mode-0700 directories, mode-0600 private files/sockets, token checks,
generation fencing, source identity, exclusive launch reservation, and bounded
attach deadlines. Test foreign-owned/insecure paths, symlinks, stale sockets,
concurrent host starts, incompatible descriptors, and interrupted publication.
Do not replace Unix sockets with an unauthenticated TCP fallback.

Keep automatic capability routing consistent with the existing host contract;
do not revive the inert Codex setting as a Mac enable switch. Host absence or
probe failure leaves ordinary in-Hono ownership and an accurate degraded notice.
Host success alone does not make every active session detachable: retained
ordinary sessions and volatile queues must still block seamless reload.
Mock servers must never discover an ambient real-provider host.

### 3 — preserve reload and terminal ownership semantics

Reuse the existing wrapper state machine, `AgentSession` proxy, worker owner,
and socket adapter. Extend native cleanup beneath them rather than duplicating
the protocol. Audit `provider-host-status.ts`, server startup logging, capability
reporting, and platform-specific copy for assumptions that failure means Linux.
Any client contract change must follow the existing compatibility review rules.

For a wrapper-owned host, API reload and `SIGHUP` retain workers; terminal
`SIGINT`/`SIGTERM` and owner loss terminate them within bounded deadlines. For a
separately foreground-owned host, closing an attached wrapper does not grant
authority to kill unrelated host-owned sessions. Closing the host's own owner
must clean up its tree. Unexpected Hono loss gets bounded recovery or teardown,
not immortal unattached sessions. Preserve per-session viewer/idle anchors.

Confirm ordinary shutdown, release, terminate, attach confirmation, and restart
requests remain distinct. If cleanup fails, retain explicit failure/ownership
state and refuse a duplicate runtime; never report success merely after sending
a signal. Preserve sandbox and executor launch facts across reattachment.

### 4 — extend deterministic process and assembled-system tests

Existing evidence is distributed across these boundaries:

| Existing suite | Real boundary | Limitation |
| --- | --- | --- |
| `packages/server/test/sdk/providers/provider-runtime-host.test.ts` | Host/discovery/proxy logic with real sockets and spawned fake workers; ownership, callbacks, timeout, recovery, cleanup | Its fake worker replaces the production worker and provider adapter; core native cases are Linux-gated. |
| `packages/server/test/scripts/dev-reload.test.mjs` | Real wrapper/host; replacement PIDs, duplicate reload coalescing, HUP and frontend recovery | Backend/frontend children and worker are fixtures, not a complete Hono/provider run. |
| `packages/server/test/routes/provider-host.test.ts` | HTTP control validation and response adaptation | Does not establish native process survival. |
| `scripts/perf-suite/` specialized driver | Real host/proxy/Hono supervisor, streaming and idle release with simulated worker | Simulation excludes real adapter/SDK execution; it is not a full reload oracle. |

Run the applicable native tests on both Linux and macOS, retaining explicit
Windows fallback assertions. Add a bounded assembled-system test using the real
wrapper, Hono, host, production worker/socket adapter, and a deterministic fake
provider at the narrowest practical adapter/transport seam. Reuse captured
fixtures where appropriate. Do not count a replacement fake worker as coverage
of the real worker's replay or pending promises.

Use observable barriers: provider started, event consumed, approval pending,
backend detached, replacement attached, terminal event received. Hold/release
the fake provider at those boundaries instead of depending on a lucky sleep.
All runs have outer deadlines and cleanup in failure paths. Record the exact
mock seam and production modules exercised in the test description.

### 5 — prove real Claude and Codex continuity on this Mac

Run a fresh source-checkout wrapper against a disposable synthetic project,
isolated `YEP_DATA_DIR`, explicit private `YEP_PROVIDER_HOST_RUNTIME_DIR`, and
unoccupied server/maintenance/Vite ports. Do not redirect global HOME or reuse
the developer's host descriptor. A separate project or YA profile alone is
insufficient: native provider storage and same-user host discovery have their
own locations. Use supported provider config/storage isolation where possible;
record any intentional shared authentication/storage and scope cleanup to the
sessions created by the run. Never copy credentials into evidence or fixtures.

For each of Claude and Codex, test a new session and an ordinary durable resume
that starts a new hosted worker. Run a bounded command that records numbered
progress and a completion marker in the synthetic project. Request reload only
after native evidence confirms the command/turn is active. Compare its output
and transcript before/after, then submit a second turn. Add an actual approval
case and answer it after reattachment. Repeat with both providers active to
prove one session's lifecycle does not disturb the other.

Exercise API reload, wrapper HUP, and the actual **Server changed → Reload**
browser flow after a reversible edit to a Hono-only module. Restore only that
test edit. Verify changed backend behavior as well as continuity. Separately
test worker/host-source incompatibility in an isolated test fixture: an old
worker must not claim to run newly edited code, and the documented host restart
must produce a fresh owner. Follow the UI-testing guide for browser evidence.

## Required verification matrix

Run failure injection against disposable processes. Live providers supply
integration confidence; fake providers make timing and failure paths repeatable.

| Scenario | Required assertion |
| --- | --- |
| Active-turn reload | Hono PID changes; host/worker/provider identities, canonical YA id, native session id and active native turn identity remain the same where exposed. No new provider turn/start or resume is hidden inside reconnect. |
| Output during disconnection | A deliberately unacknowledged suffix survives in order; already acknowledged events are not replayed. Boundary redelivery before acknowledgement is allowed, but the final UI/transcript has no duplicate semantic items or terminal result. |
| Pending and detached-time approval | One actionable request after attach; its answer resolves the original worker callback. A real provider must demonstrate this, not just a fake accepting `approvalResult`. |
| Second turn after attach | New input reaches the retained session and completes without a new worker or broken request map. |
| Repeated/concurrent reload | Requests coalesce; exactly one replacement generation controls each worker; stale controllers cannot send input or acknowledge output. |
| Queued/ordinary-session blockers | Direct/deferred volatile queues and non-hosted active sessions prevent seamless reload; safe waiting and explicitly interrupting paths remain truthful. |
| Frontend failure | Vite loss/recovery does not terminate surviving provider workers. |
| Backend crash and failed startup | Recovery within grace succeeds; missed attach/confirmation deadlines terminate retained work within the configured bound. |
| Host/wrapper control loss | Worker/provider descendants are reaped by the surviving owner; no endless unattached process, retry loop, or pending approval. |
| Terminal shutdown | Idle, active, approval-blocked and deliberately hung workers clean up through cooperative/TERM/KILL paths; verify identities, process groups, sockets and owned registry state afterward. |
| Leader exit, reused PID, inaccessible identity | Original descendants can be cleaned up without signaling unrelated/reused identities. Ambiguity refuses recovery instead of weakening ownership checks. |
| Incompatible host/source and simultaneous launch | No second writer or silent takeover; correct fallback/diagnostic, with the incumbent untouched. |
| Idle/no viewers | Original per-session idle anchor survives reload; eventual release removes recurring work and owned resources. Other viewed sessions cannot renew it. |
| Unsupported platform/runtime | No accidental host launch or false continuity capability; Windows ordinary sessions still work. |

A native transcript is not an exact copy of all live events. Compare canonical
user/tool/assistant/result facts retained by each provider; separately assert
live-only lifecycle and approval events. Keep transport sequence assertions
separate from semantic deduplication and UI recovery timing.

## Evidence, CI, and completion

Record YA commit, macOS version/architecture, Node/Bun version, provider CLI/SDK
versions, selected model, launch mode, test seam, and pass/fail/skip reasons.
For each reload retain identities and socket paths, acknowledged/replayed
sequence range and byte count, old-backend exit/new-backend readiness times,
attach duration, first correct snapshot time, selected timeout/deadline and
elapsed time, terminal result, and the final process/socket survivor check.
Keep private tokens, authentication, and unrelated transcripts out of logs.
Prefer a compact structured result plus failure logs over screenshots alone.

Add focused Linux/macOS process tests to existing CI so the Mac tests actually
execute instead of passing via a platform skip. Include Windows fallback checks.
Record architecture and runtime coverage explicitly; this machine's result
does not prove the other Mac architecture or Bun. Native helper packaging, if
chosen, must be tested on every architecture for which it is shipped. Ordinary
CI uses deterministic providers without credentials; live smokes are separate
recorded integration runs. Use the normal required lint, format, typecheck and
test commands when source changes land, plus browser E2E for UI source changes.

- [x] Native identity/cleanup mechanism selected and proven on macOS.
- [x] Launch modes/capabilities and unsupported-runtime fallbacks documented.
- [x] Existing process tests pass on Linux and Mac without unintentional skips.
- [x] Assembled real-worker test proves replay, callbacks and replacement.
- [x] Real Claude and Codex active-turn, approval and subsequent-turn runs pass.
- [x] Browser reload, pending input, and degraded-mode controls verified.
- [x] Failure/terminal tests leave no owned survivors or recurring idle work.
- [x] Focused CI coverage and evidence locations recorded.
- [x] Owning architecture/runtime/API topics updated to actual supported modes.

The two validation runs are recorded below. The repeatable commands and the
supported-platform contract they exercise live in the owning
[runtime topic](../../topics/reload-safe-provider-runtimes.md#macos-verification-procedure).
The 2026-09-12 validation closes the live Claude/concurrent-provider cells and
the previously pending native CI results. Both credentialed browser cases
verify durable history as well as surviving workers. Exact replay cursor/byte
assertions remain in the deterministic production-worker/protocol suites;
these live smokes are integration evidence, not a transport benchmark.

## macOS verification evidence

### Initial verification, 2026-09-11

Tested from the uncommitted implementation based on `1b44fa073`, macOS 26.6.2
(25G83), arm64, Node 25.8.2. The independent Linux arm64 testbed used Node
22.16.0: 52 focused tests passed, with only the explicitly Darwin-specific
identity-failure case skipped. The equivalent Mac suites pass all 54 cases.
Final repository checks passed: `pnpm lint`, `pnpm format:check`,
`pnpm typecheck`, `pnpm test` (11,757 tests passed, 29 skipped), and
`pnpm test:e2e` (224 passed, 8 skipped). Lint reports two existing
informational template-string suggestions, with no errors. The focused CI job
in `.github/workflows/ci.yml` runs Node 22.16.0 on Linux, Mac arm64, Mac Intel
and Windows; those hosted CI executions were still pending at this run.
Runner labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Bun, compiled macOS servers and Desktop remained disabled. This does not close
[general CI platform coverage](../../gaps/ci-platform-coverage-holes.md).

| Live Mac scenario | Result |
| --- | --- |
| New Codex session, API reload during numbered command | Same worker, provider group, native session and runtime; command completes |
| Second Codex turn, wrapper HUP during command | Same retained runtime; numbered command completes |
| Ordinary durable resume after terminal wrapper shutdown | Same native conversation, fresh hosted worker |
| Hono-only edit, browser Server changed → Reload | New backend returns the test property; same worker; command and unsent draft survive; edit restored |
| Native Codex approval across API reload | Request remains actionable under current default mode; answer completes original command in same worker |
| Terminal shutdown after live runs | Host descriptor/socket absent and all recorded worker/provider groups gone |
| Real Claude and both providers active | Blocked: native `oauth_org_not_allowed`, organization disables subscription access |

Codex app-server 0.154.0 used `gpt-6-astra` with low effort. The account rejects
`gpt-5.4-mini`; that failed launch is not counted as continuity. Claude SDK
0.3.258 was attempted and produced the native organization error before a turn.
The synthetic project, YA data, ports and private host directory were isolated;
native same-user Claude/Codex authentication and transcript stores were
intentionally shared. No credentials were copied. Only created-session evidence
was read, and no unrelated native session was removed.

Run evidence is retained under `.artifacts/ui-testing/2026-09-11-macos-provider-host`
and `.artifacts/ui-testing/2026-09-11-macos-provider-host-live`; compact
structured results and test logs are archived with the latter. Browser captures
at 1000×600 and 375×812 verify the resulting transcript and the degraded
banner's reachable navigation. The two numbered native turns each have one start
and one terminal result; both reload intervals fall inside their original native
turn. Request-to-attach was 2730 ms for API reload and 2556 ms for wrapper HUP
on this run. The native conversation contains nine distinct test turns with no
duplicate starts or terminal records across the repeated smoke attempts. The
run also exposed a launch-mode regression, which the assembled test now covers
by changing the standing mode from bypass to default before replacement.

### Live verification, 2026-09-12

The account-access deferral above is closed. Validation used YA
`6ef7771748797ab5ac5ffb943a54adcf609f3a43` plus the credentialed test extension,
macOS 26.5.1 (25F80), arm64, Node 24.20.0, and the non-watch source wrapper.
The actual Claude session used SDK 0.3.258 / bundled CLI 2.1.258 with
`claude-sonnet-5`; the actual Codex transcript reports app-server
`0.154.0-alpha.6.2`, `gpt-6-astra`, low effort. The shell's independently
installed `claude` 2.1.268 and `codex` 0.153.4 were not the runtime-version
oracle. This validation did not update providers or widen compatibility.

The canonical synthetic project, YA data, private host directory and three
ports were isolated. Same-user provider authentication and native transcript
stores were intentionally shared; credentials were not copied or logged.

| Scenario | Result |
| --- | --- |
| New Claude session, API reload during a numbered foreground command | Same host, worker, provider process group, YA/native session and original tool call; complete ordered progress |
| Second Claude command, wrapper HUP | Same retained runtime and original tool call; complete ordered progress |
| Native Claude approval across reload, then another turn | Reconstructed UI approval resolves the original SDK callback; later turn completes |
| Claude and Codex commands active together, API and HUP | Both original workers/providers survive each replacement; both commands complete |
| Terminal shutdown, then durable resume for each provider | Old process groups and sockets disappear; each native conversation resumes into a fresh hosted worker |
| Hono-only edit and browser Server changed → Reload, each provider | Changed backend property appears, worker/provider identity persists, unsent draft survives, test edit is restored |
| Browser-run native approvals, each provider | Same pending tool/input after attach; approval completes the original command and persisted history remains readable |
| Two native approvals pending across the same reload | Both requests return; approving Claude leaves Codex pending; each command executes exactly once |
| Final terminal cleanup | Every recorded worker/provider process group and owned socket is gone |

The initial Claude API/HUP replacements attached in 1812/1264 ms; its approval
replacement took 1531 ms. Combined API/HUP replacements took 1791/1786 ms.
These are observed smoke timings, not performance ceilings. Wrapper-child
snapshots show the host retained while Hono and Vite were replaced.
The native audit pairs all eight Claude tool calls with exactly one successful
result and records ten user turns with ten assistant end-turns. Codex has six
unique started turns, each with one matching terminal event. Each measured
API/HUP reload interval lies within its original Claude tool call or Codex
turn, rather than an implicit restart/resume. After the combined approval run,
the session-detail API returned 97 Claude and 41 Codex persisted records.

The 54 focused native tests passed locally without skips. The existing
[CI run for the tested base commit](https://github.com/kzahel/yepanywhere/actions/runs/34641697632)
also passed native provider-host jobs on Linux, Apple Silicon Mac, Intel Mac,
and Windows fallback, closing the previously pending CI evidence.

Final local checks passed: `pnpm lint` (zero warnings, two informational
suggestions), `pnpm format:check`, `pnpm typecheck`, `pnpm test` (11,763 passed,
29 skipped), and `pnpm test:e2e` (226 passed, eight skipped). Both explicit
credentialed browser runs passed in addition to the ordinary suite. The console
scan passed with unchanged budgets: 110 ungated sites, 61 warn sites and 92
error sites; this validation adds no client console calls.

Evidence is under `.artifacts/ui-testing/2026-09-12-provider-host/`:
`evidence/live.json`, `native-audit.json`, `dual-approval.json`, both
`*-browser-live.json` files, and `final-cleanup.json`. Desktop 1000×600 and
phone 375×812 captures in `canonical-captures/` show recovered transcripts,
completed approvals and reachable composer controls, without a stale-server
banner. The artifact capture facility presents those captures.

The `/tmp` versus `/private/tmp` Claude transcript-routing issue discovered in
validation remains a [separate gap](../../gaps/project-path-identity-and-session-routing.md).
It is not repaired by canonicalizing the test fixture. Bun, compiled macOS
servers and Desktop remain excluded rather than inheriting this result.

This completed plan is retained as the implementation record; current
contracts and repeatable verification procedures live in the owning topics.
