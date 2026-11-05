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
pnpm test:providers:all             # All qualified launch paths
YEP_NATIVE_TEST_PROVIDERS=codex pnpm test:providers
```

The native provider workflow uses two workers on relevant push/PR checks.
Manual dispatches default to `auto`: provider and Linux app jobs use two
workers, while the macOS app job uses one. Explicit `1`, `2` or `4` selections
apply unchanged to every selected job; they remain controls rather than promises
that each capacity/worker pair is qualified. The same-source M1 control at
`a71daaa9d` passes ten app cases with one worker and unchanged guards, while two
workers exhaust nine guards. This selects a completed configuration, not a
sustained speed claim. Source `ddda13a4a` also passes all twelve app cases
with one macOS worker (311.47 seconds wall in run 42115449136). Its browser
step fails the separate 100 ms typing contract at 126.2 ms;
[that finding](../gaps/hosted-macos-native-input-acknowledgement-over-100ms.md)
remains open. Ordinary workspace concurrency and the browser's single
worker are unchanged. See
[Linux qualification](#linux-native-qualification-and-ci-gate).
Use explicit `--maxWorkers=2` or `--maxWorkers=4` with the native runners for
local controls. Both runners share process-exit handling, visible native
reporters, GitHub annotations and capacity/start/end host samples. Compare
separate `workers=2` and `workers=4` dispatches on the same source and capacity
key before claiming a speed change; a successful run after reducing concurrency
is qualification evidence, not by itself a performance result. Scenario guards
follow measured maxima below; native/listener readiness deadlines remain
unchanged. Initial browser composer mounting has its own 45-second guard: the
hosted M1 cold source-module graph remained incomplete at the previous
15-second guard, with 885 module requests and no session-detail request yet.
Forty-five seconds is three times that observed lower bound. All later browser
assertions and the 100 ms sequential-key acknowledgement limit are unchanged.
A controlled 16-second lazy-module gate fails the old mount guard and passes
this one through the full retained typing/reload/history scenario; the gate is
a one-time qualification probe, not an extra recurring test. The macOS app
job has a 20-minute guard, 2.23 times the observed 8m57s job at `ddda13a4a`,
leaving room for the cold-mount allowance and failure-evidence upload. Linux
and provider job guards stay at ten minutes. Neither readiness nor job guards
relax the 100 ms typing requirement.

The manual workflow's `suite` selector defaults to `all`; `providers` and `app` allow
targeted requalification when the other boundary's sources are unchanged.
Skipped jobs are not passes. Provider-only changes need not repeat an already
qualified application/browser matrix.

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
observation. The admin-route case uses the native SDK fork; the wrapper-signal
case uses YA's full-file Claude clone. Both keep the original commands without
attributing their inherited launches to the copy. Each then runs one new named
child from the copy. Removing only that launch's derived graph rows and scan
progress, replacing the API and reading ordinary detail restores exactly the
new copy launch from native command/result rows and the saved copy fence.
Inherited rows in these native cases are also withheld by the existing
source-id/birth predicates; the future-dated SQL/filesystem regression separately
qualifies the copy floor and its reapplication after lost scan progress.
The replacement is fenced by the worker's changed attached-server generation,
not a version reply that the retiring API can still answer. Accepted history
survives child deletion and another API replacement. Exact
post-teardown dispatch counts and endpoint failure checks remain enforced.
This is live scoped acquisition, not historical backfill or background-job
qualification. It introduces no public relationship response fields.


The separate opt-in `test/native-app/app-explicit-harness.test.ts` runs both
Claude and Codex parents through their actual shell tools. Each names a Claude
child in an explicitly different profile while an unchanged same-id native
header exists in the inherited profile. It requires pending v2 SQL with the
independent source/destination, holds the child's model response over an API
generation replacement, then checks the final edge in both directions. Codex's
actual streaming user result cannot publish an edge; only the terminal result
can finish the hint. Actual rejected reuse adds no evidence. The Codex case uses the code-mode `exec` → `tools.exec_command`/`write_stdin`
path and its actual unified-exec command items; direct top-level shell/tool
variants are not separately natively qualified here. Both protocols,
native child content, unchanged incumbent, process identity, joined cleanup and
exact four scripted model exchanges are asserted. This is POSIX qualification;
no paid inference or implicit-profile/OSS/Windows acceptance is implied.

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

Native-app qualification records monotonic fixture phases for private profile
setup, executable version checks, wrapper/host startup, API/frontend readiness,
creation and joined cleanup. Actual model requests carry their acceptance time;
admin restart requests/acceptance, backend crashes and newly observed worker
generations also mark recovery progress. A wall-clock anchor aligns monotonic
phases with server logs and host samples. An API response after a replacement
request alone does not establish that its generation changed.
Reports include at most sixteen request timings and sixty-four phase entries,
with no request bodies. The app runner selects the default reporter explicitly
so agent/minimal reporter selection cannot hide successful-case evidence. It
also records the existing performance harness's capacity key and start/end host
samples. Missing CPU or swap counters remain explicit; these diagnostic samples
alone do not establish a performance regression or improvement.

The plain app fixture owns cleanup before model/environment acquisition and
accepts an optional cancellation signal. Vitest cases use the test-owned helper
to pass their timeout/cancellation signal and join construction in
`onTestFinished`, even if the caller never retained a fixture. Version probes
and HTTP readiness observe cancellation; a cancelled constructor cannot proceed
to a new wrapper launch. Playwright and other callers retain the plain helper
without a Vitest runtime dependency. Existing readiness and case budgets remain
unchanged.

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
on the same worker. Codex runs a real command whose test-owned file gate emits
output and completes during typing. The case expands activity before typing,
requires tool-output frames during that interval, checks the final zero exit
status and completed tool row, and decodes binary/chunked frames with the same
shared decoder as the direct client. It focuses the composer once and uses
raw keyboard dispatch per key so repeated locator readiness checks cannot hide
a busy renderer. Completion must arrive as a live message before API replacement;
a completed row is checked before replacement, after replacement and after
reload. For the qualified literal POSIX Bash envelope with explicit absolute workdir
and only output/yield controls, it also requires exactly one tool row at each
point. [Bash identity convergence](codex-code-mode-render-convergence.md#2026-11-05-native-bash-identity-convergence)
records the actual captured records and conservative matching limits; this is
not qualification of arbitrary code orchestration or every shell envelope. Omitted
turn cwd and additional execution settings remain in the
[narrower Bash gap](../gaps/codex-bash-without-turn-cwd-or-with-login-still-duplicates.md).

The command records its PID and native start identity. Cleanup publishes a
terminal gate (also covering a late start), signals only a matching live
identity and verifies it is gone. An intentional early failure independently
verifies cleanup while the command is waiting. The command closes its watcher
and lets stdout drain naturally. The revised three-case macOS run passes in
47.4 seconds including cleanup, with one browser worker. This is diagnostic
evidence, not a sustained performance claim. The 120-second case guard is
2.74 times the prior hosted Linux maximum of 43.829 seconds, measured before
the added command/model continuation. Hosted qualification of the extended
case is pending; the independent 100 ms per-key bound and zero retries remain.
The ordinary mock browser suite excludes these scenarios. The API group is
opt-in separately from the native Process baseline and workspace tests.

Qualification on 2026-11-04: macOS arm64, Node 24.22.1, Claude 2.1.312 and Codex
0.166.0. Four API cases pass in 18.48 s wall time / 35.11 s summed test work;
a concurrent workspace run passes in 21.46 s / 39.95 s. Three browser repetitions
per provider pass without retries (six cases, 1.7 min, 16.3–17.7 s per case).
Desktop/phone captures use the repository artifact capture facility. The
browser scenario exposed and repaired a Codex normalization defect: an empty
`item/started` assistant was finalized asynchronously, and its delayed same-id
update could erase newer live text. Started messages now remain streaming.

The manual native qualification workflow includes Linux x64 and macOS arm64 app
jobs. Both are accepted at two workers in run 42047227082, with ten app cases
and three browser cases per platform; see [qualification scope](#linux-native-qualification-and-ci-gate).
The [historical macOS owner-interruption
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

Relationship fixture fault injection writes only its owned profile's derived
index. The app may still be committing metadata, so those atomic removals use
the existing bounded app barrier for SQLite writer contention. Only
`SQLITE_BUSY` is retryable; other mutation errors surface immediately and the
transaction rolls back. The fixture's closed signal fences retries. This is
test control, not another production writer or a wider runtime retry policy.

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

Owned Antigravity tests also observe the actual transport child's exit status
and stderr. This test-only observer reserves at most sixteen observations,
keeps at most 16,384 text characters per child and reports at most 4,000 characters after
omitting URL/credential-related lines. A clipped first line is discarded before
filtering, and a missing-library diagnostic retains only the library basename.
It requires the fixture's fresh private profile and synthetic credentials;
production stderr remains drained. An explicit unavailable observation exposes
a changed transport shape. Two real Node fault peers cover numeric exit and
POSIX signal status, split URL tails and filtered bootstrap output without model
inference. They share the existing transport-test setup rather than another
native startup.

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
The fixture's YA `Process` receives the same model and permission mode as its
adapter launch. Otherwise deferred inputs can overwrite the requested launch
mode with a default. Native Codex/OSS queue transcripts must retain Bypass's
`never`/`danger-full-access` pair on every turn. The existing OSS cancellation
and cold-continuation scenario uses default mode and checks that all persisted
turns retain `never`/`workspace-write`, exercising the opposite permission bound
without another native startup. These are requested-policy checks, not proof
of operating-system sandbox enforcement. Responses failure diagnostics retain
bounded recent native tool results as well as chat-protocol messages.
Grok buffers ACP assistant text until its native item completes; its held model
request and native interject acknowledgement establish the busy boundary instead.

The 20-case foundation takes 21.17 seconds of test work / 22.21 seconds including
Vitest startup locally. These are diagnostic samples, not CI performance claims.
Antigravity/OpenCode's multi-turn scenarios hit the initial 5-second budget;
their adjacent comments record the observed bound and derived 10-second ceiling.
Executable provisioning cost is separate: a warm frozen install takes 0.85 s;
the external macOS artifacts download about 170 MB combined on a cold cache.
Keep CI costs visible when expanding coverage. Linux is now qualified as
[recorded below](#linux-native-qualification-and-ci-gate); Windows's complete
native matrix remains unqualified. Artifact availability alone is insufficient.

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

## Linux native qualification and CI gate

The [provider-only run
42063066589](https://github.com/kzahel/yepanywhere/actions/runs/42063066589)
at `3fcffd386` passes all 69 native scenarios on Linux x64 / Node 22.23.4 with
two workers: 102.71 seconds wall and 186.57 aggregate test work. This includes
all seven direct child variants and configured depth-two OpenCode. The
four-CPU host records 54.5% whole-run CPU busy, maximum load 0.555 per
effective CPU, at least 15.2 GB available and no swap use. These are
diagnostic samples, not a sustained performance baseline. Windows's complete
matrix remains unqualified.

The workflow now runs the complete provider check for server/shared source,
native fixtures, their standalone environment builder, runner and
dependency-pin changes on main pushes and pull requests. Covering the whole
server source avoids an incomplete hand-maintained transitive dependency list;
client-only product and documentation changes do not start the check.
Automatic runs use two workers and cancel superseded checks. Each explicit
manual dispatch retains its own run, suite selector and one/two/ four-worker
controls. The Linux/macOS app and browser matrix remains manual; it is not
started by automatic provider checks. The ordinary server suite continues its
Claude/Codex baseline. No branch-protection setting is changed.

The first automatic [push run 42068711365](https://github.com/kzahel/yepanywhere/actions/runs/42068711365)
at `06c8d6f1c` passes all 69 cases in 95.76 seconds wall / 173.30 aggregate
work with the resolved default of two workers; the app job is skipped. The PR
conditions and equal path filters have static review, rather than a live PR
trial.

Earlier Linux Antigravity failures at `d33e616f9` are attributed by actual
native stderr to SIGABRT in Google initialization: the `nobody` group name was
absent, before ACP initialization or any model request. The provisioned Ubuntu
run resolves the existing user's primary GID and passes queue, cancellation
and retry; cold resume then exhausts ten seconds. Its subsequent fourteen
phase marks establish a passing 16.217-second cold case, including 3.287
seconds for the initial independent reader and 3.017 seconds for the final
reader. Setup and the first turn take about six seconds; native resume to its
model request takes 3.257 seconds. The final guard is 35 seconds, 2.16 times
that measured maximum, with both reader replays and every native-content
assertion retained. The guard adds hang headroom, not an acceleration or a
native retry.

The OpenCode startup/cancellation and retry cases previously exhausted five
seconds, cold resume ten seconds and nested Task twelve seconds. The complete
Linux run passes them, and the local 69-case run also passes while workspace
checks overlap (59.45 seconds wall / 112.70 aggregate work). Earlier macOS
failures under simultaneous workspace/native-app load remain historical
diagnostic evidence; no arbitrary concurrency or latency guarantee is
inferred. Raw evidence is retained in ignored
`tasks/input-boundaries-implementation/fifo-{all-native,all-second}.log` and
`tasks/session-relationships/slice-{14,25}-*`; the resolved test-budget
findings are preserved in Git history.

Before making this a recurring check, consecutive hosted two-worker runs
42060535825 / 42063066589 and the repeated macOS triple-suite overlap supply
the other measured maxima (Grok cancel/cold/retry bind in the latter). Guards
retain all assertions and native retries; they change failure headroom, not
passing work:

| Case | Observed maximum | Guard | Multiple |
| --- | --- | --- | --- |
| Antigravity queue | 9.224 s | 20 s | 2.17x |
| Antigravity cancel/continue | 9.520 s | 20 s | 2.10x |
| Antigravity retry | 13.063 s | 30 s | 2.30x |
| Grok gentle steering | 4.396 s | 10 s | 2.27x |
| Grok cancel/continue | 6.393 s | 20 s | 3.13x |
| Grok cold resume | 6.389 s | 20 s | 3.13x |
| Grok retry | 5.613 s | 15 s | 2.67x |
| OpenCode queue | 7.060 s | 15 s | 2.12x |
| OpenCode cold resume, both variants | 12.591 s | 30 s | 2.38x |
| Pi retry | 3.272 s | 8 s | 2.44x |

Only cold resume has the fourteen internal phase marks. Queue, cancellation,
steering and retry guards are based on complete case measurements. Earlier
macOS triple-suite overlap is a distinct workload, not proved by the quieter
Linux pass. The repeated overlap runs all 69 provider and ten app scenarios
successfully at two workers alongside the workspace suite. The original used
four native/app workers, so this establishes the supported two-worker setting
rather than four-worker overlap qualification. It takes 71.42/69.22 seconds
wall and 130.54/114.09 aggregate test work respectively. The shared 14-CPU
host reaches load 0.992 per effective CPU; Darwin CPU-busy/swap counters are
unavailable. This closes the earlier budget finding for that measured
workload, without an arbitrary-concurrency guarantee or native speedup claim.
The three newly binding Grok maxima receive the guards in the table; targeted
final-source checks follow without repeating unchanged workload bodies.

The separate [two-worker app run
42047227082](https://github.com/kzahel/yepanywhere/actions/runs/42047227082)
at `d03e72e0b` passes ten full-app cases and three actual browser cases on
both Linux and macOS. Its provider job fails and is superseded by the later
accepted provider run; a skipped app job in provider-only runs is not app
acceptance. App/browser sources are unchanged across these provider
diagnostics. This qualifies the retained relationship application boundary at
that configuration, not every future graph consumer or provider/platform
combination. The four-worker run 42047231416 fails both app jobs and remains
unqualified; exposing a manual worker control does not claim acceptance of
that setting. Vitest's existing ten-second cleanup-hook guard is shorter than
the full graceful plus forced terminator window; no hosted failure has been
attributed to that horizon, which remains a watch item without a deadline
change.

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

## Linux Antigravity bootstrap prerequisite

The native provider qualification runner requires the system group name
`nobody`. Antigravity ACP 1.4.5's Google native bootstrap resolves it before
ACP initialization; a missing name aborts with SIGABRT and no model dispatch.
The Ubuntu job creates only a missing group-name alias using the existing
`nobody` user's primary GID, preserving that account's numeric permissions. It
does not change provider flags, fixture credentials or protocol expectations.
The provisioned source passes all actual Antigravity scenarios at `3fcffd386`
in [run 42063066589](https://github.com/kzahel/yepanywhere/actions/runs/42063066589);
see the phase and guard evidence above.

For an owned Debian/Ubuntu testbed with the same missing-name failure, an
administrator can apply the same guarded alias before running the suite:

```sh
if ! getent group nobody >/dev/null; then
  sudo groupadd --non-unique --gid "$(id -g nobody)" nobody
