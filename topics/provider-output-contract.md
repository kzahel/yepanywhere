# Provider Output Contract

> The provider output contract is the single spec for the normalized objects
> every provider integration must produce — message envelope, content blocks,
> structured tool results, status, and lineage links. The named TS types are
> the type definition; runtime validation stays off hot paths.

Topic: provider-output-contract

See also:
[provider-authoring](provider-authoring.md) (the workflow map — *how to add*
a provider; this topic is the output half, *what a provider should attempt
to produce*),
[provider-abstraction](provider-abstraction.md) (when a provider/model
conditional gets promoted to the `AgentProvider` seam),
[stream-persisted-render-parity](stream-persisted-render-parity.md) (the
convergence contract between the two delivery paths),
[stream-durable-id-dedup](stream-durable-id-dedup.md) (id stability across
stream and durable copies),
[provider-state-machine](provider-state-machine.md) (the status half of the
contract),
[provider-session-tree](provider-session-tree.md) (lineage capability audit),
[transcript-display-objects](transcript-display-objects.md) (display-only
objects that are *not* provider output).

## Rule: normalize in the provider layer, against this spec

All provider-specific shape conversion happens in the provider seam — the
session reader, the stream adapter, and their normalization helpers — and
produces the shapes named here. Routes, renderers, and the client must not
carry provider conditionals that repair output shape; a shape defect in what
a provider emits is fixed in that provider's normalization helper, behind
this contract. ([provider-abstraction](provider-abstraction.md) governs when
an existing scattered conditional gets promoted into the seam.)

Where normalization lives today:

- **Persisted path.** Readers (`packages/server/src/sessions/*-reader.ts`)
  return provider-raw payloads inside `UnifiedSession`
  (`packages/shared/src/session/UnifiedSession.ts`, a tagged union by
  provider). `normalizeSession`
  (`packages/server/src/sessions/normalization.ts`) is the central
  per-provider switch that converts raw entries to normalized `Message`s,
  delegating to provider-specific helpers
  (`packages/server/src/codex/normalization.ts`,
  `packages/server/src/sdk/providers/gemini-tools.ts`,
  `packages/server/src/sdk/providers/opencode-tools.ts`,
  `packages/server/src/sessions/claude-messages.ts`).
- **Stream path.** Provider stream adapters under
  `packages/server/src/sdk/providers/` emit messages that
  `normalizeStreamMessage` (`packages/server/src/subscriptions.ts`) touches
  only lightly; heavy provider-specific transforms belong upstream in the
  adapter.

New provider work extends those helpers; it does not add conversion logic
downstream of them.

## Two delivery paths, one durable-corresponding output

A session reaches the UI live from the **stream** and again later
re-read from **persisted** storage. Both feed the same render pipeline, and
[stream-persisted-render-parity](stream-persisted-render-parity.md) requires
items with durable counterparts to converge — same semantic tool calls and
*structured* result fields, not merely similar visible text. Useful live-only
tail events are allowed; they do not justify a YA-owned shadow transcript.
Message ids must match deterministically across the two paths wherever the
provider allows ([stream-durable-id-dedup](stream-durable-id-dedup.md)); a
provider whose ids genuinely cannot align sets the `needsApproxMessageDedup`
capability and accepts the tight content+timestamp reconcile backstop.

## Typing stance: rigidly described, loosely enforced

The runtime representation is deliberately dict-like. The hot read path
casts (`JSON.parse(line) as ClaudeSessionEntry` in the Claude reader); the
client `Message` is an all-optional interface with an open
`[key: string]: unknown` index signature. There is no hot-path schema
validation, and none should be added — transcript reads and stream fan-out
are the highest-rate surfaces in the server.

The rigid description lives in named types, which are this contract's type
definition:

- `AppMessage`, `AppMessageExtensions`, `AppContentBlock` —
  `packages/shared/src/app-types.ts` (persisted entry + app extensions; the
  main app-side message type).
- Client `Message` — `packages/client/src/types.ts`.
- Server `Message`, `SessionSummary`, `Session` —
  `packages/server/src/supervisor/types.ts`.
- Zod schema families — `packages/shared/src/claude-sdk-schema/`
  (`entry/`, `message/`, `content/`, `tool/`, `guards.ts`), validated
  offline via `scripts/validate-jsonl.ts` and
  `scripts/validate-tool-results.ts` and in tests.

