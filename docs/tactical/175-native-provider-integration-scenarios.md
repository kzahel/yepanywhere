# Native provider integration scenarios

Status: selected for implementation, 2026-11-03.

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
