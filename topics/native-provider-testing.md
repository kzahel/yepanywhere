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

Qualification is per executable, production launch path, capability and platform.
The November 3 expansion audit proved local-model routing with the real
production adapters listed below. Those exploratory probes are feasibility
evidence, **not additional retained CI scenarios**. The ordinary suite still
contains only the eight Claude/Codex cases above.

| Retained family/path | Local model route / executable evidence | Retained coverage / next qualification |
| --- | --- | --- |
| Claude | SDK-bundled 2.1.312; Anthropic Messages via `ANTHROPIC_BASE_URL`. | Four retained scenarios pass; expand lifecycle, persistence and faults. |
| Claude Gateway | Same bundled executable; actual Gateway adapter configured with an owned service URL; local catalog/probe and Messages round trip pass. | Promote the distinct launch, routing, catalog and option behavior into scenarios. |
| Claude Ollama | Same bundled executable; actual Ollama adapter URL setter routes Messages to the local stub. | Promote launch behavior; this proves the Claude launch path, not a real Ollama server. |
| Codex | Pinned 0.166.0; custom Responses endpoint through app-server. | Four retained scenarios pass; expand lifecycle, persistence and faults. |
| Codex OSS | Same pinned CLI, **different `codex exec --json` adapter**; a configured service reaches local Responses and returns assistant output. | Promote the distinct exec lifecycle, controls and history. Native Ollama discovery remains separate. |
| Pi | Test-only 1.4.0; private `models.json` with `baseUrl` / `openai-completions`; production RPC adapter returns the local reply. | Promote route and existing effort-retry precedent, then queue/tool/lifecycle/history cases. |
| OpenCode | Test-only 1.18.9; `options.baseURL`, custom OpenAI-compatible model and private `OPENCODE_CONFIG`/XDG roots; production server adapter returns local Chat Completions output. | Promote server ownership, queue/tool/cancel/history; explicitly cover Git and non-Git projects. |
| Grok ACP | Test-only 1.0.67; private TOML `model.<id>.base_url`, `api_backend = "responses"`, synthetic `env_key`; production ACP adapter returns local output. | Promote receipt/steer, tools, cancellation and history. Native title/summary model calls also reach the local stub and need named expectations. |
| Gemini / Gemini ACP | Installed 0.36.0; both YA names use ACP. Private settings select API-key mode, `GOOGLE_GEMINI_BASE_URL` routes GenAI to localhost; direct ACP and production adapter round trips pass. | Promote a bounded retained baseline while preserving frozen product policy; no steering or auth/UI expansion follows from this probe. |
| Antigravity ACP | Installed official 1.4.5; API-key mode plus `GOOGLE_GEMINI_BASE_URL`; production YA adapter returns local GenAI output. Native ACP tool/cancel/model-change/cold-load probes also pass below. | Promote through YA Process/reader/Supervisor, preserving preview and platform limits. |

Pi, OpenCode and Grok were provisioned only under an ignored test-tools root;
primary installations and PATH were unchanged. Tested versions match the
existing audited targets where recorded. Their primary endpoint controls are
documented by [Pi](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/models.md),
[OpenCode](https://opencode.ai/docs/providers) and
[Grok](https://docs.x.ai/build/settings). Actual executable probes, rather than
those documents alone, establish the table's local-routing findings.

Do not claim all-provider scenario coverage while those cells remain exploratory.
A passing adapter turn also does not establish YA provider-discovery/authentication
admission: a private API-key transport is different from subscription readiness.
No real account was used by these probes. Distinguish unavailable installations,
unsupported operations, actual defects and untested paths.

## Antigravity endpoint and depth evidence — 2026-11-03

Google [documents the CLI endpoint override](https://antigravity.google/docs/install?tab=cli).
A separate probe establishes it works for YA's actual **ACP** distribution:

- Set `GEMINI_HOME` to an owned `.gemini` directory, use a synthetic
  `GEMINI_API_KEY`, and set `GOOGLE_GEMINI_BASE_URL` to the loopback stub.
- Prepare that root's `antigravity-acp/settings.json` with
  `{ "auth": { "type": "gemini-api-key" } }`. No OAuth login or `authenticate`
  RPC is needed. This is fixture-only native configuration, not a YA auth change.
- Real ACP 1.4.5 sends `POST /v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`
  and returns the scripted text. The production YA adapter separately yields
  its assistant and result events from that endpoint.
- A scripted `view_file` call reads actual bytes from an owned project. The
  following model request contains those bytes; the stub did not supply them.
- `session/cancel` during a real partial response returns `stopReason: cancelled`
  and closes the held HTTP stream. `session/set_model` changes the next request
  from Gemini 3.8 Flash to 3.7 Flash.
- After stopping the native process, the runtime's own `.db`/`.meta` files remain.
  A new process's `session/load` replays earlier output, and its next model request
  includes the earlier user input and real tool result. No database decoder or
  synthetic history is used.

The cold-load probe restored conversation context but reset the chosen native
model to its default. This is an observation, not a YA defect verdict: test YA's
saved-model reapplication separately from the native default. YA currently
selects Antigravity's model at launch and exposes no live `AgentSession.setModel`
or steering hook. A native control probe is not proof of a YA UI feature.
The ACP distribution's [registry](https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json)
identifies the tested version and official platform artifacts.

The Codex OSS probe initially used an invented model ID and correctly received
native missing-model-metadata diagnostics. Selecting a known native model while
keeping its configured endpoint local produced a reply without error events.
Fixture setup must distinguish an intentionally tested unknown-model path from
an accidental warning in the successful baseline.

GenAI needs a third wire transport alongside Messages and Responses; Pi and
OpenCode also require Chat Completions. Native Grok's Responses parser required
`created_at` and SSE `sequence_number` fields that the minimal Codex stub omitted.
Make shared transports valid for their wire protocol rather than accumulating
provider-specific malformed-response exceptions. Record expected auxiliary
requests explicitly; an unexplained extra request is not automatically accepted.

Gemini's client attempted to proxy its loopback model URL despite `NO_PROXY`.
The probe allowed a CONNECT tunnel only to its exact owned model listener;
external CONNECTs remained denied. OpenCode attempted a registry lookup and
Gemini attempted telemetry; both were denied while the model round trips
completed. Fixture setup must account for such native startup behavior and join
all child exits before deleting roots; Pi abort itself only requests termination.

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