TS-only types are erased at compile time, so naming and expanding them has
**zero runtime cost**; the cost line is runtime `.parse()`, which stays in
offline validation and tests. Where a Zod schema exists, prefer the
`z.infer`-derived named type (as `claude-sdk-schema/types.ts` already does)
so the doc, the type, and the validator cannot drift three ways. A new
normalized shape gets a named exported type in `packages/shared` and a
mention here.

### Optional client schema diagnostics

The browser's developer **Schema Validation** setting is default-off. When it
is off, tool renderers do not run their advisory provider-result schemas and the client shows no
schema-diagnostic chrome. It is a provider-contract diagnostic, not a stream
health check or a response-delivery mechanism.

When enabled, mounted tool results run their renderer-owned schemas. Every
distinct issue detected during the browser page lifetime is retained even when
its row is outside the scroll viewport, keyed by tool name, issue path, code,
and message. A fixed center-bottom warning summarizes the unique issues by
sorted tool type and opens their details. Ignoring a tool suppresses its inline
warning/toast but does not remove its issues from the global summary; the
detail marks that group ignored. Disabling validation clears the diagnostic
registry. When rich offscreen row content is deferred, the mounted tool row
runs the same schema so deferral does not leave a summary gap; the renderer
still owns its inline warning once hydrated. Results that have never entered
the mounted transcript have not been parsed and therefore cannot appear in the
summary.

Bounded client display checks run independently of this setting. They grant
access only to checked callback data and never reject retained server records.
The 14 diagnostic entries and the deliberately omitted display tools are
accounted for in the registry inventory test; a provider diagnostic cannot
substitute for a display contract. Malformed rows still contribute diagnostic
issues even when rich content cannot mount.

Gemini durable tool results retain their text and failure flag in the result
block. The routing envelope (`tool_use_id`, `content`) is not a structured tool
result. New clients also accept that older-server envelope as checked text, so
the normalization correction does not introduce a server capability dependency.

## The normalized message envelope

What a provider's normalization must attempt to supply per message. Unknown
fields are **passed through, never stripped** — consumers tolerate extras;
they rely only on the fields below.

- **Identity**: `uuid` (preferred) or `id`; consumers resolve identity as
  `uuid ?? id` (`getMessageId`). The id must be stable between the streamed
  copy and the durable copy of the same message (see parity/dedup above).
  Dedup and incremental fetch (`afterMessageId`) key on it; there are no
  content hashes anywhere in identity judgment.
- **Kind**: `type` — `user` | `assistant` | `system` | `summary`, plus
  provider-specific subtypes discriminated further by `subtype`. `role` is
  set for user/assistant.
- **Content**: canonical location is `message.content` (string or
  `AppContentBlock[]`); a top-level `content` convenience copy is added by
  the reader. Block types consumers render: `text`, `thinking`
  (+`signature`), `tool_use` (`id`, `name`, `input`), `tool_result`
  (`tool_use_id`, `content`, `is_error`). Unknown block types pass through.
- **Timestamp**: ISO-8601 `timestamp`. Load-bearing, not decorative: the
  approx-dedup backstop windows, pending-echo reconciliation, and ordering
  fallbacks all compare timestamps.
- **Structured tool results**: `toolUseResult` (and/or a `tool_result`
  block). The parity harness compares these as structured objects; a field
  present in the stream copy must survive the persisted copy.
- **Lineage**: `parentUuid` when the provider has entry-level parent links
  (see next section). Null/absent for linear providers.
- **App extensions** (added by YA downstream, never by the provider
  normalization itself): `_source` (`sdk`/`jsonl`), `_isStreaming`,
  `isSubagent`, `orphanedToolUseIds` — documented in
  `AppMessageExtensions`.

### Asynchronous Codex questions

Codex `request_user_input_async` produces an assistant message while the
originating turn keeps running. It is not a blocking input request or approval:
the user answers later through an ordinary message. YA keeps Codex's readable
fallback text as normal assistant content and preserves these fields on both
the live and persisted copies:

- `codexAgentMessageDelivery: "async"` identifies the asynchronous delivery;
- `codexAsyncQuestions` keeps the ordered question titles and nullable answer
  options.

Persisted normalization reads the canonical `item_completed` record whose
`AgentMessage` item has asynchronous delivery, retaining its provider item id.
Ordinary completed agent items and legacy `agent_message` events remain
suppressed because they duplicate full response items.

