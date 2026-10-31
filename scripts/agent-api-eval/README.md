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

# Same agent task through basic fleet enrollment, opaque invitations and relay.
pnpm exec tsx --conditions source scripts/agent-api-eval/run.ts --run \
  --peer-fleet --cases workflow --variants help --max-trials 1
```

Defaults: `gpt-6.1-sol`, medium effort, one sample, identity only, three variants,
three-trial cap, 120 seconds per trial. `--samples` permits 1–3; declare a larger
`--max-trials` for an expanded matrix. `--timeout-seconds` is a declared model-run
budget, not a test-performance assertion. Variant order rotates per case/sample.
`--out` selects local output, defaulting to ignored `tasks/agent-api-eval/`.
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

`--peer-fleet` uses the same peer-relay workflow and bootstrap, with an owned
standalone basic-account service, key-bound enrollment, signed/JWE invitation
delivery and issuer-bound protected peer tokens. The account service uses its
real HTTP adapter in-process; peer requests use the real owned encrypted relay.
The plan records `peerFleet` separately so this is not mistaken for manual
enrollment or a live external-provider qualification. Profile keys and credentials
stay in owned fixture storage and are removed on cleanup.

`--peer-relay` currently supports `workflow` only. It wraps the scripted native
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
