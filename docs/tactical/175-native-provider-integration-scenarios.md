# Native provider integration scenarios

Status: Claude/Codex foundation implemented, 2026-11-03. All-provider
qualification and expanded identity/compaction/recovery scenarios remain open.

The durable contract, commands and qualification matrix now live in
[native provider testing](../../topics/native-provider-testing.md).

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

Step 3's family audit is recorded in the owning topic's matrix. Pi and OpenCode
have existing real-executable/local-model precedents but are not installed on
this host. Grok local endpoint routing, Gemini ACP local auth/GenAI exchanges and
Antigravity local model routing remain unqualified. Claude variants and Codex
OSS need their own launch-path cases; shared executable ancestry is not proof.
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

## Remaining sequence

1. Add native multi-input identity/batching and queued `/compact` followed by
   A/B scenarios, then use the evidence to decide removal of implicit YA text
   concatenation. Do not infer a product decision from this fixture foundation.
2. Add cancellation/resume and controlled error/retry scenarios. Retain fake-peer
   fault injection only where the real executable cannot expose that boundary.
3. Qualify Pi/OpenCode and the alternate Claude/Codex launch paths, then establish
   supported local routing for the remaining ACP families. Preserve explicit
   capability/platform gaps rather than widening product policy for a test.