#### Answering and discovering questions

The web client renders structured async questions as answerable transcript
content by default. It never guesses controls from arbitrary Markdown lists.
Servers without the two optional fields retain ordinary readable text; the
client uses existing message submission and steering routes and introduces no
endpoint or capability requirement. This optional-field compatibility plan and
the default-on behavior were explicitly approved by the maintainer on
2026-09-07. Blocking questions and approvals keep their separate lifecycle.

Each supplied option is a clickable, wrapping bullet row with a filled,
bordered button treatment and hover feedback matching the blocking interview
panel. Async options send immediately; they are not multi-select checkboxes.
A deliberate click
sends that exact option; no suggested selection submits itself. Selecting a
question from its menu reveals the original transcript context, highlights
the question, opens a separate inline free-form composer, and focuses it once.
Focus remains free to leave. Stream updates and transcript virtualization
preserve the inline draft and the main composer's independent draft.

In the inline reply composer, Enter sends the reply and Shift+Enter inserts a
newline. Enter during text composition does not send. Empty replies, repeated
held-Enter events, and submission while a reply is already sending do not send
another reply.

Choice and inline free-form replies send the complete question as a Markdown
blockquote followed by the exact answer, using steering during an active turn
and ordinary input after it ends. Source message id plus question index identify
the local question; neither a `Q:` prefix nor a random subsequent user turn
establishes answer identity. Successful submission shows **Reply sent**, which
does not assert provider consumption. Failure retains the draft and pending
state. **Quote reply in main composer** is a secondary action: reveal the
question, insert its full quote through the existing composer insertion/undo
path, preserve existing text, and focus the main composer. Moving the reply to
the main composer immediately marks the question answered locally and clears
its reminders, including cross-session counts. The transcript says the reply
was moved to the main composer; it does not claim delivery to the provider.
Return uses a back-arrow icon and Quote uses a circled right chevron, with
accessible action labels and tooltips.

Before visiting a question, save the reading anchor, offset, and Follow intent.
Navigating among questions retains that first return destination. Successful
inline submission, or **Return to previous position**, restores the saved
anchor with Follow off, or the current live bottom with Follow restored, then
focuses the main composer without browser-induced scrolling. Failure does not
perform this transition. New navigation, focus movement, or pointer/wheel
interaction while submission is pending takes precedence over stale return
state. A render row without connected, measurable geometry is not a completed
navigation target; reveal it through the transcript's normal bounded path.
Initial progressive transcript loading must finish revealing the rows before
the question jump consumes its scroll and focus request.

The persistent composer toolbar, including its collapsed form, offers a muted
amber outlined speech-bubble/question-mark button. With room it reads
**3 questions · 1 turn ago**, using the youngest counted question's age.
Actual toolbar space removes the age first and then the noun, retaining the
icon and count with a full accessible label. There is no pulse or focus theft.
The wider, viewport-capped menu opens upward and may cover the composer.
Oldest questions appear at the top, newest at the bottom. Each ellipsized,
single-line preview has an outlined background, a bare muted turn-age numeral
outside its left edge, a right-side **×**, and a separator between rows.
Opening focuses the newest row; arrow keys navigate and Escape closes.

**×** silently dismisses a reminder without navigating, deleting transcript
content, or asserting an answer. Right-click or long-press opens a one-action
dismiss menu; holding alone deletes nothing. **Show dismissed** permits
recovery. Opening or closing the menu resolves nothing. An unseen dot clears
only after at least 60% of the actual question title is visible in an active
tab. Seen and sent are independent states.

#### Reminder duration and local state

One searchable **Question reminders** slider lives in **Toolbar** settings.
It ranges from 0 through 12 and defaults to 3. Zero hides both dedicated and
overflow reminder controls; transcript answering remains available. There is
no separate feature-enable setting. For a positive value `n`:

- The count and amber emphasis disappear per question after `n` subsequent
  user turns or `round(n × 160 / 3)` main-composer text changes.
- The quiet **Questions** button moves to ordinary toolbar overflow after
  `ceil(n × 8 / 3)` turns or `n × 200` text changes. At the default these two
  stages are 3 turns / 160 edits and 8 turns / 600 edits.
- A text change counts once; unchanged notifications and clearing to empty
  do not count. Inline answer typing does not age reminders. Whichever turn
  or edit threshold arrives first governs each stage.
