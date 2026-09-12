# Codex Code-Mode Render Convergence

> Refactor Codex command normalization around one rollout-recoverable semantic
> action analysis so GPT-5.5-style calls and GPT-5.6 code-mode calls render
> useful `Explored` summaries without changing structure after reload.

Topic: codex-code-mode-render-convergence

Status: complete as of 2026-07-10. Extraction, parity propagation, bounded
identity reconciliation, provider-neutral projection, compact multi-action
rendering, semantic search, and interaction/layout hardening are implemented
and verified against the available Codex rollout corpus.

Canonical slice status, landed commit history, verification evidence, and
deferred follow-ups are tracked in
[`docs/tactical/059-codex-code-mode-explored-rendering.md`](../docs/tactical/059-codex-code-mode-explored-rendering.md).
This topic remains the product/architecture contract and evidence record.

Implementation progress:

- [x] Pin the local upstream reference to Codex `0.144.1` and verify the
  checked-in protocol artifacts.
- [x] Extract the existing read/search shell recognizers into standalone
  `codex/displayActions.ts` semantic analysis.
- [x] Derive ordered, fail-closed action vectors for the observed compound
  read sequence and compare them with sanitized live `commandActions` oracles.
- [x] Route existing single-action normalization through the new analyzer while
  keeping compound execution as one `Bash` call.
- [x] Carry rollout-derived multi-action analysis through the normalized
  in-memory tool-call shape with live/reload parity.
- [x] Reconcile one-to-one code-mode `commandExecution` parents to the outer
  durable `custom_tool_call` identity using exact same-turn semantics.
- [x] Project canonical and multi-action exploration into ordered entries
  owned by their original result-bearing parents.
- [x] Render one-to-many actions within `Exploring` / `Explored` groups while
  retaining one raw parent and one combined result.
- [x] Harden semantic search, navigation identity, collapse/raw-detail state,
  file/range interactions, responsive clipping, and opt-in intrinsic height.
- [x] Complete provider/client parity, protocol, selected-schema, and full
  Codex-corpus verification. Manual before/after screenshots were explicitly
  waived by the user and are not claimed as performed.

The in-memory boundary is the provider-neutral `ToolDisplayAction` contract in
`packages/shared/src/tool-display-actions.ts`. Codex normalization attaches its
rollout-recoverable vector as `_displayActions` on a `tool_use` block, and
client preprocessing carries it to `ToolCallItem.displayActions`. Neither field
is written back to the rollout or to another YA-owned durable record. Live
`commandActions` remain test/diagnostic oracle data and do not populate this
field.

See also:
[stream-persisted-render-parity](stream-persisted-render-parity.md) (the graded
live/durable convergence contract),
[provider-read-edit-disciplines](provider-read-edit-disciplines.md) (current
canonical tool and exploration-kind layers),
[provider-refresh](provider-refresh.md) (upstream audit procedure), and
[codex-sessions](codex-sessions.md) (rollout reader behavior).

## Product constraints

1. **Codex rollout files are the sole durable transcript source of truth.** Do
   not add a YA-owned durable message, metadata sidecar, or shadow transcript
   to preserve live app-server detail.
2. **Tool calls present live and in rollout should strongly converge.** The
   active tail may move, but reload should not replace one tool structure with
   another, reorder calls, or change grouping merely because the live SDK had
   richer metadata.
3. **Useful live-only events remain allowed.** This plan does not prohibit
   ephemeral thinking, progress, status, or other tail information absent from
   rollout. It applies the stricter convergence expectation to Codex tool calls
   that have durable counterparts.
4. **No model-version branch.** Normalize observed provider shapes, not model
   names. GPT-5.5 and GPT-5.6 may appear in one session, and future models may
   reuse either call shape.
5. **Fail closed.** An ambiguous or mixed command remains an honest `Ran` /
   `Exec` call. Do not label arbitrary execution as exploration.

## Evidence and current gap

### Persisted GPT-5.5 shape

