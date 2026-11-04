# Native provider integration scenarios

Status: foundation and first app-continuity slices implemented, 2026-11-04.
Retained coverage is 60 native cases across ten production launch paths, plus
four Claude/Codex full-app API cases and two browser scenarios (three local
repetitions per provider). Pi successful queued compaction is implemented.
Hosted platform acceptance and the opportunities below remain open; this is
not a completed comprehensive-coverage plan.

The durable contract, commands and qualification matrix live in
[native provider testing](../../topics/native-provider-testing.md). This plan's
[opportunity backlog](#opportunity-backlog-and-recommended-next-work) is the
single entry point for the follow-ups unlocked by that infrastructure. The
[roadmap](../roadmap/README.md) still owns product priority; individual linked
gaps own concrete defects. Ignored `tasks/` logs are supporting evidence,
not the durable backlog.

## Opportunity backlog and recommended next work

Updated 2026-11-04. These are candidates, not authorization to implement every
row or reopen the general core refactor. Keep one inventory here instead of
copying it into the topic and roadmap. Mark a row implemented only when its
own boundary has evidence; recheck linked gaps against current source before
starting, since adjacent work may already have repaired them.

Already delivered: actual pinned executables and four scripted model wires;
queue/tool/history scenarios for all ten paths; cancellation/continuation,
model restoration and rate-limit recovery; Claude/Codex/Pi queued compact;
and the bounded Claude/Codex app reload/approval/tool/browser schedules.
The app slice also exposed and repaired Codex's empty started-snapshot race.
Exact versions, costs, platform limits and commands stay in the owning topic.

### Recommended next selections

1. **Resolve input identity and manual batching.** Queue A/B through YA and
   steer A/B natively at controlled model/tool boundaries. Inspect actual native
   requests, authoritative receipts, reopened history and one browser echo case.
   Demonstrate where YA concatenates independently of native grouping. Then
   decide whether each manual join has a justified consumer; remove unsupported
   joins or preserve every input's provenance. Keep explicit YA Queue ordering
   and native steering distinct. This returns to the original product question,
   rather than making infrastructure expansion the end in itself. Owners:
   [merged echoes](../../gaps/merged-queued-turn-orphans-chunk-echoes.md),
   [durable input identity](../../gaps/provider-user-turn-durable-identity.md),
   [delivery intent](../../topics/message-control-steer-queue-btw-later-interrupt.md).
2. **Qualify loss of the runtime owner.** Existing app tests replace Hono while
   its host/worker survives. Next kill the wrapper, host or worker independently,
   cut control during approval/tool execution, and cover terminal signals.
   Place faults before and after admission/receipt; assert bounded teardown,
   no second writer or automatic duplicate submission, and honest recovery from
   persisted state. Do not promise continuous turns after their owner dies or
   persistence of volatile queues. Include the dense-output macOS schedule and
   correlate identities/logs before reconsidering its default. Owners:
   [reload runtime](../../topics/reload-safe-provider-runtimes.md),
   [macOS interruption](../../gaps/macos-provider-host-turn-interruptions.md).
3. **Make reviewed platform runs and upgrades routine.** Obtain and review the
   existing manual Linux/macOS acceptance runs before promoting scoped jobs to
   gates. Run unchanged semantic scenarios for provider upgrades; pin/check real
   executables and keep unsupported/missing cells explicit. Track provisioning,
   scenario, teardown, retries and runner cost separately. A local macOS pass
   is not Linux/Windows acceptance. Owners:
   [qualification](../../topics/native-provider-testing.md),
   [provider refresh](../../topics/provider-refresh.md).

### Further opportunities unlocked by the same harness

| Opportunity | Concrete next evidence and benefit |
| --- | --- |
| Admission and retry ambiguity | Cut model/control connections before acceptance, after acceptance and during output; inject terminal errors, retry exhaustion and truncated streams. Establish which input ran, what can safely retry, and which outcomes stay uncertain. Fake control peers complement real executables for faults native CLIs cannot emit. |
| Durable live-to-history identity | Extend beyond providers that retain supplied UUIDs. Verify authoritative native receipt mappings survive reload/cold resume, exact-turn links resolve and identical text does not conflate inputs. Reuse the identity gaps above; text matching alone is insufficient. |
| Settings and permission truth | Exercise effort/model/permission changes, approval denial, tool cancellation, launch-only controls and explicit unsupported/restart-required outcomes. Check the actual next request and tool effect, including refused writes in an owned project. Audit native-only steering/urgency affordances before exposing them; do not require every provider to expose the same controls. |
| Remaining compact/activation paths | Exercise supported automatic compaction, compacted cold resume and restart/handoff native dispatch without sending commands as ordinary prompt text. Recheck the [restart compact gap](../../gaps/restart-compaction-codex-literal-text.md) and [start-window coverage](../../gaps/codex-compact-start-window-untested.md) before selecting a repair. Keep this below the frequently used input path. |
| Concurrent session isolation | Run two real sessions through Supervisor/host. Cancel, compact, change a setting or reload one while the other streams; assert separate identities, histories, queues and callbacks. Add browser coverage only for a distinct UI boundary. |
| Unwanted background calls | Inventory title, recap, suggestion and subagent requests with options off/on. Prove applied versus unsupported controls and zero unexpected model requests; turn the [side-effect audit](../../gaps/provider-session-side-effect-controls.md) from belief into native evidence. |
| Authenticated and relay recovery | Reuse existing owned auth/relay fixtures with a real native session. Disconnect/rejoin during a turn, expire or revoke access and verify scoped replay and no duplicate submission. Keep credential/transport tests separate from inference quality. |
| Tools, media and saved rendering | Feed real native file/edit/tool results and fixture media through production readers/compiler; compare live and reopened presentation. Close the remaining [native display coverage](../../gaps/tool-display-native-provider-coverage.md) cells selectively, instead of duplicating every browser case for every provider. |
| Provider unification and deletion | Start with two concrete Claude/Codex paths. Write common assertions for admission, consumption, cancellation, command completion and readiness; keep native translation in adapters. If duplicate policy really has the same contract, consolidate it and delete the old branches under unchanged scenarios. Keep gentle/immediate scope differences explicit. No new provider superclass, scheduler or conversation store is selected. |
| Reproducible race exploration | Generate a bounded set of input/steer/compact/cancel/reload schedules around held real model/tool barriers. Record the failing schedule and version, then minimize it into a regression. This is proposed depth, not an existing exhaustive or property-testing engine. |
| Retention and responsiveness | Use dense output and larger saved histories to check bounded replay/memory, backpressure, process/listener cleanup and sequential typing. Keep measured platform-specific budgets; no-inference tests do not establish paid-service latency or cache efficiency. |
| Packaging and release parity | Reuse the same model/tool actions through built or installed artifacts and current release acceptance. Coordinate with the [release work](../development/releasing.md); do not create a competing package-smoke framework or claim source-wrapper checks qualify shipped artifacts. |
| Diagnostics and test simplification | Retain bounded phase/request/identity evidence for failures and an independent expected-capability inventory. Replace shallow mocks or stale trace expectations only when surviving native scenarios protect their useful contract; keep protocol-fault and old-history regressions. |

### Keep the thread durable

When selecting a row, add its bounded next scenario and acceptance here, then
record current behavior/results in the owning topic and product status in the
roadmap. Link or remove the corresponding concrete gap when actually resolved.
Keep completed evidence separate from proposed opportunities. The next session
should be able to start from this section without reconstructing the chat or
reading private `tasks/` output.

The native harness qualifies scheduling, protocol, tools, persistence and app
behavior against controlled model replies. Real subscription/auth setup,
provider service behavior, model quality, billing/cache efficiency and sustained
OS lifecycle still need their appropriate live/platform evidence. This backlog
is neither a full-code-coverage claim nor a requirement to run every combination
on every change.

## Outcome and standing direction

The maintainer selected actual provider executables against scripted local
model APIs as the primary integration evidence for native behavior. Build
reusable action/expectation scenarios, rather than making recorded provider
conversations the authority for current behavior. Use this evidence before
refactoring scheduling, steering, attribution, cancellation and recovery.

YA Queue means complete the current turn, then deliver A, then B separately.
Native steering remains a separate intent and may group inputs itself. Manual
YA text concatenation requires demonstrated value and explicit policy; it is
not a prerequisite for either queueing or native steering. This slice first
establishes executable-backed evidence, without silently changing queue defaults.

Relevant prior work: [plan 174](174-shared-steering-and-native-urgency.md),
[captured fixture replay](127-captured-provider-fixtures.md),
[provider abstraction](../../topics/provider-abstraction.md),
[delivery intent](../../topics/message-control-steer-queue-btw-later-interrupt.md),
[merged-input identity defect](../../gaps/merged-queued-turn-orphans-chunk-echoes.md),
and [provider-native user identities](../../gaps/provider-user-turn-durable-identity.md).
The local investigation in `tasks/batching-investigation/` confirms native
Claude 2.1.312 next/later grouping with an isolated API stub, and YA's separate
timing-dependent input-queue concatenation. Existing real-Claude helper/creation
tests and Pi's local-server retry test are reusable starting points. T3's
shared replay scenarios/gates are useful structure; its replayed SDK/CLI
boundary does not execute the current native provider implementation.

## 1 — own native processes and local model exchanges

Reuse owned profile/environment facilities. Remove inherited provider/account,
agent and shell authority, use synthetic credentials and loopback endpoints,
reject unexpected model routes/requests, and join native/server cleanup on
failure as well as success. Capture executable path/version and exercised
capabilities. Missing required executables or an unsupported selected provider
must fail the explicit integration command, not silently pass as skipped.
Never fall back to paid inference or a fake provider executable.

Keep scripted Anthropic Messages and OpenAI Responses transports small and
event-driven. The stub determines response/tool/finish barriers and records
actual requests; tests assert semantic ordering/content/identity and native
history, not a golden notification trace. No browser is required for a
server/provider scheduling contract. Shared scenarios retain provider-specific
capability expectations instead of requiring false all-provider parity.

## 2 — qualify Claude and Codex through YA

Use the bundled real Claude runtime and an explicitly pinned test Codex runtime
matching the audited target. Test-only dependency installation must not upgrade
the user's CLI/configuration. Start with real text/tool execution, exact input
and native history, queue A/B ordering through YA Process, and native steering
while a controlled request is active. Extend cancellation/recovery when the
fixture establishes the native evidence required to assert those outcomes.

Run these through one documented integration command and CI. Ordinary parsing,
fake-peer fault injection and historical replay remain valuable at their own
boundaries; they must not be reported as current-native qualification.
Measure setup/scenario/teardown cost and use event gates instead of sleeps.
Report versions and scenario results, with actionable failures and no real
credentials. Preserve fast focused invocation for subsequent provider refactors.

## 3 — audit every retained provider family

Record endpoint override, protocol, authentication prerequisites, installed
executable availability and current qualification for Claude variants, Codex/
OSS, Pi, OpenCode, Grok, Gemini ACP aliases and Antigravity. Reuse transports
where their real model protocol matches. Qualify a provider only with its real
executable; distinguish startup/control-only evidence, unsupported local-model
routing and unavailable installations from a passed inference-free scenario.
Do not change frozen provider/product policy merely to make a test green.

## 4 — make the direction durable

Own the testing contract in a topic linked from development/provider-refresh
guidance. Provider upgrades must run the applicable native scenarios and state
the version tested; optional additional versions belong in isolated test roots.
Keep the roadmap explicit about implemented coverage and remaining cells.
Run required workspace/static checks, retain meaningful regressions, and commit
the foundation and qualification findings without absorbing concurrent work.

## Implementation and verification, 2026-11-03

Steps 1 and 2 are implemented in `packages/server/test/native-provider/`:
real SDK-bundled Claude 2.1.312 / SDK 0.3.312 and test-pinned Codex 0.166.0,
shared controlled Messages/Responses exchanges, standalone roots/environment,
actual YA Process scheduling and joined native/listener cleanup. Four scenarios
per provider cover separate queued A/B turns and durable UUIDs, actual tool
execution, native-acknowledged gentle steering and response-cancelling immediate
steering. They assert YA output, native requests/history and clean shutdown.
No paid inference, primary CLI upgrades or UI changes are involved.

The suite exposed Claude's requested cancellation being reported as an SDK
`errorClass: "aborted"` error instead of an `AbortError`. The narrow repair
requires YA's abort signal as well as that classification. The shutdown assertion
fails before the repair and passes after it; unrelated SDK failures remain errors.
The stronger steering output assertion also exposed a fixture race: previous-turn
idle is not completion of the correction. The test now waits for correction
output before final idle, and for actual streamed output/native receipt before
finishing the original gentle-steer response.

The initial Step 3 family audit has since been extended by the endpoint and
Antigravity depth investigation below. Its earlier “unqualified route” cells
are superseded by the owning topic's dated matrix. Feasibility is distinct
from retained CI qualification.
Step 4's documentation, root command, strict helper typecheck and ordinary CI
suite integration are implemented. Linux/Windows execution remains CI acceptance,
not a claimed local pass.

Focused eight-case runs pass without warnings/errors; initial samples cost
1.75–4.16 seconds of test work and 2.56–5.82 seconds including Vitest startup.
The Codex-only selector passes four cases; selecting unqualified Pi fails clearly
before any native model scenario. Lint, formatting and root typechecking pass.
The corrected workspace run passes: 6,941 server and 7,092 client tests,
plus shared/relay/other workspace checks (server 143.46 seconds). The native
suite also passes after moving Codex into a private test-tool dependency so
its CLI bin cannot shadow the normal development PATH; frozen install passes.
The earlier full run caught the known independent Rendez restart delivery gap,
reproduced in isolation. That red result remains recorded in
[the watcher gap](../../gaps/rendez-nested-watch-event-after-restart.md); the
later passing run does not close it. Existing intentional fault-fixture logs
remain tracked in [suite diagnostic debt](../../gaps/full-suite-timing-and-diagnostics.md).
No broad logging suppression, watcher fix or timeout increase is bundled here.

## Retained breadth implementation, 2026-11-04

The owning matrix supersedes the eight-case baseline below: 20 retained cases
now exercise all ten launch paths, sharing a queue/tool/history workflow and
native steering only where exposed. Claude/Codex retain six baseline cases
because the tool round trip is folded into A's queued turn. All selected
executables are exact test dependencies or official checksum-verified artifacts;
missing runtime/version/platform fails explicitly. The all-provider command
passes in 22.21 s locally, including runner startup. Primary installations,
provider targets, UI and queue defaults are unchanged.

Real Codex OSS resume lost assistant output because it parsed human headings.
New/resumed exec turns now both request native JSONL, removing the old text and
duplicate-half parser. Existing 22-case service/resume checks and the full
workspace suite pass. The expanded native cases assert production reader
history, clean owned teardown and no unexpected diagnostics/model requests.

## Retained depth implementation, 2026-11-04

The owning topic records 57 passing cases across ten paths, including actual
file-tool cold resume, native id/context/history preservation, graceful and
hard-stop continuation, OpenCode non-Git continuation, live/cold model selection,
Antigravity cold-load model reapplication, and all-provider controlled 429
recovery. Claude/Codex queued compact actually finishes before separate A/B;
Pi's native too-small refusal holds following input until explicit cancellation.
Successful Pi compact boundary/terminal publication remains unqualified.
Frozen Gemini preserves its explicit unsupported-resume refusal; no protocol,
authentication or UI expansion was made.

Native tests drove narrow production repairs for Codex replayed usage/control
ownership, Pi false-positive model acknowledgement, cross-process OpenCode port
collision and ACP worker-tree teardown. The latter also classifies requested
transport closure narrowly, preserving unexpected native errors. The earlier
Codex OSS output repair is committed separately. YA warning/error logs, including child loggers,
are captured and asserted; existing intentional unit-fault logs were cleaned up
in their own tests rather than suppressed globally.

The complete run passes in 50.23 s wall time locally; 192 focused provider cases
pass in 24.01 s. Full workspace and static checks pass. A manual Linux x64
acceptance workflow runs the complete set with verified artifacts; it must pass
and be reviewed before becoming a change gate. Baseline Claude/Codex cases
continue to run in ordinary CI. Linux/Windows are not locally qualified.

Steps 5–7 now have substantial retained coverage, not complete acceptance.
Next are successful Pi compact, approvals and terminal failures, native batched
identities, wrapper settings and Supervisor/provider-host restart ownership.
Steps 8–9 and the remaining platform matrix stay open; this is not full code
coverage or completion of the comprehensive program.

## Comprehensive expansion — maintainer direction, 2026-11-03

The maintainer wants this to become comprehensive integration assurance across
providers, including cancellation, steering, interruption, model changes,
resumption and persistence. Apply shared scenarios wherever the real provider
supports them; investigate endpoint feasibility before defining coverage gaps.
Use those scenarios to make later simplification safe, rather than continuing
with ad hoc post-change sessions as the main evidence.

This extends the selected plan; it does not restart the archived session-core
rewrite, select a new transcript store or authorize speculative UI controls.
Keep the production adapters and native stores as the systems under test.

### Endpoint investigation and current evidence

The [owning matrix](../../topics/native-provider-testing.md#all-provider-adoption-matrix)
records exact versions, endpoint controls and evidence boundaries. In owned
profiles with synthetic credentials, real production adapters completed local
model round trips for Pi 1.4.0, OpenCode 1.18.9, Grok 1.0.67, Gemini ACP 0.36.0
and Antigravity ACP 1.4.5. Claude Gateway/Ollama also reached local Messages
through their actual launch paths. Codex OSS's distinct exec path reached local
Responses; using known native model metadata removed the exploratory
unknown-model diagnostic, with no error events in the corrected route probe.
The November 4 retained breadth milestone above supersedes this initial audit.

The real Antigravity ACP runtime additionally read an owned file, delivered its
result to the next model request, changed model, cancelled an open response,
and loaded its native conversation in a new process with prior input/tool
context intact. It reset the model selection on cold load. This is strong
feasibility evidence for deeper tests, not proof those operations pass through
YA's complete app, public identity, readers or restart ownership.

Native controls and YA features are different inventories. Antigravity exposes
native model control, while its current YA adapter applies model only at launch
and exposes no live setModel/steer hook. Pi's native steering facilities likewise
do not mean YA currently advertises steering. Test the current contract first;
new controls require a separate feature decision after the evidence is available.

Initial control inventory from current production adapter hooks (source evidence,
not a new passing scenario matrix):

| YA launch path | Native steering through YA | Graceful interrupt hook | In-process model hook |
| --- | --- | --- | --- |
| Claude / Gateway / Ollama | Gentle and per-message Now | Yes | Yes, SDK control |
| Codex app-server | Gentle; launch-scoped Immediate | Yes | Yes, native turn/settings semantics |
| Codex OSS exec | None advertised | None; verify hard-stop path | None; verify public restart/next-launch behavior |
| Pi RPC | None advertised | Yes, RPC abort | Yes, RPC set_model |
| OpenCode server | None advertised | Yes, native abort endpoint | None; verify public restart/next-launch behavior |
| Grok ACP | Gentle interject, no Now | None; verify hard-stop path | None; verify public restart/next-launch behavior |
| Gemini ACP aliases | None advertised | None; verify hard-stop path | None; model selected during startup |
| Antigravity ACP | None advertised | Yes, native session/cancel | None; model selected during startup despite native set_model support |

All have native history/continuation integrations that need their own production
reader and cold-resume scenarios; the hook inventory does not establish those
work. Manual compaction/commands, effort, approvals, media and process-host
support need operation-specific applicability. Keep unsupported controls visible
in the report instead of synthesizing them for common-test convenience.

Probes and results are retained under ignored `tasks/native-provider-coverage/`.
They are exploratory, not a parallel test framework to ship. Promote successful
recipes into the existing native fixtures with strict assertions and cleanup.
No primary CLI, provider account, compatibility marker or product default was
changed. Native Linux/Windows qualification remains pending.

### What comprehensive coverage means

The target is a reviewed matrix of **YA-visible behavior × production launch
path × relevant runtime/platform**. Every required cell needs an assertion,
an explicit unsupported-operation contract, or a named unresolved blocker.
A generic green provider turn is not completion of its matrix.

Use line/branch coverage of YA's adapter, normalization, scheduling and reader
code as a secondary way to find unexercised paths. A percentage cannot establish
ordering, no duplicate delivery, identity or cleanup. These tests cannot measure
all code inside proprietary executables, real inference quality, real cache
reuse/billing, OAuth renewal or the public service's production behavior.
Keep bounded live authentication/inference checks for those distinct boundaries.
No inference is required for the scripted behavioral matrix below.

### Scenario depth and acceptance

| Surface | Controlled scenario and required outcomes |
| --- | --- |
| Startup, discovery and routing | Exact native version; native catalog and selected model; explicit endpoint/auth scope; unavailable runtime and invalid config fail clearly. No implicit alternate executable, paid endpoint or fresh-session fallback. Distinguish model-discovery/auth readiness from directly starting the adapter. |
| Streaming and turn completion | Multiple text deltas, thinking where supported, tool rounds, final text and usage. Interim text/tool completion must not become final idle. Final YA events and production reader output agree on logical content and status. |
| YA Queue and batching | Hold a real turn; enqueue A and B; neither starts at interim output/tool completion; complete the turn, A, then B. Exercise editing/removal, native queue refusal, two id-only inputs, attachments and native grouping. Record exact multiplicity/order and source identities; use this to resolve the existing concatenation/echo defect. |
| Gentle and immediate steering | Wait for actual native receipt while generation or a tool is held; assert when correction reaches the model. Immediate mode must cancel the applicable work and deliver once; gentle mode must preserve its defined boundary. Test refused controls and duplicate/fallback races. Unsupported urgency must not be advertised or silently substituted. |
| Stop and hard shutdown | Stop during streamed text, a tool, pending approval, compact, idle and just after completion. Where supported, graceful stop preserves the native process/session and accepts the next turn; hard abort reaps the owned tree and emits one terminal outcome. No phantom SDK error or stale pending callback. |
| Tools, approvals and questions | Actual owned-file read/write and shell command, tool failure, multiple/parallel tool calls, native permission allow/deny/cancel and fixed-choice/free-text questions where available. Denial causes no side effect; cancelled approval cannot act later. Test the provider's actual tool schema rather than constructing its output. |
| Model, effort and permission changes | Verify the next actual request's model/effort and native acknowledgement. Cover idle change, busy deferral/refusal, initialization-only settings, unsupported values and failed change preserving prior state. Cold restart must restore YA's chosen settings according to current contracts, independently of native defaults. |
| Persistence and readers | Let the native executable write its own files/database; stop and reopen through YA's production reader. Compare user/assistant/tool/usage semantics, IDs and ordering with the live stream. Cover Git/non-Git projects, Unicode paths, attachments, partial/truncated tails and reader disposal. Do not manufacture the transcript under assertion. |
| Cold resume, ownership and identity | New native process under the same owned profile; continue from the real native address while preserving YA public ID and scope. Inspect the next model request for prior input/tool context and exactly one new input. Missing/wrong source, foreign project, changed store and refused resume never allocate a replacement conversation. Test active-owner reads without a competing loader. |
| Compaction and context | Queue `/compact`, A, B through YA. Script the summary/model exchanges and verify compact happens first, user input is not swallowed or concatenated unintentionally, native history/reader context survives, and following requests use the compacted history. Add failed, cancelled, automatic and compact-first-resume paths only where the provider actually supports them. |
| Errors and recovery | Inject 429/Retry-After, retryable 5xx, terminal 4xx/auth/model rejection, broken/truncated SSE, disconnect before and after acceptance, and an abrupt owned native exit. Assert bounded retry/cancellation, actionable error, preserved history and no duplicate input. A syntactically accepted error frame is not proof of recovered behavior. |
| Side effects and usage | Inspect all local model calls, including title, summary, suggestions and subagents. Verify requested off/applied/unsupported/restart-required results instead of treating omission as success. Check scripted token/cache-usage normalization and persistence, without claiming measured cache efficiency. |
| App continuity and concurrency | Through real Supervisor/storage and a standalone Hono process: admission, two concurrent sessions, detach/reconnect, queued work across replacement, canonical ID binding and supported provider-host reload. One session's cancellation/model/store cannot affect the other. Exercise exact acknowledgement-before/after-failure barriers. |
| Presentation and media | For distinct native reader/normalization paths, carry real tool input/results and fixture media through the production compiler. Retain a small browser layer for actual optimistic-echo reconciliation, pending approval, queue controls, model picker and sequential typing during concurrent streaming. Native-only tests do not qualify those UI outcomes. |

Apply the relevant rows to every provider, with explicit capability expectations.
The core common rows are routing, text/tool turn, YA Queue, hard shutdown,
persistence and continuation (or the provider's explicit refusal). Never demand
identical native UUIDs or steering APIs from every provider. For providers that
do not retain YA UUIDs, assert supported mapping/provenance separately from text
multiplicity and retain the unresolved identity gap. Text matching is not a
substitute durable identity contract.

Relevant gaps remain independent acceptance inputs:
[merged input echoes](../../gaps/merged-queued-turn-orphans-chunk-echoes.md),
[durable user identity](../../gaps/provider-user-turn-durable-identity.md),
[side-effect controls](../../gaps/provider-session-side-effect-controls.md) and
[native display conversions](../../gaps/tool-display-native-provider-coverage.md).
Adding a test does not close one without resolving its full remaining obligation.

### 5 — promote endpoint recipes into retained all-provider fixtures

Extend `test/native-provider/`, preserving the existing root command and strict
typecheck. Add GenAI and Chat Completions alongside valid Messages/Responses.
Share semantic actions and small model-wire emitters; keep provider launch,
receipt, tools, capability expectations and production history acquisition
explicit. There is no new production provider interface or generic replay DSL.

Start with Antigravity (new provider and proven deep routing), then Pi/OpenCode,
Grok, alternate Claude/Codex launches and the frozen Gemini ACP baseline. Basic
routing is now demonstrated, so installations alone are not a reason to defer
these families indefinitely. Reuse the Pi effort-retry route and replace overlap
only when the new retained scenario protects its actual refusal/retry contract.
Codex OSS is a distinct exec lifecycle, not another name for app-server coverage.
Keep the native Ollama discovery branch separate from configured Responses
services; no model weights/server inference are needed to script its discovery.

Provision exact test-only runtimes from official immutable versions/artifacts.
Keep native companion files together and record version, official artifact
source and integrity for hosted CI provisioning.
Reuse the private nested test-tools dependency pattern; no CLI shim may shadow
normal YA development discovery. No global installs, provider refreshes or
version-floor changes are part of coverage provisioning.

Acceptance per newly retained family: local prompt/reply, one actual tool,
separate queued A/B turns, clean joined abort and production history read. Add
its defined graceful interruption/control assertions next; label the remaining
depth explicitly. Fail when a selected required runtime is missing or mismatched.
Do not convert an unqualified/failed cell into a passing skip.

### 6 — deepen cancellation, settings and durable continuation first

For each qualified family add a small multi-turn lifecycle scenario: read a
fixture file, hold a streamed reply, interrupt, continue, change supported model/
effort, stop the owner, reopen the production reader, then cold resume with the
same native source and verify prior context plus exactly one new input.
Use separate fresh scenarios for terminal/error branches so earlier state cannot
mask them. One concrete source-audit risk to test is Pi's current `setModel`
catching and discarding an RPC rejection: an invalid native model must not be
reported by YA as successfully applied. Establish the failing scenario before
choosing the adapter/Supervisor correction. Cover unsupported operations with explicit YA rejection/fallback
assertions and zero unintended model requests.

Antigravity's observed cold-load model reset is the first concrete setting
restoration case. For live model switching, test the public current YA behavior;
keep direct-native affordance experiments separately labelled until YA exposes
that operation. Preserve preview Windows unavailability, frozen Gemini policy,
subscription-key filtering and native-store validation.

### 7 — protect input identity and queued compaction before simplifying

Extend the current queue/steer tests to real tool boundaries and multiple input
identities, including native grouping. Capture both native API inputs and
production reader output; verify there is no extra optimistic/sent echo through
one focused UI case. Establish the fail-before case for the merged-input gap.
Only then decide removal of implicit YA concatenation, keeping native steering
and explicitly ordered YA Queue separate.

Add queued compact plus A/B, cancellation during compact and cold continuation
of compacted history. Put shared assertions at the Process/Supervisor layer,
with provider-specific command/control hooks. Do not silently emulate a missing
provider compact command to produce false parity.

### 8 — add fault, approval and ownership interleavings

Extend model transports with explicit held-response, tool-result, permission,
error and connection-cut barriers. Test both sides of admission/acknowledgement,
not only a disconnect before any work begins. Fake app-server/ACP peers remain
appropriate for malformed control messages that real executables cannot emit;
their results must stay distinct from native qualification.

Use the existing standalone YA lifecycle, Supervisor and reader facilities for
HTTP/restart/host tests. Do not create a parallel orchestrator or durable store.
Separate provider-host capable paths from ordinary in-Hono ownership and test
the documented fallback on unsupported platforms. No browser is needed for
server ownership, persistence or native cancellation.

### 9 — grow CI and coverage reporting without a Cartesian explosion

Keep fast core scenarios in ordinary CI; add provider-specific depth to the
relevant change gates and an explicit full native-provider job. Use the full
job for all qualified families, supported platforms and selected alternate
runtimes; keep expensive combined host/restart/fault schedules separately
attributable. Every new mandatory cell must have measured setup/scenario/
teardown cost before deciding cadence. The initial three-second two-provider
sample is not evidence that hundreds of scenarios or binary installs stay cheap.

Cache immutable binaries/dependencies by version, platform and integrity; never
cache authenticated profiles. Report provisioning separately from execution,
plus total wall time, worker load, retries and failures. Keep per-case timeouts
under the measured [budget policy](../../topics/test-time-budgets.md).
Use separate test processes/files when parallelizing environment-owning fixtures;
never mark cases sharing `process.env` concurrent. Prefer a few intentional
multi-turn workflows to dozens of repeated native startups, without cross-test
state or broad error suppression.

Maintain an explicit coverage inventory linked to production provider IDs and
independent expected behaviors. A new registered provider or public control
requires a coverage decision. Do not derive all expected coverage from the same
capability booleans under test: an accidentally false capability must not silently
skip its regression. Reports distinguish retained pass, observed native-only
capability, expected unsupported behavior, exploratory success, unresolved defect
and untested platform. CI must never summarize those all as “covered”.

### Completion criteria and refactor use

- All retained provider names and distinct launch paths have matrix entries;
  required supported-platform core cells run real executables with no inference.
- Cancellation/next-input, settings, native persistence/reader and cold resume
  have retained scenarios for every supported path; unsupported operations have
  externally observable refusal/fallback checks. Deeper rows remain visible
  until implemented, rather than disappearing behind a broad completion label.
- Failures retain bounded native version/request phase, YA event/state and
  owned-history diagnostics without credentials or unrelated private history.
  All owned listeners, processes, readers and asynchronous cleanup are joined.
- Before a refactor, run the affected scenarios on the old implementation;
  demonstrate the regression where feasible; make the bounded change; rerun
  unchanged semantic assertions and relevant workspace checks. Consolidate/remove
  shallow overlap only after identifying the surviving boundary coverage.
- Real service authentication, inference quality/cost/cache efficiency and real
  OS/browser presentation keep their separate acceptance. No “full code coverage”
  claim is made for native proprietary internals or these external boundaries.

## Selected next slices — 2026-11-04

The maintainer approved both full-app lifecycle/macOS dev-reload qualification
and successful Pi queued compaction, with incremental commits. Reuse existing
provider-host, standalone process and browser facilities; keep macOS hosting
opt-in and leave runtime/version targets and UI capabilities unchanged.

### 10 — qualify real app reload with Claude and Codex

Combine actual dev wrapper, Hono, provider host/worker, production adapter,
real pinned executable and scripted model API in owned standalone profiles.
First retain an API/socket lifecycle case, then a thin browser case proving
submission, reconnect and transcript convergence. Verify API/frontend generation
replacement with stable host/worker/native identity, held model/tool continuity,
exactly one subsequent input, persisted history and identity-checked teardown.
Exercise long-running tools with dense output on macOS, pending approval,
volatile queued-input blockers and unexpected Hono loss as distinct schedules.
Native and application acceptance are separate evidence. A short passing run
does not close the historical macOS interruption gap or enable its default.

### 11 — confirm Pi compact completion at the provider boundary

Create sufficient real native history in an owned Pi profile and demonstrate
successful compact RPC plus persisted native summary while the YA queue remains
held. Introduce narrowly typed completion evidence for a synchronous completed
command, distinct from asynchronous dispatch acknowledgement. Require native
proof before releasing queued A/B; preserve Claude/Codex boundary plus terminal
behavior. Cover native refusal, model failure and abort/lost outcome without
releasing following input on guessed success. Remove the Pi gap only after
successful native and shared ownership checks establish the repaired contract.

Measure retained startup, scenarios and teardown costs, and keep full-app
qualification separate from the fast Process-level baseline. Record exact
platform results and remaining failure schedules in the owning topic docs.

### Pi completion implementation evidence

The pinned Pi 1.4.0 executable persisted a real compaction summary and returned
its successful RPC result while YA still held compact/A/B. The unchanged native
scenario failed before the repair. The adapter now validates native completion
metadata and returns an explicit synchronous-completion fact; the shared gate
uses it without fabricating a provider event. Lost/invalid RPC evidence stays
uncertain. Successful compact, native refusal, controlled model failure and
hard abort pass together with existing Claude/Codex and gate tests (22 cases,
4.12 s local). Full workspace passes (6,950 server cases, 151.50 s), with existing
negative-fixture diagnostic debt retained separately. No public capability or
macOS default changes are involved.

### Full app implementation evidence

The retained source-app fixture now runs the real wrapper, Hono, Vite, host,
worker and pinned Claude/Codex executable against the existing loopback model
server. Four API/socket cases cover requested API/frontend replacement, abrupt
Hono loss, pending native approvals, an actual tool's dense output, volatile
queue blockers and exactly-once continuation/history. Private dotenv/profile
isolation and PID/start-identity teardown remain mandatory.

The thin real-browser scenario submits through the composer, observes partial
output, preserves a typed draft across API replacement, follows up, refreshes
history and sends again on the same worker. It exposed a Codex started-message
normalization defect: asynchronous enrichment of an empty started snapshot
could erase later live text. Marking started assistant messages streaming
repairs the boundary. The original browser assertion failed before this fix;
six cases (three repetitions per provider) pass afterward without retries,
including each keystroke below 100 ms under concurrent output.

API qualification takes 18.48 s wall time / 35.11 s summed work locally (four
cases); a concurrent workspace run takes 21.46 s / 39.95 s. Browser repetition
takes 1.7 min total, 16.3–17.7 s per case. Versions: macOS arm64, Node 24.22.1,
Claude 2.1.312, Codex 0.166.0. The manual workflow adds Linux/macOS app jobs;
those hosted platform passes remain pending. Commands and remaining boundaries
are in the owning native testing and reload-safe runtime topics. The historical
macOS interruption gap stays open and its default remains off.
