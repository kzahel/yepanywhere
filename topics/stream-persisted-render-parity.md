# Stream / Persisted Render Convergence

> Provider persistence is the durable transcript authority. The live stream
> may add useful ephemeral detail near the active tail, but live items that
> have persisted counterparts should converge with minimal structural change.

Topic: stream-persisted-render-parity

See also: [transcript-display-objects](transcript-display-objects.md) (the
opposite direction — display-only objects that are *not* provider turns),
[provider-authoring](provider-authoring.md) (a new provider must satisfy this
contract), [codex-sessions](codex-sessions.md),
[stream-durable-id-dedup](stream-durable-id-dedup.md) (the id/dedup half of
"same session, two sources"), and
[codex-code-mode-render-convergence](codex-code-mode-render-convergence.md)
(the Codex 5.6 normalization/rendering plan). Dev-doc:
`docs/project/multi-provider-integration.md`.

## Hidden-activity incident (2026-08-07)

A Claude Gateway turn appeared to stop updating for more than ten minutes after
steering, deferred queue promotion, and a nearby compaction. The local rotating
activity phrase continued, but the latest thinking and compact activity rows did
not advance. Restarting YA revealed the missing assistant, tool-use, and
tool-result activity.

The provider transcript established that this was a projection failure rather
than missing provider work:

- deferred patient messages promoted at `23:17:12Z`;
- a Claude `compact_boundary` persisted at `23:20:11Z`;
- dozens of assistant, tool-use, and tool-result records persisted through
  `23:34:20Z`;
- the process reported idle immediately afterward; and
- a later cold session read after restart returned the records the live view had
  omitted.

No augmentation or subscription error was logged during the interval. Client
diagnostic collection was not enabled for a usable incident trace, so the
server ordering fault is reproduced directly rather than inferred from browser
logs.

### Dispatch-order audit

The path is FIFO until optional asynchronous presentation work enters it:

1. `provider-runtime-host.ts` receives sequenced worker events and removes them
   from `eventQueue` with `shift()`.
2. `Process.emit` iterates its listener `Set` in insertion order, but deliberately
   does not await listener promises.
3. `createSessionSubscription` used to await Markdown, diff, highlighting, and
   other augmentation before emitting each finalized message. Every provider
   message therefore started an independent continuation. Completion order was
   determined by augmentation duration: later messages could overtake an earlier
   one, and one unresolved augmenter could hide its raw provider record.
4. `handleSessionSubscribe` assigns event IDs synchronously in actual send order;
   WebSocket frames preserve that order. `RelayProtocol`, `ManagedStream`, and
   `useSession` forward received events synchronously. The client cannot recover
   provider order from event IDs after the server has already sent a different
   order.
5. `mergeStreamMessage` can replace an existing SDK message by stable `uuid` or
   `id`, which makes raw-first delivery followed by same-id enrichment possible
   without changing row order.

This is not deliberate LIFO dispatch. Listener invocation is ordered; the old
observable order was nondeterministic async completion.

### Ruled-out owning causes

- The rotating activity phrase is client-local animation while
  `isProcessing=true`; it does not prove fresh provider or server events.
- Incremental Claude transcript parsing reuses one entries array, but the
  normalization cache checks both array length and final-entry identity, so
  append-only growth invalidates the cached projection.
- A speculative client refetch on every owned-session update could recover from
  several server faults, but it would add polling and duplicate durable reads
  without fixing the ordering boundary. That experiment was removed.
- Compaction, steering, deferred input, and warm transcript caching remain
  important live-test scenarios, but none owns message dispatch. They increase
  the chance and visibility of a slow-enrichment race.
- Liveness/status events are separate `Process` events. They explain how a view
  could keep showing activity decoration while transcript rows were blocked,
  but changing liveness caching would not release those rows.

## Live tool-field loss incident (2026-08-19)

