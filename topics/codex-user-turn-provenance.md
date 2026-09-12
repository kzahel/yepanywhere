# Codex User-Turn Provenance

> A Codex `response_item` with `role: "user"` is model-input syntax, not proof
> that a person authored the content. YA should identify real user turns from
> Codex's persisted turn lifecycle and retain the paired response item only as
> the richer rendering payload.

Status: closed. Slices 1-3 landed; no further work is planned.

Topic: codex-user-turn-provenance

Related topics: [injected-message-visibility](injected-message-visibility.md),
[codex-sessions](codex-sessions.md),
[stream-durable-id-dedup](stream-durable-id-dedup.md),
[stream-persisted-render-parity](stream-persisted-render-parity.md), and
[provider-refresh](provider-refresh.md).

Follow-on consumer repair (2026-08-01): Fork boundary resolution moved from
`SessionPage`'s normalized-role scan to the server's real-user predicate. A
user-role tool result no longer terminates a turn. Durable normalization also
preserves Codex's provider turn id as non-enumerable server metadata so a
renderer id never reaches `thread/fork`. This does not reopen the provenance
work below; it records a consumer that now follows the established boundary.
See the [session fork and clone unification record](../docs/tactical/075-session-fork-clone-unification.md).

## Invariant

YA must not infer user authorship from a Codex response-message role alone.

- A real user turn should render from the richest durable provider payload.
- Provider-injected context must not render as a normal user prompt, determine
  the session title, or count as a user turn.
- Classification must follow Codex's persisted lifecycle semantics before
  falling back to prompt-text recognition.
- A compatibility fallback must preserve genuinely old or foreign Codex-like
  rollouts that do not carry the lifecycle evidence used by current Codex.

This specializes the broader injected-message visibility contract for Codex
rollouts. The important distinction is **provenance**, not whether text happens
to resemble XML or Markdown used by a system prompt.

## Observed Defect

Session `019f4d01-af21-7840-b7a4-1fc5c3c34998`, created by Yep Anywhere with
Codex CLI `0.144.1`, persisted this startup sequence:

```text
response_item role=user
  content[0] = <recommended_plugins>...</recommended_plugins>
  content[1] = <environment_context>...</environment_context>

response_item role=user
  content[0] = the actual user prompt
event_msg type=user_message
  message = the actual user prompt
```

The project had no `AGENTS.md`. The July 9 fix only recognized the other
startup composition:

```text
recommended_plugins + AGENTS instructions + environment_context
```

Consequently, YA's durable normalizer rendered the first response item as a
user bubble, the summary reader used it as the title, and the client fallback
did not recognize it as session setup. This was a fresh parse, not a stale
summary-index result. YA metadata already held the correct `initialPrompt`.

The defect appears intermittent because Codex composes only the contextual
fragments available for a given project. A project with `AGENTS.md` exercised
the previously covered shape; a project without it exposed a different
adjacency.

## Upstream Codex Receipts

The investigation used the local `references/codex` checkout at the exact
declared target tag and commit:

```text
tag:    rust-v0.144.1
commit: 44918ea10c0f99151c6710411b4322c2f5c96bea
```

`references/` is optional and gitignored. On a fresh checkout, run
`pnpm clone-references` before following these source coordinates.

### 1. Initial context is assembled from optional fragments

`codex-rs/core/src/session/mod.rs`,
`Session::build_initial_context_with_world_state_and_mcp`:

- creates `contextual_user_sections`;
- pushes rendered recommended-plugin instructions when candidates exist;
- appends user-role fragments from full world state, including optional
  `AGENTS.md` instructions and environment context;
- calls `build_contextual_user_message(contextual_user_sections)`.

Relevant source neighborhoods at `rust-v0.144.1` are approximately lines
3197-3205, 3349-3354, 3441-3446, and 3478-3481.

`codex-rs/core/src/context_manager/updates.rs`, `build_text_message`, maps each
section to its own `ContentItem::InputText` block. Codex does not concatenate
the fragments before persisting them. The block boundary is therefore useful
provider structure that YA currently throws away while classifying.

