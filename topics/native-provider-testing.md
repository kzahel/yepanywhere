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

The native suite's boundary is YA `Process` → production provider adapter → actual
native executable → local model API, plus the native transcript it writes.
The separate full-app qualification below covers HTTP/WebSocket admission,
browser rendering and provider-host reload with Claude/Codex. Authenticated
subscription routing and real model quality/cache billing retain their own
integration/live checks. Scripted usage fields
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

- Pi 1.5.0 and OpenCode 1.18.9: exact nested npm
  test dependencies, including platform-native optional binaries where needed.
  The executable package is an explicit workspace so the full pnpm audit
  includes its dependency graph. Gemini CLI is no longer installed or tested;
  Antigravity owns the maintained Google CLI path.
- Antigravity ACP 1.4.5 and Grok 1.0.70: official immutable artifacts in
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

## Native nested-harness evidence

The opt-in `test/native-app/app-nested-harness.test.ts` runs an actual Claude
parent whose Bash tool starts a second named Claude executable on the owned
scripted endpoint. It checks pending SQL before replacing the API, reattaches
the same native process, then verifies both directions of the command-evidence
edge. Both the admin restart route and direct wrapper SIGHUP preserve that
pending correlation; real process completion remains terminal. A real second invocation of the already-used id fails, with no added
observation. Forking copies both commands but creates no fork launch edge;
accepted history survives child deletion and another API replacement. Exact
post-teardown dispatch counts and endpoint failure checks remain enforced.
This is live scoped acquisition, not historical backfill or background-job
qualification. It introduces no public relationship response fields.

## Native v0 creator evidence

The opt-in `test/native-app/app-creation-relationships.test.ts` uses the real
application and provider host. An actual Claude or Codex parent executes a shell
tool against its private launch-bound v0 connection, creates a second actual
executable, repeats the same request and submits a conflicting retry. Both
executables stay on the owned scripted model endpoint. The fixture explicitly
enables API discovery and management only in its private profile; production
defaults are unchanged and no operator credential is substituted.

The scenario checks the parent's canonical launch attribution, one receipt and
one native child dispatch, both directions of `created_session` in profile SQL,
receipt evidence, API surface provenance and native identity bindings. Absence
of a provider-child edge is checked after an accepted complete structural
observation of the parent's stored native ref; its version deliberately ignores
ordinary parent body activity. While the real parent remains active, the owned API
process is replaced. Reopening SQL and the existing authorized v0 relationship
reply must retain the same creator receipt. The WebSocket reconnects before the
parent finishes; no old subscription is treated as surviving API replacement.
A single read-only SQL snapshot supplies rows, with assertions outside the
publication wait. The post-restart catalog contains exactly the parent and
child; model failure/egress and dispatch counts are checked after joined teardown.

The fixture now exercises the full two-by-two creation matrix for the currently
supported local v0 providers: Claude and Codex can each create either provider.
Both exact native versions are checked when selected, and a mixed fixture
explicitly allows both model protocols on its owned listener. Each exchange uses
the protocol detected from its request path; unexpected routes/protocols,
credentials or external model endpoints still fail, retaining the explicitly
classified auxiliary requests. Each initial parent, parent continuation and
child exchange is directly checked against its expected protocol. Post-teardown
counts also require two parent-protocol requests and one child-protocol request,
without assuming which concurrent continuation arrives first. The creation
case has a 40-second test budget, derived from its measured 18.00-second maximum
with workspace, native-app and all-provider suites running concurrently; this
adds guard headroom rather than changing runtime behavior or claiming speed.

This remains POSIX Node qualification. It does not qualify peer-native dispatch,
Windows or a new public graph contract. Unit/integration fixtures retain the
remaining admission, peer, recovery and access-control boundaries. The four
creation cases are opt-in with the existing native-app suite, rather than
another startup cost in ordinary workspace tests. Independent review and the
final eight native-app cases pass. The standalone all-provider suite passes
68 cases; concurrent OpenCode/Antigravity budget failures remain open findings,
not repaired flakes. Detailed timings and scope are recorded in plan 176.

## Native child evidence

