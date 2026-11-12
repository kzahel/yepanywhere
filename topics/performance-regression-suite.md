# Performance Regression Suite

> The performance regression suite is YA's configuration-driven black-box test
> family for comparing server and real-browser latency, retained memory, and
> correctness across project, session, turn, payload, cache-budget, and
> concurrent-client scales.

Topic: performance-regression-suite

Historical surveys and recovery measurements live in the
[`performance-regression-suite.runs`](performance-regression-suite.runs/README.md)
ledger. This document owns only the current harness and interpretation
contract.

## Execution and fixture ownership

`scripts/perf-suite/run.mjs` is a thin CLI/result orchestrator and imports no YA
modules from the measured checkout. Process/fixture ownership, telemetry,
request clients, server/browser/built/specialized drivers, aggregation, and
ratchet evaluation live in independently testable sibling modules. Together
they create detached project worktrees from an immutable fixture revision,
generate deterministic provider files whose cwd values use those worktrees,
start an isolated execution checkout on non-production ports and app-data
paths, check fixture-derived API/rendering invariants, and write one JSON
result.

Execution, fixture, and harness identities remain distinct. Harness identity
hashes every imported implementation module plus config and ratchets and uses
their path-scoped revision/dirty state, so unrelated shared-worktree changes
cannot relabel a measurement and a changed driver dependency cannot preserve an
old identity.

Every spawned process carries a unique `ya-perf-suite-` argv marker and
`PERF_RUN_ID`, starts in its own process group, and enters a run-local
PID/PGID/port manifest. A marker-family sweep must be clean before work.
Every repetition and every failure/signal path runs `perf-sweep --kill
--kill-group` and then a report-only verification. Surviving debris fails the
run. Orchestration removes or rejects a prior output target before starting so
a crash cannot be classified from stale results.

Generated work and raw results remain local under the suite directory. Scale
points and repetition counts live in `scripts/perf-suite/config.json`; targets
live in `scripts/perf-suite/ratchets.json`. Scenario-specific thresholds do not
belong in driver code.

## Isolated frontend transcript calibration

The [frontend calibration](../docs/research/190-frontend-renderer-calibration.md)
uses `scripts/perf-repro/transcript-browser.mjs` and the client E2E fixture under
`transcript-performance/`. It feeds normalized completed turns through the real
store and renderer, comparing the transcript alone with the full session page.
Its static host owns no backend. This separates renderer scaling from the
50,000-session/provider-file scenario; it does not replace end-to-end qualification.

Measure frame callback gaps, calibrated missed opportunities, long tasks,
visible reply delivery and exact native typing prefixes. The hard input deadline
is 100 ms per key. Aggregate TaskDuration/write remains a CPU efficiency measure,
not a frame deadline. Append-only and typing runs stay separate. The negative
control must detect a 150 ms key-task stall. Runtime/harness hashes, host capacity
and eligibility, offered timestamps and raw results accompany each comparison.
Timing calibration is opt-in; only its inexpensive measurement-integrity case
joins the ordinary root test command. No CI timing ratchet changes.

## Driver contracts

### Server

The server driver uses public HTTP routes plus the maintenance listener. Heap
ratchets request full garbage collection and retain the minimum of seven heap
samples; RSS uses their median. Current source emits session-detail clocks and
bounded cache/V8 gauges. Older checkpoints report missing owner telemetry as
unavailable, never as synthetic zero.

The session-detail augmentation clock carries a description with input-message,
changed-message, and Markdown cache hit/join/miss counts. Those counts are
request-local even when detail requests overlap. A tracked suite process may set
`YA_PERF_PERSISTED_AUGMENT_DELAY_MS` to place a bounded test-only delay inside
that same clock; an untracked server rejects the variable. This probe validates
the clock path and is not an optimization result.

### Browser

The browser driver adds the measured checkout's React dev client and one real
page per configured client. Cache modes warm and revisit a three-session ring,
then prove under held refresh that cached final content is usable before the
network completes while zero budget stays blank. The artificial hold is
excluded from ordinary timing.

Cold, warm, and append observations independently mark readable text, glossary
annotation, project-path anchors, and final display. Mutation-time
`performance.now()` marks are authoritative; a Playwright polling wake-up is
not a performance timestamp. Per-page Chrome DevTools Protocol snapshots count
live and detached nodes, documents, listeners, and layout objects. Browser-wide
snapshots inventory processes; Linux additionally reports per-process RSS,
PSS, and private bytes only when every process is readable.