The sampled GPT-5.5 rollouts primarily use separate `function_call` records
named `exec_command`. YA canonicalizes a simple `sed`, `cat`, or `rg` command to
one `Read` or `Grep` tool. The client then folds adjacent canonical tool calls
into an `Explored` group.

This path appears polished largely because the provider commonly emits one
simple shell action per call. Compound commands have always fallen back to
`Bash`; they were merely less common in the inspected GPT-5.5 sample.

### Persisted GPT-5.6 code-mode shape

The observed GPT-5.6 rollout records an outer `custom_tool_call` named `exec`.
Its input is JavaScript orchestration containing nested calls such as
`tools.exec_command({ cmd, workdir, ... })`; the corresponding result is an
array of text blocks. The rollout does not contain the app-server
`commandActions` array for that nested execution.

`codex/codeModeExec.ts` extracts literal nested calls without evaluating
JavaScript. When exactly one nested `exec_command` is found, it enters the
normalizer. The standalone display-action analyzer now derives every safe
read/search/list action from a compound command. The parent remains one `Bash`
call with an ordered `displayActions` vector because it still owns only one
combined execution result.

### 2026-07-11 shape drift: JS-literal arguments and detached cells

A GPT-5.6 rollout from 2026-07-09 (`019f48bb-…`, 1,797 `exec` calls)
falsified two assumptions of the shipped extractor:

- **Nested-call arguments are JS object literals, not strict JSON.** The
  model emits unquoted identifier keys, single-quoted strings, spaces, and
  trailing commas — often mixed with quoted keys in one object
  (`{cmd:"pwd && ls","workdir":"/repo"}`). Strict `JSON.parse` rejected
  essentially every `exec_command` in the session, so every run fell
  closed to a raw `exec` block and the transcript omitted the command.
  The literal reader now parses JS literal expressions without evaluating
  code (identifier keys, `'…'`/interpolation-free `` `…` `` strings, JS
  escapes, trailing commas) and still fails closed on interpolation,
  identifiers, and calls. Evidence: 738/738 single-`exec_command` calls in
  that rollout recover their command; the 4 remaining raw `exec` blocks are
  genuinely non-literal or looping scripts.
- **Scripts detach into cells.** A code-mode script that outlives its
  `yield_time_ms` returns `Script running with cell ID N`; a later
  `function_call` named `wait` (`{cell_id, yield_time_ms, max_tokens}`)
  collects the finished script's printed output — commonly a unified-exec
  result record `{chunk_id, wall_time_seconds, exit_code, output}`.
  `wait` now normalizes to the `WriteStdin` (Shell, "waiting for output")
  presentation; unified-exec chunk records unwrap to their inner `output`
  (with `exit_code` driving the error state) for `WriteStdin` and `Bash`
  results; and client preprocessing links `wait` rows to the originating
  command by cell id, including a poll that itself detaches into a new
  cell. Anything not exactly one chunk record keeps its raw text.
  Two more linking/presentation rules (2026-07-11): a wait's collected
  output may reveal the PTY session its script started — a provider
  envelope or the script-printed `SESSION_ID=N` convention — and
  preprocessing bridges the origin command to that session, so later
  `write_stdin` polls of it (and cells they detach into) inherit the
  linkage. A detach envelope renders as "still running →
  script cell N" rather than "No output", and a completed pure poll
  with no output, no exit code, and no linked context after enrichment
  is hidden as an info-free row (pending polls stay visible). Cell ids
  are not unique across a rollout (numbering restarts); the maps process
  in transcript order so the latest declaration wins.

### 2026-09-12 native code-mode command status

A captured Luna session retained a native `item_completed/CommandExecution`
with exit code 7, while its outer `exec` succeeded after printing a reduced
`{output, exit_code}` object. Cold history now uses the native execution status
and exit code for the corresponding Bash result, preserving the script's
original output. An outer script completing does not make its command successful.

