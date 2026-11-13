# Agent HTTP API documentation eval

Opt-in behavioral checks for [plan 166](../../docs/tactical/166-agent-api-bootstrap-and-documentation.md).
Normal tests call no models. The fixture imports the real CoreApi and private
HTTP adapter with deterministic sources: no full YA app, profile discovery,
scanner, real project tree or public listener. A test-only private proxy records
HTTP outcomes and exact response bytes without authentication headers/bodies.

```sh
# Print the matrix and byte baseline; no auth access or model calls.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts

# One setup qualification trial using existing ChatGPT Codex sign-in.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run --variants help

# Small descriptive comparison: 12 fresh trials, serial within the runner.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --cases identity,pagination,unsupported,control --max-trials 12

# Optional local diagnostic; this does not expand shipped provider eligibility.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --local --variants help --cases identity

# Confirmation lane, not another mandatory matrix.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --effort high --variants help --cases pagination

# One real encrypted-relay peer workflow with two isolated profiles.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --peer-relay --cases workflow --variants help --max-trials 1

# Same agent task through basic Identity Service enrollment, opaque invitations and relay.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --peer-identity-service --cases workflow --variants help --max-trials 1
```

Defaults: `gpt-6.1-sol`, medium effort, one sample, identity only, three variants,
three-trial cap, 120 seconds per trial. `--samples` permits 1–3; declare a larger
`--max-trials` for an expanded matrix. `--timeout-seconds` is a declared model-run
budget, not a test-performance assertion. Variant order rotates per case/sample.
`--out` selects local output, defaulting to `ya-agent-api-eval/` in the system
temp directory.
Do not point it at a shared or tracked directory. No model calls belong in CI.

Local mode uses the installed Codex OSS/Ollama harness, default model
`qwen3.5:9b`, and no hosted auth. Tool calling and bootstrap must pass the setup
case before local results count as documentation evidence. Harness/setup
failures are distinct from wrong model answers. Qwen is diagnostic, not an
acceptance gate. `--model` selects an explicit different model; never compare
documentation variants across different models as though text caused the gap.

The subscription lane uses a saved `auth.json` with `auth_mode=chatgpt`; API-key
auth and ambient API keys are not passed. Each trial has a fresh mode-0700 HOME,
CODEX_HOME and cwd, only a mode-0600 access-only copy of the saved sign-in, no copied personal
config/instructions/skills, ignored user config/rules and an ephemeral CLI
session. The original credential file is never changed by the runner. The copy omits
API-key fields and blanks refresh authority, so it cannot rotate the operator
refresh token. Preflight requires access expiry to cover the declared matrix
budget plus margin and a recent refresh timestamp. Refresh an old sign-in
through the normal Codex workflow before retrying; there is no billing fallback. The real-model runner currently requires POSIX process groups; native Windows
eval execution is deferred until descendant cleanup is qualified. Windows API
transport/PowerShell test paths remain separate. Profiles and fixture listeners
are removed on completion, timeout and handled interruption. SIGKILL/crashes
cannot guarantee cleanup; do not share residual `ya-agent-eval-*` directories.

This is a fresh task environment with full shell tools, not an OS isolation
sandbox. The model is instructed to use the private fixture API for YA facts.
Inspect command traces when interpreting results. Obvious legacy-API/personal
file/source shortcuts are flagged and disqualify a trial; this heuristic is
not a proof against every filesystem shortcut. No MCP servers or web tools are
configured. Codex shell snapshots are disabled, matching API-enabled YA
launches. Actual native Windows and packaged provider qualification is separate
from this local behavioral harness.

The three variants import actual shipped text, not copied prose:

| Variant | Supplied context |
| --- | --- |
| minimal | Actual connection command plus schema discovery link |
| help | Actual shared bootstrap, with help/schema discovery links |
| inline | Actual bootstrap plus generated Markdown help |

All variants can fetch the same live help/schema. Cases cover own identity,
exact project lookup, matching sessions beyond page one, summary inspection
among similar titles, incomplete-catalog absence, unsupported writes/remote
routing and an ordinary arithmetic task that should need no API calls. Graders
compare domain identifiers and requested results with fixture truth and real
successful API evidence, not exact prose or a prescribed call sequence. The
control case fails if it makes unnecessary API calls. `conversation` extracts an exact
artifact from prose amid native tool noise; `evidence` checks that unknown activity
and incomplete coverage are not reported as successful completion. `follow` waits
for scripted worker progress; `reconnect` checks explicit replacement after a
window change. Both use the production bounded follow adapter. `create` uses an explicit
management lease, real in-memory SQLite retry receipts and scripted native-owner
admission, then checks the worker answer and creator via HTTP. `workflow` adds
queued follow-up input, an identical-key retry, receipt consumption and the
follow-up answer. Its grader requires the same receipt id on both successful
submissions and an actual successful consumed receipt read; answer prose alone
does not pass. Normal tests exercise that complete private-HTTP fixture without
calling a model.