The baseline `native-children.test.ts` executes actual native child tools. The
November 4 qualification exercised Claude 2.1.318's `Agent` and Codex 0.166.0's
namespaced v2 `collaboration.spawn_agent`. Parent and
child use owned scripted model APIs with synthetic credentials. The test
compares raw native child identity and parent launch anchors with a separately
opened production reader, including the child's actual reply. Codex request
classification uses native `client_metadata.thread_id`: parent and child may
share a prompt-cache key. Its v2 spawn result returns a task path, so discovery
uses the correlated persisted `SubAgentActivity` start record plus the child's
own native immediate-parent metadata, retaining the
older native-id call/output format. A focused append test covers partial records,
unrelated interactions and deduplication across persisted event envelopes.

These are regenerated native specimens, not constructed reader fixtures or
paid inference. The relationship scenario also qualifies Claude Gateway,
Claude Ollama, Codex OSS, Grok and OpenCode, including production-reader SQL publication and
reopen, on macOS arm64. Each qualified family also verifies exact-parent cheap
metadata refresh against those native-created children. Codex/OSS independently
check the native SQLite spawn index; its rows locate child-owned header proof
rather than establish creation parentage. Gateway explicitly enables its default-disabled Agent
tool for this scenario; production defaults and remote child-model availability
are not changed or qualified. Both parent and child stay on the owned model
endpoint with synthetic credentials. The OpenCode nested scenario below adds
depth-two evidence. Other providers/depths and peer-native dispatch remain
separate relationship qualification work in
[plan 176](../docs/tactical/176-durable-session-relationships.md). Process and
full-app version guards now use the same root compatibility markers through
`runtimes.ts`; stale fixture tables cannot independently select an older Claude
or Codex runtime.

| Native child path | Qualified evidence | Limit |
| --- | --- | --- |
| Claude / Gateway / Ollama | Actual `Agent`, native ids, production child content, SQL publication/reopen | Direct children; Gateway fixture explicitly enables Agent. |
| Codex / OSS | Actual v2 `collaboration.spawn_agent`, native start correlation and child-owned immediate parent, production content and launch mappings, SQL anchor reopen | Review/internal delegates stay excluded; deeper descendants remain separate qualification. |
| Grok 1.0.70 | Actual `spawn_subagent`, parent tool result, explicit sidecar ids, child's own summary, production content, SQL reopen | Default cwd; cross-cwd/worktree navigation and exclusion remain unqualified. |
| OpenCode 1.18.9 | Actual `task`, own native database parent/directory, parent continuation id, production content/exclusion, SQL publication/reopen; configured depth-two child/grandchild chain and refused next depth | Default direct children; depth two explicitly enables Task permission and native depth setting. Other depths/platforms and unsupported 2.x remain unqualified. |
| Pi | Transcript-node parent links | Those are not session-child proof. Common YA lineage still applies. |
| Antigravity / frozen Gemini | No qualified YA native child source | Do not infer a child capability from the transport. |

Grok parent/child calls also use the owned scripted model API. Its metadata
contains the delegated prompt; the graph whitelist excludes it. Strict native
proof and legacy directory spellings have filesystem/SQL regressions, while the
old captured corpus remains historical evidence rather than current spawning
qualification. These are local macOS results, not Linux/Windows or native-mobile
acceptance for the new source.

### Native OpenCode depth two

The separate `opencode-nested-children.test.ts` executes two nested native Tasks
with fixture-only `subagent_depth: 2` and an explicit `general` Task permission.
The default child inventory omits Task. The enabled fixture checks correlated
tool-result messages, independent native ids/parent columns, immediate-parent
production mappings/content and top-level exclusion. A further Task returns the
native depth-limit error without allocating a fourth session. The root's one
structural acquisition publishes both immediate edges; a leaf acquisition
establishes known empty. Both links and the empty leaf survive SQL reopen after
native-storage deletion. Post-teardown assertions require exactly six scripted
model exchanges and no unexpected egress/errors. No production default changes.

## Full source app and dev reload qualification

```bash
pnpm test:providers:app             # Four real API/socket lifecycle cases
pnpm --filter @yep-anywhere/client exec playwright install chromium
pnpm test:providers:app --browser   # Three real browser scenarios
pnpm test:providers:app --browser --repeat-each=3
```