### 2. Codex has a first-class contextual-fragment registry

`codex-rs/context-fragments/src/fragment.rs` defines
`ContextualUserFragment`. Marked fragments own opening and closing markers;
`matches_marked_text` trims surrounding whitespace and requires both markers,
case-insensitively.

`codex-rs/core/src/context/contextual_user_message.rs` registers contextual
user fragment types, including:

- user/`AGENTS.md` instructions;
- environment context;
- additional context and skill injections;
- turn-aborted and subagent notifications;
- internal model context;
- recommended plugins;
- legacy internal warnings.

This is the upstream abstraction YA was approximating with whole-message
regular expressions.

### 3. Contextual response messages are not user turns

`codex-rs/core/src/event_mapping.rs`:

- `is_contextual_user_message_content` checks the message's individual content
  items against the contextual-fragment registry;
- `parse_user_message` returns `None` for contextual content;
- `parse_turn_item` therefore does not produce `TurnItem::UserMessage` for
  ordinary injected context. Hook prompts are recognized separately as
  `TurnItem::HookPrompt`.

The response role is needed for model-input semantics. It is deliberately not
the UI authorship contract.

### 4. Accepted human input emits a separate user-turn event

`codex-rs/core/src/hook_runtime.rs`, `record_pending_input`, routes accepted
`TurnInput::UserInput` to
`Session::record_user_prompt_and_emit_turn_item`.

`codex-rs/core/src/session/mod.rs`, that method:

1. converts the input to a response item and persists it;
2. constructs `TurnItem::UserMessage` from the original `UserInput`;
3. emits started/completed turn-item lifecycle events.

The response item remains the richer model/history payload. The turn item
carries UI provenance, including `client_id` and UI text elements that a
response item cannot carry.

`codex-rs/protocol/src/legacy_events.rs`, `TurnItem::as_legacy_events`, maps a
`TurnItem::UserMessage` to `EventMsg::UserMessage`; a `HookPrompt` intentionally
does not become that legacy user event.

For the target rollout format, this produces the stable adjacent pair:

```text
response_item(role=user) -> event_msg(type=user_message)
```

### 5. Codex itself uses the event as user-turn authority

`codex-rs/core/src/session/rollout_reconstruction.rs` marks a replay segment as
`counts_as_user_turn` only when it sees `EventMsg::UserMessage`. The adjacent
comment says that only a real user-message event should make the segment count
as a user turn.

This is the strongest receipt for YA's intended interpretation: the event is
not merely a duplicate display string. It is Codex's persisted authorship
boundary.

## Local Rollout Evidence

The investigation performed read-only scans over the local plain-JSONL Codex
corpus under `~/.codex/sessions`:

- 1,370 rollout files;
- 13,273 persisted `event_msg/user_message` entries;
- every one was immediately preceded by a user-role response message;
- no user event lacked the adjacent rich response item.

There were 3,282 unpaired user-role response messages. Their first-fragment
categories were:

| Count | Unpaired response category |
| ---: | --- |
| 1,949 | `# AGENTS.md instructions...` |
| 1,226 | `<environment_context>...` |
| 61 | `<turn_aborted>...` |
| 32 | `<recommended_plugins>...` |
| 7 | legacy internal `apply_patch` warnings |
| 7 | `<subagent_notification>...` |

No unpaired item in this corpus was evidence of a human-authored prompt. One
user event's text was not exactly equal to the concatenated response text
because the response also contained image-label and image blocks; adjacency
still paired it correctly. That is why the event should establish provenance
while the response item remains the rendering source.

This corpus is supporting evidence, not a protocol guarantee. The source
receipts above establish the intended current behavior; the audit catches
local exceptions and future drift.

## Current YA Mismatch

YA currently makes a global source choice:

- if any user-role response item exists, normalize response items and suppress
  all `event_msg/user_message` rows as duplicates;
