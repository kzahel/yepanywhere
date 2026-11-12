# Frontend transcript calibration

Plan [190](../tactical/190-active-session-cost-at-scale.md), stage 4 / step 6.

The maintainer asked to distinguish server/API performance from browser
responsiveness and establish an isolated renderer workload before more production
optimization. This change adds measurement infrastructure, with no production
renderer/store/protocol change. The original server targets remain unchanged.
The original 5 ms aggregate tab-work target remains an open efficiency target;
it is not a 60 Hz frame budget or a deadline for one complete append.

## Boundary

The fixture under `packages/client/e2e/transcript-performance/` uses the actual
session detail store, reducers, MessageList, tool/Markdown renderers, virtualization
and MessageInput. `view=page` mounts the actual main entry, App, navigation layout
and session route; `view=transcript` retains the shared store/renderers/composer
with their real required contexts and the real session scrolling CSS.

A fake source supplies explicit in-browser API responses and quiet subscriptions.
The fixture build substitutes only the source-selection binding, so normal app
startup cannot replace that source with a localhost transport. No rendered
component is substituted. Full-page chrome has 200 idle sessions in one project;
starred/categorized queries are empty. Service-worker support is disabled in the
benchmark context. Network requests outside the fixture origin, unexpected API
requests, browser errors/warnings, missing output and wrong retained-message
counts invalidate a run. This is not a 50,000-session backend test.

Loaded-history controls explicitly select unlimited initial history and disable
existing active-window trimming through the normal settings setters, in both
views. Otherwise the full page correctly trims large histories to a recent tail,
invalidating comparisons against a transcript retaining all requested messages.
The runner verifies initial and final retained counts. This deliberately tests a
history-retaining configuration, not the normal bounded working set. An initial
matrix exposed that mismatch and was interrupted; it is excluded from results.

Input messages are normalized completed turns: prompt, Read call, result and
pre-rendered Markdown answer (four messages / three displayed rows). Fixtures
are built outside the shared checkout. Messages are prepared before timing and
appended through the existing store's `applyCatchupMessages` action. This excludes
provider parsing, network/stream framing, acquisition/coalescing and metadata
activity. Full-page source chrome stays stable. Streaming replacement, tool
completion, catch-up bursts, compaction, scrolling and changing collection metadata
remain separate future workloads. No claim of whole-pipeline performance follows
from this calibration.

## Measurement and interpretation

`scripts/perf-repro/transcript-browser.mjs` uses production Vite output in bundled
Playwright Chromium with its sandbox enabled. Each fresh context settles and hydrates before measuring.
Repetitions reverse configuration order. Start/end build fingerprints and harness
module hashes identify the exact artifacts; raw per-case observations survive a
validation failure. A manifest is saved before cases, and each case saves its
raw observations plus CPU/host/build/harness evidence before summarization.
Output directories must be empty. All owned server/browser
resources close in `finally`; port 3400 is never involved.

One completed turn is offered each second by a browser timer independently of
DOM observation and native typing. Scheduled and actual ingress times are both
retained; early sub-millisecond timer delivery counts as zero lateness. A bounded
pending-marker probe finds the exact reply row and marker text at frame
opportunities. Its text range must intersect both the transcript scrollport
and the viewport in both axes; hidden/zero-size ranges do not count. It does not force scrolling
or await each append before offering the next. Missing markers fail validation.

Frame measurements use monotonic callback delivery times, with a separate idle
rAF cadence calibration. rAF/DOM observations indicate presentation opportunities,
not physical display paint. Report all of: p95 and maximum frame gap, estimated
missed opportunities at calibrated cadence, gaps exceeding 16.7 ms (+0.5 ms
measurement tolerance), gaps exceeding 33.3 ms (+0.5 ms), and browser long tasks
(50 ms or longer). A rare stall must remain visible even when p95 hides it.
The host may supply a 120 Hz cadence; that is recorded, not assumed to be 60 Hz.