fi
getent group nobody
```

The local installer and test scripts never run `sudo` automatically.

## Cold resume qualification phases

The shared cold-resume scenario stops its initial owner, opens history through
an independent production reader, then resumes from native persistence. This
covers opening a stopped session before sending new input, including the
Antigravity reader's native `session/load`, which may update continuation
metadata. The resumed model request must contain the initial prompt, actual
tool result and prior reply; after stopping the resumed owner, another
independent reader must recover both old and new turns.

Fourteen fixed monotonic phase marks printed for each cold case distinguish
construction, native exchanges, initial replay, source resolution, stop, final
replay and close on passing and failing runs. Awaiting the initial or resumed
request includes native spawn/load until model dispatch; these marks alone do
not separate those internal steps. A last mark without its successor names
unfinished work, not a completed phase. Timeout guards include reader and
shutdown work. These cold cases qualify view-then-resume. They do not establish
direct-only Antigravity or OpenCode resume.


The changed Process source `06c549a79` passes automatic Linux provider run
42081658163 (69 cases, two workers). App run 42081724289 passes Linux's ten app
and three browser cases, but its three-CPU M1 macOS job exhausts seven app-case
budgets before the browser step. The [hosted macOS gap](../gaps/hosted-macos-native-app-case-timeouts.md)
retains readiness phases, capacity and the pending one-worker control. No full
macOS or combined matrix acceptance is claimed for that source.


The existing Codex native-child scenario includes an actual child tool command.
Its marker must remain in native child persistence and never appear in the
parent Process stream. This qualifies the [thread ownership boundary](provider-child-sessions.md#codex-live-notification-ownership)
without inventing parent markers or dropping native child history. The new
assertion fails against the previous adapter and passes with the root-thread
filter; it adds one scripted child continuation and no additional CLI startup.


The Bash presentation slice `33059ad06` passes automatic provider run
42086495032 (all 69 cases); its app/browser matrix is not thereby qualified.
The same-source `06c549a79` one-worker control 42085703995 passes Linux, while
macOS is never acquired by a runner (zero steps, no log; capacity annotation).
It supplies no new macOS test result. The original executed two-worker timeouts
and the broader qualification limit remain in the hosted macOS gap.