Without a native parent-call ID, association is deliberately conservative:
there must be exactly one open tool call, normalized as Bash from code-mode
`exec`, with the same owning turn and exact parsed command text. Multiple
executions with different IDs invalidate the association. Missing, ambiguous,
unmatched, or invalid execution metadata keeps the existing output behavior;
it does not authorize interpreting arbitrary printed JSON as command status.
The native transcript remains the authority; no extra persisted state is added.

### 2026-08-02 plan updates nested in code mode

Codex may invoke `tools.update_plan({ plan })` inside an outer code-mode `exec`.
The rollout does not persist the TUI's live plan-update event as a first-class
record: durable state consists of the literal nested call in the outer
`custom_tool_call` source and an empty `{}` nested-tool result. YA recovers that
literal call as the canonical `UpdatePlan` tool, preserving the checklist on
reload, and normalizes the empty success acknowledgement to `Plan updated`
instead of exposing the code-mode execution envelope.

While a turn is active, app-server reports the checklist separately through
`turn/plan/updated`. That notification has no tool-call id, so YA presents each
update immediately with a turn-local transient id; the rollout-derived
tool call remains authoritative after reload. When live and durable copies
overlap, the client pairs exact same-turn checklist inputs one-to-one and
adopts the durable call id. Both paths produce the same canonical `UpdatePlan`
checklist shape.

The resulting checklist is user supervision state. Conversation view keeps it
top-level under its own contract rather than counting it as routine hidden
activity.

### Live app-server shape

Raw SDK logging is enabled in the inspected environment and records Codex
app-server notifications before YA conversion. For the exact observed command

```text
sed -n '130,235p' docs/tactical/165-native-feature-parity-baseline.md &&
sed -n '930,1265p' native/crates/mclone-scene/src/session.rs &&
sed -n '1020,1335p' native/apps/mclone-native-client/src/flat_client_driver.rs
```

the completed `commandExecution` item contained three structured `read`
actions with names and absolute paths. This confirms that upstream already
performs the desired one-command-to-many-actions analysis.

A second correlated sample locked identity behavior: app-server used an inner
`exec-f6e9…` id while rollout stored the outer `call_FE1X…` id, and the raw log
contained no `rawResponseItem/completed` bridge for the turn. YA now attaches
ephemeral turn/origin metadata and reconciles only exact, one-to-one normalized
matches to the rollout id. Ambiguous multi-nested calls remain a bounded
active-tail replacement; no YA-owned durable correlation record exists.

At investigation time YA discarded that information for rendering. The landed
pipeline now independently derives rollout-recoverable actions from command
text plus workdir/cwd, carries them to the client, projects them as semantic
entries, and renders them through the existing explored surface. Live
`commandActions` remain an oracle rather than a rendering source.

### First-party Codex behavior

Codex's shell parser returns a vector of `ParsedCommand` values. An execution
is exploration-only only when every parsed value is `Read`, `ListFiles`, or
`Search`. The TUI keeps adjacent exploration-only executions in one cell and
renders multiple reads from one execution as friendly action summaries while
retaining the execution as one call.

That is the behavioral oracle, not a runtime dependency. The upstream parser
is intentionally complex; YA should not casually reimplement all shell
semantics.

## Desired normalized model

The standalone Codex semantic-action module is implemented in
`packages/server/src/codex/displayActions.ts`, avoiding further growth of the
already large provider and session-normalization files.

The conceptual output is:

```ts
type CodexDisplayAction =
  | { kind: "read"; path: string; name?: string; startLine?: number; endLine?: number }
  | { kind: "search"; query?: string; path?: string }
  | { kind: "list"; path?: string };

interface CodexCommandAnalysis {
  actions: CodexDisplayAction[];
  explorationOnly: boolean;
}
```

The provider-neutral in-memory boundary is implemented as `ToolDisplayAction`
in `packages/shared/src/tool-display-actions.ts`. Provider-confirmation source
or confidence may be useful in diagnostics, but it must not leak into render
identity or make live and rollout render items differ.