- otherwise use event-message user rows.

The response source is useful for rich content, but the global gate discards
the provenance carried by the event. Afterward YA tries to recover provenance
from concatenated text:

- `packages/server/src/sessions/normalization.ts` has startup and
  turn-aborted text classifiers;
- `packages/server/src/sessions/codex-reader.ts` independently filters title
  candidates and counts all response-role user messages;
- `packages/shared/src/transcript/messageProjection.ts`,
  `SessionPage.tsx`, and public-share helpers contain additional setup-prefix
  fallbacks.

This creates three kinds of drift:

1. **Composition drift** — optional upstream fragments produce unenumerated
   combinations such as plugins + environment.
2. **Surface drift** — transcript, title, count, share, and client fallback can
   disagree.
3. **Version drift** — every new upstream contextual fragment can require a
   new YA regex even when Codex's lifecycle contract has not changed.

The mixed response/event summary rules documented in
`docs/tactical/038-codex-session-index-memory.md` preserve the current
implementation, not the desired semantic contract. Update that document when
the provenance classifier lands.

## Proposed Classification Contract

Build one server-owned Codex user-turn provenance pass over rollout entries.
It should classify a user-role response item as one of:

- **user-authored** — paired with the immediately following persisted
  `event_msg/user_message` through Codex 0.150 or the equivalent typed
  `event_msg/item_completed(UserMessage)` event from Codex 0.151;
- **visible provider context** — a provider item with a specific first-party
  display contract, such as a hook prompt;
- **hidden/setup provider context** — an unpaired response item that Codex
  treats as contextual model input;
- **legacy/unknown** — a rollout without current lifecycle evidence where YA
  cannot safely apply the current-version invariant.

For a user-authored pair:

- render content and images from the response item;
- retain event fields as provenance/correlation metadata;
- use the event's user-turn identity where useful, especially `client_id`;
- consume the event as the paired witness rather than rendering a duplicate.

For legacy/unknown data, fail compatibly. A rollout with no user-turn events at
all must not have all response-role user messages silently erased. Use exact
per-block contextual markers as the fallback, preserve unrecognized legacy
messages, and record audit/debug evidence for unresolved cases.

Do not classify by loose prefix alone. If a human literally submits
`<environment_context>...</environment_context>`, Codex's accepted-input path
still emits a user-message event; structural provenance correctly preserves
it as authored.

### Append-tail behavior

Codex persists the response item before its user event. A file watcher can
observe the file between those two appends. The classifier must tolerate a
trailing, temporarily unpaired user response:

- do not commit it as a provider-context title merely because its witness has
  not arrived yet;
- allow the next append parse to resolve the pair;
- keep the existing optimistic/live user echo authoritative while the active
  session is in that small durable-write gap;
- use YA's persisted `initialPrompt` as a first-turn recovery/title hint for
  YA-originated sessions, not as a substitute transcript for arbitrary
  provider history.

No polling or recurring retry loop is needed; ordinary file append events and
the existing parse path provide the resolution edge.

## Cleanup And Improvement Plan

### Slice 1 — Canonical durable provenance classifier (landed 2026-07-10)

Goal: fix the reported transcript/title defect and establish one semantic
classifier without broad client or id-reconciliation work.

1. Add a focused server module for Codex user-turn provenance over parsed
   rollout entries. Keep response/event pairing and compatibility fallback in
   that module.
2. Make durable normalization render only paired user-authored response items
   as normal user prompts. Continue using their rich response content.
3. Make Codex title extraction choose the first paired real user turn.
4. Make Codex message counting count real user turns rather than every
   user-role response item.
5. Preserve known special provider items such as hook prompts behind an
   explicit classification result rather than letting them look user-authored.
6. Keep the session-summary index version unchanged. New or modified sessions
   use the corrected interpretation immediately; unchanged cached titles and
   counts correct gradually rather than forcing a costly global cache rebuild.