Background-effect lifecycle state survives navigation and append timing-buffer
resets. A session that stays mounted need not emit another lifecycle change;
the sidebar's single-active-consumer check uses the latest state of each mounted
session, removing it on unmount, rather than only the current phase's marks.

`focused-append` is the one-project, one-session, one-page selected-session
critical path. It has a distinct history key from fleet scenarios because it
excludes deliberate multi-file/multi-page fan-out. Its cache proof leaves the
selected route before refresh so a one-session ring cannot create a false
same-route result.

An interaction trace is a separate observation mode from the cache proof. It
may keep the measured route mounted, change Conversation View, type without
submitting, scroll, disclose older history, and reveal tooltip or hover-card
surfaces without first navigating away to prove cache behavior. A trace that
mixes those modes is invalid because the cache proof's route departure changes
the DOM whose interaction cost the trace intends to measure.

The `sidebar-switch` interaction trace is diagnostic rather than primary-score
evidence. It alternates two cached session routes and labels fresh, elapsed-idle,
and post-activity phases. Because those phases execute in order, an apparent
phase difference is not a causal activity-versus-time attribution until an
interleaved or separately randomized control reproduces it.

The `cached-sidebar-switch-routine` scenario is the bounded exception: ordinary
push/PR CI loads two 120-turn sessions, alternates six times without injected
activity, and excludes the first cold destination load from its latency
distribution. Every later switch must reuse the same retained session layer,
and retained switch-to-first-readable-frame p95 must stay at or below 200 ms.
This gate does not cover expiry, append catch-up, or sustained concurrent
updates.

### Built client

The built-client driver prepares one production build before host sampling and
records its identity, elapsed time, and cleanup without charging build time to
a measured leg. Each repetition uses separate fresh servers for the direct and
browser legs, so the direct probe cannot warm the browser process. Server
useful readiness runs from process spawn through `/api/projects` readiness to
the expected selected-session needle. Browser readiness runs from cold page
navigation to independently observed transcript milestones. These are DOM
readiness clocks, not paint timestamps.

### Specialized contracts

The specialized driver uses two fresh legs. An out-of-process simulated
provider-runtime worker exercises YA's real runtime host, proxy, supervisor,
subscription, augmentation, and idle release. It must produce the configured
thinking-capable stream, raw final message, and same-id enriched replacement,
then release verified-idle ownership after the final viewer unsubscribes.
Its semantic-action replay also launches Chromium, so CI must install the
Playwright browser for this driver as well as the browser and built-client legs.

The public-share leg creates a real frozen share against a local simulated
relay, verifies bounded chunk metadata, drives the configured reader herd
through the legacy full-response route, and samples forced-GC memory. The
provider adapter/SDK, provider transcript writer, and internet relay remain
outside this simulation.

A cohort run may launch several isolated specialized-contract lanes under one
parent lease to model concurrent offered load. Each lane still owns its server,
browser, fixture, ports, app data, process group, and semantic action. The
parent records one host window and performs the authoritative final marker-family
sweep. Cohort endpoint samples remain valid only for the qualities that the
specialized driver actually observes; they cannot be substituted for missing
browser frame, leak-slope, tooltip, or browser-startup-memory terms in a
multi-quality score.

Routine server/browser/built-client runs use an in-process post-provider mock
and disable provider discovery. They cannot support claims about provider
startup, parsing, transcript production, or provider teardown.
Standalone mock legs do not bootstrap a detached provider host. The specialized
wrapper explicitly supplies its simulated host and owns that host's teardown.

## Performance Measurement Hosts

Before treating benchmark output as regression evidence, follow this topic.
The host need not be fully uncontended, but the run must record its automatic
capacity key plus start/end CPU pressure, load, available physical/effective
RAM, and swap evidence, with
enough headroom for the scenario. If contention is uncertain, run a small
speculative sample first and expand only when it reproduces. Compare historical
baselines and machine-specific ratchets only within one capacity key; portable
checked-in ceilings may run on any host whose samples show enough headroom, but
they are not same-machine historical evidence.

Small low-cost cloud instances may be created for performance verification
without a separate permission question. The launch still gets the normal
big-effect gate record and must install an external TTL or cleanup guard before
the instance starts. Record provider, region, instance class, and instance ID;
verify deletion after success or failure, including attached disks, reserved
addresses, and other paid resources.

## Host capacity and history

