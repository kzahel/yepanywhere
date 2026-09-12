# Capture small provider sessions for offline regression tests

Status: first bounded capture/replay slice implemented locally, 2026-09-12.
Two real Claude/Codex sessions, import tooling, native/adapter replay, and
negative controls are available. The broader matrix, independent review,
mounted/browser coverage, and full transport replay remain pending.
Renderer repairs remain owned by [tactical 126](126-tool-display-regression-follow-up.md).

## First implemented slice — 2026-09-12

The [checked-in corpus and refresh recipe](../../packages/server/test/fixtures/captured/README.md)
contains complete native files and pre-conversion per-session logger records
from Claude Haiku (Agent SDK 0.3.258 / bundled CLI 2.1.258) and Codex Luna
(app-server 0.154.0, low effort). Both sessions performed read/write work,
successful and intentionally failing commands, then a second user-requested
read. A recorded Claude prefix also proves pending-tool behavior.

The maintainer authorized local capture with inexpensive models; this slice
used an isolated YA data directory and disposable project on macOS, rather than
the originally proposed Linux VM. Provider credentials/history remained in
their existing provider locations. Only the two selected sessions were imported.

The replay calls actual native readers and provider conversion methods, then
the existing normalization/augmentation/compiler harness. It does not replay
the provider transport/session loop or browser micro-delta reducer. Logger
envelopes are removed; raw provider variants/order and native relationships are
retained, with explicit string redactions for private capture context.

Thirteen offline tests enforce semantic expectations and negative controls through
the normal server test discovery; root tools typechecking includes the helper
and importer. The initial corpus is 269,033 JSONL bytes, with about 205 ms of
test time locally. Full tactical completion still requires broader scenarios
and mounted/browser evidence.

The real Codex case revealed a native failure-status discrepancy, now repaired.
Cold normalization associates authoritative native command metadata with the
single matching open code-mode Bash call. The captured failure is an ordinary
passing assertion; synthetic mutations cover missing, wrong-turn,
wrong-command, concurrent, and multiple-execution evidence, plus native success
with misleading printed JSON. Broader live/durable convergence remains outside
this slice.

## Motivation and existing work

The historical audit in tactical 126 found supported displays falling back to
raw output despite passing schema and fixture checks. Inventing native records
from the same renderer fixtures can reproduce an incorrect assumption on both
sides of a test. Capture a small baseline from real providers, retain native
shapes independently of display schemas, and replay it on every ordinary test
and CI run without invoking a live provider.