The analysis describes display semantics; it does not split execution or
claim separate results. One compound shell call still owns one combined output.

## Canonical data flow

Both inputs must recover the same rollout-equivalent command description before
semantic analysis:

```text
persisted 5.5 function_call(exec_command)
    └─ parse arguments ───────────────────────────────┐
                                                     │
persisted 5.6 custom_tool_call(exec)                  │
    └─ literal code-mode scan                         │
       └─ nested exec_command { cmd, workdir } ───────┤
                                                     ▼
live commandExecution                         canonical command + cwd
    └─ unwrap executable and shell launcher ──────────┤
                                                     ▼
                                      shared display-action extractor
                                                     │
                                      ┌──────────────┴──────────────┐
                                      ▼                             ▼
                           render normalization           oracle comparison
                                                         with commandActions
```

The live `commandActions` array is initially an oracle:

- use it to build sanitized fixtures;
- compare it with derived actions in tests and optional debug diagnostics;
- expand the shared extractor when real mismatches reveal a safe missing case;
- do not create richer live structure that ordinary rollout replay cannot
  reproduce.

An optimistic live presentation may be considered later only when its
reconciliation is demonstrably bounded at the active tail. It is not required
for this refactor.

## Rendering policy

After shared action analysis:

- **Exactly one compatible action:** preserve current canonical `Read`, `Grep`,
  or list rendering and the existing structured result normalization.
- **Several exploration-only actions:** keep one parent `Bash`/`Exec` execution
  and its original command/result, but expose the derived actions to an
  `Explored` presentation. Do not manufacture a result per action.
- **Several nested code-mode calls, all exploration-only:** one code-mode parent
  may expose all derived exploration actions while retaining its original
  nested-call detail for expansion.
- **Any write, mutation, unknown command, or unsafe parse:** retain ordinary
  `Ran`/`Exec` rendering. A read followed by `git status`, a redirect, or an
  unrecognized pipeline is not an exploration group.

Client grouping now accepts “a run of tool calls whose semantic action lists
are exploration-only,” rather than only “a run of exploration
`ToolCallItem`s.” This allows both:

- several adjacent one-action calls, as today; and
- several action rows within one compound execution.

The parent call remains the expansion and result owner. Search anchors,
timestamps, stable IDs, and scroll-height estimates must derive from that
parent so action summaries do not masquerade as separate executions.

## Grouped execution output and skill reads

The web client presents an `Exec` result's text-block array as ordered readable
sections, including when an older server sends that array as a JSON string.
Newlines remain newlines; execution timing is secondary text. Recognized
command-result records expose their output, exit code, and duration, including
records printed through `Promise.allSettled`. Nonzero exit codes remain visible.
Malformed, truncated, or mixed-media arrays retain their original detail.

A literal leading `cat` of a `SKILL.md` file adds the skill path to the parent
summary. A group consisting entirely of those simple reads is labeled
`Loading skill` / `Skill load`; compound or mixed calls remain `Exec` and keep
their call count. Mentioning a skill path in a search, echo, or dynamic shell
expression does not qualify. This is presentation of a read, not evidence that
the skill's instructions were executed successfully.

For a skill-reading group, returned skill frontmatter supplies an expandable
`Skill: <name>` section. Other Markdown documents collapse under their leading
heading. The complete text stays available inside each section, with wrapping
and bounded vertical scrolling. The original script and result remain under
`Raw execution`. Output blocks are not assigned to nested calls by position:
script print order need not match call
order. This client-only presentation uses the existing wire contract and does
not alter transcript identities, grouping, or stored provider records.

`decodeCodeModeOutput` in `packages/shared/src/code-mode-output.ts` owns this
decoding for non-React consumers as well as the Exec renderer. Its result holds
ordered `parts` with `text` and a `kind` of `text`, `command-output`, or
`script-status`. Command parts also expose `exitCode`, `durationSeconds`, and
`sessionId` when present. Consumers should skip script-status parts when
parsing substantive output, preserve the other block boundaries, and retain
the original input for raw detail. An `undefined` result means the outer
value is unrecognized or contains mixed media; it never means empty output.