A live Claude turn showed one thinking activity for about five minutes while tool
work continued. Sending a steer caused the accumulated tool activity to appear.
The server stream was active; the client live projection was lossy:
`useStreamingContent` copied only `type`, `text`, and `thinking` from each
`content_block_start`, discarding a tool block's `id`, `name`, and `input`.
Conversation view therefore could not compile live tool-call rows. Durable JSONL
catch-up restored the complete blocks later, making the steer look like a render
flush.

The live accumulator now retains the complete provider block and accumulates
`input_json_delta.partial_json` until it forms a valid tool input. Unknown or
incomplete deltas do not publish a no-effect React update. Focused tests cover
live tool identity and completed input, and the authorized browser tab advanced
to 50 live activities without another steer.

Replaceable micro-deltas use two timers over one dirty set:

- a quiet timer follows the newest delta at an adaptive cadence with a 100 ms
  base; and
- a maximum-age timer remains pinned to the oldest unpublished delta. Its
  ordinary bound is 200 ms, rising only with the adaptive interval under
  measured flush/event pressure.

Whichever timer fires drains the set and cancels the other. A flush callback
that accepts more data re-arms before returning. Recomputing a shorter adaptive
deadline against the pinned origin schedules an immediate zero-delay flush when
that deadline is already past. Stream-progress liveness uses the same
leading-plus-trailing principle: burst events are rejected before the React
setter, but one timer publishes the final observation if the stream goes quiet.

## Implemented repair boundary

`packages/server/src/subscriptions.ts` establishes provider order before any
optional await:

- perform bounded synchronous preparation, including task-list correlation;
- emit every raw provider message immediately;
- clear streaming bookkeeping synchronously on stream completion;
- retain one FIFO lane only for mutable streaming-coordinator state;
- run finalized-message work independently with at most four active and 128
  queued items;
- when that optional queue saturates, keep raw messages visible, drop only the
  oldest queued enrichment, and log one start plus one aggregate end record for
  the saturation episode rather than one error per dropped item;
- coalesce queued same-id snapshots and publish only the latest generation;
- publish one atomic same-id enriched message, followed by the equivalent
  compatibility `markdown-augment` event;
- keep an unidentified message as one raw representation rather than generating
  two unrelated client IDs; and
- emit turn completion without waiting for optional enrichment, allowing the
  client to become idle and fetch the durable transcript.

Queued state is cleared on completion and cleanup. Running work receives a
cloned message and cannot publish after teardown or after a newer generation
supersedes it. Cleanup also releases viewer presence, live-delta demand, and the
project path-index claim. `Process.emit` deliberately does not await subscription
promises, so optional presentation work cannot backpressure provider ingestion.

`finalized-message-augmenter.ts` is the single per-message implementation for
Markdown, Edit, Write, Read, and ExitPlanMode presentation. Both the persisted
batch facade and live finalizer call it. Every assistant text block receives its
own `_html`; the compatibility event carries the first block only for older
clients, while current compilation prefers each block's inline HTML.

Late-join replay and the active-process/no-session-file REST fallback augment
detached copies of `Process` history. Provider-owned replay state is never
mutated. File-backed reads, active-process reads, and live finalization use the
same private-session augmentation boundary and project-file-link context.

The broad activity channel and the owned-session content stream are separate
subscriptions. When activity reports a turn idle, the client performs an
immediate durable-transcript catch-up and one trailing catch-up for providers
whose last persistence write follows the idle event. The idle composer must not
remain visible beside a transcript tail that predates the completed turn merely
because the content subscription still appears connected.

Final Markdown ownership now lives in `SessionDetailState.markdownAugments`.
WebSocket events dispatch through the session-detail reducer, and warm reveal
and route snapshots retain the map. Duplicate updates remain no-ops, live IDs
can migrate to durable IDs, and active-window pruning removes stale entries.
Token-rate pending/block Markdown remains on the ref-backed streaming path.

