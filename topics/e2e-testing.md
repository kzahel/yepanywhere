# End-to-end testing

Topic: e2e-testing

## Purpose and boundaries

The default client Playwright suite builds the local and remote clients and
starts one YA server and relay per run, isolated from the developer's data. A
test in that suite should exercise a failure that a smaller boundary cannot
observe. Running an existing browser test after a change and adding a
permanent browser test are separate decisions.

Before retaining or adding any case, apply
[test value and CI cost](../docs/development/testing.md#test-value-and-ci-cost).
Agents may remove shallow tests, including those useful only as initial
implementation evidence. Moving a trivial mocked assertion to a cheaper layer
does not automatically make it worth retaining. Preserve meaningful regression,
integration and rare-race detection; reduce the seconds spent on retained cases.

For a test worth retaining, choose the smallest boundary that can falsify the
observable contract:

| Contract under test | Preferred check |
| --- | --- |
| Parsing, ranking, state transitions, or request mapping | Unit test of the owning function or hook. |
| Control state, conditional rendering, keyboard behavior that does not depend on browser layout, or persistence through component mounts | Component test with representative data. |
| HTTP status, response body, access rule, or filesystem effect without browser behavior | Server route or service integration test. |
| Layout, pointer targeting, focus, selection, scroll, downloads, browser security, or real sequential typing | Focused browser test. Use a lightweight page or component fixture when the YA server is not part of the contract. |
| Session launch, live provider stream, authentication, relay, reconnect, or client/server compatibility across a real boundary | Full-app E2E test with the required services. |

Browser-specific does not automatically mean full-app E2E. A visual review or
one-time design capture follows [UI testing](ui-testing.md); it does not by
itself justify a permanent regression case. Keep the real key-by-key typing
coverage required by [AGENTS.md](../AGENTS.md) for affected input paths, at
their expected data volume and concurrent-update conditions.

## Current full-app isolation debt

The full-app suite has 109 spec files and 329 listed cases as of the
2026-09-27 full local run.
Playwright's default page fixture gives each test a fresh browser context,
but `global-setup.ts` starts one YA server, relay, and data directory for the
entire invocation. Most cases share those services and their settings,
sessions, and files. `remote-login.spec.ts` now starts a separate worker-scoped
YA process and data directory for its credential-mutating cases. The run's
temporary directory isolates the default services from the developer's data
and from other runs; it does not isolate cases using those default services
from one another. There is no suite-wide server reset between cases.
The common fixture clears the seeded `mock-session-001` server draft before
each case. Specs using another seeded composer session declare its IDs with
`test.use({ draftSessionIds: [...] })`; the reset uses that spec's server URL,
including isolated server overrides. A browser-only harness with no server
draft can declare an empty list. Fresh browser contexts alone do not reset
server drafts.

This is a significant reliability gap. With one worker, files run serially;
cleanup can make the usual order pass while concealing an order dependency.
With two workers, files can overlap on the same server.
The local two-worker full-suite trial stopped after five failures; remote and
relay specs interleaved while both mutating the same remote-access
configuration, although the trial has not established the cause of each
failure. A green serial or sharded run establishes that its particular
schedule passed, not that its cases are independent. CI retries can also
conceal a first-attempt failure.

Before expanding the full-app suite or optimizing its execution further,
prioritize test independence. For each mutating spec, identify shared server
settings, auth state, session files, and relay state; run it alone and beside
the specs that touch the same state, including a changed order. Make setup and
cleanup own that state explicitly, then verify the test passes without relying
on a preceding case. Use a separate server fixture where reliable reset is
impractical. Keep shared startup for read-only checks when it remains safe;
do not pay for a server per case without evidence that the boundary needs it.
When probing a pair with two workers, use one copy of each file per invocation.
`--repeat-each` can schedule two copies of the same file concurrently on the
shared server, so it does not repeat the same pairwise experiment safely.
The [E2E suite plan](../docs/tactical/135-e2e-suite-cost-ratchet.md) tracks the
isolation work and the [open gap](../gaps/e2e-shared-server-isolation.md) records
the observed failure.

## Adding or expanding a case

Before adding a Playwright case, identify the observable regression it would
catch, the boundary that makes a cheaper test insufficient, and any existing
test of the same behavior. Put data and option variants at the lower level;
keep one browser case for the browser-specific boundary. Add desktop and phone
variants only when the contract changes across those layouts. Avoid combining
independent flows into one long case: a failure should identify the behavior
that broke without replaying unrelated steps.

Account for marginal cost before adding a case: measured case and spec time,
full-suite setup cost if a new fixture is needed, CI retry history, fixture
complexity, and how often UI changes will invalidate its selectors. A case that
duplicates a lower-level assertion needs a distinct browser failure it can
catch. Cost alone does not remove transport, security, or real input coverage;
it prompts a narrower fixture or assertion.

When changing an existing feature, update affected assertions but do not add
another E2E variant merely because its neighboring tests live in Playwright.
Move API-only checks to server tests and pure state checks to unit/component
tests when doing so preserves their contract. Do not skip or weaken a failing
case to improve suite time.

## Verification cadence

During implementation, run the relevant unit, component, route, and focused
browser cases. From the repository root,
`pnpm --filter @yep-anywhere/client exec playwright test e2e/<spec>.spec.ts`
runs a selected browser spec. Use the full local browser suite when changing
shared browser fixtures, global setup, transport, routing, or another surface
whose affected cases cannot be bounded reliably. Existing release or migration
plans may require a full local run for their own gates. State which browser
scope actually ran in the handoff.

CI continues to run the full client E2E suite. A focused local run does not
turn a failing full CI run into a pass, and CI retries do not make an
intermittent assertion healthy. Visual verification and capture remain owned by
[UI testing](ui-testing.md), including a user's explicit visual-QA handoff.

The separate iPad WebKit job allows 45 minutes for cold dependency installation
and tests. [CI 36908114440](https://github.com/kzahel/yepanywhere/actions/runs/36908114440)
exhausted the former 15-minute job limit while downloading 125 MB of Ubuntu
packages from the hosted image's Azure mirror; the browser tests never began.
The job budget is three times that observed limit, independently of Playwright's
per-test deadlines and the unchanged input-latency assertions.

The full-app Playwright configuration still defaults to one worker. Run-scoped
services share mutable state, while the opt-in worker fixture below isolates
parallel files. CI now exercises two worker-owned servers in each of the two
isolated shards. The migration remains under first-attempt/retry measurement;
cases assigned sequentially to one worker must still reset the state they
mutate.
Compare the slower shard's wall time with the single-job gate and also report
the sum of shard job times as runner cost. A partial local run stopped by the
failure limit is not a valid speed comparison; the current measurements are in
[the E2E cost ledger](../docs/testing/e2e-ci-cost-ledger.md).

### Worker-owned services

Mutable services are worker-owned by default; `pnpm test:e2e --workers=4`
needs no extra isolation environment setting. Builds and the
remote-client Vite/preview servers remain invocation-owned; each worker starts
its own seeded YA profile and relay only when a fixture needs them. The default
worker count remains one until full-suite and comparable CI evidence supports
a change. Keep `--retries=0` in diagnostic parallel runs so a retry cannot hide
shared state.

Paths derive from Playwright's `TEST_WORKER_INDEX` before spec imports, rather
than from a test callback. A replacement worker after failure gets fresh
transcripts, projects, credentials, settings and databases. Hooks that inspect
seeded files or the server port must request the worker-scoped `workerServer`
fixture explicitly; test-auto fixtures run after `beforeAll`.

Listener health is insufficient readiness for file mutation. Production
defers provider watcher attachment after binding, so a write made earlier can
enter the initial baseline without notifying an already-enumerated catalog.
Worker setup waits for named Claude/Codex/Gemini observation and completed
baselines in maintenance `/status`, then for a settled seeded catalog. Reading
these diagnostics never activates watchers or probes provider storage. Keep
live discovery and append assertions unchanged.

Custom YA servers own separate provider-host runtime directories and clear
inherited host connections. Each fixture's HOME/USERPROFILE points into its
owned profile, isolating per-user provider installation gates from the normal
user's live servers. Ordinary fixtures explicitly disable both manual reload
flags so a developer's shell does not enroll them in source watching or display
reload banners over tested controls. A reload-specific fixture may opt in
through its explicit environment. The legacy run-scoped server uses the same
home and reload isolation. Their short run-owned runtime paths avoid Unix
socket length limits. Await `disposeYaServerProcess` before removing storage;
restart preserves its profile and host. Atomic recovery records let global
teardown reclaim detached children after worker failure, and failed cleanup
retains its recovery state. An E2E-only spawn observer records detached host
launches before readiness, covering crashes before `host.json` publication.
An incomplete launch receipt fails cleanup and retains evidence; descriptor
absence alone cannot establish successful reclamation. The observer preserves
the real attach/start path and restart lifetime. On Unix, recovery validates the recorded process
identity and waits for the whole process group, including descendants after
the leader exits. Windows uses bounded `taskkill /T /F`; detached-tree recovery
and PID-reuse protection are weaker there and are not established by Unix
tests. Worker ownership prevents concurrent mutation;
each spec must still undo state it leaves for the next case on that worker.

Fetch-then-fulfill route handlers use `routeWithDrain` when they can remain
active after assertions. The page fixture settles all managed callbacks
before removing interception patterns and reports handler errors. In
Playwright 1.58, `unrouteAll({ behavior: "wait" })` alone can force-continue a
sibling request while its callback still awaits a fetch response.

Windows cleanup runs `taskkill /T /F` asynchronously so launcher pipes and
child exit events can drain. A nonzero result is accepted only after the owned
target is verified absent; a live target still fails cleanup with the command's
diagnostics. Computer-control CI retains its browser traces on either platform.
Packaged startup checks wait for valid port-file contents rather than treating
file creation as publication, and include the selected port in readiness errors.
Browser assertions inside a short settling window control browser time while
preserving the real response/render path, then resume or advance its timer to
verify the settled state. Assertion round-trip latency must not consume the
window being asserted.

A full local run on 2026-09-29 passed 345 cases with 12 platform/device skips,
two workers and no retries in 8.0 minutes, including teardown. This establishes
one passing schedule on macOS. The merged repair passed 347 cases with 12
skips and four workers without retries; the Linux full CI run also passed,
with one relay typing retry and no retries in the repaired startup cases.
Worker ownership is now the default, while `YEP_E2E_SERVER_SCOPE=run` retains
the explicit legacy timing control. Repeated first-attempt reliability and
comparable timings remain the acceptance gate; the historical shared-state
failures above are the reason for this migration.

`pnpm e2e:typecheck` checks the Playwright specs, configurations and support
modules with Node and browser types. Root `pnpm typecheck` includes this gate;
Playwright's transpilation alone does not check fixture contracts. Global setup
calls Vite directly for the invocation bundle; it does not repeat the client
TypeScript compilation already required by the root gate. Run `pnpm typecheck`
when changing fixture contracts; a standalone Playwright run is not that check.

Private YA fixtures can request `serveBuiltClient: true` to serve the immutable
invocation bundle without another Vite listener. Use it when the test needs the
real application but does not import source modules or depend on development
behavior. Retain Vite for source-entry/component and dev-server contracts.
Remote relay, frozen-share layout and artifact gateway fixtures likewise use
the invocation's `remotePreviewURL` when they require no source imports or HMR.
The native-webview check prebundles its test host and installs it before the
built UI starts. A test-only bridge does not require serving the entire app
through Vite. Keep that bridge in test tooling; production CSP still applies
to the UI and must not be relaxed for a cross-origin fixture import.
Creation fixtures register their owned project before exercising launch, so
project admission does not depend on a transient discovery/virtual-project
cache entry or on source compilation delaying the first interaction.
Multi-browser creation tests establish initial draft publication through the
real draft read API before opening an auto-focused second editor. The normal
draft quiet debounce can publish an intermediate prefix while typing continues;
a focused nonempty editor deliberately holds later remote text until blur.
Keep the local sequential-typing assertion and verify the full server snapshot
as the handoff precondition before testing delayed creation acknowledgement.
The in-process Project App fixture also serves the invocation's built client;
only its project's live-preview process needs Vite/HMR. It mounts real auth and
server-settings services so principal resolution can admit the Apps settings
pane. Unknown API requests return 404 instead of falling through to SPA HTML.
The artifact gateway keeps a distinct viewer hostname, private relay and HTTPS
artifact origin; its file route must return the remote shell rather than raw
artifact HTML. Private fixtures can read the shared preview port without
activating the common mutable YA fixtures.
A supplied `mockClaudeSession` enrolls the retained Claude store before server
startup; writing a transcript alone does not establish discovery membership.

## Measuring value, time, and instability

For each reduction pass, record a fixed source revision, the cases changed,
their unique browser/server assertions, and the lower-level coverage that
replaces them. Measure before and after on comparable runs:

- Per-case and per-spec elapsed time, plus full job wall time and setup time.
  Report median and a high percentile across enough CI runs to distinguish a
  change from runner noise; a single local run is a prioritization signal.
- First-attempt failures, retry passes, and final failures by case and commit.
  Separate product regressions, broken fixtures/builds, and intermittent tests.
  Repeated failures across commits are not a flakiness estimate.
- Coverage retained at each boundary: which real browser, server, or transport
  failure would still be detected after a move or consolidation.

Review the slowest specs and any retrying case first, but prioritize removable
duplication over an expensive case with unique boundary coverage. Compare CI
history before changing timeouts; [test time budgets](test-time-budgets.md)
owns timeout evidence. The current reduction sequence and its baseline live in
[the E2E suite ratchet plan](../docs/tactical/135-e2e-suite-cost-ratchet.md).

### Fixed-source CI comparisons

The CI workflow accepts manual `e2e_workers` (1, 2 or 4 per shard) and
`e2e_scope` (worker or legacy run) inputs. Push and pull-request runs retain
worker scope and two workers per shard. A manual run still executes every CI
gate, so it is a complete verification of its recorded `headSha`. Dispatch
comparisons against the same revision and verify that SHA before comparing;
a later push can advance `main`. Rerunning a recorded run retains its source
and inputs. Record first-attempt failures, retries, per-shard service time,
combined job time and runner start skew in the cost ledger.
Use legacy run scope with one worker as the speed control; larger counts
in that scope exercise known shared-state failures and cannot establish speed.
The downstream deployment job ignores manual CI completions, and its job-level
concurrency prevents skipped completions from cancelling a push deployment.