`--peer-identity-service` uses the same peer-relay workflow and bootstrap, with an owned
standalone basic-account service, key-bound enrollment, signed/JWE invitation
delivery and issuer-bound protected peer tokens. The account service uses its
real HTTP adapter in-process; peer requests use the real owned encrypted relay.
The plan records `peerIdentityService` separately so this is not mistaken for manual
enrollment or a live external-provider qualification. Profile keys and credentials
stay in owned fixture storage and are removed on cleanup.

`--peer-relay` supports `workflow`, `target_contract`, `approval` and `controls`. It wraps the scripted native
work in real independent peer managers, private profile storage, protected SRP
and an owned ephemeral relay. The model receives its source launch connection,
discovers the other authorized host and uses server-addressed HTTP there. The
grader requires remote HTTP evidence and the same retry/consumption/provenance
outcomes. It does not contact a public relay or launch real worker models.

Reports include every completed or timed-out trial, success, exit status,
HTTP requests/errors/repeats, time to first successful HTTP request, duration,
bootstrap/prompt bytes, fetched documentation bytes including repeated reads,
command count and CLI-reported usage. Summed processed input is not unique
context added. Cache counts do not establish documentation-specific cache
savings. No dollar price or tokenizer estimate is invented; unavailable usage
is null. Zero usage is not substituted for missing reporting. Results may be
false while the runner exits successfully; inspect successes/trials rather
than treating exit status as a product gate.

Raw JSONL and stderr are retained locally after redacting the launch grant and
known saved-auth values. They remain potentially sensitive task artifacts.
Do not publish them without inspecting them. Provider rate/usage exhaustion
stops the matrix; there is no automatic fallback to API-key billing.

CI runs deterministic tests in `test/core-api/eval.test.ts` to exercise real pagination, incomplete
catalog semantics, auth-failure/repeated-byte tracing, grader rejection,
access-only auth and a TERM-resistant descendant surviving its leader.
`tsconfig.agent-api-eval.json` checks the runner via the root typecheck gate.
The run plan records harness/docs source hashes and CLI version. Root
`tools:check` runs the dry-run command to print the current exact byte baseline
in CI logs, without reading auth or calling a model;
there is no arbitrary token ceiling or full-prose snapshot.

Initial macOS byte baseline (2026-10-30): minimal 292, help 696, inline 8,353;
served help 7,655 and launch-bound OpenAPI JSON 57,517 bytes. These are UTF-8
bytes, not model tokens. Evidence and sample sizes are recorded in plan 166.

