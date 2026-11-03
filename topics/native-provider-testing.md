# Native provider integration testing

Topic: native-provider-integration

## Contract and purpose

Use actual provider executables against scripted loopback model APIs as the
primary integration evidence for provider behavior wherever the provider allows
it. The executable runs its real scheduling, tools, protocol, persistence and
cancellation code. Only model responses are scripted; no model inference or
paid API call is needed. Use these tests to establish behavior before provider
or shared scheduling refactors and to verify it afterward.

A scenario is an action/assertion recipe, not a recorded conversation. For
example: hold the current model request open, enqueue A and B through YA,
finish the current response, observe A alone, finish A, observe B, then check
YA events and the native transcript. A new executable must actually satisfy
those assertions. Do not update snapshots merely to accept changed behavior.
Historical captures remain useful for old transcript/parser regressions under
[the captured corpus](../packages/server/test/fixtures/captured/README.md).
Fake CLI/SDK peers remain useful for injecting protocol faults. Neither is
current-native qualification.

## Run and boundaries

```bash
pnpm install --frozen-lockfile
pnpm test:providers
YEP_NATIVE_TEST_PROVIDERS=codex pnpm test:providers
```

The selector accepts comma-separated qualified fixture names. An unknown or
unqualified selected provider fails; a missing executable or mismatched version
also fails. There is no fake executable, paid fallback or successful skip.
The same cases run in the ordinary server suite through `pnpm test`, including
the existing CI unit-test job. No browser or extra CI service is needed.
Root `pnpm typecheck` checks the native test helpers as well as production code.

The current boundary is YA `Process` → production provider adapter → actual
native executable → local model API, plus the native transcript it writes.
It does not cover HTTP/WebSocket admission, browser rendering, provider-host
reload, authenticated subscription routing or real model quality/cache billing.
Those retain their separate integration/live checks. Scripted usage fields
must never be reported as measured cache efficiency or actual token cost.

The executable sources are deterministic test dependencies:

- Claude: the real CLI bundled with `@anthropic-ai/claude-agent-sdk`; its
  reported version must match the root Claude compatibility marker.
- Codex: exact `@openai/codex` dependency in the private
  `test/native-provider/executables` package, using its platform-native optional
  package; its reported version must match `codexCli.expectedVersion`.
  The server depends on that package only for development. Its nested CLI bin
  stays off YA's ordinary development PATH. This pin does not upgrade or select
  the user's installed Codex runtime.

Do not use the primary CLI as an implicit fallback when optional dependencies
are absent. Runtime support/version policy remains owned by
[provider version support](provider-version-support.md).

## Isolation and lifecycle

Fixtures reuse the standalone environment scrubber with private project, home,
XDG, Windows app-data, provider histories and YA roots. They remove inherited
provider/account/agent authority and shell startup configuration. Model auth
uses only a synthetic key, and the listener checks it. The model listener rejects
unexpected routes, credentials and oversized requests; failures reject pending
scenario gates. It emits minimal Anthropic Messages or OpenAI Responses SSE.

Both native endpoints point at loopback. A deny proxy rejects external CONNECT
requests. Codex's observed optional startup catalog destinations (`chatgpt.com`,
`github.com`, `api.github.com`) are recorded and denied without failing the
model scenario; unexpected destinations fail. This is process configuration,
not an OS network sandbox. Do not infer whole-machine egress enforcement from
it. No real credentials are supplied and no public model endpoint is configured.

Each fixture owns and joins native process abort, model listener closure and
private-root removal, restoring the parent environment even on failure.
Tests in one file run sequentially because the production adapters read
`process.env`; do not mark these cases concurrent. Tools operate only on the
owned project. Tests wait for real requests, responses and YA output/state
events, rather than scheduling sleeps. A request arriving is not proof that its
YA output has arrived, and an idle notification from the previous native turn
is not completion of a queued steering turn.

