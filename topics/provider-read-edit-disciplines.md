# Provider read/edit disciplines

> Each agent provider chooses its own file read/edit tool format and its own
> staleness/locating strategy; YA maps every provider's named read/edit action
> blocks onto one canonical presentation (Claude's `Read`/`Edit`/`Write`
> vocabulary plus a uniform diff augment) without dictating how any model edits.

See also: [`provider-abstraction.md`](provider-abstraction.md) (the
`AgentProvider` seam), [`ui-architecture.md`](ui-architecture.md) (the render
boundary principle this normalization obeys),
[`opencode-backend.md`](opencode-backend.md) and [`pi-provider.md`](pi-provider.md)
(per-backend tool normalization), [`codex-api-provider.md`](codex-api-provider.md)
(Codex protocol), [`relative-filenames.md`](relative-filenames.md) (file-path
display these blocks feed), [`collapse-expand-mode.md`](collapse-expand-mode.md)
(outline grouping that consumes this canonical mapping), and
[`codex-code-mode-render-convergence.md`](codex-code-mode-render-convergence.md)
(the planned one-command-to-many-actions extension for Codex code mode).

Topic: provider-read-edit-disciplines

## Two layers: native discipline vs YA presentation

There are two independent concerns, and the load-bearing fact is that YA only
owns the second:

1. **Native read/edit discipline** — how a provider's agent locates and rewrites
   file content: the tool names, the input schema, and the staleness/safety
   model. This is owned entirely by the provider's own agent (its system prompt,
   tool schema, and the model's training). YA does **not** define, override, or
   re-instruct the edit tools of any backend.
2. **YA presentation** — how a completed or in-flight read/edit *renders* in the
   session blocks-outline. YA canonicalizes every provider's named action blocks
   to one vocabulary and one diff view, so a phone supervisor sees the same
   `Edit` card whether the bytes came from Claude's `Edit`, Codex's
   `apply_patch`, pi's `edit`, or OpenCode's `edit`.

This separation is why adding a backend never means teaching a model a YA edit
format. The model emits whatever tool calls its own harness trained/prompted it
to emit; YA is strictly downstream for read/edit (it receives `tool_use` /
`tool_result`, normalizes, and renders). See *Initiation* below for why that is
also the right place to draw the line.

## The spectrum of native disciplines

Ordered by how much the format trusts the model's reproduction of file content
and where the "locating intelligence" lives (in verbatim text, in a context
anchor, or in line hashes). Claude/pi/OpenCode specifics below the Codex line
are exact-string-replacement variants that differ only in field names and
single-vs-array shape; Codex and hashline are the genuine outliers.

| Provider | Read | Edit | Locate / staleness |
|---|---|---|---|
| Claude Code | `Read` returns `cat -n`-style line-prefixed text | `Edit` (verbatim `old_string`→`new_string`, unique-or-`replace_all`), `Write` for whole-file | exact byte match; line numbers are a display aid, not the address; enforced read-before-edit gate, stale file ⇒ match fails |
| Codex CLI | `read_file` / shell (`sed`/`cat`/`head`) | `apply_patch` emitting V4A grammar (`*** Begin Patch` / `*** Update File:` / `@@` context / `+`/`-`/space) | context-anchored, deliberately no line numbers; tolerant fuzzy/whitespace matching |
| OpenCode | `read` (`filePath`) | `edit` (`oldString`→`newString`, `replaceAll`), `write` | exact-string match (Claude-shaped under camelCase fields) |
| pi | `read` (`path`,`offset`,`limit`), no `cat -n` prefixes | `edit` (`edits[]` of `{oldText,newText}`, each matched against the *original*, non-overlapping, unique), `write` | exact-string match; LF-normalized + BOM-stripped before matching, line endings restored on write |
| Gemini / Grok (ACP) | provider tools over ACP | provider tools over ACP | provider-defined |

**Claude — verbatim string with a read-gate.** The `Read` line numbers are
inert; `Edit` locates by an exact `old_string` (raw bytes, whitespace included)
that must be unique or use `replace_all`. Read-before-edit is enforced, and a
file changed since the read is caught *indirectly* — the `old_string` no longer
matches — rather than by a dedicated integrity check.

**Codex — context-anchored V4A.** `apply_patch` emits a grammar that locates
hunks by surrounding context, not line numbers, and absorbs whitespace drift via
fuzzy matching. Per the peer research that motivated this doc (external,
uncited — treat as reported, not repo-verified): V4A is **trained into the GPT
weights**, not merely prompted, which is why it does not port cleanly — dropping
the V4A system-prompt instructions reportedly broke Azure-hosted GPT-4.1 (no
baked-in format), and Warp had to rename tools to match what Codex was trained on
(`grep`→`ripgrep`) and strip preambles that stalled the model. This is the
*anchor-in-weights* end of the spectrum.