The client preserves transcript identity for structurally equal same-id SDK
messages. Once an identified raw message is visible, later same-id replacements
are held for a bounded 100 ms window and only the latest replacement is
published; a different message id, waiting-input/idle status, or turn completion
flushes the pending replacement first. This keeps raw-first latency and event
order while preventing a raw/enriched burst from reconciling the complete
detailed transcript once per intermediate snapshot.

Focused regressions in `packages/server/test/subscriptions.test.ts` prove raw
order while the first finalizer is blocked, independent later finalization,
latest-generation suppression, bounded saturation logging, atomic
enriched-message/event order, immediate completion, replay cloning, cleanup,
and no post-teardown publication.
`packages/server/test/render-parity.test.ts` covers multiple text blocks as well
as provider render parity. Session-detail reducer, selector, snapshot, and hook
tests cover final-Markdown ownership and restoration. The active-process route
regression proves canonical multi-block rendering without mutating process
history.

## The convergence contract

A session reaches the UI two ways:

- **Stream** — live provider events during a running turn (e.g. Codex
  `command_execution`, Claude SDK messages).
- **Persisted** — the same session re-read from disk later (Codex rollout
  JSONL, Claude JSONL DAG, OpenCode SQLite, …).

Both feed the same `compileTranscriptProjection` → render-item pipeline, but
equality is graded by whether the live item has a durable counterpart:

- **Durable-corresponding items — strong convergence.** Tool calls, tool
  results, assistant messages, and other records present in both paths should
  preserve semantic identity, ordering, grouping, parameters, and roughly the
  same layout. These are the highest-jank failures because a refresh can
  reorder several rows or replace one group with another.
- **Live delivery precedes optional enrichment.** Forward raw provider messages
  in provider order before asynchronous markdown, diff, highlighting, or other
  augmentation. Enrichment work is serialized when it shares mutable stream
  state and may follow as a same-id update; it must not delay or reorder the
  underlying activity. A failed or stalled augmenter degrades presentation, not
  transcript visibility.
- **Live enrichment — update in place.** Streaming output, elapsed time,
  progress, provisional status, or a more timely label may enrich a durable
  item while it is active. Prefer changes that do not alter row count, group
  boundaries, navigation anchors, or stable identity. Once the persisted
  counterpart is available, the item settles to the durable representation.
- **No-effect replacements do not publish.** A structurally equal same-id SDK
  snapshot preserves the existing transcript array and message identity.
  Replaceable same-id enrichment bursts publish their latest bounded snapshot,
  not every intermediate representation.
- **Reload-safe snapshots are reconciliation, not replay.** A native provider
  snapshot may contain the whole completed active-turn prefix. Reattaching YA
  must not publish that prefix as freshly observed live activity. Browser
  reconnect already triggers provider-durable REST catch-up; the replacement
  live stream restores only result-backed items whose snapshot status is
  explicitly in progress, then consumes later provider deltas normally.
- **Truly ephemeral live items — allowed.** Thinking deltas, transient status,
  progress, and other provider events that are never persisted may appear and
  disappear near the live tail when they are useful. They are not evidence
  that YA should invent a parallel persisted transcript.

The practical stability boundary is therefore `settled transcript | recently
completed turn | active live tail`: the left side should be very stable; some
bounded movement at the right edge is expected. Provider persistence remains
the sole durable source of truth. In particular, Codex rollout files are the
canonical durable transcript; YA must not create a second durable message or
metadata record to preserve live-only shape.