Codex `exec`, JSONL usage and ephemeral/controlled-config behavior follow the
[official non-interactive documentation](https://developers.openai.com/codex/noninteractive).
This is local, explicitly requested account use, not a CI auth distribution
workflow. Reviewers continue to be launched through YA; the eval process runs
directly so fixture env and personal context can be controlled without adding
an arbitrary-environment injection API to YA.

The `operation` case discovers `createSession` and reads its focused schema;
fetching the full schema fails that case. `selection` discovers a named AAR
pool, creates a worker with model/high effort/Fast tier/plan mode, and verifies
its selected account and last-applied settings through session detail. The
fixture derives readback from submitted controls; the grader rejects missing
or wrong HTTP readback even when final prose claims success. Its scripted
worker is API-contract evidence, not a live AAR/provider qualification.

For a comparable baseline and candidate, run the same model, CLI, variants,
cases and samples, then compare the complete reports:

```sh
pnpm exec tsx --conditions source scripts/agent-api-eval/compare.ts \
  /tmp/ya-v0-before/results.json /tmp/ya-v0-after/results.json
```

The comparison refuses incomplete or duplicate matrices and reports each case
as well as totals. It exits nonzero for task failures or increased aggregate
requests, errors or fetched documentation bytes, both overall and per case. Path/response bytes,
full-schema reads, command counts and duration remain visible. These small
paired trials are descriptive; call/byte costs need no timing benchmark, and
no host-latency or statistical model-quality claim follows from elapsed time.
New tasks require their own successful trials rather than being treated as
zero-cost unsupported baseline tasks. Normal CI verifies the new graders,
private-HTTP workflow, focused-schema size advantage and help size against the
observed 15,884-byte pre-change baseline, without calling models.

The [2026-11-12 evidence](../../topics/http-api-v0.md#measured-discovery-evidence--2026-11-12)
records a complete 10-trial comparison: 10/10 successes before and after,
61→54 requests and 111,188→72,138 fetched documentation bytes, with all per-case
checks passing. It also records rejected intermediate candidates, full-schema
and bootstrap growth, new-task qualification, and the limit on timing claims.

## Target-owned API and control tasks

[Plan 192](../../docs/tactical/192-v0-session-control-and-peer-contracts.md)
adds three tasks to the same protected peer fixture. `target_contract` discovers
an operation absent from the access table, reads the target's focused schema,
submits its required query and returns the unfamiliar result. `approval` inspects
and answers a blocked worker, then reads its post-approval artifact. `controls`
interrupts one worker, stops another and verifies both receipts and session
states. Graders require actual domain effects and reject unsupported prose.
These workers remain scripted; native CLI and cross-host qualification are
separate from documentation usability.

```sh
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --peer-relay --variants help --cases target_contract,approval,controls \
  --max-trials 3
```

Mutation bodies now use a plain `prompt` string and `Idempotency-Key` headers.
The grader and fixture follow the target's operation names and schemas, while
receipt admission/delivery remains separate from task completion. Normal CI
covers the new task effects, grader rejection and both incoming/outgoing grant
ceilings without calling models.

The November 13 candidate passes all eight tasks: four existing local tasks,
one existing peer workflow and these three new peer tasks, with zero HTTP
errors. The paired comparison intentionally does not pass its byte/call
non-increase gates: local requests are 35→34 while documentation bytes are
71,176→76,212; peer requests are 15→18 and bytes 12,023→49,985. The peer trace
adds target help and two focused target schemas as intended. The expanded
guide alone is about 1.2 KiB larger. Target-addressed documentation was initially
missing from the aggregate byte counter; comparison now derives this metric
from the retained HTTP traces, including those historical reports. This qualifies behavior, not an efficiency improvement
or a statistical model comparison; inspect comparison results separately from
per-task success.

## Native cross-host control qualification

`test/native-provider/native-v0-peer-target.test.ts` is an explicit opt-in
fixture, skipped in normal CI. It launches the pinned real Codex executable
against the scripted local model, then serves the protected peer API. On the
owned target, set `YEP_NATIVE_PEER_SOURCE_ID` to a fresh UUID and
`YEP_NATIVE_PEER_TARGET_READY` to an owner-private temporary JSON path, then run:

```sh
pnpm --filter @yep-anywhere/server test \
  test/native-provider/native-v0-peer-target.test.ts --maxWorkers=1
```

The ready file contains this short-lived fixture's invitation, server id and
listener port. Orchestrate target startup, private file transfer and a temporary
listener-port firewall rule through the machine testbed's common CLI. On the
controller, use the copied ready file and the target's reachable address:

```sh
pnpm exec tsx --conditions source \
  scripts/agent-api-eval/native-peer-control.ts READY_JSON \
  ws://TARGET:PORT/peer/ws
```

The controller uses an isolated private agent API and a new peer manager; it
checks real approval, native output, prompt retry, interrupt, verified stop,
retained metadata, unknown response fields and delayed provenance. It prints
only outcome booleans and call count. It uses no provider sign-in or configured
user peer. Signal target teardown by creating `READY_JSON.done` on the target
within its declared 120-second external-controller window; remove the fixture
JSON, temporary firewall rule and profile afterward and restore testbed power
state. This is manual native qualification, separate from real-model evals.

The November 13 macOS→native Windows ARM64 Node 24.22.1 run passed all these
checks (31 HTTP calls); the retained controller then passes the same scenario
with 25 calls. Native Windows Codex also passed the local approval/
interrupt/stop case in 17.67 seconds after an earlier 20-second run reached its
first model request but exhausted that guard; its retained 60-second Windows
budget is three times that observed lower bound. Native macOS Claude/Codex
controls and the four existing app creation/replacement combinations passed.
These focused results do not establish a passing whole-repository Windows
suite; [the baseline limitation remains](../../gaps/windows-validation-baseline.md).