**OpenCode and pi — exact-string, prompt/schema-anchored.** Both converge on the
same discipline as Claude's `Edit`: replace an exact substring. OpenCode's `edit`
is Claude's `Edit` with camelCase fields; pi's `edit` generalizes to an array of
disjoint `{oldText,newText}` replacements (each matched against the original
file, explicitly not incrementally). pi's tool is *prompt-anchored*, not
weights-anchored — it ships a `description`, `promptSnippet`, and
`promptGuidelines`, and a `prepareArguments` step that repairs known model
quirks (e.g. Opus 4.6 / GLM-5.1 sending `edits` as a JSON string instead of an
array). That repair layer is itself evidence the format is portable across a
model matrix rather than native to one.
(pi tools: `~/pi/packages/coding-agent/src/core/tools/{edit,read,write}.ts`.)

**hashline — a pi extension (external; a YA non-goal).** hashline is *not* a YA
mechanism and *not* a competitor harness; it is an alternative edit tool loaded
into pi via pi's tool-override extension API
(`~/pi/packages/coding-agent/examples/extensions/tool-override.ts` is the
mechanism, not hashline itself, which is not vendored in the `~/pi` fork). It
fuses a line number into the anchor and hashes the line content, making the
number load-bearing: a hash mismatch is a *first-class rejection of the whole
edit set before touching the file* — the most conservative point on the
staleness spectrum, versus Claude's indirect match-failure and Codex's fuzzy
absorption. The implementation worth knowing is jerryan's `hashline-edit` fork,
which hex-encodes the short hashes. **YA does not employ hashline in any
YA-specific way and has no plan to.** It is recorded here only as the
conservative reference point for the spectrum.

## How YA maps named blocks to one presentation

YA canonicalizes to **Claude's tool vocabulary** (`Read`, `Edit`, `Write`,
`Bash`, `Grep`, `Glob`, …) and Claude-style input field names (`file_path`,
`old_string`, `new_string`). The mapping happens in layers, each near the data
it normalizes (per the render-boundary principle), so live streaming and
reloaded history agree:

- **Client name aliases** —
  `packages/client/src/components/renderers/tools/index.tsx` `TOOL_NAME_ALIASES`
  (e.g. `apply_patch`→`Edit`, `shell_command`/`exec_command`→`Bash`,
  case-insensitive) feed the `ToolRendererRegistry`; unknown names fall through
  to the raw-JSON fallback renderer rather than a misleading alias.
- **Codex server normalization** —
  `packages/server/src/codex/normalization.ts` does more than rename: Codex
  performs reads/writes/greps as **shell commands**, so
  `normalizeCodexToolInvocation` reverse-maps a `bash` call into a canonical
  block — `sed`/`cat`/`head` ⇒ `Read`, `rg` ⇒ `Grep`, heredoc write ⇒ `Write` —
  and `apply_patch` ⇒ `Edit`. Output is re-shaped to match
  (`normalizeReadOutput`, `normalizeRipgrepOutput`, etc.).