Every result carries `host.capacity.capacityKey`, derived from platform,
architecture, CPU model, visible/effective CPU, cgroup quota/cpuset, and
bucketed physical/effective memory. Exact capacity fields, Node/V8 versions,
CI metadata, and start/end host samples remain beside it. Samples include load,
available host/cgroup memory, swap, Linux pressure data where available, and
whole-run CPU occupancy. Each repetition gets its own resource window.
Linux availability uses `MemAvailable`; Darwin uses Node's
`process.availableMemory()` (free plus reclaimable inactive/purgeable pages),
with immediately free bytes and the availability source recorded separately.
Earlier Darwin samples used `os.freemem()` under the availability field and
therefore underreported headroom; those samples describe free pages, not
available memory. CPU/swap evidence remains independently required.

Before fixture work, the suite takes a three-second baseline and requires
sufficient effective CPU, idle CPU equivalents, CPU-busy fraction, load per
effective CPU, available memory, and bounded swap growth. Missing CPU or swap
evidence is not clean. A failed baseline makes the result diagnostic-grade and
prevents a ratchet pass.

History keys combine capacity, driver, and scenario. Historical comparisons
and tightened machine-specific ratchets do not cross capacity keys. Broad
checked-in maxima are portable safety ceilings. Exact classes may override
individual targets in `capacityOverrides`; an unseen class uses portable
targets but does not thereby establish a same-machine improvement. Native
browser-process bytes are capacity-specific; content-addressed CDP object
counts may remain portable.

The manual `.github/workflows/performance.yml` workflow is diagnostic, not a
push/PR gate. It uploads result, history, and logs on failure as well as success
and emits the capacity registration needed for later review. Small cloud hosts
follow the same eligibility, marker, teardown, and deletion rules.
Ordinary `.github/workflows/ci.yml` separately runs the small retained-sidebar
scenario as a push/PR gate.

## Provider-backed tiers

Routine ratchets do not execute a live provider. Prefer a deterministic
harness-process simulator when provider startup, protocol events, transcript
writes, controls, thinking blocks, and teardown are under test. A post-provider
mock is acceptable only when its bypassed boundary is named and no claim crosses
that boundary.

Before ratcheting either simulation as provider-representative, compare a small
live sample and record provider-execution share plus event-shape differences.
Live runs use the lowest-cost model/effort that still exercises the required
thinking path and record provider, model, effort, cost, and capacity. The
current specialized worker is a runtime-protocol child, not a first-party
harness simulator.

## Background-work evidence

Maintenance status exposes background summary pending/in-flight counts,
deduplication/outcome counters, and recent batch durations on one monotonic
clock. The suite snapshots this state around append windows and records counter
deltas plus batches newer than the opening sequence. A watcher-enabled run must
show that summary work occurred; a watcher-disabled contrast has a distinct
harness identity and cannot stand in for that contention path.

## Cache and source identity

A retained Claude transcript is a cache hit only when device, inode, ctime,
mtime, and size all match. Incremental parsing is limited to strict growth of
that identity and verifies the 1 KiB boundary before the previous offset. A
same-size change, shrink, or replaced inode receives a full parse.

The boundary probe does not prove that every earlier byte stayed unchanged. A
same-inode prefix rewrite followed by growth can evade it when the final probe
matches. Current provider transcript writers are treated as append-only;
stronger detection would require a source revision or full prefix hash.

Source-byte cache charges, JavaScript heap, browser-process PSS, and CDP object
counts are complementary signals, not an additive component decomposition.
Cache comparisons report entry/byte accounting alongside broad heap residuals.

## Current phase ownership

Profiled samples explain at least 80% of each important total with named,
non-overlapping phases. Historical checkpoints without owner clocks retain
totals only.

| Total | Recurring owner set |
|---|---|
| server detail | augmentation, transcript read where material, framework/serialization/loopback |
| browser warm return | response/navigation residual where material, state queue to commit, React commit to readable text |
| browser append | observed file change through preprocess, grouping through commit |

Augmentation consumes normalized persisted messages plus project context and
produces Markdown/media/path-enriched response messages.
Framework/serialization/loopback carries response bytes through Hono and the
direct relay. Append-to-preprocess includes file observation, focused refresh,
state merge, and scheduling. React commit-to-readable covers rendered
projection after state is queued. Nested MessageList spans do not become
additive peers of their queued-to-commit parent.

The result ledger records the recovery measurements that established these
owners and the current ratchet values. The topic retains the semantic phase
boundaries so later instrumentation does not silently rename or double-count
them.

## Ratchet interpretation

Checked-in maxima are broad ceilings over repeated observations, not claims
that the maximum is desirable or a historical floor is acceptable. Browser
warm and append final-display targets remain at or below the one-second user
concern threshold. Independent ceilings cover significant phases, response
volume, cache charges, memory residuals, transcript entries/bytes, DOM/layout
objects, process PSS on registered capacity, and rendered rows.