This is a bounded implementation follow-up to
[tactical 124's native ingestion and rendering work](124-enforced-tool-display-contracts.md)
and the [native coverage gap](../../gaps/tool-display-native-provider-coverage.md).
Extend the existing corpus and harnesses described in
[stream/persisted parity](../../topics/stream-persisted-render-parity.md) and
[the portable transcript baseline](061-portable-transcript-baseline-and-corpus.md).
YA already has checked-in JSONL fixtures, sanitized observed specimens, native
conversion tests, and mounted renderer tests. The improvement is independent
capture provenance and connected coverage, not introducing fixtures from zero.

Keep these guarantees distinct:

| Check | What it establishes |
| --- | --- |
| `scripts/validate-jsonl.ts` | Native JSONL parsing and provider Zod schema compatibility. |
| `scripts/validate-tool-results.ts` | Structured SDK tool-result schema compatibility. |
| `pnpm tools:audit` | Historical reading, lineage, normalization, augmentation, compilation, and display preparation; does not mount renderers. |
| Native replay/parity tests | Adapter/reader behavior and semantic convergence at the actual exercised entry points. |
| Mounted and browser assertions | Expected visible content, status, controls, media, and interactions. |

Ordinary CI already runs fixture-based tests, including tests of the reusable
audit itself. It does not scan a developer's complete private history or invoke
the standalone validators over that history. Keep broad local audits as a
source of additional specimens; a small baseline cannot replace their breadth.

## T3 Code reference

Source inspected on 2026-09-11 at commit
`57aee3e19f1910f3323f06384bb2a1d02b79e369`:

- [Recorded Codex wire fixture](https://github.com/pingdotgg/t3code/blob/57aee3e19f1910f3323f06384bb2a1d02b79e369/apps/server/src/provider/testFixtures/codexMultiAgentWire.json):
  a real two-child fan-out, with CLI version, model, effort, notifications, and
  responses. The routing tests preserve observed child-before-registration
  ordering and root-thread self-activity.
- [Runtime replay test](https://github.com/pingdotgg/t3code/blob/57aee3e19f1910f3323f06384bb2a1d02b79e369/apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts):
  production Codex runtime against a scripted fake provider process, combining
  the capture with explicitly constructed lifecycle and approval cases.
- [CI workflow](https://github.com/pingdotgg/t3code/blob/57aee3e19f1910f3323f06384bb2a1d02b79e369/.github/workflows/ci.yml):
  ordinary server tests run in three shards; replay needs no live model.
- [Import tests](https://github.com/pingdotgg/t3code/blob/57aee3e19f1910f3323f06384bb2a1d02b79e369/apps/server/src/project/AgentSessionScanner.test.ts)
  mostly construct JSONL; Claude import deliberately drops tool records.
  Adapter and UI tests also commonly construct events or normalized props.
  This inspection did not find a broad native-transcript-to-rendered-UI corpus.

Adopt the capture-once/offline-replay pattern. YA's full tool history requires
additional persisted-reader and presentation assertions. This was source
inspection, not a run of T3's test suite or a claim of equivalent coverage.

## Work plan

### 1 — define a bounded capture matrix

Start with Claude and Codex, selecting distinct production paths explicitly
(including Codex app-server versus OSS where applicable). Add other providers
as their independent conversion gaps are addressed. A few short sessions per
provider are the initial budget, not thousands or every model combination.

| Scenario | Facts and displays to preserve |
| --- | --- |
| File work | Read, write, edit, and search; paths, contents, and meaningful diffs. |
| Commands | Success, failure, output, and a detached command with wait/poll completion where supported. |
| Media | A small local image and mixed text/image output where emitted; retained media and file actions. |
| Plans and questions | Plan steps/counts and selected answers where supported. |
| Subagents and lifecycle | Parent/child ownership, completion, cancellation, and failure where supported. |
| Session continuation | Cold read/resume and one fork/lineage case where supported. |

Record unsupported or unobserved cells explicitly. A requested prompt is not
proof the provider used the desired tool. Verify each capture before counting
its coverage. Keep rare historical shapes from tactical 126 as separate
minimized specimens; current providers may never emit those older shapes again.

### 2 — capture real sessions in a disposable environment

Use a disposable Linux VM with a small synthetic repository and ordinary test
assets. When available, use the machine-control CLI and platform guide for VM
lifecycle. Keep machine selection and credentials outside repository fixtures.
Capture is an occasional development operation, separate from offline replay.

Save the final provider-native transcript, required child/ancestor sidecars,
and small referenced assets. Where a scenario tests live behavior, also record
the provider events before YA normalization and the responses needed for a
deterministic injected transport. Identify the exact capture seam: a final
JSONL file alone does not establish live-stream or adapter-wiring coverage.

Each specimen needs a manifest with scenario/prompt, provider and CLI/SDK
versions, model/effort, YA revision, capture date/platform, entry point,
required files, and expected semantic/UI facts. Mark real captures, sanitized
captures, reconstructed records, and synthetic extensions separately.

Sanitize before committing, following the existing private-corpus procedure.
Replace private paths, identifiers, and content consistently while preserving
joins, record ordering, null/omitted fields, array shapes, and media references.
Retain only synthetic task data and necessary assets; never credentials or
unrelated session history. Re-run readers and replay after sanitization so
redaction cannot silently break the case. Document the capture recipe so a
future maintainer can refresh it without the original VM or private files.

### 3 — replay through production ingestion and rendering

Extend existing fixture locations and test helpers after inventorying them;
do not build another normalizer or derive native captures from display inputs.
Feed persisted artifacts through production readers and lineage resolution.
Feed captured live events through the relevant adapter with an injected
transport or scripted peer where needed, then use production normalization,
augmentation, and transcript compilation.

Keep server checks data-only and mount client rows from the same corpus.
Assert pairing, ordering, ownership, execution status, prepared display
classification, and specific visible content/controls. Supported positive
cases must fail when they unexpectedly become raw, even if no exception occurs.
Exercise complete rows so media and safe input-side actions are covered too.
Compare live/durable facts only where both sources actually retain them;
live-only lifecycle details get their own assertions.

Use existing browser facilities for representative media opening, disclosure,
and desktop/phone behavior that DOM-only tests cannot establish. Replays use
local assets and deterministic clocks/transports; they must not contact real
providers or depend on the capture machine's filesystem.

### 4 — enforce the baseline in normal tests and CI

Wire the bounded corpus into existing root test/typecheck commands and CI,
including actual fixture discovery and server fixture typechecking. Publish a
coverage manifest that identifies provider path, scenario, evidence class,
and missing cells. Fail on absent declared fixture files and unexpected loss
of positive display semantics. Keep runtime and corpus size bounded and record
the measured cost of the added tests when implemented.

Prove the gate with temporary negative probes: remove a required specimen,
break a tool/result reference, and make a supported rich case return raw.
Each must fail its intended check. Replay must work from a clean checkout with
no provider credentials or private transcripts. Preserve older version cases
when refreshing captures, and document deliberate retirements.

## Completion and remaining boundaries

- [ ] Claude/Codex baseline captured, sanitized, and independently reviewed
  for structure and expected behavior; exact paths and missing cells recorded.
- [x] First two persisted/captured-live cases replayed at their declared reader
  and adapter seams; broader matrix and transport/session loop remain pending.
- [ ] Positive mounted assertions and representative browser interactions pass.
- [x] Root tests execute this corpus offline through the existing CI test
  command; negative probes prove gates. Remote CI has not been run for this slice.
- [x] First-slice capture/refresh procedure and durable coverage rules moved into owning
  parity/provider/testing documentation as implementation lands.

Local validation: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and
`pnpm test` passed. The new sources also received explicit lint/format checks.
The ordinary root test run included the capture checks with no provider authentication. All thirteen
checks now pass without expected-failure exceptions.

Fixture infrastructure can land before renderer repairs. Keep known failing
specimens linked to tactical 126 with explicit pending positive assertions;
do not bless their current raw fallback or hide them in an unexplained skip.
The baseline is complete only when its declared positive assertions pass.

Linux capture does not establish Windows/macOS provider process behavior.
Full historical coverage, every provider/tool variant, compaction/reconnect
timing, and exhaustive visual correctness remain separate obligations. This
plan does not change provider compatibility markers, implement renderer fixes,
or move product priorities in the roadmap.