- **pi server map** — `packages/server/src/sdk/providers/pi-tools.ts`
  `normalizePiTool` maps names (`read`→`Read`, `edit`→`Edit`, …) **and** fields
  (pi `path`→`file_path` for Read/Write/Edit; a single-element pi `edits[]` is
  expanded to `old_string`/`new_string` so the diff augment engages; `grep`
  keeps `path` since Claude's Grep also uses `path`).
  `normalizePiToolResult` maps pi text results into YA's structured `Bash`,
  `Read`, `Write`, and `Edit` result contracts where safe, and pi edit
  `details.patch` is preserved as a raw patch so multi-edit rows can render a
  diff after reload. Non-vanilla pi sessions that emit an `apply_patch` tool
  also map to canonical `Edit` with the same raw-patch interpretation Codex
  uses; vanilla pi is unaffected because it does not emit that tool.
- **Gemini-CLI server map** — `packages/server/src/sdk/providers/gemini-tools.ts`
  `normalizeGeminiTool` maps the non-ACP `gemini` CLI's `read_file`→`Read`,
  `replace`→`Edit` (`old_content`/`new_content`→`old_string`/`new_string`),
  `write_file`→`Write`, `glob`→`Glob`, `search_file_content`→`Grep`,
  `run_shell_command`→`Bash`. Retained by `normalization.ts`
  `convertGeminiMessages` for durable history after removal of the deprecated
  stream-JSON execution adapter. `write_todos` /
  `delegate_to_agent` / `save_memory` stay unmapped (honest raw fallback — their
  field shapes don't match a canonical renderer). The ACP gemini/grok path
  instead canonicalizes via `toolCall.kind`→`mapKindToToolName`.
- **OpenCode server map** —
  `packages/server/src/sdk/providers/opencode-tools.ts`
  `OPENCODE_TOOL_NAME_MAP` plus `OPENCODE_TOOL_FIELD_RENAMES` (e.g. `edit`:
  `oldString`→`old_string`, `newString`→`new_string`, `replaceAll`→`replace_all`)
  — the complete name+field shape that pi still defers. Shared by the live
  provider and the durable reader so both render identically.

### Exploration-kind classification

A second, weaker client normalization sits beside the renderer aliases in the
same module (`renderers/tools/index.tsx`): `getExplorationKind` classifies
tool names as `read`/`search`/`list`-shaped actions so the transcript can fold
consecutive exploration calls into one "Explored" group
(`ExploredToolGroup`, `sessionDetail/exploration`).

The two tables are deliberately separate because they assert different
strengths of claim:

- A `TOOL_NAME_ALIASES` entry routes the tool to a canonical renderer, which
  is only safe when the input schema matches that renderer's expectations;
  otherwise the honest raw-JSON fallback is better than a misrendered card.
- An `EXPLORATION_TOOL_KINDS` entry claims only "this action reads/searches/
  lists" — safe for any input schema — so provider names like `grep_search`
  or `list_dir` can group as exploration while still rendering through the
  fallback.

Rule: both tables live in the registry module as the single owner of client
tool-name normalization; classify a new provider's tool names there (not in a
consumer), and keep each normalization site commented with a pointer to this
section.

`sessionDetail/explorationProjection.ts` is the next, presentation-only layer.
It adapts either a canonical exploration tool or a parent carrying
provider-neutral `displayActions` into ordered entries while retaining the
original `ToolCallItem` as the sole status/result/raw-detail owner. Entries use
parent id plus source-order index and never become synthetic transcript tools
or result owners. This is what lets several canonical parents with one action
and one code-mode parent with several actions share the same explored model.
`buildAssistantRenderSegments` and `ExploredToolGroup` consume that projection;
the component shows semantic rows by default and nests the unchanged parent
tool renderer only when raw command details are requested.
`sessionDetail/explorationPresentation.ts` owns the next semantic presentation
step: entry labels, compact/search text, and explored-row height estimates.
Search entry ids remain presentation anchors targeting the stable group; only
real parent ids participate in transcript row and scroll-snapshot identity.

### The uniform diff augment

Renaming gets a block to the right renderer; the **diff augment** gives every
`Edit`, whatever its source format, one diff view.
`packages/server/src/augments/edit-augments.ts` `computeEditAugment` turns an
(`old_string`,`new_string`) pair into a `structuredPatch` (jsdiff) plus
syntax-highlighted, word-level `diffHtml`. It is attached to the `Edit`
`tool_use` input live by `stream-augmenter.ts` and on reload by
`sessions/persisted-augments.ts`, so the renderer needs no provider knowledge.
`EditRenderer.tsx` consumes `_structuredPatch` / `_diffHtml`, and for Codex
falls back to a `_rawPatch` (`RawPatchPreview`) parsed from the V4A text via
`computeStructuredPatchDiffHtml` when no old/new pair exists. Code-mode Codex
normalization stores its recovered `apply_patch` string under that canonical
`_rawPatch` key; persisted augmentation must consume the same key, with
`patch_apply_end`'s `unified_diff` rows as a fallback rather than requiring the
older `diff` spelling. Result: the same collapsed preview, expand-to-modal,
"show full context", and copy-post-change affordances regardless of backend.

Read and Edit are **file-backed details by composition**, not a viewer class
hierarchy. A Read path enters the canonical `FileViewer`. An expanded Edit
composes the shared managed-detail lifecycle with `FilePathLink` for canonical
file identity and its context menu, plus the shared source-header path and
version-control actions. Its source projection uses Source Control's
`UnifiedDiff`; provider-specific normalization remains outside that component.

### Edit-block full-context toggle

The full-diff modal offers **Show full context** whenever the session has a
project and a file path. Default remains the hunk-only view.

- If the provider supplied a nonempty `originalFile` snapshot, the toggle
  expands that snapshot the way it always has (`POST /diff/expand`).
- Otherwise the client reads the **current** file. It keeps diff markers only
  when the replacement can be uniquely identified: an exact substring match, or
  a single whitespace-insensitive line-block match (same rule as a merge that
  ignores space). Ambiguous or missing matches drop the markers and show the
  current file as plain source.
- Grok and pi leave `originalFile` empty, so they take the current-file path.
  No new server capability: the client uses existing `GET /files` and
  `POST /diff/expand`.
- Switching projections preserves the first changed row's existing offset from
  the real scroll root. The first change therefore keeps the hunk view's few
  context lines above it instead of being geometrically centered; full context
  primarily adds surrounding content and a scrollbar. Source and fixed-font
  rendered Edit projections share this rule. A markerless current-file fallback
  has no changed row to anchor.

## Initiation — where the edit format comes from

The user's original framing is correct: a model emits read/edit actions in its
**native format unless nudged otherwise by tool instructions**. In YA's
architecture that nudging happens entirely inside each provider's own agent —
the Claude Agent SDK defines `Edit`/`Write`/`Read`; `codex` owns `apply_patch`;
`pi --mode rpc` owns its `edit`/`read`/`write`; OpenCode owns its tools. YA
supplies task content and reads back blocks. **YA never injects an edit-format
instruction**, which means the initiation axis is purely a provider property:

- *Anchor-in-weights* (Codex V4A): the trained model produces the format; high
  edit fidelity on its native model, but degrades/breaks when the format is
  moved off that model (the reported Azure/Warp cases).
- *Anchor-in-prompt/schema* (Claude `Edit`, pi/OpenCode `edit`): the format is
  carried by the tool schema + guidelines and can be driven into many models;
  exact-string replacement is simple enough to be effectively in-distribution
  for essentially every instruction-tuned model, which is why provider-agnostic
  harnesses (pi, OpenCode) standardize on it instead of a trained grammar.

### Design principle: don't impose off-distribution edit formats

Recorded as a project design stance (user, 2026-06-22), and one I agree with
directionally with a sharpening:

> Telling a model to edit in a way it was not weights-trained to do is an unwise
> source of friction — except for batch "write the program that performs this
> mass transformation" cases.

**Verdict.** Agreed for *high-ceremony structured* formats (V4A grammar,
hashline hashes): the empirical evidence (above) is that forcing them
off-distribution lowers fidelity or breaks. The sharpening: the robust dividing
line is the **locating burden the format places on the model**, not literally
"present in the training set." Exact-string replacement is prompt-anchored yet
near-universal, so "edit in your weights-native way" and "use a simple universal
exact-string format" mostly coincide in practice — they diverge only for formats
that demand the model reproduce/track structure it has no prior for (V4A is
native to GPT; hashline is native to nothing until trained). The batch-transform
exception is really a *different mechanism* (emit a codemod/program, not a
per-edit anchor format), so it does not weaken the rule for interactive edits.

**Consequence for YA.** This is the design rationale for the two-layer split:
YA's correct posture is to **map presentation, not dictate format**. YA should
not add a YA edit tool or rewrite a backend's edit discipline; it should keep
canonicalizing whatever native blocks arrive. A non-native format is worth its
friction only when it buys a safety property the native one lacks (hashline's
hard staleness rejection vs Claude's indirect match-failure) — a trade YA is not
currently making.

## Audit 2026-06-22 — fixtures vs normalization code

Checked each provider's example transcripts (`packages/server/test/fixtures/`)
against the normalization code. Findings and resolutions:

- **Closed — Gemini CLI (`gemini.ts`)** was emitting raw `tool_name`
  (`read_file`/`replace`/`write_file`/`glob`/`search_file_content`/
  `run_shell_command`), which hit the raw-JSON fallback (no rich card, no diff
  augment). Added `gemini-tools.ts` (`normalizeGeminiTool`), wired into the live
  and durable paths, with `gemini-tools.test.ts`.
- **Closed — pi argument fields and durable reload parity.** `pi-tools.ts`
  (`normalizePiTool` / `normalizePiToolResult`) now renames fields in addition
  to names and structures pi built-in results for the renderer, with
  `pi-tools.test.ts` and `pi-reader.test.ts`. The live `PiProvider` path and
  durable `PiSessionReader` path both use the same canonical mapping, so pi
  sessions reloaded after a YA restart should keep the original action-card
  headline/detail quality.
- **Verified OK — ACP (gemini-acp, grok).** Canonicalize via
  `toolCall.kind`→`mapKindToToolName`; no gap.
- **Verified OK — Codex / OpenCode.** Codex reverse-maps shell + `apply_patch`;
  OpenCode has the name+field map with tests.

## Open follow-ups

- **Unknown-tool honesty** — keep the "no misleading alias for unknown tools"
  rule (OpenCode/Gemini/pi normalizers all pass unmapped tools through; see
  `opencode-backend.md` *Gaps To Close*).
- **pi multi-edit** — a multi-element pi `edits[]` renders by name only (no
  MultiEdit renderer); revisit if multi-edit pi turns become common.
- **Gemini todo/subagent rendering** — `write_todos`/`delegate_to_agent` are
  intentionally unmapped; map them (with field remaps) if Gemini-CLI todo/Task
  rendering becomes worth it.
