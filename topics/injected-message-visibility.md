# Injected-message visibility contract

How YA-injected, non-user text (control commands, compaction summaries, skill
contents, resume re-injection) is shown — or hidden — in the transcript UI.

See also: [`ui-architecture.md`](ui-architecture.md) (rendering boundary),
task 029 (per-model compact threshold, the first consumer of the hide path).

## Invariant

**YA-injected context-initialization text must not render as an ordinary user
or assistant turn.** When YA, rather than the user, puts text in front of the
agent to shape context — the `/compact` command it queues, a post-compaction
summary, a skill body, a resume-from-full re-injection — that text either
carries a system/compaction visibility contract (rendered as a boundary/system
item) or is hidden, but it is never a normal turn. The symptom this guards
against: a `/compact` user bubble, or a wall of skill/resume text, appearing as
if the user typed it.

## Single hide chokepoint (landed)

All hiding of injected user-role messages routes through **one** predicate so a
future "show hidden" UI can reveal them consistently instead of each call site
deciding ad hoc:

- `UserMessageMetadata.hidden?: boolean` (`packages/shared/src/user-message-metadata.ts`)
  is the only signal.
- `Process.isHiddenInjectedMessage(message)` (`packages/server/src/supervisor/Process.ts`)
  is the only reader. It gates the optimistic **user echo** in
  `queuePreparedMessage` (both the SSE-replay bucket push and the live emit) —
  and nothing else. It is deliberately **not** folded into `shouldEmitMessage`,
  which must stay an unconditional `return true` for provider-stream messages.
- Producer: `Supervisor.tryResumeCompaction` stamps `metadata.hidden` on the
  `/compact` it queues, so **both** resume-time compact-first and the task-029
  threshold trigger emit no `/compact` user turn — matching native
  auto-compaction, which shows none.

### Result vs. visibility contract

A YA-initiated compaction has two halves, both satisfied by reusing
`tryResumeCompaction`:

- **Result contract** — it drives a real `compact_boundary` system message,
  which the client renders as a collapsed "Context compacted" item
  (`transcriptProjection/messageProjection.ts`, system-subtype branch). Same as
  native.
- **Visibility contract** — the `/compact` command itself is hidden (above), so
  no spurious user bubble. Same as native.

Scope note: the hide path covers the **optimistic echo** (a YA-side SSE
broadcast, not the JSONL transcript). `/compact` as a recognized provider slash
command is not persisted as a user content turn, so suppressing the echo is
sufficient for the live path. If a provider ever did persist it, that becomes a
JSONL-classification problem — see Part 2.

### Codex compaction output

Codex may persist a readable compaction handoff as an assistant message with
top-level `metadata.compaction_output: true`, including `phase: "final_answer"`.
This is internal compaction output, not an ordinary assistant answer. YA shows
it through the existing **Context compacted** disclosure, collapsed by default;
expanding it retains access to the full summary, rendered as Markdown using
the same safe renderer as assistant prose. Raw provider metadata stays plain
text. If Markdown augmentation fails, the original summary remains readable.
The expanded summary uses primary text color; plain-text details and code
blocks use the theme's code background, remaining readable in both themes.

When the following `compacted` checkpoint supplies the summary, that checkpoint
owns the single disclosure and its pagination identity. Token accounting between
the output and checkpoint does not create a second summary. A partial rollout
read before the checkpoint arrives still exposes the marked output as a
collapsed disclosure. An empty checkpoint must not discard that readable output.
Ordinary assistant messages without the marker retain their normal rendering,
regardless of their phase, headings, or wording. No new client/server capability
or wire format is required.

## Part 2 — persisted injected rows

Some injected rows are **real JSONL transcript messages**, not optimistic
echoes, so the echo chokepoint above does not touch them. The fix is to
classify/tag injected context-init text in the reader/render pipeline so it
inherits the system/hidden contract.

### Post-compact replay continuation (landed 2026-09-15)

When Settings → Providers → Continue after compaction is enabled for the
session's provider, YA queues a hidden user turn after a compact boundary
settles. The text always starts with
`This session is being continued after compaction (Yep Anywhere replay).` and
ends with `continue.` Optional last-N prose uses the **Handoff from…** `user: `
format and states that it is a replay. Optimistic echo is hidden via
`metadata.hidden`. Persisted provider-echoed copies are dropped from transcript
projection by that opener, the same way Claude's compact-summary preamble is
hidden, so the row is never a user bubble. See
[post-compact-replay](post-compact-replay.md).

### Claude compact summary (landed 2026-06-26)

Claude can persist a manual compact as a cluster of rows:

