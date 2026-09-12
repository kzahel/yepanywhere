# macOS provider-host support

Status: completed for the approved Node source-checkout scope, 2026-09-12.
Native Mac ownership, assembled production-worker replay/callbacks, live Claude
and Codex reload/approval/resume, simultaneous active turns and approvals, and
terminal cleanup are verified. The previous `oauth_org_not_allowed` deferral
is closed. Linux, Apple Silicon Mac, Intel Mac and Windows fallback CI jobs
passed for the tested base commit. Evidence and remaining support boundaries
are in the owning [runtime topic](../../topics/reload-safe-provider-runtimes.md#macos-live-verification-2026-09-12).

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
- [Full-stack degradation injection](../../gaps/full-stack-degradation-injection.md)
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

Implementation evidence and repeatable commands are in the owning
[runtime topic](../../topics/reload-safe-provider-runtimes.md#macos-live-verification-2026-09-12).
The 2026-09-12 validation closes the live Claude/concurrent-provider cells and
the previously pending native CI results. Both credentialed browser cases
verify durable history as well as surviving workers. Exact replay cursor/byte
assertions remain in the deterministic production-worker/protocol suites;
these live smokes are integration evidence, not a transport benchmark.

The `/tmp` versus `/private/tmp` Claude transcript-routing issue discovered in
validation remains a [separate gap](../../gaps/claude-symlink-project-transcript-routing.md).
It is not repaired by canonicalizing the test fixture. Bun, compiled macOS
servers and Desktop remain excluded rather than inheriting this result.

This completed plan is retained as the implementation record; current
contracts and repeatable verification procedures live in the owning topics.