- A focused button or open menu is not retired underneath the interaction.
  New questions restore visibility without reviving old aged/dismissed counts.

The transcript menu covers loaded history only, without background history
fetches. Aging affects reminders, never answer state or transcript content.
Per-question drafts, seen/sent/dismissed state, and edit ages are browser-local,
keyed by source, session, message id, and question index. Reloads retain them;
storage events synchronize tabs on the same browser origin. Other devices are
independent. When browser storage is unavailable, the current visit still
works in memory. Receiving the live and durable copy of one question must not
create duplicate controls or duplicate replies.

#### Discovery from Inbox and session navigation

With `session-async-questions`, Inbox rows and sidebar session rows show the
same local unanswered count as the transcript reminder. Inbox's toolbar and
sidebar navigation entry also expose aggregate counts. These controls are
default-on and share the existing reminder slider; zero hides them. Ordinary
unread-session counts remain separate. Unknown question inventories never
masquerade as a known zero.

Session-row question counts sit outside the title area's hover-menu overlay.
The menu and count retain separate, non-overlapping click targets on desktop
and touch layouts, including compact sidebar rows. A compact row's trailing
project name and status letter share that protection: the overlay may cover
title text only, and they remain visible and clickable while it is shown.

Click or right-click a count to open previews directly. Aggregate menus group
questions by session, with the most recently updated session last; questions
within each group remain oldest-first. Compact counts retain an icon and
accessible description. Where space is tightest — a sidebar session row, the
sidebar Inbox entry, a crowded composer — the control is the icon plus any
current count and never spells out its name, so it cannot crowd out the title
beside it. Menus may be wider than the button and choose the
available space above or below it. Dismissal and successful inline submission
update all mounted surfaces in the same tab, including sessions whose
transcripts have never been opened. Draft typing does not redraw every count.

The additive `asyncQuestions` list/Inbox/activity projection carries source
message id, question index, preview title, subsequent-user-turn age, and an
`omitted` flag. The current Codex reader scans at most the final 2 MiB of an
uncompressed rollout, retains at most 128 questions younger than 32 user turns,
and clips preview titles to 320 characters. Canonical completed async items
define identity; duplicate items do not create duplicate previews. Compressed
rollouts or an observation invalidated by a concurrent file change leave the
field absent. An `omitted` inventory tells the menu that earlier questions may
be missing and directs the user to the transcript. This bounded recent window
is not a complete historical question count.

Selecting a preview opens the source session with the existing 32-turn tail
request and resolves the exact question in that transcript. Replies always use
the full source title, never its clipped preview. Cross-session submission or
Return resumes Follow at the live bottom and focuses the main composer;
ordinary in-transcript visits retain their saved-position behavior. A missing
source question is not replaced by guessed text or an unrelated question.

This optional contract uses permanent capability ID 60, version-implied from
0.8.2 and explicitly advertised by source builds before that release. The
maintainer approved the plan on 2026-09-07 against v0.8.0 and v0.8.1, both of
which lack this projection. Without the capability, omit collection counts and
menus, retain existing transcript controls when structured fields are present,
and issue no new request. No reply route or older capability meaning changes.

### Standalone tool output

A provider output that has no call id is visible context, but it is not a
`tool_result`: there is no honest `tool_use_id` with which to pair it. Codex
`function_call_output` records without `call_id` and live
`functionCallOutput` items therefore normalize to a `system/tool_output`
message. The row names the provider tool with its optional namespace and keeps
the output expandable on its own. It must never attach to the preceding tool
call by position or a fabricated id.

The provider item id is the row identity in both live and persisted paths when
Codex supplies it. `codexToolName` and `codexToolNamespace` retain the display
name, top-level `content` holds the readable output, and `toolUseResult` keeps
the structured value. For Codex function outputs whose structured value is a
nonempty array of only `input_text` items, readable content is the concatenated
text. Mixed, image, audio, resource, and encrypted arrays retain their
structured JSON envelope (with the ordinary inline-media sanitization rules).

Codex OSS command-execution messages forward the shared normalizer's
`_displayActions`, matching rollout-derived file actions. Shell-recognized Read
calls keep the same file affordances before and after reload. Native OSS parity
uses the durable `exec_command_end` record for result text and exit code;
function-output wrappers alone are not the authoritative execution record.

## Command execution metadata (exit code, runtime)