- `system/compact_boundary` with `compactMetadata`;
- a transcript-only `user` row carrying `isCompactSummary: true`;
- local-command caveat, `/compact` command, and stdout wrapper rows.

YA now treats that cluster as one collapsed compact boundary in the transcript.
The compact boundary survives reload even when the boundary only names its
preserved parent in `compactMetadata.preservedSegment` /
`compactMetadata.preservedMessages`; the summary is attached as expandable
detail. Local-command caveats and compact command/stdout wrappers are hidden
from the default view. The compact-summary text remains semantic context for
server-side restart/fork summarization when a selected window includes it, but
it is not a user-authored request.

### Claude slash-command skill body (landed 2026-06-26)

Claude can persist a skill-backed slash command as adjacent rows:

- a `user` row containing only `<command-message>`, `<command-name>`, and
  `<command-args>` XML tags;
- a following `user` row with `isMeta: true` and text-block content beginning
  `Base directory for this skill: ...`, followed by the skill body and
  `ARGUMENTS: ...`.

YA now treats that pair as one collapsed local-command system item. The
one-line header is the echoed slash command (for example
`/harsh-review last 10 commits`); the injected skill body remains available as
expandable detail, but does not render as a user bubble. Server-side user-turn
slicing also treats the skill body as synthetic, and fork-after source
validation rejects the body as a selected user-authored request.

### Claude `/goal` command row (landed 2026-11-13)

YA runs a Claude `/goal` by sending a hidden `/goal …` line and publishing
its own goal receipt. Claude persists that line as a `<command-name>/goal`
user row, which reload rendered as a grey `/goal …` block beside the
receipt. The receipt now records the line in `providerCommandText`, and
`mergeLocalCommandMessages` drops the first matching command row after the
receipt's position. Receipts stored before that field match on
`/goal <objective>`. A `/goal` typed in Claude's own UI has no receipt and
still renders as its command row.

### Codex resumed environment context (landed 2026-06-30)

Codex can persist a user-role `response_item` containing only
`<environment_context>...</environment_context>` immediately before the real
user turn that wakes a TUI-created session. YA now suppresses that lone
environment-context setup item when it is immediately followed by a normal user
prompt, so the context row does not render as a fictitious user turn.

### Codex startup instructions with plugin recommendations (landed 2026-07-09)

Codex can now prefix its persisted startup instruction user-role row with a
`<recommended_plugins>...</recommended_plugins>` block before
`# AGENTS.md instructions for ...`. YA treats that shape as the same injected
startup instruction row as the older plain `# AGENTS.md instructions for ...`
form: the durable reader suppresses it, and the client setup fallback collapses
it into `Session setup` rather than rendering it as a user-authored turn. The
Codex summary reader also skips the row when deriving the first-turn session
title; the session-summary index version advances with that interpretation so
already-cached plugin-prefixed titles are rebuilt after restart.

### Codex user-turn provenance (landed 2026-07-10)

The startup-prefix rule above did not cover Codex's optional composition of
recommended plugins plus environment context when no `AGENTS.md` exists. YA
now follows Codex's persisted lifecycle instead of treating user-role syntax as
authorship: an accepted prompt is the user-role response item immediately
followed by an `event_msg/user_message`. The event witnesses provenance; the
response item remains the rich rendering payload and the duplicate event is
consumed.

Unpaired current-format response items are provider context and do not render,
title the session, or count as user turns. Rollouts with no user-message events
retain an exact-marker legacy fallback so unknown older or foreign prompts are
not silently erased. The same classifier now owns durable normalization, title
extraction, and message counting. New or modified sessions use that corrected
summary interpretation immediately; unchanged cached summaries correct
gradually without a proactive global cache rebuild. See
[`codex-user-turn-provenance.md`](codex-user-turn-provenance.md) for upstream
source receipts and the local-corpus audit.

The downstream cleanup now carries `codexUserTurnProvenance` on normalized
Codex user turns. Client setup recognition is only a compatibility fallback for
unprovenanced historical rows, is centralized in `codexLegacySetup.ts`, and
requires complete marked setup blocks. Explicitly paired prompts and live SDK
echoes always win over text resemblance, including a human-authored literal
`<environment_context>...</environment_context>` prompt.

Remaining Part 2 scope: broader resume-from-full init text can still render as
normal turns. It predates the compaction work and needs its own classification,
not a local CSS hide.

## "Show hidden" — not planned

Hidden turns are currently fully suppressed. YA previously exposed some setup
context through an auto-collapsed `Session setup` item, and the legacy client
fallback still recognizes old unprovenanced rows. There is no current product
requirement to restore that surface for server-classified context. Reconsider
only if a concrete debugging or transparency need emerges; it is not
outstanding work for the Codex authorship fix.