This separate suite runs the actual `scripts/dev.js` wrapper, Hono, Vite,
provider host/worker, production adapter and pinned Claude/Codex executable.
Only the model API and unrelated update lookup are scripted. It owns standalone
home/config/history/project/data/host roots and synthetic credentials, scrubs
checkout dotenv authority, requires the current Vite client, and joins teardown
with PID/start-identity checks. Failed cases print bounded wrapper/server logs;
browser failures also retain Playwright traces. This is configuration isolation,
not an OS egress sandbox. It never uses an installed primary browser.

The four API cases prove requested API/frontend replacement, abrupt Hono loss,
pending native approval, a real tool's dense output during replacement,
volatile queue blockers/cancellation, streamed socket output, persisted history
and the next input delivered exactly once. Worker/native process identities
remain stable while API/frontend generations change. Approval continues on the
original native callback and the real tool executes once.

The two browser cases additionally prove actual composer submission, visible
interim/final output, draft retention across server replacement, sequential
keystroke acknowledgement under concurrent output (each below 100 ms), one
user bubble, transcript convergence after page refresh and another submission
on the same worker. The isolated browser config has no retries; the ordinary
mock browser suite excludes these scenarios. The API group is opt-in separately
from the inexpensive native Process baseline and ordinary workspace tests.

Qualification on 2026-11-04: macOS arm64, Node 24.22.1, Claude 2.1.312 and Codex
0.166.0. Four API cases pass in 18.48 s wall time / 35.11 s summed test work;
a concurrent workspace run passes in 21.46 s / 39.95 s. Three browser repetitions
per provider pass without retries (six cases, 1.7 min, 16.3–17.7 s per case).
Desktop/phone captures use the repository artifact capture facility. The
browser scenario exposed and repaired a Codex normalization defect: an empty
`item/started` assistant was finalized asynchronously, and its delayed same-id
update could erase newer live text. Started messages now remain streaming.

The manual native qualification workflow includes Linux x64 and macOS arm64 app
jobs. Hosted platform acceptance still awaits those runs; local macOS evidence
is not Linux acceptance. The [historical macOS owner-interruption
gap](../gaps/macos-provider-host-turn-interruptions.md) remains open and the host
stays opt-in there. These scenarios do not cover wrapper/host crashes, all
signal ladders, authenticated/relay routes, browser offline recovery or real
inference/cache efficiency. Existing fault-peer and live checks remain useful.

## Installed npm package acceptance

`pnpm build:bundle && pnpm test:package` adds a separate distribution boundary:
clean npm installation → published CLI entry point → HTTP session creation →
production adapter → real executable → scripted loopback model API, with live
WebSocket output and a native-history read after a server restart. It reuses
this suite's model server and real file-tool actions. Both Claude and Codex
must pass; no selected executable can skip or fall back to inference.

The first launch has no provider credentials and exercises normal provider-host
discovery with neither `USE_MOCK_SDK` nor a host-disable override. It must expose
the expected version, responsive HTTP/WebSocket, ready SQLite and no degraded
host or host-script import failure. Each provider then reads an owned file
through its actual native tool; those bytes must reach the next model request.
A held streamed reply must reach the session WebSocket before model completion.
After restarting the server with the same private profile, the original public
session URL must return the input, reply and tool result without new inference.

The harness scrubs inherited authority, owns home/config/history/data/project
roots and process groups, and joins identity-checked process-tree shutdown
before removing fixtures on success or failure. Synthetic keys and loopback
model endpoints use the same deny proxy as the native suite. The update lookup
alone receives the existing offline no-update fixture. This is configuration
isolation, not an OS egress sandbox. Authentication is disabled only on the
private loopback YA listener; login, relay, browser rendering, provider-host
reload and real model quality remain outside this gate.

Claude uses the runtime bundled with the **cleanly installed** SDK dependency,
so its SDK/CLI versions are recorded even when npm's published range resolves
newer than the source lockfile. Codex uses the pinned private test executable
with the same exact-version check as the native suite. This smoke does not
advance either provider's audited-through marker or replace the pinned depth
suite. Missing binaries and scenario failures fail the command.

`--tarball=/absolute/path/candidate.tgz` tests existing bytes;
`--expected-version=VERSION` checks the intended release version. The narrower
`node scripts/agent-self-package-smoke.mjs --production-startup --tarball=PATH`
checks historical startup artifacts without requiring newer session APIs.
The original `--startup` SQLite/mock matrix remains independent.