Append-only and append-plus-typing runs are separate. Native sequential typing
uses individual browser key events. Every input prefix must match at the input event and acknowledgement frame, and
keydown event timestamp to the next input-acknowledging frame must be <=100 ms.
Controller round-trip delay is excluded from that browser-clock interval. The
intentional negative control blocks the first key task for 150 ms: the runner
must detect a typing failure, long task and frame gap even if p95 stays low.
Nine real-Chromium integrity controls reject a wrong marker, wrong reply,
scrollport clipping, display:none, visibility:hidden, a transparent ancestor
and nested clipping, with visible positive cases including viewport-propagated
body overflow under a fixed mobile shell. They run before host
baseline sampling. Missing samples fail closed. Aggregate CDP TaskDuration divided by append count
includes idle page work, probe work and (in typing runs) typing; it is a secondary
CPU measure, not the duration of a render or a frame.

Host capacity, baseline eligibility and measured CPU/memory/swap windows use the
existing performance suite's policy. A measurement is qualified only if baseline
and measured windows pass. Checks/review/builds must be idle during accepted
windows. This first calibration is a diagnostic experiment; frame counts are not
a new CI timing ratchet. Exact prefixes, complete delivery and negative-control
detection are correctness gates.

## Run

In an external archive with normal workspace dependencies and a private shared
package link (never build the shared working tree's client):

```bash
pnpm --dir <archive>/packages/shared build
pnpm --dir <archive>/packages/client exec vite build \
  --config e2e/transcript-performance/vite.config.ts
node scripts/perf-repro/transcript-browser.mjs \
  --client-dist <archive>/packages/client/dist --out /tmp/frontend-append
node scripts/perf-repro/transcript-browser.mjs \
  --client-dist <archive>/packages/client/dist --typing --out /tmp/frontend-typing
node scripts/perf-repro/transcript-browser.mjs \
  --client-dist <archive>/packages/client/dist --turns 20 --views page \
  --appends 3 --repeats 1 --negative-control --out /tmp/frontend-negative
```

Defaults: 20 / 200 / 1,000 loaded turns, both views, 1 Hz, 12 appends, three
repetitions, desktop 1280 x 800. `--widths 375` exercises a 375 x 812 viewport;
these are desktop Chromium viewport controls, not mobile-device qualification.
`--serve` exposes the frozen fixture for artifact capture or manual inspection.

## Qualification outcome

The final frozen production fixture was measured with one matched sampler
identity, Node 25.8.2 and Playwright Chromium 148.0.7778.96. The final desktop
matrix uses eight appends at 1 Hz, two repetitions per size/view, and reverses
configuration order in the second repetition. Append-only and typing runs are
separate. A single six-append narrow-viewport control covers 20 and 1,000 turns
in both views. All four final commands exit zero, including the expected-failure
stall control. The [evidence](190-frontend-renderer-calibration.evidence.json)
retains artifact/harness/source hashes, raw-result/log hashes, commands, host
qualification, per-key latencies/prefix checks and marker observations.

Append-only desktop results (CPU ranges across two repetitions; p95 delivery
pools 16 appends per point):

| Initial loaded turns | Mounted rows, transcript / page | Aggregate CPU ms/append, transcript / page | Visible reply p95 ms, transcript / page |
|---|---|---|---|
| 20 | 84 / 84 | 43.1–46.2 / 60.4–60.5 | 26.4 / 35.7 |
| 200 | 14 / 11 | 43.1–47.9 / 53.6–53.7 | 77.8 / 84.9 |
| 1,000 | 14 / 11 | 61.0–65.1 / 66.6–67.1 | 92.8 / 271.6 |

Each point retains its requested initial messages plus all appends: 112, 832
or 4,032 final messages. The 20-turn case does not virtualize, so it mounts more
rows than the larger cases. Do not fit a history-scaling curve across that
virtualization boundary. At 200 versus 1,000 turns, the mounted row count stays
constant while transcript-only aggregate work grows. That is a useful future
attribution boundary, not evidence identifying the compiler as the cause.

Across 28 normal cases, all 216 appended replies are observed, all 1,292 native
key prefixes match at the input event and acknowledgement frame, and maximum
key latency is 19.6 ms (100 ms deadline). Pooled frame gap p95 is 10.3 ms and
maximum is 29.3 ms. There are 44 gaps above 17.167 ms among 25,918 measured
frame intervals, none above 33.833 ms, and no 50 ms long tasks. These are generally
short frame opportunities, not proof of uninterrupted 60 fps or physical paint.
Measured idle rAF cadence is about 8.3 ms on this host.

The 1,000-turn full page misses the 250 ms delivery aspiration: an initial
append reaches 271.6 ms in append-only runs and 278.1 ms during typing. Later
appends are generally near 90 ms. With only 16 observations per point, pooled
p95 is the maximum; treat this as a reproducible diagnostic, not a precise
population percentile. Short frame gaps alongside delayed text visibility
suggest investigating follow-scroll/virtual-window scheduling before a broad
React rewrite. A profile or trace is still needed to identify the cause.

The 375 x 812 control passes exact typing and complete delivery: maximum key
latency is 16.9 ms, maximum frame gap 20.4 ms and worst visible reply 108.1 ms.
It is a narrow desktop-Chromium viewport, not a mobile keyboard/device result.
The final 150 ms stall control records a 160.8 ms key acknowledgement, 161.6 ms
frame gap and one long task, while frame p95 stays 10.4 ms. It correctly fails
the input deadline while passing measurement validity and the negative-control
expectation.

All final windows pass the existing host capacity/headroom/memory/swap policy;
the same capacity key identifies the host. No measured window grows swap.
Reviewer, checks and builds are idle during accepted windows. Earlier runs
with normal page trimming, the pre-final sampler, and the phone false-negative
and runs before the explicit Chromium sandbox launch setting are excluded
entirely from these figures. The phone issue was in observation:
body overflow propagates to the viewport even when a fixed shell leaves its
body layout box at zero height. The ninth positive browser control protects
that rule. No production mobile layout change was needed.

## Checks, review and follow-up

Full workspace tests pass: server 7,400 (94 skipped), client 7,397, shared 989,
root 23, plus the other participating workspaces. Lint is warning-free;
typechecking, formatting, source budgets and console scanning pass. No budget,
SQL ceiling, timeout, retry or capability changes. The one retained root integrity
test costs about 1 ms in a roughly 59 ms Node invocation in one local sample;
it catches sparse stalls hidden by p95 and missing/incorrect observations. No
new browser timing gate joins ordinary CI. The nine browser controls run only
when this opt-in harness runs. Copied broken samplers fail the marker, clipping,
CSS visibility and propagated-body controls; restoring the sampler passes.

Sol 6.1 high reviewed through YA with applied bypass permissions, under explicit
read-only instructions. Marker collisions, clipped/CSS-hidden output, existing
output-directory handling and failed-case provenance findings were verified and
fixed. Follow-up inspection cleared the history controls, CLI realpath entry
and viewport rule. Final numerical/evidence review cleared the sandboxed results with no remaining
must-fix, should-fix or nit findings.

The artifact capture facility produced and separately inspected 1000 x 600 and
375 x 812 full-page captures after native typing and an append. Both show the
appended reply above the composer with the typed text intact, usable controls
and no stale-runtime banner. The capture-only context reports Playwright's
expected service-worker block warning; timed contexts remove that capability
and ignore no product warnings.

Recommended next slices:

1. Trace the delayed first append in the large virtualized full page. Locate
   the reveal/follow-scroll scheduling boundary and repair its ownership if the
   trace confirms unnecessary waiting; retain this workload as the guard.
2. Extend the fixture with streaming-tail replacements and tool completion,
   then bursts and scrolling, through the actual frontend ingress/coalescer.
   This completed-turn result does not qualify that higher-rate path.
3. Return to backend process/main-thread CPU attribution against the original
   50k-session scenario. The 5/15 ms server targets and catalog/memory/restart
   acceptance remain separate and open.

The original 5 ms tab-work target remains unmet. This change establishes where
responsiveness and CPU efficiency differ; it claims no production speedup.