7. Add exact regression fixtures for:
   - plugins + environment with no `AGENTS.md`;
   - plugins + AGENTS + environment;
   - a genuine paired prompt whose literal text resembles a contextual tag;
   - a paired prompt with image blocks whose event text is not equal to the
     concatenated response text;
   - a temporarily trailing response before its event witness;
   - a legacy no-event rollout and an unpaired turn-aborted item.
8. Update `injected-message-visibility.md` and the summary-parser tactical
   notes with the provenance contract.

This slice should not change live provider protocol handling, approximate
stream/durable dedup, or client rendering architecture.

### Mandatory local verification for Slice 1

Before considering the classifier complete, run a read-only audit over local
sessions and report the totals and every exception. The audit should use YA's
actual parser/classifier rather than an unrelated grep approximation.

At minimum it must check:

- every classified real user response has a recognized user-turn witness;
- every `event_msg/user_message` is paired exactly once;
- the classified first real turn agrees with the event-derived title across
  the corpus;
- classified user-turn count agrees with user-event count for current-format
  rollouts;
- unpaired/unknown response items are grouped by provider version, originator,
  content-block types, and safe marker/prefix preview;
- the reported session yields the actual prompt as title and first visible
  user turn;
- before/after normalization diffs do not remove any paired user turn.

The audit must print exceptions and representative file/session ids rather
than turning unexpected rows into an ignored count. Include compressed
rollouts when the active Node runtime and YA reader can inspect them; otherwise
state the skipped representation count explicitly.

Slice 1 added `scripts/audit-codex-user-turn-provenance.ts`, exposed as
`pnpm codex:user-turns:audit`. Its 2026-07-10 run over the complete local
corpus reported:

| Check | Result |
| --- | ---: |
| Plain rollouts parsed | 1,374 |
| Compressed rollouts skipped | 0 |
| Parsed entries | 1,907,317 |
| Malformed lines | 0 |
| User-message events | 13,300 |
| Paired/authored responses | 13,300 |
| Hidden provider-context responses | 3,288 |
| Legacy/unknown responses | 0 |
| Normalized visible user turns | 13,300 |
| Normalized turns carrying provenance | 13,300 |
| Exceptions | 0 |

The reported session had eight classified user turns. Both its first classified
turn and its first normalized visible user turn were the actual repository/MVP
prompt, not the recommended-plugin list or environment context. The audit also
grouped every unpaired response by CLI version, originator, content-block
types, and a safe marker preview; the groups were recognized provider context
such as environment, `AGENTS.md`, recommended plugins, abort notifications,
subagent notifications, and legacy warnings.

### Slice 2 — Remove duplicated downstream heuristics (landed 2026-07-10)

After the server classifier landed:

1. Route public-share prompt selection, fork/source user-turn slicing, and
   other server consumers through the same provenance result.
2. Reduce client setup regexes to a compatibility fallback for older servers
   or already-materialized historical rows.
3. Centralize any remaining client fallback predicate and cover it with the
   same provider shapes.
4. Remove or narrow obsolete whole-message startup regexes only after tests
   prove no compatibility surface still relies on them.

Slice 2 carries the server result explicitly on every emitted Codex user turn
as `codexUserTurnProvenance` (`paired`, `event-only`, or `legacy-response`).
Downstream clients therefore never need to infer authorship from the prompt
text when current server evidence exists.

Public-share prompt selection now prefers server-owned `initialPrompt`, the
already-normalized transcript, and the provenance-derived `fullTitle`; it no
longer applies a second server-side setup-prefix classifier. Fork/source
selection and recent-user-turn pagination operate on normalized messages and
also reject explicit provider-synthetic rows.

All remaining client setup recognition routes through
`lib/codexLegacySetup.ts`. That compatibility predicate:

- runs only when no server user-turn provenance or live SDK source is present;
- requires the entire text to consist of complete first-party Codex setup
  blocks, including closing markers;