Release acceptance retains `candidate.tgz`, its SHA-256, version/runtime/provider
results and server diagnostics in `dist/npm-release/`. A receipt is written only
after all required checks and cleanup succeed; rerunning removes an earlier
receipt first. Publication must verify the receipt and archive, then publish
those exact bytes. The reusable Linux workflow runs on relevant pull requests,
manual dispatch and as a mandatory dependency of npm publication. These checks
require no browser or paid model service. Cross-platform runtime checks retain
their existing workflow; this release gate does not qualify every provider/OS.

Qualification on 2026-11-04: the complete gate passes on macOS arm64 with
Node 24.22.1, npm-resolved Claude SDK 0.3.318 / CLI 2.1.318 and pinned Codex
0.166.0. The final scenario run takes 6.70 seconds, excluding package installation
and build. A separate Linux arm64 / Node 24.22.1 clean-install startup check
accepts the same candidate and rejects published 0.9.2 specifically for
`providerHostDegraded: true`; no owned server/Node process remains after either
case. The complete hosted Linux x64 gate also passes in
[acceptance run 41796036263](https://github.com/kzahel/yepanywhere/actions/runs/41796036263)
on source `1e2371350`, Node 22.23.4, the same Claude SDK/CLI versions and
Codex 0.166.0. Its job takes 2m49s including setup/build/install; the production
startup and provider scenarios take 9.44 seconds. The retained tarball's version,
source revision and SHA-256 were independently verified after download. This
qualifies the installed-package scenarios above, not the full all-provider
native matrix or paid inference.

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

## Retained lifecycle and recovery depth — 2026-11-04

Before Gemini retirement, the complete suite passed **65 cases** across ten launch paths,
in five scenario files. The ordinary Claude/Codex baseline is **20 cases**;
the selector and all-provider command run the same assertions. Native state is
always created by the executable, then reopened through production readers.

The security cleanup removes Gemini's four native cases and its executable.
The historical measurements below include those retired cases. Pi 1.5.0 passes
all nine retained Pi scenarios on Linux x64 against the owned model endpoint.

| Behavior | Passing native coverage / explicit limits |
| --- | --- |
| Cold resume after a real tool | Nine paths preserve native id, earlier input/reply and actual file bytes in a new process's model request and reopened history. OpenCode additionally runs the same workflow outside Git. Frozen Gemini 0.36 refuses its retained unsupported session/resume method, without a new session or model request. |
| Cancellation and continuation | Claude variants, Codex, Pi, OpenCode and Antigravity cancel a held real model response and continue on the existing owner. Grok and Codex OSS hard-stop and cold-resume the same native history. Gemini hard-stop joins its real launcher/worker and closes the held model connection; continuation explicitly refuses as above. |
| Model change and restoration | Claude, Codex and Pi change the actual next model request and reapply the selection on cold launch. Pi invalid-model refusal leaves YA's requested selection unchanged. Antigravity cold-load explicitly reapplies a different selected model instead of accepting the runtime's default reset. Wrapper model-selection matrices and effort/permission changes remain separate work. |
| Rate-limit recovery | Every path receives a controlled HTTP 429, retries the original input and produces a persisted final reply. Codex app-server and exec publish an explicitly asserted recoverable Reconnecting event; no unexplained diagnostics are accepted. |
| Queued compact followed by A/B | Claude, Codex and Pi actually compact through their native model request before delivering A and B separately. Claude/Codex publish a compact boundary; Pi validates its synchronous native RPC completion and persisted summary. All preserve following input/output. |
| Failed queued compact | Pi's real small-session refusal and model error hold later input until explicit cancellation. Aborting a held native summary closes the model connection and leaves its outcome uncertain; following input never runs on guessed success. |

Before the input-boundary slice, the combined 60-case local macOS arm64 run took **51.80 seconds wall time**,
(107.87 seconds summed test work), without unexpected warnings/errors. Pi completion adds three retained cases to
the previous 57-case run; these samples are not a measured speedup. The
standalone 16-case Claude/Codex baseline passes in 3.88 seconds wall time
(7.21 seconds summed work), retaining the inexpensive ordinary CI path.
The separate focused provider group passes 192 cases in
24.01 seconds, with its intentional fault diagnostics explicitly asserted.
The full workspace passes (6,950 server / 7,097 client cases; server 149.28 s).
Static checks, frozen install and client console budgets pass. These are local
samples, not a CI or cross-platform performance claim. Native retry backoff,
real startup and reader/teardown costs remain part of the measured workload;
budget comments identify initial 5-second limits and the affected paths only.

The suite found and repaired five production defects: lost resumed Codex OSS
output, replayed Codex usage retargeting the active turn, rejected Pi model
selection reported as success, default OpenCode ports colliding across YA
processes, and ACP launcher-only shutdown leaving a native worker/model request
alive. Requested ACP transport closure is classified narrowly; unrelated native
errors remain errors. No new UI capabilities or queue policy changes follow.

The manual `Native provider model API qualification` workflow provisions and runs
the full set on Linux x64 at the supported Node floor. It is deliberately an
acceptance job until its first Linux run is reviewed; the normal CI server suite
continues to gate the Claude/Codex baseline. Promote the complete job to relevant
change gates after that acceptance. No Linux or Windows pass is claimed here.

Remaining depth includes native multi-input/batched identity, broader tool
denial, wrapper/host terminal faults and retry exhaustion, wrapper settings/
effort, authenticated/relay recovery and platform qualification. The separate
Claude/Codex full-app cases cover only the listed ownership/reconnect schedules.
These distinct boundaries do not establish full code coverage.

## Input boundary and identity qualification — 2026-11-04

Five additional native cases cover buffered direct inputs with Claude/Codex/Pi
and independently acknowledged duplicate-text Claude/Codex steers. They execute
a real tool, assert one original identity per queue yield, inspect actual model
input without YA separator joining, then reopen production readers. Claude may
natively combine the two inputs and records both through normalized
`inputMessageIds`; Codex preserves separate user items. Pi preserves separate
text turns, while its native node-ID mapping gap remains open. A shared queue
change must run the all-provider suite as well as these distinct launch shapes.

The added `native-input-identity.spec.ts` runs in the separate full-app browser
configuration and stays out of the ordinary mock browser matrix. It uses the
real server setting for gentle steering, actual composer submissions and native
queued receipts. It proves grouped echo reconciliation, draft retention and
cold-page navigation to an original contributing input. Typing is sequential
under concurrent output with a 100 ms limit and 200-line history/reply fixtures.
The final all-provider run passes 65 cases in 52.68 s locally on macOS arm64.
All three browser cases pass in 48.6 s; three additional repetitions of the
strict grouped-input case pass in 41.9 s without retries. The separate API suite
passes four cases in 26.78 s. The full workspace and static checks also pass;
[plan 175](../docs/tactical/175-native-provider-integration-scenarios.md#input-boundary-implementation-and-compatibility-selection)
records the final counts. Capture and platform limitations remain the same as
the source-app suite above.

Current-client behavior on supported older servers is unchanged when the new
optional field is absent; no new route/write or capability bit is required.
The reviewed core release corpus is 0.8.1, 0.9.0, 0.9.1, 0.9.2, 0.10.0,
0.10.1, 0.10.2 and 0.11.0, plus the existing 0.8.0 base. Their normalizers pass
native fields through but do not emit `inputMessageIds`. The maintainer approved
preserving existing absent-field behavior and excluding old-extension/frontend
qualification against new servers. These choices do not withdraw current-client
support for older servers or change queue defaults.

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
| Pi | Pinned 1.5.0 RPC; private models.json, Chat Completions. | Real RPC lifecycle and native JSONL reader. |
| OpenCode | Pinned 1.18.9 server; private custom provider, Chat Completions. | Actual server tool execution and production SQLite/export reader. |
| Grok ACP | Official 1.0.70; private TOML Responses endpoint. | Gentle interject; title, title refresh and dashboard requests explicitly recorded/scripted. Compatibility imports of other apps' rules/config are disabled in the owned fixture. |
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

The single [opportunity backlog and suggested next selections](../docs/tactical/175-native-provider-integration-scenarios.md#opportunity-backlog-and-recommended-next-work)
records remaining work and the architecture/testing improvements this harness
unlocks. It distinguishes implemented evidence from proposed depth; this topic
owns current contracts and qualification. The evidence does not change queue
defaults or justify removing implicit YA concatenation without identity/policy
qualification.