Only one complete command-result layer is unwrapped, optionally beneath the
observed `{status: "fulfilled", value}` wrapper with an optional integer `i`.
Recognition requires a chunk id, output string, finite nonnegative wall time,
and either an integer exit code or a session id. Unknown fields and malformed
metadata leave the block unchanged. Stdout is a leaf: JSON inside it, including
another complete execution record, is never decoded recursively. Arrays of
settled results, multiple JSON records in one block, and rejected-result
wrappers also remain unchanged.

Format recognition cannot authenticate origin: a script can print exactly the
same bytes as an execution envelope. Callers that know a script printed stdout
directly can pass `{commandResults: "preserve"}` to keep those block texts
literal. The decoder does not infer print provenance from JavaScript source.
Workflow activation is a separate consumer integration; extracting this API
alone does not change how workflow annotations are parsed.

## Implementation plan

### Phase 0 — pin evidence and upstream source

- Refresh `references/codex` for local reading to the official source matching
  YA's declared and installed `0.144.1` target (`rust-v0.144.1`, commit
  `44918ea` as observed 2026-07-10).
- Fetch current upstream `main` separately for comparison; do not implement
  main-only protocol behavior in the `0.144.1` compatibility path.
- Inspect the matching shell parser, app-server `CommandAction` mapping,
  thread-history reconstruction, and TUI exploration-cell grouping.
- Extract small, sanitized raw SDK fixtures covering single and multiple
  `commandActions`; never commit unrelated command output, user content,
  credentials, or absolute home-directory details.
- Keep raw SDK logging temporary. The inspected log was already approximately
  986 MB; disable or rotate it deliberately after fixture capture.

### Phase 1 — standalone semantic-action extraction

- Add the standalone action types and extractor with no React dependency.
- Reuse existing command unwrapping and simple read/search parsing where safe;
  move shared logic rather than maintaining competing recognizers.
- Add bounded parsing for top-level exploration sequences observed in rollout:
  `&&`, safe `;`/newline sequences, and known formatting pipelines.
- Respect quoting and shell nesting. If a connector cannot be classified
  confidently, return no exploration analysis.
- Resolve relative paths against the provided workdir/cwd for display parity,
  while retaining compact project-relative presentation downstream.
- Support upstream action names `read`, `search`, and `listFiles` in the oracle
  adapter.

### Phase 2 — unify 5.5, 5.6, live, and reload normalization

- Route persisted `function_call`, persisted code-mode `custom_tool_call`, and
  live `commandExecution` through the same semantic extractor.
- Preserve the existing exactly-one-action adapter to canonical rich tool
  renderers and structured result normalization.
- Add an optional derived display-action field to the normalized in-memory
  tool-call shape. It is recomputed from each provider source; it is not a new
  durable record.
- Audit code-mode call IDs and result pairing across live/reload before using
  the derived field for group IDs. Align deterministic parent identity rather
  than adding a content-based duplicate workaround.
- Compare live upstream `commandActions` with derived actions in tests. Runtime
  mismatch diagnostics, if retained, must be bounded and off by default.

### Phase 3 — render one-to-many exploration actions

- Extend assistant render segmentation to consume semantic action lists.
- Render one compound exploration call as `Exploring` while pending and
  `Explored` when complete, using the existing vocabulary and styling where
  possible.
- Retain one expandable parent execution with the original command and combined
  output; action rows are summaries, links, and navigation targets only where
  stable identity can be derived from the parent.
- Preserve current grouping of adjacent GPT-5.5-style `Read`/`Grep`/list calls.
- Update predictive height, transcript search anchors, collapse/expand state,
  keyboard behavior, and mobile horizontal scrolling for the new within-call
  action rows.