Working-set identity, held-refresh behavior, zero-budget behavior, exact
fixture counts, negative link controls, correct event ordering, and clean
process teardown are hard correctness failures rather than probabilistic
timing thresholds. A run with uncertain contention or incomplete host evidence
is diagnostic and cannot move a ratchet.

## Coverage boundary

The suite covers simulated provider-file discovery, project/session and
collection reads, file-observed append, glossary/path rendering, browser
transcript retention, server/browser memory, runtime-hosted simulated
streaming, time-compressed verified-idle release, and concurrent frozen-share
reads.

It does not execute a real provider adapter, SDK/harness, provider transcript
writer, or remote internet relay in routine legs. Simulated token throughput is
not provider speed. A one-second reap scenario does not establish multi-hour
timer stability. Provider-backed timing, adapter parsing, transcript-write
behavior, long-duration timer drift, and remote-relay effects require live
calibration or a lower harness-level simulator.

Session-detail `ya-metadata` measures dynamic commands, queue summaries and fresh
provider child-session reads independently of `ya-route` slicing and anchor
lookup. Suite version 9 includes that phase in non-overlapping totals and keeps
the fleet append 5 ms route ceiling alongside a 40 ms metadata ceiling. Older
execution revisions retain their original combined route clock.

The specialized public-share byte budget includes safe assistant Markdown HTML
introduced by `ced769acc` (see [public transcript media](media-rendering-and-routing.md#read-only-shares)).
CI run [34479361388](https://github.com/kzahel/yepanywhere/actions/runs/34479361388)
measured 19.114 MiB for all three eight-response herds, versus the pre-feature
13.107 MiB baseline. The 24 MiB ceiling replaces that obsolete 16 MiB budget;
the harness also requires rendered assistant Markdown and reports its byte
contribution, so removing rendering cannot masquerade as an optimization.

The simulated provider persists its deterministic user/assistant fixture rows
before publishing each final assistant/result pair. Browser REST catch-up can
therefore read the same stable message IDs even between live-process snapshots.
This fixture writer is part of the simulated leg; the real provider SDK's writer
remains outside the measured boundary. The no-browser-diagnostics assertion and
verified-idle release assertion remain required.

Semantic browser setup and replay run with idle reaping disabled. After Chromium
closes, the specialized driver sets the one-second deadline through the public
settings API, verifies the remaining raw subscriber retains the idle provider
past that deadline, then measures release after its final unsubscribe. Failures
include the owned-server diagnostic tail rather than discarding that evidence.

Every measured server, including this leg's, runs at one console log level, so
no leg pays logging cost the others and production do not. A diagnostic rerun
may raise the owned-provider leg's level for a richer failure tail; the level
it ran at is recorded beside its numbers, and a raised level makes that
repetition diagnostic rather than comparable.

The owned fixture creates its session with explicit `thinking: "off"`,
matching the browser's initial setting for the simulated model. An unspecified
launch value followed by the browser's explicit off value is a real
launch-setting change and restarts the worker, which invalidates this replay's
stable-process and prior-turn assumptions. The deterministic worker still emits
its synthetic thinking block to exercise that transport/rendering shape.

## Plan 190 combined qualification

The separate `scripts/perf-repro/active-session.mjs` driver owns the expensive
50,000-idle-session/200-compaction fixture. Its
[2026-11-11 qualification](../docs/research/190-combined-scale-qualification.md)
records immutable build/harness hashes, host eligibility, population/history
controls and separate profile attribution. Optional `--typing` and
`--additional-tab` phases keep input probes out of the original active CPU
clock. Network data events account for bytes while NDJSON streams remain open;
finished-request sizes alone do not measure authoritative collection updates.

`--check-targets` is an explicit numeric-subset guard, not full acceptance or
a historical ratchet. It rejects missing metrics/phase resource evidence,
ineligible hosts, optional profiler runs and missing/changed runtime artifact
identity (including shared resolved from the actual server). Qualitative idle/no-rescan/retention
and repeated flatness/extra-tab gates remain open. Fast helper tests are part
of the normal root test command; the full expensive fixture remains opt-in.
Recorded runs predate the final driver's additional lists/restart host windows
detail-fetch count guard and automatic runtime fingerprints. Shared runtime
identity was verified only retrospectively for those runs; preserve their
measured hashes/limitations rather than certifying a frozen-runtime ratchet.