Command-like tool results (Bash and shell-session polls such as Codex
`write_stdin`/`wait`) normalize per-command execution metadata into the
structured tool result when the provider reports it, instead of leaving it
embedded in output text or raw provider records:

- `exitCode?: number` — the command's exit status.
- `durationSeconds?: number` — provider-reported wall time for the command.

Provider sources normalized today: Codex unified-exec chunk records
(`{chunk_id, wall_time_seconds, exit_code, output, session_id}` printed as
tool output — the chunk's `output` becomes the result text, raw chunk fields
pass through structured per the pass-through rule, and a `stdout` alias
rides alongside so renderers need no chunk knowledge), and Codex shell text
envelopes (`Wall time[:] N seconds`, `Process exited with code N`,
`Exit code[:] N`). Claude SDK Bash successes carry structured output, while
failures may carry `is_error: true` plus a string beginning `Error: Exit code
N`; transcript projection normalizes that authoritative failure envelope into
combined output and `exitCode`. Without `is_error: true`, identical text
remains command output.

Display rules (client, `getCommandResultMeta`/`formatCommandDuration` in
`packages/shared/src/transcript/shellToolOutput.ts`):

- **Exit code 0 is never shown** — success is the default; a visible exit
  code always means failure. Every nonzero command result shows `rc=N` in the
  collapsed row header, whether or not the command produced output.
- **Failure state does not recolor combined output** — the row's error-status
  dot and `rc=N` carry command failure. Known stderr remains error-colored;
  its foreground must retain strong contrast in dark and light themes.
  Combined provider output uses the normal output color.
- **Command output remains fixed-width** — source and enriched renderings of
  stdout, stderr, and combined output use the same fixed-width metrics. File
  links, glossary terms, and other annotations may change color or decoration,
  but do not switch the surrounding output to the prose face.
- **Runtime is a detail-view fact**: shown in the command detail surfaces —
  the Bash output modal, the expanded result body — not in collapsed row
  summaries, except alongside a nonzero exit code (`rc=1 in 12.5s`).
- Renderers read metadata through `getCommandResultMeta`, which accepts
  both the normalized fields and raw provider spellings
  (`exit_code`, `wall_time_seconds`), so a provider whose normalization
  lags still displays correctly once its fields pass through structured.
- A pending command call reads **Run**. A pending `write_stdin`/`wait` poll
  reads **Waiting**, while a completed poll keeps the historical **Shell**
  label. Its linked command/session summary supplies the execution context, so
  a long-lived command and the current wait are visible as distinct activity
  rather than two apparently equivalent running commands.

## Web browsing results (Codex `web.run`)

Codex's namespaced browsing tool (`web.run`; `web__run` when flattened into
a code-mode `exec` script) normalizes to canonical tool name `Web` with the
structured result `CodexWebRunResult`
(`packages/shared/src/codex-web-run.ts`). The provider prints one text blob
— a script envelope (`Script completed` / `Wall time N seconds` /
`Output:`) followed by page blocks separated by an exact 80-dash rule. Each
block is a `Title (URL)` line plus a marker line carrying a follow-up
reference (`turn0search4`), `[wordlim: N]`, and `Key: value;` metadata
(Published, Crawled, Content type, Source, Redirected to URL, Total lines);
the body is either windowed page lines (`L0: …`, several may share one
physical line) or a prose search snippet.

The parser (`packages/server/src/codex/webRun.ts`) treats the U+E200–E202
private-use citation wrappers as format-significant markup:
`cite<id>†<label>[†<domain>]` reduces to its visible
label, bare page references drop. It fails closed — output without the
envelope or a page block keeps its raw-text presentation — and the
normalized `content` string drops the envelope, so "Script completed" never
reaches rendered text. The client `Web` renderer
(`packages/client/src/components/renderers/tools/WebRenderer.tsx`) renders
page content in the prose output font (it is web prose, not terminal
output) and mirrors the shell-output preview affordances via the shared
primitives in `renderers/tools/outputPreview.tsx` (first-N-lines clamp,
tail tooltip, hidden-line badge, hover copy button, click-for-modal).

## Inline base64 is interchange-only