User-requested goal-command receipts are an explicit display-history exception:
they record a YA-local control operation, not provider output. YA stores the
same local-command row used for live delivery in session metadata, with stable
identity and placement, so reloading preserves the marker. See
[emulated-slash-commands.md](emulated-slash-commands.md#codex-goal-commands).
This does not authorize copying provider-only stream output into YA storage.

## Draft-first augmentation decision

The implementation has two publication phases per identified finalized item:

1. bounded, order-sensitive synchronous preparation followed by immediate raw
   insertion in provider order; and
2. one atomic same-id replacement after all finalized Markdown, diff, preview,
   highlighting, glossary, and project-link work for that item settles.

There is no subscription-wide finalization tail and no separate
"geometry-neutral" paint. Markdown block structure and the presence,
truncation, or expansion of diffs, plans, task panels, and file previews set
geometry. Syntax-color spans, glossary spans, and file-link anchors are intended
to preserve visible text and line structure, but splitting them out would add a
third render and a new ordering surface. They therefore remain bundled until a
future change demonstrates a material raw-to-final latency reduction and proves
at desktop and phone widths that row height and scroll anchors do not move.
Project-file index hydration remains bundled for the same reason.

Representative output is pinned by augment and parity tests for Markdown
structure, syntax-highlighted code, multi-block assistant output, Edit/Read/
Write/plan previews, project-file links, and glossary annotations. Subscription
tests use controlled promises rather than sleeps: while one item is blocked,
raw drafts remain ordered and visible, later item finalization can publish, and
completion remains immediate. The deterministic transcript Playwright specimen
continues to enforce stable top-level render identity, no horizontal overflow,
and final layout at desktop and phone widths.

For incident reproduction, the high-value operator scenario remains an isolated
YA profile with Claude Gateway bursts, intentionally slow enrichment,
compaction-adjacent output, steering plus deferred input, reconnect, and durable
catch-up. It exercises deployment/provider timing beyond the deterministic
contract tests; it is not a reason to restore serialized enrichment or a
YA-owned shadow transcript.

For durable-corresponding items, "converge" is stronger than "eventually show
similar text." Structured fields are latent UI, and item count/order/grouping
are layout. A fact used to restructure a live tool call should either be
recoverable from persistence or be demonstrably safe as bounded optimistic
tail presentation.

## Enforcement

`packages/server/test/render-parity.test.ts` +
`test/utils/render-parity-harness.ts`. `assertRenderParity(name, persisted,
stream)` normalizes both render-item arrays and reports the first structural
difference by path (e.g. `$[3].toolResult.structured.exitCode`). The
`runPersistedPipeline` / `runStreamPipeline` pair build the two sides from the
same logical session; keep the two fixtures representing the *same* commands so
a drift means a real asymmetry, not two different sessions. The comparison
retains render-item IDs, source-message IDs and parent/tool relationships,
block HTML, media, and structured fields. Provider-specific identity aliases
must be declared at the assertion. Current Codex user, assistant, and reasoning
rows instead converge on persisted provider identity; positional ids remain a
historical fallback.

The harness intentionally enforces strict equality for facts and items that
the fixture declares paired. That is a conservative test for the
durable-corresponding category, not a ban on separate live-only event types.
When an intentional live-only item is added, test its tail lifecycle separately
and do not weaken paired-tool parity to accommodate it.

## Worked instance: Codex Bash `exitCode` (2026-07-01)

Adding `exitCode` to Codex structured Bash results surfaced it on the **stream**
path (`command_execution` events carry `exit_code`) but not on **reload**. Two
gaps, both fixed:

1. **The persisted parser dropped a recoverable code.**
   `normalizeCodexToolOutputWithContext`'s Bash branch computed `exitCode` but
   did not pass it to `createBashToolResult` — unlike the command-execution
   path. Fixed by threading `exitCode` through (`codex/normalization.ts`).
2. **The reload fixture was unrealistic.** Real Codex persists the exit code in
   a structured `exec_command_end` event (which funnels through the *same*
   `normalizeCodexCommandExecutionOutput` as the live stream); the parity
   fixture used only a plain `function_call_output` string, which carries no
   exit code for a zero exit. Fixed by adding the `exec_command_end` event the
   real reload path relies on (the later `function_call_output` is deduped).

The durable lesson: **make durable-corresponding items funnel through the same
normalizer using facts recoverable on both sides.** For these Codex commands
that means the structured `exec_command_end`, not a best-effort parse of an
output string. Live-only facts may still render at the active tail, but they
must not silently restructure the settled tool call after reload.

## Provider-normalizes direction (deferred)

`topics/bash-result-contract.md` proposes a provider-base Bash-result
normalizer so every provider emits the same structured facts (output,
empty-output, exit code, timing, interruption, background state). That is the
principled long-term home for this contract — a single normalizer both paths
share, per provider. Phase-1 (a default provider-base normalizer matching
today's Codex heuristic) is **not yet implemented**; the exitCode fix above is
the point fix. Track that work under bash-result-contract, and require a
stream+persisted parity fixture whenever a provider gains a new structured
field.

## Native ingestion through tool display

`server/test/utils/native-tool-display-corpus.ts` feeds deterministic native
messages into production adapters before the existing parity harness. Server
checks compare compiled records and data-only prepared values/classification;
`client/.../tools/__tests__/displayNative.test.tsx` runs the same pairs and mounts
both outputs with semantic content expectations. A safe raw fallback is a test
failure for a declared rich/partial specimen. No CLI, credentials, or paid
provider session is required. The persisted harness includes the production
TaskList snapshot pass before rich augments.

Coverage ownership (invented values; evidence classes distinguished below):

| Provider seam | Paired tool variants |
| --- | --- |
| Claude SDK `convertMessage` / actual JSONL reader and normalization | Read text/dedup/image/PDF/text-only; Write file/ack/rejection; Edit replacement/text-only; Bash; Glob; Grep files/content/count/text-only; TodoWrite; Task complete/async/text-only; search/fetch; questions; plan exit; background shell/task output; kill; task create/update events |
| Codex app-server raw-response notifications / rollout response items | goals, plan, stdin, image, spawn; multi-call Exec; custom apply_patch; code-mode Web; shell-recognized Read/Grep/heredoc Write/Bash |
| Codex commandExecution notifications / durable shell calls | Read, Grep and heredoc Write; structured bodies, status and checked values agree |
| Gemini CLI native events / session JSON | read_file, replace, write_file (including rejection), glob, search_file_content, run_shell_command |
| OpenCode SSE parts / stored message parts | read, edit, write, glob, grep, bash, todowrite, task, webfetch, websearch, question, apply_patch |
| Pi AgentSession events / native message-node reader | read, write, edit replacements, bash, grep; both sides use pi-tools normalization |
| Grok ACP updates / updates-JSONL reader | Write/SearchReplace, ReadFile, and Bash results; both sides use the shared Grok normalizer |
| Codex OSS command_execution / rollout execution records | Bash and shell-recognized Read, including file actions |

The matrix deliberately does not claim every provider emits every renderer
variant. Additional Grok tool conversions, non-shell Codex OSS events, Pi custom
extensions, and Gemini ACP's input-less call notifications retain their owning
provider adapter tests and universal display fallback; no new rich variant is
claimed for those paths here. Gemini ACP cannot supply a complete Write input
from its current notification adapter. Unknown/provider-defined tools retain
raw inspection without a schema registration. Existing provider tests remain
responsible for transport wiring and variants not declared above.

Write highlighting, Edit structured-patch-only/changes/target-only records and
TaskList snapshots have explicit synthetic controls: these are YA augmentation
or incomplete compatibility shapes rather than fabricated native histories.
Native file pairs also exercise production highlighting. Registry controls check
all declared alternate shapes, and browser coverage includes nested rejected
Write, partial text, pending-to-complete, disclosure, and corrected input.

Two bounded native comparison exceptions are asserted before comparison:
Grok's reader retains final ACP `status` as extra input metadata while live
emission keeps it on execution state; Codex commandExecution labels empty output
`(no output)` while rollout output is empty. Neither changes checked result
facts, execution status, identity, or rendered content. The corpus does not
invent durable parent links for independently retained child transcripts;
compiled ownership is compared as supplied, with nested mounting checked by the
Task/ToolCallRow suites and browser fixture.

A bounded local census on 2026-09-10 inspected at most 20 recent inactive files
per provider and 8 MB per file: 3,522 Claude rows (2.1.201–2.1.258) and 8,607
Codex rows (0.145.0–0.153.2). Only aggregate tool/field/version counts were kept
locally. Committed fixtures contain invented values, not transcript excerpts.
Codex adapter source was checked against the declared rust-v0.154.0 reference.

### Evidence added after the display-contract review

The original display-derived native envelopes remain adapter/containment
controls. They do not establish observed-provider coverage. Independent controls
in `observed-tool-display-specimens.ts` retain field presence and nesting from
inactive Claude Code 2.1.223 JSONL: mixed WebSearch link groups/commentary, Read
text, Read image dimensions, and Edit replacement results. All values are
invented replacements. The exact source version and evidence class accompany
each control; live SDK envelopes are reconstructed, not captured.

The independent PDF and partially specified image-dimension controls follow
installed Agent SDK 0.3.258 declarations; no local specimen for those shapes was
found in the bounded scan. That scan examined 30 inactive files below 8 MB each
per provider, excluding files modified in the preceding hour. Claude versions
were 2.1.201, 2.1.220, 2.1.223, 2.1.238, and 2.1.258; Codex versions were
0.147.0, 0.149.1, 0.152.1, and 0.153.2. Private source locators and raw observations
remain in ignored local storage. Tests have no dependency on that storage.

The Claude pairs now pass through `ClaudeSessionReader.getSession`, including
JSONL parsing and DAG selection. Multi-record prefixes cover a rejected Write
and a corrected neighboring call, preserving order, identity, error text,
classification and mounted output. A live unfinished call with active-work
knowledge is pending; the same frozen JSONL tail without that knowledge is
incomplete. Terminal prefixes must converge exactly. Separate child JSONL and
metadata-sidecar controls verify child call order, exclusion from the parent
history, and the sidecar's launch-tool-to-agent mapping against live SDK parent
ids. They do not fabricate parent ids inside current child history.

The expanded tests still do not prove every distinct provider conversion or
observed specimen promised by tactical 124. Remaining coverage is recorded in
`gaps/tool-display-native-provider-coverage.md`; transport wiring and paid live
sessions are not exercised by these deterministic conversion/reader controls.

## Captured provider replay baseline — 2026-09-12

[The captured corpus](../packages/server/test/fixtures/captured/README.md) adds
two real sessions independent of renderer fixtures: Claude Haiku through Agent
SDK 0.3.258 and Codex Luna through app-server 0.154.0. Each retains the full
selected native transcript and ordered per-session raw logger messages before
provider conversion. Explicit string redactions remove capture-machine context
while preserving JSON structure and call/result relationships.

`packages/server/test/captured-provider.test.ts` uses production native readers,
provider conversion methods and the existing normalization/augmentation/compiler
harness. Assertions cover two user inputs in durable history, ordered tool
calls/results, main-session ownership, completion text, rich/partial preparation,
failure status, and an observed unfinished Claude live prefix. Missing-file,
broken-result-reference, and rich-to-raw negative controls must fail their gates.
Normal root tests discover this corpus and root typechecking includes its code.

These are adapter/reader replays, not full RPC/session-loop recordings or UI
tests. User submissions are verified from native history, not invented in the
provider output. No browser subscriber was attached during capture; browser
micro-deltas, media, compaction, subagents, cold provider resume, and transport
authentication are outside this slice. Expected facts must be stated from the
scenario and raw evidence rather than copied from current compiler output.

The corpus exposed and now guards a repaired native Codex failure-status loss.
A uniquely associated native `CommandExecution` supplies status/exit code for
the outer code-mode Bash row; both paths must mark the captured exit-code-7
command failed. Synthetic mutations verify missing/wrong/ambiguous evidence
does not cause guessed attribution, and native success overrides misleading
printed JSON. See [the association contract](codex-code-mode-render-convergence.md#2026-09-12-native-code-mode-command-status).
All positive assertions are ordinary passing tests. Refresh captures in new
versioned directories; retain old evidence unless retirement is deliberate and
documented.
