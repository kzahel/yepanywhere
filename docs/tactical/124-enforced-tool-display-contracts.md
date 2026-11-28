# Enforced Tool Display Contracts

Topic: tool-display-contracts

Status: checked registration and bounded review corrections implemented
2026-09-10. All 26 specialized registrations use schema-bound dispatch. The
review corrected supported shapes, failure/standalone output, callback variance,
commentary error state, per-operation expectations, and native reader evidence.
Original step 5 is still only partially evidenced: observed specimens and
conversion coverage do not yet span every distinct provider path. See
`gaps/tool-display-native-provider-coverage.md`; the older completion statement
below must not be interpreted as full native-corpus sign-off.

Validation record for the initial implementation (superseded by the correction
commit's validation for touched behavior):

- 976 registry mutation/lifecycle controls; 80 native paired specimens mounted
  on both delivery paths; 81 native server checks including variant accounting.
- Full client suite: 5,534 passed. Full server rerun: 4,930 passed, 54 skipped.
  Root test invocation also passed shared (719), relay (130), push broker (44).
  The unrelated watcher classification test race was subsequently fixed in
  [3351fcd47](https://github.com/kzahel/yepanywhere/commit/3351fcd47) by controlling
  pending-baseline event ordering; production watcher behavior was unchanged.
- Root lint and format checks clean; root typecheck includes compile-fail
  fixtures and the clean server fixture scope. Nine architecture probes pass.
- Browser fixture passes at both required sizes, including a width assertion,
  recovery/disclosure and zero page/console errors. Final captures inspected
  sequentially and archived at
  `.artifacts/ui-testing/2026-09-10-tool-display-contracts/{desktop,phone}.png`.
- Console budgets unchanged (110 chatty sites, 61 warn and 92 error sites).
  CSS module checks pass; coupled/scattered legacy ownership prevented bounded
  extraction. Only the new partial-text wrapping rule uses a new module.
- Validation ran on macOS. No Linux/Windows native filesystem behavior changed;
  those operating systems were not run locally. Native cases use deterministic
  injected messages, not paid live provider sessions.

## Review correction validation

- Full workspace run: client 5,666 passed; server 4,947 passed, 54 skipped;
  shared 719, relay 130 and push broker 44 passed. No watcher retry was needed.
- After the final label, partial-task and empty-standalone corrections, focused
  client checks passed 1,352 tests (including 1,077 registry controls and 94
  native mounted checks); native server checks passed 98. No runtime warnings.
- Root lint, formatter and typecheck checks passed, including the annotated
  callback compile-fail probes and clean server-fixture typecheck scope.
- Four browser cases cover recovery and restored semantics at 1000x600 and
  375x812. Final captures were inspected sequentially and archived in
  `.artifacts/ui-testing/2026-09-10-tool-display-review-corrections/`.
- Console budgets are unchanged. CSS ownership remains coupled/scattered;
  no independently owned extraction was identified. Validation ran on macOS;
  Linux and Windows were not run locally. Test filesystem writes use portable
  temporary-directory APIs and unconditional cleanup.

## Motivation and requested outcome

Issue [#124](https://github.com/kzahel/yepanywhere/issues/124) exposed a gap
between a valid retained tool record and the requirements of a rich renderer.
A real Claude subagent issued Write with `content` but no `file_path`. The
provider rejected the call, and both its SDK output and persisted child JSONL
legitimately retained the incomplete arguments. The collapsed Write preview
assumed a path existed and crashed the session before displaying the error.
Offline provider validation and live/persisted agreement cannot establish
that a renderer can consume that record.

Commit `dedea8fa7795c7c772ea46769be3651fa13f26d3` added selected display schemas,
raw fallback, and tool-row exception containment. It is a bounded fix, not a
complete type boundary: schemas and registrations remain separate, callbacks
can still consume unknown values, and callers can retrieve renderers directly.

The maintainer wants incremental implementation with a finite, test-enforced
end state. Future specialized tools should automatically inherit protection
and test obligations, without remembering a second schema map or test list.
This plan addresses tool-data shape failures; it does not claim arbitrary UI
code, asynchronous effects, or event handlers can never fail.

## Existing contracts and related work

Planning searched `tasks/` (absent in this checkout), `gaps/`, and tactical
plans. Extend the following existing owners rather than creating a parallel
normalization or transcript framework:

- [Provider output contract](../../topics/provider-output-contract.md):
  provider-specific conversion belongs in the provider seam; hot reads and
  fan-out remain permissive rather than fully runtime-schema parsed.
- [Rich text rendering](../../topics/rich-text-rendering.md#malformed-and-partial-tool-records):
  original records stay inspectable, actual execution status is preserved,
  display failure remains local, and corrected records retry rendering.
- [Stream/persisted parity](../../topics/stream-persisted-render-parity.md):
  durable counterparts must converge structurally, with explicit live-only
  exceptions and provider persistence remaining authoritative.
- [Portable transcript corpus](061-portable-transcript-baseline-and-corpus.md):
  semantic fallback coverage is partial and live/fallback browser specimens
  remain pending. Reuse and extend that corpus for this surface.
- [Portable transcript compiler](../../topics/portable-transcript-compiler.md):
  keep data-only display preparation separable from React. This plan does not
  introduce a native projection, public envelope, or wire-version change.
- [Server test typechecking](107-server-test-typechecking.md) covers server
  contract and type fixtures through root `pnpm typecheck`. The tool-display
  config also checks the mounted client suite and audit tools.

This is a renderer-boundary stability extension. It does not change roadmap
priority or take on the larger source-runtime, transport, or native compiler
initiatives in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## T3 Code comparison informing the proposal

Source audit of local `~/github/t3code` at
`d29c56a5c404cb0f58d3b2ac41762fa0d0ac28d4` on 2026-09-10:

- Live native events pass through provider adapters into canonical runtime
  events, orchestration commands, persisted application events, and projections.
  The event store decodes application events with Effect schemas; application
  types derive from shared schemas. Not every internal event is runtime parsed:
  Claude's `offerRuntimeEvent` queues its typed argument directly.
- T3 does read Claude JSONL and Codex rollout files. Its session importer
  extracts user/assistant text and resume metadata into application history;
  it does not reconstruct YA's full rich persisted tool transcript. Normal T3
  history instead comes from its own application event/projection storage.
- T3's `ItemLifecyclePayload.data` and activity `payload` remain
  `Schema.Unknown`. Shared envelope schemas do not prove arbitrary tool input
  is complete. Its inspected display path guards object/string extraction and
  uses generic work-log summaries. The missing-path Write example can be
  summarized without assuming a path, based on source inspection, not a live
  reproduction in T3.

Reference paths within that checkout:

- `packages/contracts/src/providerRuntime.ts`, `orchestration.ts`, `rpc.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`summarizeToolRequest`)
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `apps/server/src/project/AgentSessionScanner.ts`, `AgentSessionImporter.ts`
- `apps/server/src/project/AgentSessionScanner.test.ts` (drops tool records)
- `apps/web/src/session-logic.ts` (`toDerivedWorkLogEntry`, `extractChangedFiles`)

Borrow explicit application/display contracts and guarded consumption. An
Effect migration or application-owned shadow transcript would be much larger
and would not by itself close the arbitrary-tool-payload gap. YA retains its
stronger native-history fidelity obligation.

## Intended end-state guarantees

1. Every specialized tool display is registered with a display contract.
   Registration is the authoritative inventory for dispatch and tests.
2. Public display operations accept untrusted JSON-compatible tool data. A
   private checked dispatcher chooses a supported rich/partial variant or the
   shared raw fallback. Schema output is the prepared display model: a
   value-carrying discriminated union whose variants preserve the relationship
   between checked data, execution phase, and callback types. No cast promotes
   raw payloads, and no separate hand-written model hierarchy duplicates schemas.
3. Pending, incomplete, aborted, failed, and complete execution states remain
   distinct from whether rich display is available. Success schemas are not
   applied to provider rejection text as if it were a successful result.
4. Input-only, result-only, and paired displays explicitly state requirements.
   Standalone results remain usable when the original input is unavailable.
   Supported partial forms such as Read dedup and raw Edit patches remain rich.
5. Original input/output and provider augmentations survive for inspection.
   Checked projections must not accidentally strip fields needed by media,
   links, diffs, or commentary. Fallback/inspection infrastructure owns raw
   data separately from rich callback props. Known augment fields consumed by
   callbacks are explicitly checked and typed; preserving unknown fields does
   not grant callbacks access to them as trusted data.
6. All summaries, dynamic names, collapsed/expanded views, inline views,
   Conversation view, and nested/subagent tool displays use checked dispatch.
   Unknown tools receive generic display without needing a registration.
7. Unexpected render exceptions remain local and recover on record changes.
   Ordinary positive/negative contract tests require zero unexpected boundary
   catches, not merely an absence of uncaught page errors.

Completeness means every registered display and callable entry point follows
this boundary. It cannot mean predicting every future provider payload.

## Work plan

### 1 — inventory tool displays and establish coverage ownership

Enumerate production registrations, aliases, callback entry points, direct
imports, and special paths. Start with `tools/index.tsx`, `tools/types.ts`,
`displayContracts.ts`, `blocks/ToolCallRow.tsx`, `tools/summaries.ts`,
`renderers/blocks/ToolUseRenderer.tsx`, and
`lib/sessionDetail/conversationView.ts` in the client. Include the existing
26 registrations as a baseline to verify, not a permanently hard-coded count.

For each renderer, identify supported normalized variants, execution states,
augmentation dependencies, and existing fixtures. Define explicit coverage
ownership for provider/tool variants rather than an unrealistic Cartesian
product of every tool and provider. Unknown/provider-defined tools retain the
universal fallback test obligation.

Include `lib/validateToolResult.ts` and the imports of Bash internals from
`components/ToolCommentaryBoundary.tsx` and `lib/toolCommentarySource.ts`.
Developer diagnostics retain their distinct provider-schema purpose; inventory
checks must name supported diagnostic entries and deliberate omissions without
equating provider validity with display eligibility. The initial source audit
found 26 registrations, 7 input-display schemas, 4 result-display schemas, and
14 diagnostic result schemas. Re-enumerate on the implementation checkout.

Acceptance: an inventory generated from production registration and a bounded
legacy allowlist identify every entry point. New registrations cannot opt into
legacy status. The allowlist may only shrink during this migration.

### 2 — introduce checked registration and dispatch

Create a typed registration factory that owns schemas, declared display
variants/states, and callbacks. The factory captures each schema/callback
relationship before storing a safe dispatch interface in the heterogeneous
registry; a generic `register` signature alone must not erase that relationship.
Keep test fixtures out of the production bundle, but tie their manifest to
registry keys with exhaustive type/runtime checks so new registrations cannot
be omitted.

Pass the checked value, not the original unknown object after a boolean
`safeParse` check. Use schema-derived, value-carrying variants for supported
shapes. Name Edit alternatives such as raw patch and old/new strings instead
of treating an all-optional object as proof of every renderer requirement.
Declare result-only display support per definition; unsupported forms still
have the universal inspectable fallback. Keep provider conversion in existing
server/provider helpers; this boundary only establishes display eligibility
and prepares display-specific data.

Resolve execution phase and the effective error flag once for all operations,
including records whose status is `error` but lack an explicit result flag.
Rich callbacks receive only their prepared values and explicitly typed context.
The untouched raw record stays with fallback/inspection infrastructure, not in
the model passed to rich callbacks.

Make raw callbacks private. Public callers may request safe display operations
or inert metadata. Protect synchronous summary/name preparation as well as
React mounting; a React boundary cannot catch work performed outside its tree.
Retain per-row containment as the final defense for unexpected render bugs.
Route `summaries.ts` and dynamic names through safe dispatch; instrument any
last-resort synchronous catch so tests can distinguish recovery from success.

Start with Write/Read/Edit as representative input, result, alternate-shape,
and augmentation cases. Avoid repeated parsing per render callback by sharing
preparation for one immutable record/revision. Prepare after commentary has
transformed the record presented to the row; do not attach stale eligibility
to an earlier compiler output. Standalone callers use the same preparation
function for their actual input. Do not introduce an unbounded cache or mutate
a validated object afterward.

Acceptance: positive and negative compile-time fixtures prove required
registration fields and inferred callback types. Missing-path Write falls
back; complete Write, Read dedup, and supported Edit alternatives stay rich.

### 3 — enforce a registry-driven rendering suite

For each declared variant, require independent positive fixtures and semantic
expectations. Execute all declared operations and relevant lifecycle states.
Generate bounded deterministic malformed cases by deleting required fields,
changing scalar types, inserting nulls, and damaging nested array elements.
Also retain hand-authored issue regressions and provider specimens; generated
cases are containment evidence, not the oracle for schema correctness. Each
declared positive variant needs semantic expectations and a corpus specimen
from a provider that emits it, or an explicit synthetic-only explanation.

| Case | Required result |
|---|---|
| Valid supported variant | Specific rich content; raw fallback fails the test |
| Missing/wrong/nested malformed fields | Declared partial or raw display, original record remains inspectable |
| Pending to complete/failed | Correct content and actual execution status |
| Malformed to corrected | Recovery without stale fallback or identity loss |
| Result without input | Declared standalone display or inspectable fallback |
| Alias and unknown tool | Canonical protection or generic fallback |
| Collapsed/expanded/summary/inline | No unchecked entry point |
| Deliberately throwing renderer | Local fallback, neighboring rows usable, corrected record retries |

Mount components; obtaining a React element alone does not execute its render
body. Exercise representative disclosure/interactive transitions. Assert no
unexpected catches, React warnings, or page errors. The deliberate exception
test has an explicit expected-error assertion, not blanket console suppression.

Acceptance: removing a fixture or registering an untested variant makes CI
fail. Returning raw fallback for a valid control also fails CI. Seeds and case
names are stable and failures name tool, variant, operation, and mutation.

### 4 — migrate the remaining tool display surfaces

Migrate small groups based on the inventory: shell/search/web, task/agent/goal,
questions/plans, then remaining special displays. Sequence may change when
shared input/result families make a different grouping smaller.

Remove renderer-owned unsafe casts as each group adopts checked props. Route
all summary, dynamic-name, Conversation, standalone, and nested call sites
through the same dispatcher. Preserve current successful presentation and
supported provider augmentations; do not make raw fallback the normal output
merely to satisfy safety checks.

Move legitimate shared helpers such as `normalizeBashResult` and
`BashModalContent` to appropriately owned modules before enforcing private
renderer imports. Keep data-only preparation separate from React components.
Test that known augmentation paths, including highlighted Write output, still
use their intended rich presentation. Coordinate the developer-diagnostic
inventory without replacing its provider schemas with display schemas.

Acceptance: the legacy allowlist reaches zero and is deleted. The separate
schema map and unchecked public renderer interface no longer permit drift.

### 5 — verify native ingestion through rendered parity

Extend the existing corpus and parity harness instead of adding another
normalization implementation. For declared provider/tool variants, pair native
live events and native persisted records for the same logical operation, run
their production adapters/readers and normalization helpers, then compile and
prepare the resulting displays. Keep server parity tests data-only: compare
RenderItems and prepared display classifications/values there. Client tests
mount both outputs from the same corpus and assert the expected rich content.
The combined coverage exercises ingestion through rendering without requiring
React mounting inside server tests.

Current `runStreamPipeline` starts at `normalizeStreamMessage`, after some
provider-specific adaptation. Retain those useful focused tests, but do not
label them native-adapter coverage. New native cases must exercise the relevant
production seam with deterministic injected transports, not paid live sessions
as a CI dependency.

Assert semantic identity, ordering, parent/child ownership, status, structured
input/result facts, display classification, and expected visible content on
both sides. Pair the rejected Write regression as well as successful and
partial controls. Live-only facts retain their own lifecycle assertions;
unavailable durable facts are documented rather than fabricated for equality.

Coverage follows distinct production normalization paths that claim each
variant, not just one provider per renderer. Where providers share exactly the
same helper, record that equivalence and retain appropriate adapter-wiring
coverage. A single provider specimen cannot establish independent conversions.

Acceptance: the declared variant matrix has no uncovered rows or unexplained
exceptions. A provider shape change that causes rich output to disappear, or
one-sided loss of a paired fact, fails the suite even when fallback is safe.

### 6 — close bypasses and make the contract permanent

Add narrowly scoped architecture checks for importing private renderer
implementations, retrieving raw callbacks, and asserting raw payloads into
display types. Prefer TypeScript and module visibility; use parser-backed
checks for concrete escape patterns that ordinary typing cannot prevent.
Do not claim a lint rule proves arbitrary TypeScript assertions safe.

Wire registry coverage, rendering tests, native parity, and actual type tests
into ordinary root/CI commands. Include new server fixture files in a clean,
non-emitting enforced check, coordinated with tactical 107 rather than hiding
them behind its unenforced diagnostic baseline. Client `src/**/*` fixtures
already participate in its TypeScript check; tactical 107 coordination applies
to server-side fixtures. Prefer existing lint/configuration facilities and a
small parser-backed architecture test over a new custom lint plugin.

Acceptance includes deliberate negative probes: a renderer without a contract,
a missing fixture, a private import, an invalid callback property access, and
an invalid fixture must each fail the intended gate. Remove probes after
verifying the gates; retain appropriate compile-fail/tooling tests.

Update owning rich-text, provider-authoring/output, and parity topics with the
durable outcomes, callback boundary, and new-tool contribution procedure. Clarify
the distinction between bounded client display checks and permissive server
hot-path ingestion. Tests and this tactical are not substitutes for contracts.

## Validation and completion

- Zero legacy registrations, raw public callbacks, or unguarded identified
  display entry points; test inventory derives from production registration.
- Positive rich controls and malformed/lifecycle/fallback coverage pass for
  every declared display variant and operation.
- Native paired specimens establish both convergence and renderability for
  the declared provider/tool coverage matrix, with explicit bounded exceptions.
- Root/CI actually executes the new checks and typechecks their fixtures.
- Relevant tests are warning-free; source changes pass typecheck, lint, and
  formatter checks. Client changes follow console/CSS policies and scoped
  formatting. Use existing browser facilities for final representative live,
  fallback, and nested transcript verification under repository UI policy.
- Validation is proportional to displayed records; no full-transcript runtime
  parse, new background loop, or unbounded validation cache is introduced.
- Successful views preserve semantics and augmentations. Original invalid
  records remain inspectable, with actual execution status and local recovery.

## Scope

This is a medium-sized renderer-boundary migration plus targeted corpus work.
It does not replace native persistence, remodel the wire protocol, adopt Effect,
or promise full runtime validation of provider messages. A newly discovered
upstream normalization defect gets its own bounded fix and contract evidence;
it is not authorization to expand this migration indefinitely.

## Implementation-machine handoff

The maintainer selected another machine for implementation because it has more
session history to validate against. Begin there by reading this plan and the
owning topics, checking current source/registration inventory, and locating the
existing local corpus. The local review-session URL and T3 checkout are useful
optional references; neither is required to understand the accepted design.

Use that history to characterize actual provider versions, tool variants,
partial/error records, augmentations, and nested sessions. Record coverage and
source-version provenance, distinguish captured native events from synthesized
fixtures, and identify missing distinct normalization paths before claiming
completion. Use existing corpus tooling and deterministic replay first; new
live sessions are targeted gap-filling evidence rather than a CI dependency.

Keep private transcripts and raw diagnostic artifacts local. Commit only
sanitized minimal fixtures that preserve the relevant shapes, states, and
relationships. Follow the existing private-corpus procedure in tactical 061.
Provider schema checks, parity checks, and mounted display checks establish
different guarantees and must be reported separately.

Implement and validate the steps in bounded groups, maintaining the shrinking
legacy inventory and the acceptance matrix. Finish by verifying CI gate failure
probes and migrating durable behavior into owning topics. Update this plan's
status with evidence as work lands; the larger corpus is additional evidence,
not a substitute for the enforced registration boundary or an excuse to leave
uncovered registered displays at completion.

## Independent review and accepted decisions

Reviewed on 2026-09-10 through YA at `localhost:3400`. The process reported
resolved model `claude-fable-5-1` and effort `medium`. The read-only reviewer
examined this draft plus YA and T3 source and completed its turn without file
edits. Its full review is retained in
[the YA review session](http://localhost:3400/projects/L1VzZXJzL2tncmFlaGwvY29kZS95ZXBhbnl3aGVyZQ/sessions/aae054e5-a44f-4f20-b27b-33c62ef5cb26).
The session link is machine-local evidence, not a portable documentation
dependency. This section preserves the findings needed without that server.

### Reviewer recommendation

The reviewer supports the approach and favors a hybrid: schema output is the
prepared display model. A typed factory should return value-carrying variants
and preserve the relationship between a schema and the callbacks consuming it.
A separate hand-written model hierarchy would duplicate much of that work.
The original step 2 already requires passing checked values; the review makes
the representation and enforcement of that requirement more concrete.

The review also recommends keeping normalization/parity comparison in the
server's data-only harness and mounting components in the client from the same
corpus. Pipeline coverage should connect through shared fixtures and assertions,
without requiring React rendering inside the server test suite.

### Source-checked findings incorporated into the work plan

- `ToolRenderer` has type parameters, but the registry stores the default
  `ToolRenderer` whose inputs/results are unknown. Merely adding a generic
  registration method is insufficient unless the factory captures and retains
  the schema/callback relationship inside the checked dispatcher.
- `lib/validateToolResult.ts` contains another per-tool schema map for developer
  diagnostics. Its purpose differs from display eligibility. Decide inventory
  coordination explicitly without treating provider validation and display
  validation as interchangeable. Source recheck found **14** entries, correcting
  the review's reported 13; current display maps have 7 input and 4 result entries.
- `ToolCallRow` derives the error flag differently at its outer eligibility
  check and some registry calls: the first falls back to `status === "error"`,
  while later calls fall back to `false`. Establish one authoritative display
  execution-state interpretation and test the absent-result-flag case.
- Commentary code imports `normalizeBashResult`/`BashModalContent` from the Bash
  renderer. Relocate legitimate shared helpers before enforcing private renderer
  imports. Preparation must account for commentary transformations, which can
  change the input seen by rendering.
- Existing malformed-record tests use server-side React rendering for most
  cases. That executes render bodies, but does not verify mounted lifecycle,
  effects, or interaction. Retain those useful tests and add client mounting
  and positive semantic controls rather than describing them as no rendering.
- Client `src/**/*` fixtures already participate in its TypeScript check.
  Tactical 107 coordination is specifically for server-side parity/type fixtures.

### Accepted qualifications

The reviewer suggested carrying untouched raw data on the prepared model. Keep
it owned by fallback/inspection infrastructure rather than exposing it to rich
callbacks; otherwise a renderer can regain the same unknown-data escape hatch.
Preserving unknown augment fields does not make them trusted. Fields consumed
by rich callbacks still need typed, checked representation.

The reviewer suggested at least one native provider specimen per display
variant. That is useful minimum evidence, but it does not cover every distinct
provider conversion. Retain coverage for distinct production normalization
paths that claim the variant, with explicit shared-helper equivalence or
documented gaps instead of claiming one provider proves all providers.

T3's inspected generic work-log path avoids YA's particular Write assumptions;
the review's broader phrase that T3 never attempts per-tool rich display should
not be treated as an audited repository-wide absence claim. Likewise, an exact
cast-count audit or a promised tiny custom checker is not a completion proof.

The maintainer accepted the schema-derived model and the qualifications above.
The implementation steps now specify preparation after commentary transforms,
named Edit alternatives, standalone-result capabilities per definition, and a
distinct but coordinated developer-diagnostic inventory. The review notes above are retained as design history. The correction pass
keeps safe public operations over private parsed values rather than exposing
a fully phase-correlated prepared-value union; that representation is an
explicit design qualification, not a claim that all intended guarantees have
been mechanically proved.