JSON is the interchange representation, and base64 is how binary survives
inside it. The API wire format and the persisted jsonl legitimately carry
images as inline base64 content blocks — JSON has no binary type, and the
transcript is a replayable log. That legitimacy ends at ingest: past the
boundary where wire messages become retained client/session state, binary
payloads belong behind refs/handles (server-served media refs, or client
`Blob` + object URL), never as inline base64 strings held in memory. A heap-resident base64 string costs ~2.7x
the raw bytes (base64 overhead x UTF-16), is pinned to the JS heap where a
`Blob` could be spilled by the browser, and re-streams at full weight to
remote clients on every fresh transcript load.

Direction: the **server** owns the conversion, not the client. Whatever
the harness emits with inline base64 — user-pasted screenshots, tool
results, or assistant-*generated* images — is extracted at the server's
provider seam; the client receives either binary over the existing
authenticated channel or a media URL. The URL form carries security
obligations, not just plumbing:

- same authn/authz as the transcript itself — an unguessable capability
  URL is not authorization (URLs leak via logs, history, referers, and
  shared screens);
- opaque media ids mapped server-side, never client-supplied paths;
- correct `Content-Type` with sniffing disabled, and script-capable
  formats (SVG) served neutralized — generated media is untrusted input;
- must work over both transports: direct HTTP and the relay tunnel,
  where a side-channel HTTPS fetch would bypass the end-to-end
  encryption — media on the relay path rides the encrypted channel.

Known debt: today the client `Message` model retains wire-shaped blocks,
so inline base64 rides through to render and into the session-detail
transcript cache. The measured retention charges
([session-detail-data-layer](session-detail-data-layer.md)) count that
payload at true weight, which contains the damage but does not fix the
representation. The intended client seam is the session-detail ingest
boundary once the store-authoritative migration completes, consuming the
server-served refs above (which also cut transcript transfer to mobile
clients). [`session-media-handles.md`](session-media-handles.md) records
the problem statement, measured local evidence, and a possible opaque
media-id lookup model. When it lands, resume/replay and the offline Zod
validation paths must reconstitute or tolerate handles.

## Status

The status half of the contract is
[provider-state-machine](provider-state-machine.md): `processState`
(`idle`/`in-turn`/`waiting-input`), `sessionLiveness.derivedStatus`,
compacting, and ownership. Providers supply raw process/stream events; the
seam derives these normalized states — the same
normalize-in-the-provider-layer rule applies.

## Lineage: forest links at two levels

Provider lineage appears at two distinct levels, and the contract keeps them
separate:

- **Entry-level parent links** (a message forest inside one transcript):
  Claude `parentUuid` (single-parent branching forest — see the
  `packages/shared/src/dag.ts` module header), Pi v3 `id`/`parentId`.
- **Session-level source links** (lineage between session ids): Codex
  `forked_from_id`, OpenCode session `parentID`, and YA-created transcript
  copies. YA surfaces ordinary copy provenance as `forkedFromSessionId`.
  `parentSessionId` is a different, interactive relationship reserved for a
  YA `/btw` aside's Mother and is explicit through
  `parentSessionKind: "btw-aside"`.

Distinguish **harness-native data model** from **what YA currently
surfaces**. Capability flags describe the latter only: Pi natively maintains
a tree (`/tree`, per-entry `parentId`) while YA reads just the active-leaf
path, so Pi's `supportsDag` is `false` without contradicting Pi's data
model. The audit and the proposed `sessionTree` capability live in
[provider-session-tree](provider-session-tree.md).

**Traversal rule**: any parent-link traversal — linearization, reorder
repair, walk-to-root, tree projection — uses the shared facility in
`packages/shared/src/dag.ts` (`orderByParentChain`, `needsReorder`, over the
`DagOrderable` view) rather than a hand-rolled per-provider walk. The
facility is deliberately a small family, because the traversals differ by
intent: conservative reorder repair (never invents order), active-leaf path
selection, and lineage/tree projection. Extend it by generalizing the
id/parent accessors (today it hardcodes `parentUuid`), not by copying the
loop. Known debt predating this rule: the Pi reader's walk-to-root and the
Claude reader's DAG handling are self-contained.

## Capabilities registry

Client-side capability flags (`ProviderCapabilities`,
`packages/client/src/providers/types.ts`): `supportsDag`,
`supportsCloning`, `needsApproxMessageDedup`, `approxDedupExcludesTools`.
Each flag is a claim about how far the provider's normalization satisfies a
section of this contract; when a provider's normalization improves (e.g.
deterministic id alignment lands), flip the flag in the same change.