- Avoid new user-visible concepts or settings; this restores first-party-like
  provider presentation rather than introducing a YA-specific default.

### Phase 4 — parity and regression verification

- Add paired live/persisted fixtures for the exact three-read command and for
  equivalent GPT-5.5 and GPT-5.6 shapes.
- Assert normalized semantic actions, parent tool identity, ordering, group
  boundaries, result ownership, and render-segment signatures.
- Exercise a live-to-rollout reconciliation test so the settled transcript
  does not change row count or group structure.
- Run the focused server/client tests, render-parity harness, typecheck, lint,
  `pnpm console:scan`, and persisted-schema validation against selected
  sanitized rollout/SDK samples.
- Inspect the transcript in YA before and after reload at desktop and narrow
  mobile widths. Treat unexpected React warnings or layout churn as failures.

## Required test matrix

### Extractor unit cases

- one `sed`, `cat`, `nl | sed`, PowerShell windowed read, `rg`, and list action;
- three reads joined by `&&`;
- multiple exploration commands separated by safe semicolon/newline syntax;
- connectors inside quoted strings do not split;
- known read/list/search pipelines with formatting helpers;
- duplicate paths and separate ranges of the same file;
- relative paths with workdir and absolute app-server oracle paths;
- mixed read + `git status`, read + write, redirects, mutation, and unknown
  commands fail closed;
- malformed code-mode JavaScript and nonliteral nested arguments remain raw;
- multiple nested code-mode tool calls preserve source order.

### Normalization parity cases

- GPT-5.5 `function_call(exec_command)` and GPT-5.6 outer `exec` representing
  the same command yield the same semantic actions;
- live `commandExecution.commandActions` agrees with rollout-derived actions;
- started/completed live items and reloaded result pair to the same parent;
- simple one-action calls retain today's canonical input and structured result;
- compound output stays attached once to the parent call.

### Client cases

- one parent with three reads renders one `Explored` group and three summaries;
- adjacent one-action calls still group as before;
- mixed/unknown calls break grouping;
- pending-to-complete changes `Exploring` to `Explored` without changing group
  identity;
- reload preserves segment IDs, order, labels, collapse state compatibility,
  search anchors, and estimated layout shape.

## Acceptance criteria

- The observed three-`sed` call renders as one friendly exploration group both
  live and after rollout reload.
- Existing simple GPT-5.5 `Read`/`Grep` rendering and result detail do not
  regress.
- No model-name conditional selects the renderer.
- No JavaScript is evaluated and no arbitrary `Bash`/`Exec` call is classified
  as exploration.
- No synthetic per-action tool results are created.
- No YA-owned durable transcript or metadata sidecar is introduced.
- Live-only `commandActions` improve evidence and validation without becoming
  a second source of settled transcript truth.
- Focused tests, parity tests, lint, typecheck, and client warning checks pass
  without warnings.

## Closed Implementation Decisions

- A single parent containing several actions and a run of several canonical
  parents use the same provider-neutral projection and `ExploredToolGroup`.
- The bounded shell recognizers cover the observed corpus and continue to fail
  closed. Additional upstream parity is evidence-triggered; a full shell parser
  is not adopted by default.
- No optimistic live-only enrichment ships. Rollout-derived structure is
  sufficient, and live `commandActions` remain fixture/diagnostic oracle data.

## Closeout Verification

- 145 focused server extractor, normalization, provider, session, and
  render-parity tests passed with one intentional skip.
- 148 focused client propagation, reconciliation, projection, component,
  search, navigation, and scroll tests passed without runtime warnings.
- The generated Codex protocol subset matched the installed `0.144.1` target.
- Selected GPT-5.5 and GPT-5.6 rollouts validated 456/456 and 559/559 records.
- The full available Codex corpus validated 1,889,566/1,889,566 records across
  1,354 rollout files.
- Typecheck and lint passed; the client console warning budget remained at
  `+0`.
- Manual before/after screenshots were user-waived and are not represented as
  a completed visual inspection.
