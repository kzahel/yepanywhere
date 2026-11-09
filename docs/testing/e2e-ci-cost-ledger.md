# Client E2E CI cost ledger

This log records comparable browser-suite measurements for the
[E2E reduction plan](../tactical/135-e2e-suite-cost-ratchet.md). The
[run-level CSV](e2e-ci-cost-baseline-2026-09-27.csv) preserves the source SHA,
elapsed time, case count, and retry counts for each job. The
[case-level CSV](e2e-ci-case-baseline-2026-09-27.csv) preserves 336 observed
case identities, passing-run duration medians and 90th percentiles, and their
first-failure, retry-pass, and final-failure counts. Run IDs in the first file
resolve under `https://github.com/kzahel/yepanywhere/actions/runs/<run_id>`.

## 2026-09-27 baseline — 35 main-branch CI jobs

Source: the latest 35 completed `ci.yml` runs on `main` when sampled, from
[run 35909851714](https://github.com/kzahel/yepanywhere/actions/runs/35909851714)
at 2026-09-23 19:31 UTC through
[run 36312838295](https://github.com/kzahel/yepanywhere/actions/runs/36312838295)
at 2026-09-27 10:32 UTC. Each run used the single-worker `e2e-tests` job.
Thirty jobs passed and five failed; the listed case count grew from 318 to
334 across these changing commits. One successful
[334-case run](https://github.com/kzahel/yepanywhere/actions/runs/36312160095)
is the fixed reference for inspecting individual case durations.

| Measure | Median on 30 passing jobs | 90th percentile | What it includes |
| --- | ---: | ---: | --- |
| Entire `e2e-tests` job | 20m39s | 21m05s | Checkout, install, browser install, test command, cleanup. |
| `pnpm test:e2e` step | 20m06s | 20m33s | Shared/client builds, services, then Playwright cases. |
| Before `Running … tests` | 1m49s | 1m53s | Setup and builds inside the test command. |
| From `Running … tests` to step end | 18m16s | 18m40s | Serial case execution, fixture overhead, reporting, teardown. |
| Sum of reported case attempts | 17m42s | 18m08s | Includes retry attempts; excludes skipped cases and between-case work. |

The medians of these components are calculated independently and therefore
need not add exactly. The separate `pnpm install` and Playwright browser-install
steps had passing-job medians of 3s and 8s. The successful reference run used
about 1m51s before cases and 18m15s afterward; its reported case attempts
sum to 17m44s. Case execution dominates job time, while every focused run
also pays the setup cost unless it uses a narrower fixture.

### Slowest specs in passing CI jobs

Each value is the sum of Playwright's reported case-attempt durations for a
spec within a job. Medians and nearest-rank 90th percentiles use the 30 passing
jobs; they are prioritization signals, not isolated-spec wall time. All listed
specs appeared in all 30 jobs.

| Spec | Cases per job | Median | 90th percentile | Reference run |
| --- | ---: | ---: | ---: | ---: |
| `async-questions.spec.ts` | 1 | 72.0s | 78.0s | 78.0s |
| `relay-integration.spec.ts` | 13 | 56.9s | 57.5s | 52.5s |
| `slash-command-argument-completions.spec.ts` | 3 | 48.7s | 52.0s | 48.6s |
| `multi-host-secure-coexistence.spec.ts` | 14 | 47.0s | 49.3s | 38.5s |
| `all-sessions-search.spec.ts` | 15 | 39.7s | 41.3s | 40.3s |
| `remote-login.spec.ts` | 13 | 36.0s | 37.7s | 33.1s |
| `source-control-clean-landing.spec.ts` | 7 | 34.7s | 35.0s | 34.7s |
| `question-aside.spec.ts` | 1 | 34.5s | 35.0s | 34.3s |
| `file-viewer-comment.spec.ts` | 11 | 29.9s | 30.4s | 30.2s |
| `artifact-viewer.spec.ts` | 12 | 28.9s | 32.8s | 32.8s |

The earlier local run ranked All Sessions search first at 37.4s and async
questions second at 35.2s. CI reverses that order, with async questions taking
roughly twice as long as in the local run. Subsequent reduction slices should
use the CI ranking and report both environments separately.

### First two contract inventories

`async-questions.spec.ts` is one 797-line case that visits the session,
Settings, Inbox, and sidebar at desktop and phone widths. Its distinct browser
checks include focus and scroll preservation during a live message, reply
failure and retry through the server, cross-session counts delivered over the
activity stream, phone overflow controls, a 200-character real sequential
typing sequence, and an older-server capability fallback. Existing
`asyncQuestions.test.ts`, `AsyncQuestionsButton.test.tsx`, and
`useDrafts.test.ts` already cover some reminder aging, compact button text,
and draft source isolation. `QuestionAnswerPanel.test.tsx` covers blocking
provider interviews, not async questions, so it is not replacement coverage.
Compare each repeated state assertion with the relevant tests before moving
it. The [known timing gap](../../gaps/async-questions-e2e-flake.md)
reported two failures in four unchanged local runs on 2026-09-24.

`relay-integration.spec.ts` has 13 cases around real encrypted relay login,
bounded transfer, refresh/resume, stale saved URL, error paths, and relay route
navigation. Its transport boundary is not replaceable by a mocked component
test. All cases share remote-access configuration and teardown; setup and
duplicated page assertions are the first costs to inspect. The `!! Commands`
route case failed alongside its local and remote counterparts in four CI jobs,
so it needs a shared-cause diagnosis before a coverage decision.

### Failures and retries

Twenty cases failed on their first attempt across eight jobs. Seven passed on
a retry; 13 remained failed. Six jobs had at least one retry pass, including
two jobs that still failed for another case. The five failed jobs comprise four
jobs where the same three `!! Commands` cases failed together across local,
relay, and remote routes, plus one earlier job with a persistent Files API
case failure. The latest three-case failure followed an intervening passing
run, so its cause needs investigation before classifying it as a product
regression or intermittent test behavior. No job in this window stopped during
compilation.

The seven retry-pass cases were one each in `session-right-pane`,
`slash-command-argument-completions`, `page-keys-after-scrollbar-drag`,
`all-sessions-search`, `artifact-viewer`, `source-selection`, and
`question-aside`. The four failed `!! Commands` jobs account for 12 of the 13
persistent case failures. Retry attempts added 43s of reported case time to
passing jobs and 289s to failed jobs across this window. These are observed
replays, not an estimated flake rate: source revisions and case counts changed
throughout the window.

### First follow-up diagnosis

The latest failed job's `!!` local-command attempt reached a completed command
before its held POST receipt settled. The test reloaded immediately, so the
recovery draft remained in local storage and its reload assertion failed.
Retries then encountered a command left in the shared server. The relay and
remote route cases were asserting that the global history was empty, so they
failed after the local test even though their own navigation worked. The
fix waits for the receipt and draft clearance, removes this test's commands
after each attempt, and checks the destination heading in the two route
cases. A focused component test keeps the empty-history assertion. Two
focused repeats of each of the three affected cases passed on one shared
test server after the cleanup correction. The first full CI run after the
change passed without retries; more runs are needed to assess the trend.

### First post-change CI sample

[Run 36324063569](https://github.com/kzahel/yepanywhere/actions/runs/36324063569)
on the first reduction slice (`f7193eee7`) passed on 2026-09-27. The job
listed 332 cases: 324 passed, eight skipped, and none retried. The E2E job
took 19m19s; its test step took 18m46s, including 1m37s before Playwright
began cases and 17m09s thereafter. The baseline passing-job medians were
20m39s, 20m06s, 1m49s, and 18m16s respectively. The async-question case
reported about 1.1m versus its 72s baseline median; the slash-completion spec
reported 43.1s versus 48.7s; multi-host reported 36.2s versus 47.0s.

This is one passing job at a different revision and case count, so the
differences are observations, not a measured steady-state gain or flake-rate
change. The second slice shares startup in slash completion and multi-host,
labels async-question checkpoints, and removes five API-only Files cases. The
following sample compares its CI job with this run; a fixed passing-job window is
still needed for a trend.

### Second post-change CI sample

[Run 36325789955](https://github.com/kzahel/yepanywhere/actions/runs/36325789955)
on the second slice (`12485f1c4`) passed on 2026-09-27. It listed 327 cases:
319 passed, eight skipped, and none retried. The E2E job took 20m49s; its
test step took 20m13s, including 1m50s before cases and 18m22s thereafter.
That is 1m30s slower than the preceding single run and 10s above the
35-job baseline median. The sum of list-reporter case durations was about
17m53s, versus 16m43s in the preceding run. Most of this observed difference
is in case execution, not setup.

| Spec | Baseline passing-job median | First sample | Second sample |
| --- | ---: | ---: | ---: |
| `async-questions.spec.ts` | 72.0s | about 66s | about 72s |
| `slash-command-argument-completions.spec.ts` | 48.7s | 43.1s | 40.0s |
| `multi-host-secure-coexistence.spec.ts` | 47.0s | 36.2s | 38.9s |

The five removed Files cases were almost free in reported execution time;
the Files spec took 2.5s across seven cases in the first sample and 2.8s
across two browser cases in the second. Moving them makes the test boundary
clearer but should not be credited with a wall-time saving. Shared startup
did not produce a measurable full-job gain in this one run. The slash spec's
reported case time improved, while multi-host and async-question times moved
upward from the preceding run.
These two post-change jobs have different case counts and are insufficient
to establish a median or retry trend. Keep the full CI gate and collect a
comparable window before closing the cost objective.

### Two-shard CI experiment

[Run 36327293044](https://github.com/kzahel/yepanywhere/actions/runs/36327293044)
is the single-worker control at the same test source revision as the sharding
change. It passed 319 cases, skipped eight, and had no retries. Its E2E job
took 20m17s, including a 19m43s test step.

The workflow-only change in
[run 36328686139](https://github.com/kzahel/yepanywhere/actions/runs/36328686139)
split the same 327 listed cases across two isolated CI runners. Each shard
kept Playwright at one worker and built and started its own test services.
Both shards passed without retries:

| CI run | Listed cases | Result | Job wall time | Test step |
| --- | ---: | --- | ---: | ---: |
| Single-job control | 327 | 319 passed, 8 skipped | 20m17s | 19m43s |
| Shard 1/2 | 165 | 157 passed, 8 skipped | 12m36s | 12m05s |
| Shard 2/2 | 162 | 162 passed | 10m53s | 10m16s |

The two shards started one second apart, so the slower shard set the E2E gate
at 12m36s: 7m41s (38%) shorter than the control. Their combined job time was
23m29s, 3m12s (16%) more runner time than the control because setup and builds
ran twice. The shard time difference was 1m43s. These are one paired CI
observation, not a steady-state speed or retry-rate estimate. Shard timing
should be compared over a fixed window before rebalancing files.

A separate local full-suite trial with `--workers=2` shared one test server.
It stopped at the five-failure limit after 186 passes, eight skips, and 127
cases not run; it took 4m48s before stopping. The failures included async
question scroll, file-viewer pointer targeting, relay transfer, and two
remote-login checks. The incomplete run cannot establish a local speed gain,
and the failures do not by themselves identify a common cause. Keep the local
full-app default at one worker unless a complete parallel run becomes reliable.

### Repeated two-shard CI checks

The workflow-only run above and subsequent runs used the same test source and
the same 327 listed cases. The later source revision changed only E2E guidance
and this ledger. Each row reports an entire required pair of shards; "gate
from first start" includes any delay before the second shard acquired a
runner.

| Run | Shard 1 job | Shard 2 job | Start skew | Gate from first start | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| [36328686139](https://github.com/kzahel/yepanywhere/actions/runs/36328686139) | 12m36s | 10m53s | 1s | 12m36s | 319 passed, 8 skipped, 0 retries |
| [36329637452, attempt 1](https://github.com/kzahel/yepanywhere/actions/runs/36329637452/attempts/1) | 12m10s | 10m29s | 3m07s | 15m17s | 319 passed, 8 skipped, 0 retries |
| [36329637452, attempt 2](https://github.com/kzahel/yepanywhere/actions/runs/36329637452/attempts/2) | 12m22s | 10m46s | 47s | 12m22s | 319 passed, 8 skipped, 0 retries |

All three E2E pairs passed. Runner queuing consumed part of the wall-time gain
in the second pair. The third workflow attempt initially failed outside E2E:
the Windows `persistence-native` job hit an `EBUSY` temporary-directory error
in `ReviewCaptureService.test.ts`. That failed job passed on a targeted rerun;
the workflow is green. The E2E shards were not rerun in that attempt. These
green E2E runs show that the shard layout can complete; they do not prove case
independence inside either shard or establish a stable failure rate. The
[shared-server gap](../../gaps/e2e-shared-server-isolation.md) remains open.

### Collection method and next comparison

Run selection used `gh run list --workflow ci.yml --branch main --limit 35`.
Job and step timestamps came from the GitHub Actions jobs API. Case identity,
duration, attempts, and the `Running … tests` timestamp came from each job's
Playwright list-reporter log. The CSV records job and step durations to whole
seconds and derived durations to tenths; percentile figures use nearest-rank
ordering. The case-level file groups by spec path and full Playwright title;
its duration columns use only passing jobs, while failure counts use all 35.

After the first reduction slice, collect another fixed window with the same
method. Compare passing-job median and high-percentile wall time at comparable
case counts and revisions, and report first-attempt failures, retry passes,
and persistent failures separately. Keep the unique browser or transport
assertions beside each removed or moved case in the tactical plan.


### Worker isolation campaign — 2026-09-29

The full worker-owned suite passed locally on macOS with `--workers=2
--retries=0`: 345 passed, 12 platform/device cases skipped, 8.0 minutes.
Teardown completed and removed the invocation profile. This is a complete
schedule, unlike the earlier failure-limited parallel trials; it is still
one local observation rather than a CI speed or flake-rate estimate.

A refreshed CI history query used the workflow-runs API with an explicit
`main` branch filter, then job timestamps for each exact revision. Thirteen
passing two-shard pairs from September 27–29 had a slower-shard median of
12m36s, nearest-rank p90 of 14m37s and median combined job time of 23m29s.
Case counts and source changed across that window, so it is a prioritization
baseline rather than a controlled comparison. The next comparison retains
the two shards and changes only the worker scope/count on a fixed test source.
Record start skew separately from service/test time and report retries as well
as final passes.

The first unit-storage fix's [CI run 36630063508](https://github.com/kzahel/yepanywhere/actions/runs/36630063508)
passed the general unit job in 7m52s and shard 2 in 12m58s. Shard 1 failed the
real Linux live-preview case: its cold iframe became ready just after the
five-second assertion in the retry trace. The harness now warms the actual
Vite module and validates sandbox availability before navigation; only the
first cold-frame assertion has a measured 15-second allowance. That workflow
also failed an Intel macOS native-host descriptor wait without child output.
The native fixture now reports child exits and bounded stdout/stderr at the
same deadline; no speculative production timeout was increased.

### Fixed-source worker comparison and follow-up — 2026-09-30

`1dd1e6b7e` and `e916fd004` use identical test source; the latter changes only
the workflow to worker scope and two workers per existing shard.

| Exact run | Scope/workers per shard | Shard 1 job | Shard 2 job | Combined jobs | Result |
| --- | --- | ---: | ---: | ---: | --- |
| [36641621916](https://github.com/kzahel/yepanywhere/actions/runs/36641621916) | run / 1 | 16m41s | 9m35s | 26m16s | 347 passed, 10 skipped, no retries |
| [36644008475](https://github.com/kzahel/yepanywhere/actions/runs/36644008475) | worker / 2 | 14m35s | 7m56s | 22m31s | async-question failed all attempts; four retry passes elsewhere |

The worker pair consumed about 14% less combined job time but failed; this does
not establish a reliable or steady-state speed improvement. The async retry
trace exhausted a five-second composer wait while 823 source modules loaded
through the routed dev app. The final connection-refused screenshot followed
fixture teardown; it was not evidence of a Vite crash preceding the failure.

The [follow-up run 36646266324](https://github.com/kzahel/yepanywhere/actions/runs/36646266324)
includes supervisor draining and offline update checks, so it is a changed-source
observation: shard 1 passed 173 cases without retry in 8m39s job/7.9m tests;
shard 2 took 9m50s job/9.1m tests, with two persistent failures and two retry
passes. Its 2m16s runner start skew made the gate 12m06s from the first start.
The persistent cases identified a real lazy-page admission gap and a restart
that reloads a routed dev app during a five-second assertion. The unit job's
pagination fixture exceeded five seconds while capturing 165 rows through
durable SQLite transactions. All four native provider-host/preload jobs passed.

Follow-up repairs preserve the browser assertions: lazy route boundaries retain
the route tier, restart waits for its actual reload, and a coherent incremental
mock owns its synthetic cursor. Private read-state/async YA fixtures serve the
immutable built client, and public share uses the shared remote preview. The
async initial checkpoint now waits for actual transcript volume; an unrevealed
empty viewport also reports zero bottom distance. Faster initial rendering also
exposed an empty-sidebar interaction hold; a regression proves first population
must remain visible before subsequent order is held. The SQL pagination case
uses actual in-memory SQLite with the same schema and 165 captures; persistence
cases retain disk. Full-app unit teardown joins every app service before deleting
its file root, including artifact readiness writes.

Four focused two-worker repetitions passed all 32 async/read-state/provider/slash
cases without retries. After incorporating three upstream commits, the full
four-worker run passed all 345 established cases in 4.3m with clean teardown;
both new upstream selection cases failed (Mac copy shortcut and a held-press
follow assertion). The latter exposed the independently proved pending-release
frame defect; wheel/press regressions fail before its repair and pass afterward.
Root workspace tests passed server 6,148 and client 6,498, and the strict E2E
gate caught a new upstream import of the removed synchronous stop helper.
The new fixture now awaits disposal. These are local functional observations
under overlapping checks, not controlled timing claims.

Three otherwise-identical Vite builds checked the actual HTML entry while
reviewing startup dependency cost: before the route hold 652,094 raw / 188,121
gzip bytes; with a heavy-store import 654,358 / 188,895; with the extracted
source-key subscription 654,182 / 188,841. The retained implementation adds
720 gzip bytes to the entry, not the raw TypeScript graph's apparent 165 KB.
The store continues re-exporting the same single source-key owner.

The final merged local checkpoint passed 347 browser cases with 12 skipped,
four workers, zero retries, and clean teardown in 4.7m. Root workspace tests
passed 6,148 server and 6,501 client cases; lint, formatting and type checks
passed, including the strict E2E gate. These overlapping local runs establish
functional coverage, not a controlled performance comparison. Twelve focused
selection repetitions also passed. The selection fixture now targets a visible
text-line rectangle whose actual hit belongs to the transcript; the old caret
lookup could return nearby text while the pointer landed in outer padding.
Both reviewers checked the corrected targeting and ownership repairs.

The intervening upstream [run 36651162131](https://github.com/kzahel/yepanywhere/actions/runs/36651162131)
was green but included retry passes: two in shard 1 and three in shard 2.
Its 11m55s / 8m21s job pair is another changed-source observation, not proof
that the remaining races disappeared. First-attempt results remain the gate.

### Merged repair verification — 2026-09-30

[Run 36653354418](https://github.com/kzahel/yepanywhere/actions/runs/36653354418)
passed every gate at `dcb10ef9a`. Shard 1 passed 171 cases with nine skips and
no retries in 8.0m tests; shard 2 passed 177 with one skip and one relay recovery
typing retry in 6.7m. The prior persistent async/readiness/restart failures passed
on their first attempts. The typing retry failed the existing 100ms/presence
check; the retry trace recorded six present samples at 28–59ms. Its assertion
now reports all measured samples without changing the bound. Linux workspace
units passed 6,194 server and 6,501 client cases (389.23s / 583.98s). This is
a changed-source single observation, not a median or flake-rate estimate.

The CI workflow's manual inputs enable a fixed-source legacy run/one-worker
control and worker/two-worker schedule at `6e7d1c799`; their recorded run IDs
are 36653620810 and 36653595132. Queue delay and actual runner start skew are
recorded separately. Subsequent source changes do not affect those immutable
comparison runs.

Both fixed-source runs at `6e7d1c799` passed all CI gates. Their E2E jobs were:

| Schedule | Shard 1 job | Shard 2 job | Combined jobs | First-start to final finish | Retry passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| run / 1 ([36653620810](https://github.com/kzahel/yepanywhere/actions/runs/36653620810)) | 14m47s | 10m39s | 25m26s | 15m21s | 1, search Escape |
| worker / 2 ([36653595132](https://github.com/kzahel/yepanywhere/actions/runs/36653595132)) | 7m43s | 7m14s | 14m57s | 10m48s | 1, session app tabs |

The slower job decreased 47.8% and combined E2E job time decreased 41.2%.
Runner start skew was 34s for the control and 3m34s for worker scope; queue
waiting is excluded from these job durations. Identical-source unit jobs took
10m13s and 8m10s, illustrating runner variability. This is one pair, with one
retry in each schedule, and does not establish a median, p90, or steady-state
flake rate. The subsequent dismissal repair is absent from both comparison
commits and cannot explain their timings.

Follow-up local stress found a real search dismissal writer: a late resize
could repin to the bottom after a committed search was dismissed before the
reader's scroll event arrived. Controlled Escape and close-button regressions
fail before fencing follow intent and pass afterward; 40 unmodified Escape
repetitions passed with four workers and no retries. A separate missing initial
highlight remains tracked in its own gap. Settings search also regenerated its
navigation callbacks on every urgent keystroke, invalidating all row scopes
before the deferred query. A held row-consumer regression fails before stable
callbacks and passes afterward. Relay typing now measures captured native
frames even while its reconnect clock is mocked; the 100ms bound is unchanged.

Fixture ownership follow-ups use an explicit held command-receipt gate,
count only the expanded-search fixture's own query and roles, and give the
queue layout case a private built-client server with real persisted backlog
loaded paused after restart. Sessions API cases now join their own app services
before removing each history directory; all 41 focused cases passed. These
changes need a fresh merged full-suite and exact-SHA CI checkpoint.

The next local default-scope full run passed 346 cases with 12 skips in 4.2m
and failed one existing title-resize assertion (-2900). That oracle mixed its
first changed width with later text; it now polls text and current width in
one browser evaluation. Ten repetitions of each viewport passed, together
with ten cross-tab repetitions using stable snapshot timestamps and focusing
the typing tab before its existing quiescence baseline. All original event
ceilings, sequential 100ms typing, resize and reservation bounds remain.
A proposed non-overflow readiness wait was discarded because all phone
repetitions exceeded it by four pixels; it is not an established fit boundary.

A controlled hook regression also proves the search frame remained on a
detached row when the same render ID was remounted. The repair transfers to
the connected identity without rescrolling or resetting the original fade
deadline, and clear cancels queued transfer work. Its content observer remains
on the selected row; a separate structural observer detects remounts without
recording unrelated streaming text. The 80-case browser batch passed 79 with
one missing initial frame. A later instrumented 160-case batch passed all;
instrumentation was removed. Neither observation closes the historical frame
finding or attributes it to the independently repaired remount defect.

The intervening upstream `675a534ea` CI failed the restart scroll-memory case
on all three attempts: after restoring near the assistant tail, its opening
user-text locator found only hidden markdown copy source. The fixture now waits
for the actual final assistant paragraph, preserving saved high-water memory
and the two-pixel restore bound. That changed-source run also needed five
retry passes elsewhere; retain those as findings, not accepted reliability.

The final merged checkpoint passed the complete default-scope browser suite:
347 cases, 12 skips, four workers, zero retries, 4.2m, and clean teardown.
Root checks passed 6,148 server and 6,506 client cases (105.48s / 110.18s),
plus lint, formatting and all type gates. Six restart repetitions passed
within the unchanged 15s test budget. These are local functional observations;
the next acceptance checkpoint is first-attempt CI on the published revision.

### Exact-source repeat and remaining startup ownership — 2026-09-30

The published `cead003b4` had different outcomes at identical source. Its
[push run 36662540397](https://github.com/kzahel/yepanywhere/actions/runs/36662540397)
passed all other gates and shard 2 (178 first-attempt passes, one skip,
7m29s job). Shard 1 took 11m28s: 168 passes, nine skips, two retry passes
(artifact relay and thinking-budget entry), and a persistent restart-memory
failure. The same-source
[manual repeat 36662665230](https://github.com/kzahel/yepanywhere/actions/runs/36662665230)
passed every gate. Both shards passed on their first attempts: 171 / 178
passes, nine / one skips, 8m50s / 7m24s job times. Combined job time was
16m14s. These two outcomes are not a stable failure-rate estimate.

The restart retry trace recorded the correct restored scroll position, 4937,
but its final poll began with only 29ms remaining in the 15s test budget.
Initial private-server startup took about 5.3s, restart 4.1s, and each app boot
about 2s. This case now avoids the unused common worker server, uses a
documented 30s overall budget (twice the observed limit), and verifies loaded
history and restoration in one poll. It retains 180 paragraphs, meaningful
scroll range, unchanged saved-memory equality, and the two-pixel bound.
The trace does not prove the cause of the earlier hidden opening marker.

Artifact relay, ordinary relay and frozen thinking-budget fixtures now reuse
the immutable built remote client. The artifact case retains its private
HTTPS gateway and real relay; its viewer origin reads the shared preview port
without activating an unused common YA fixture. A deliberate raw-artifact
response on the file route failed the built-shell assertion as intended;
the temporary mutation was removed. All 21 focused cases passed with four
workers and no retries. The context popover fixture also owns subscription
usage as absent, so unrelated real provider usage cannot change its label or
popover mode. Its overlap and hit-testing checks remain unchanged. Six
restart and six popover repetitions passed without retries. These repairs
still require the merged full-suite and published CI checkpoint below.

The merged startup slice passed the full default-scope browser gate: 347
passes, 12 skips, four workers, no retries, 4.2m, with clean teardown. The
private restart case took 7.3s locally. Fresh workspace units passed 6,148
server and 6,506 client cases (115.33s / 121.99s); lint, formatting and all
type gates passed. These local observations preserve functional coverage;
the next comparison is repeated first-attempt CI at the published source.

### Final startup and audit follow-up — 2026-09-30

At `16f77a5ca`,
[push run 36665933364](https://github.com/kzahel/yepanywhere/actions/runs/36665933364)
passed all unit/native/type/lint gates but failed the newly reported production
dependency audit and one artifact popup case. Shard 2 passed 178 cases with
one skip and no retries in a 5m49s job. Shard 1 passed 170 with nine skips
and one persistent popup failure in 10m39s; the earlier restart and cold-entry
findings passed on their first attempts. The exact-source
[manual repeat 36665981830](https://github.com/kzahel/yepanywhere/actions/runs/36665981830)
passed both E2E shards without retries: 171 / 178 cases, nine / one skips,
8m59s / 6m00s jobs, combined 14m59s. Only its audit gate failed. This repeat
does not close the first-attempt or median/p90 acceptance window.

The popup retry trace proves its first Edit popup loaded the correct mode.
Its cold source fixture took 6.6s and that first full-app popup 5.7s; the
15s test deadline then interrupted the second popup's load. The case now
fully verifies each mode once and requires the other real gesture to open
the exact verified URL without toggling the source viewer. It closes that
duplicate tab at navigation commit, avoiding two redundant full-app boots.
Only this case uses the documented 30s measured budget; action and expectation
budgets remain unchanged. All six focused repetitions passed without retries.
Private artifact teardown also stops notifications before joining disposal.

The audit fixes only two compatible transitive resolutions, `fast-uri` 3.1.8
and `brace-expansion` 2.1.7, with no new exclusions. Frozen installation and
production audit passed. The first fresh unit run failed 16 Codex fake-process
cases, a focused file failed seven, and an unchanged file repeat passed 122
with two skips. The unchanged workspace repeat passed 6,148 server and 6,506
client cases (113.50s / 117.24s). The new
[Codex startup gap](../../gaps/codex-provider-unit-startup-timeouts.md) records
the ambiguous waiter, late shell receipt and unjoined-finalizer follow-ups;
neither dependency causality nor CPU contention is established.

The final merged local browser run passed 348 cases with 11 skips, four
workers, no retries and clean teardown in 4.3m. The availability-gated emulator
WebRTC `?auto` case executed in this run; the preceding local run skipped it.
No browser cases were removed. Fresh lint, formatting and strict E2E types
passed, alongside the workspace/type/audit checks above. Published exact-source
CI remains the final campaign checkpoint.

### Time-planned shards — 2026-11-09

Baseline [run 42507550642](https://github.com/kzahel/yepanywhere/actions/runs/42507550642)
(`main`, two count-split shards, two workers each) passed 582 cases with one
flaky retry. Shard 1 spent 29.7 case-minutes in 16.6m; shard 2 spent 13.2
case-minutes in 8.5m. Its global setup took 65s, 46s of it in serial
shared, local-client and remote-client builds.

All comparisons below ran on the same source of the `e2e-shard-experiment`
branch through `workflow_dispatch`, with files assigned by
`scripts/e2e-shard-plan.mjs` from the baseline's per-file seconds. Concurrent
dispatches queued for runners, so job start skew is excluded; times are the
Playwright step. Case time includes failed attempts and their two retries.

| Run | Shards × workers | Shard steps | Case time | Failing cases |
| --- | --- | --- | ---: | ---: |
| [42575122537](https://github.com/kzahel/yepanywhere/actions/runs/42575122537) | 3 × 2 | 9.0 / 10.8 / 12.0m | 52.4m | 7 |
| [42575130244](https://github.com/kzahel/yepanywhere/actions/runs/42575130244) | 3 × 3 | 7.7 / 6.7 / 8.9m | 55.4m | 5 |
| [42575137788](https://github.com/kzahel/yepanywhere/actions/runs/42575137788) | 4 × 2 | 5.9 / 6.5 / 7.1 / 7.0m | 42.3m | 5 |
| [42576927238](https://github.com/kzahel/yepanywhere/actions/runs/42576927238) | 4 × 2 | 6.1 / 6.8 / 7.9 / 6.3m | 43.6m | 5 |
| [42576936037](https://github.com/kzahel/yepanywhere/actions/runs/42576936037) | 3 × 3 | 10.2 / 8.8 / 8.4m | 64.6m | 11 |

The one failure-free three-shard job spent 15.1 case-minutes against 14.6
planned, so the plan predicts balance; the spread comes from failing cases.
Three workers on the four-vCPU runner inflated case time and doubled
failures in its repeat. Concurrent builds cut global setup by about 10s on
CI (about 50% locally). Four shards with two workers is the default.

Three cases failed every attempt on current `main` and in every comparison:
`session-page-header-paths.spec.ts:497`, `long-context-effort-warning.spec.ts:18`
and `session-page-correction-attachment-paths.spec.ts:188`. Each costs three
attempts per run and makes its shard the slowest.

Local macOS (14 cores), same source: four workers ran 601 cases in 7.6m
(27.3 case-minutes, six failures); eight workers took 5.1m (33.1
case-minutes, four failures). Four of the four-worker failures passed alone
with one worker.