- recognizes plugins + environment with or without an `AGENTS.md` fragment;
- is shared by transcript preprocessing, navigation/search/correction,
  fork-from-initial-turn selection, and public-share prompt selection.

This preserves old materialized transcripts while ensuring a paired human
prompt that literally resembles `<environment_context>` remains an ordinary
user turn on every current surface.

### Slice 3 — Durable user ids (landed 2026-08-24)

YA sends the queue message uuid as `clientUserMessageId` on `turn/start` and
`turn/steer`. Codex persists it as `user_message.client_id` through 0.150 and
as the nested `item_completed.item.client_id` on a typed `UserMessage` from
0.151. The provenance classifier recognizes both witnesses, and the paired
rich response-item message uses that client id as its durable uuid. Historical
rows fall back to the response-item id and then their JSONL position.

The typed witness can arrive in a later file append than its response item.
The incremental normalizer reprocesses that trailing response when the witness
appears, so an active-turn steer converges on the optimistic queue uuid without
content- or timestamp-based matching.

This makes optimistic, live, replayed, and durable user turns converge by
identity without treating equal content or nearby timestamps as evidence of a
duplicate. An older server can leave two visible copies, which is safer than
erasing a real repeated turn.

Visibility and title correctness do not depend on changing reconciliation
identity.

### Slice 4 — Typed provider-context visibility (not planned)

Codex distinguishes hidden contextual fragments from visible hook prompts and
may add more typed context surfaces. YA previously presented setup context in
an auto-collapsed `Session setup` section; current server-classified context is
hidden instead. The collapsed path remains only as compatibility handling for
old, unprovenanced transcripts.

There is no current product requirement to restore a setup/debug surface, so
this slice is not planned. Reconsider it only in response to a concrete need
for inspecting effective provider context; it is not part of the completed
authorship fix.

## Slice 1 Implementation Result

Slice 1 implemented **server-side durable provenance classification for
transcript normalization, title extraction, and message counting, plus the
local-corpus audit**.

It is the smallest slice that fixes both symptoms in the reported session
without leaving the header and transcript on different definitions of “first
user prompt.” It also produces evidence before behavior is generalized. No
additional implementation slice is required to complete this workstream.

## Acceptance Criteria

- The reported session's first visible user turn and automatic title are the
  actual prompt, not recommended plugins or environment context.
- Projects with and without `AGENTS.md` behave identically at the authorship
  boundary.
- A genuine prompt containing context-like literal text remains visible when
  paired with Codex's user-turn event.
- Rich response content, including images, is retained for real user turns.
- Session `messageCount` no longer includes hidden contextual user-role
  response items.
- New and modified sessions use corrected titles and counts without
  proactively invalidating unchanged persisted summaries.
- Focused tests pass without warnings.
- The local audit reports corpus totals, compressed-rollout coverage, and zero
  unexplained loss of paired user turns; any exceptions are documented before
  landing.
- `pnpm lint`, relevant server tests, typecheck, and the Codex session-data
  validation path complete without warnings.

## Non-Goals

- Do not replace provider-owned Codex rollouts with a YA shadow transcript.
- Do not make prompt-text equality the primary response/event correlation;
  image-bearing prompts prove the strings can differ legitimately.
- Do not broaden the first slice into live-stream id reconciliation or the
  session-detail data-layer refactor.
- Do not hide all user-role response items in rollouts lacking current Codex
  lifecycle evidence.
- Do not add polling or watcher work beyond the existing append-driven parse
  path.

## Slice 1 Decisions

- Current-format unpaired provider context is hidden. Restoring a
  typed/collapsed setup presentation is not planned.
- The presence of any persisted user-message event enables strict pair
  authority for that rollout. A rollout with none retains exact-marker
  filtering plus a compatibility-preserving legacy/unknown path.
- A trailing unpaired response is omitted from the durable snapshot until the
  normal append/reparse edge supplies its witness. No polling was added.
- The audit is a committed maintenance command so provider refreshes can rerun
  the same parser, classifier, normalization, and exception checks.
