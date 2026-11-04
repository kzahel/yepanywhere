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
pnpm test:providers                 # Claude/Codex baseline
pnpm test:providers:install         # Verified Antigravity/Grok artifacts
pnpm test:providers:all             # All ten launch paths
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

- Pi 1.4.0, OpenCode 1.18.9 and Gemini CLI 0.36.0: exact nested npm
  test dependencies, including platform-native optional binaries where needed.
- Antigravity ACP 1.4.5 and Grok 1.0.67: official immutable artifacts in
  `test/native-provider/executables/artifacts.json`. The explicit installer
  verifies SHA-256 before extracting into `node_modules/.cache/ya-native-provider-tests`.
  Runtime tests still check the executable version. No primary install is changed.

The complete artifact set is currently pinned for macOS arm64 and Linux x64.
Antigravity additionally has verified artifact entries for macOS x64/Linux arm64;
Grok's other platforms remain unqualified. Unsupported selected platforms fail
installation explicitly. Antigravity's production Windows exclusion remains.
An owned executable may be selected with `YEP_NATIVE_TEST_ANTIGRAVITY_PATH` or
`YEP_NATIVE_TEST_GROK_PATH`; the same version checks still apply.

Do not use the primary CLI as an implicit fallback when optional dependencies
are absent. Runtime support/version policy remains owned by
[provider version support](provider-version-support.md).

## Isolation and lifecycle

Fixtures reuse the standalone environment scrubber with private project, home,
XDG, Windows app-data, provider histories and YA roots. They remove inherited
provider/account/agent authority and shell startup configuration. Model auth
uses only a synthetic key, and the listener checks it. The model listener rejects
unexpected routes, credentials and oversized requests; failures reject pending
scenario gates. It emits valid Messages, Responses, Chat Completions and GenAI responses,
including streamed text/tool events and explicit non-streamed probes.

All configured native endpoints point at loopback. A deny proxy rejects external CONNECT
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

On macOS arm64, 2026-11-04, the retained foundation passes 20 scenarios across
ten production launch paths. The baseline Claude/Codex group has six cases;
tool execution is folded into the queue scenario to avoid another native startup.

| Scenario | Assertions |
| --- | --- |
| YA Queue A/tool/B, all ten paths | Original turn, A alone, actual native file tool inside A, A's final response, then B alone. B stays deferred through the tool. Native history is read through YA's production reader after joined native shutdown. |
| First Codex OSS exec tool | New exec and resumed exec are different native launches; the first also proves the real code-mode file tool and persisted result. |
| Gentle steering | Claude, Gateway, Ollama, Codex and Grok acknowledge native receipt before the held original response completes; correction reaches actual model input, YA output and native history. |
| Immediate steering | Claude, Gateway, Ollama and Codex cancel the held model response before delivering the correction. |

Claude variants and app-server Codex additionally retain A/B's supplied input
UUIDs in native JSONL. Other native identity guarantees remain separately gated;
passing text/history assertions does not close the
[durable input identity gap](../gaps/provider-user-turn-durable-identity.md).
Grok buffers ACP assistant text until its native item completes; its held model
request and native interject acknowledgement establish the busy boundary instead.

The 20-case foundation takes 21.17 seconds of test work / 22.21 seconds including
Vitest startup locally. These are diagnostic samples, not CI performance claims.
Antigravity/OpenCode's multi-turn scenarios hit the initial 5-second budget;
their adjacent comments record the observed bound and derived 10-second ceiling.
Executable provisioning cost is separate: a warm frozen install takes 0.85 s;
the external macOS artifacts download about 170 MB combined on a cold cache.
Keep CI costs visible when expanding coverage. Linux/Windows native acceptance
is still pending; artifact availability does not imply execution qualification.

## All-provider adoption matrix

Qualification is per executable, production launch path, capability and platform.
All rows below now have retained queue/tool/history scenarios, using actual
production adapters and readers in private standalone profiles.

| Family/path | Executable / local model route | Additional retained foundation |
| --- | --- | --- |
| Claude | Bundled 2.1.312 / SDK 0.3.312; Messages override. | Gentle and immediate steering; durable input UUIDs. |
| Claude Gateway | Same bundled CLI; real Gateway service/catalog/effort probe. | Gentle and immediate steering; actual launch/routing path, not a real upstream Gateway service. |
| Claude Ollama | Same bundled CLI; adapter URL setter routes Messages locally. | Gentle and immediate steering; qualifies Claude launch, not an actual Ollama server. |
| Codex | Pinned 0.166.0 app-server; custom Responses endpoint. | Gentle and immediate steering; durable input UUIDs. |
| Codex OSS | Same CLI, distinct new/resumed exec JSONL path; owned service catalog. | Separate first-exec tool coverage. |
| Pi | Pinned 1.4.0 RPC; private models.json, Chat Completions. | Real RPC lifecycle and native JSONL reader. |
| OpenCode | Pinned 1.18.9 server; private custom provider, Chat Completions. | Actual server tool execution and production SQLite/export reader. |
| Grok ACP | Official 1.0.67; private TOML Responses endpoint. | Gentle interject; title, title refresh and dashboard requests explicitly recorded/scripted. Compatibility imports of other apps' rules/config are disabled in the owned fixture. |
| Gemini / Gemini ACP | Pinned 0.36.0; both names use ACP; private API-key settings, GenAI override. | Bounded frozen-path regression coverage; no auth/UI/protocol expansion. |
| Antigravity ACP | Official 1.4.5; private API-key settings, GenAI override. | Native view_file and actual ACP history load via production reader. |

These scenarios do not qualify provider discovery/subscription authentication,
OS sandbox policy or all native controls. No real account is supplied. Native
auxiliary traffic is named and recorded; unexplained model requests fail rather
than receiving a generic canned answer. Root diagnostics are captured and
asserted, including child logger warnings/errors, rather than globally silenced.

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