Native teardown assertions protect [Claude's requested-cancellation
contract](claude.md#contracts), including the SDK's classified abort errors.

## Qualified scenarios and current evidence

On macOS arm64, 2026-11-03, real Claude 2.1.312 (SDK 0.3.312) and Codex
0.166.0 pass the same four scenarios each:

| Scenario | Assertions |
| --- | --- |
| YA Queue A then B | Three distinct model turns, A excludes B, deferred rows drain, assistant output reaches YA, both texts and input UUIDs persist natively. |
| Actual tool round trip | Native Claude Read / Codex code-mode shell reads an owned file; its previously unknown content reaches the next model request and native history; final output reaches YA. |
| Gentle steering | Wait for native input receipt while a streamed response is open; correction reaches the next native request, YA output and native history. |
| Immediate steering | The open response is cancelled before the correction request; correction reaches YA output and native history. |

Every case joins shutdown and asserts no Process errors or unexpected model
requests. Eight cases took 1.97–4.16 seconds of test work, 2.87–5.82 seconds
including Vitest startup in initial local samples. These are local diagnostic
measurements, not a CI performance claim. Keep the runner default budget until
slower CI evidence justifies an override under [test time budgets](test-time-budgets.md).
Linux/Windows native qualification is still pending CI; their platform packages
are selected explicitly and missing packages fail. No platform pass is implied
by the macOS sample.

## All-provider adoption matrix

Qualification is per executable, launch path, capability and platform. A shared
base class or protocol does not automatically qualify another launch mode.

| Retained family/path | Local model route / evidence | Remaining qualification |
| --- | --- | --- |
| Claude | Anthropic `ANTHROPIC_BASE_URL`; all four shared cases pass. | Resume, approvals, compaction and failures. |
| Claude Gateway / Ollama | Same real Claude executable, different endpoint/auth/model setup; reusable Messages transport. | Run those production launch paths explicitly; plain Claude results do not qualify them. |
| Codex | Custom `model_providers` Responses endpoint; all four shared cases pass. | Resume, approvals, compaction and failures. |
| Codex OSS | Same real CLI, different local-model launch path. | Qualify the OSS launch and local-server assumptions explicitly. |
| Pi | Existing [real Pi effort-retry test](../packages/server/test/e2e/pi-effort-retry.e2e.test.ts) uses a local Chat Completions server and private models config. | Pi is absent on this host; migrate that proven route into shared queue/tool/control cases before claiming coverage. |
| OpenCode | [Documented actual-executable reproduction](opencode-backend.md) uses an OpenAI-compatible custom provider, `options.baseURL`, private `OPENCODE_CONFIG`/XDG roots. | OpenCode is absent on this host; qualify its server lifecycle and shared scenarios. |
| Grok ACP | Retained ACP adapter and native interject capability exist. | Binary absent here; establish supported local endpoint/auth routing first. No guessed environment override or fake CLI qualification. |
| Gemini / Gemini ACP | Both names execute ACP. Installed Gemini bundle exposes `GOOGLE_GEMINI_BASE_URL` and API-key routing. | Owned ACP authentication and a local GenAI transport are not yet qualified. Keep frozen provider policy; source discovery alone is not a scenario pass. |
| Antigravity ACP | Owned real ACP initialize probe reports 1.4.5; control/startup evidence only. | Local model endpoint routing is unqualified. Native login alone is insufficient for inference-free model scenarios. |

Do not claim “all providers pass” while cells remain unqualified. Missing
installations, unavailable endpoint overrides, unsupported capabilities and
actual failures are different findings. Preserve those distinctions in reports.

## Adding scenarios, providers and upgrades

1. Name the behavior and the boundary that could regress. Prefer this suite for
   native scheduling/tool/persistence behavior; add a browser only when the
   behavior depends on the browser boundary.
2. Express actions and semantic assertions once where outcomes match. Keep
   adapter-specific launch, tools and capability expectations explicit; avoid
   a second provider abstraction or a generic replay framework.
3. Add only the model protocol needed for that behavior. Control a real request
   or tool boundary, inspect actual native requests, and assert user-visible YA
   events plus persistence/identity where relevant. Do not replace native
   scheduling or synthesize the transcript being asserted.
4. Require the real executable/version and prove isolation, cleanup and no paid
   fallback before adding the family to the selector. Measure startup, scenario
   and teardown cost. Add platform evidence separately.
5. Provider upgrades run applicable scenarios and record the exact tested
   version. Keep native test pins and audited markers aligned through the
   existing [refresh process](provider-refresh.md); a green subset is not a
   whole-provider compatibility audit. Investigate drift against upstream
   protocol/source before changing the stub or expectations.

Next scenario priorities are native multi-input identity/batching, queued
`/compact` followed by A/B, resume after cancellation and controlled failure/
retry. They should supply evidence for removing implicit YA concatenation;
this foundation does not change queue defaults or claim those cases are covered.
The implementation sequence and remaining work live in
[plan 175](../docs/tactical/175-native-provider-integration-scenarios.md).
