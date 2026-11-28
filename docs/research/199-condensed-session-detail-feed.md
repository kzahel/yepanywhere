# Research 199: Condensed Session Detail Feed for Conversation View

**Date:** 2026-11-28
**Status:** Revised after adversarial review (Claude Fable 5.2 session `d68e42cd-0691-4df9-8ea5-34b39e883e9e`)
**Related:** [Tactical Plan 199](../tactical/199-condensed-session-detail-feed.md), [Conversation View](../../topics/conversation-view.md), [Server Capabilities](../../topics/server-capabilities.md), [Simple Client API](../../topics/simple-client-api.md)

## Problem Statement

Conversation View (with the **"Show full activity transcript"** toggle off) is the default reading mode for `SessionPage` ([`topics/conversation-view.md`](../../topics/conversation-view.md)). In Conversation View, routine tool activity and intermediate thinking blocks are collapsed per turn into a single compact summary line (`4m · 17 activities hidden`), leaving user prompts, assistant prose, surfaced errors/incomplete calls, plan updates, user questions, media-bearing tool results, commentary-bearing tool calls, workflow-tagged calls, MCP App tool calls, and at most two thinking previews in the latest active turn.

Today, that filtering happens **exclusively on the client** inside `projectConversationView()` ([`packages/client/src/lib/sessionDetail/conversationView.ts`](../../packages/client/src/lib/sessionDetail/conversationView.ts)). For every session load, reload, and older-page fetch, the server still:

1. Reads, normalizes, and clones (`detachSessionMessageProjection`, `structuredClone` in `normalization.ts:413`) every message in the active window, including full `tool_use` inputs and `tool_result` stdout/file bodies.
2. Runs `augmentPersistedSessionMessages()` ([`packages/server/src/sessions/persisted-augments.ts`](../../packages/server/src/sessions/persisted-augments.ts)) and `augmentFinalizedMessage()` ([`packages/server/src/augments/finalized-message-augmenter.ts`](../../packages/server/src/augments/finalized-message-augmenter.ts)) on **every** routine hidden message:
   - Shiki syntax-highlighted unified diffs (`_editHtml`) for every `Edit` tool call,
   - Shiki file highlighting for `Read`/`Write` tool calls,
   - `augmentProjectPathLinksInMessage()` scanning and path-index probing every `Bash` command, tool argument, and tool-result string,
   - Markdown HTML rendering (`_html`) for assistant text.
3. Ships the entire megabyte-scale JSON payload over localhost, LAN, or relay to the browser (including mobile phones over relay).
4. Forces the client to parse JSON, store all raw messages and heavy bodies in `SessionDetailCache`, compile every message into `RenderItem[]` via `compileTranscriptProjection()`, and then hide 80–95% of the content inside `projectConversationView()`.

## Live Measurements

Measured on `localhost:3400` (clean warm server, PID `87166`) using the default client session-detail query (`tailCompactions=2&tailTurns=20`):

### Current Payload & Server CPU Breakdown

| Session | Provider | Window Msgs | Full Wire (Raw / Gzip) | Assistant Prose | Thinking | Tool Use + Result | Edit Diff HTML | Path Links | Errors / Media | Server `readMs` / `augmentMs` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `7a60de38` | Antigravity | 290 | **824 KB** / 194 KB | 17 KB (17 blocks, 2.1%) | 17 KB (31 blocks) | **657 KB** (80%, 118 calls: 55 `read_file`, 34 `run_command`, 21 `edit_file`) | 0 KB | 55 KB | 0 / 0 | 18 ms / **216 ms** (warm reload) |
| `94699e38` | Antigravity | 371 | **1,154 KB** / 266 KB | ~25 KB (~2%) | ~20 KB | **~1,000 KB** (~87%, 61 `run_command`, 55 `read_file`, 11 `update_steps`, 9 `schedule`) | 0 KB | 120 KB | 0 / 0 | 24 ms / ~160 ms |
| `dd1d2a23` | Codex | 3,109 | **7,236 KB** / 1,022 KB | 60 KB (96 blocks, 0.8%) | 45 KB (617 blocks) | **5,200+ KB** (85%, 513 `Bash`, 400 `sleep`, 117 `Exec`, 37 `Edit`, 18 `WriteStdin`) | **871 KB** (37 edits) | 97 KB | 6 / 0 | 187 ms / **631 ms** |

### Empirical Wire-Size Comparison: Option A vs Option B (Raw and Gzip)

Simulated directly on the live JSON payloads returned by `localhost:3400` for the same three sessions:

- **Option A (Heavy-body stripping, keep all message envelopes):** Keep every canonical message envelope, ID, structure, compact tool-use summary/fold keys (`path`, `command[:160]`, `session_id`, etc.), errors, media, and recent thinking; strip large routine `tool_use` inputs, large routine `tool_result` bodies, historical thinking text, and per-message tool augments (`_editHtml`, `_fileHtml`, `_projectPathLinks`).
- **Option B (Per-turn collapsed stubs):** Replace each contiguous hidden run with a single ~500 B summary stub while keeping visible prose, errors, and the tail.

| Session | Msgs | Full (Raw / Gzip) | Option A (Raw / Gzip) | Option A Savings (Raw / Gzip) | Option B (Raw / Gzip) | Option B Savings (Raw / Gzip) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `7a60de38` | 290 | 824 KB / 194 KB | 272 KB / **31 KB** | 67.0% / **84.0%** | 33 KB / **7 KB** (19 msgs) | 96.0% / **96.4%** |
| `94699e38` | 371 | 1,154 KB / 266 KB | 481 KB / **61 KB** | 58.3% / **77.1%** | 34 KB / **6 KB** (13 msgs) | 97.0% / **97.6%** |
| `dd1d2a23` | 3,109 | 7,236 KB / 1,022 KB | 1,726 KB / **200 KB** | 76.2% / **80.4%** | 177 KB / **28 KB** (230 msgs) | 97.6% / **97.2%** |

### Key Observations

1. **Option A captures ~80% of gzipped wire savings AND the full ~85–90% server `augmentMs` savings — without changing message identities.**
   - JSON message envelopes compress extremely well under gzip because UUIDs, roles, and wrapper keys are repetitive. On `dd1d2a23` (3,109 messages), gzipped wire size drops from **1,022 KB → 200 KB (80.4%)**; on `7a60de38`, **194 KB → 31 KB (84.0%)**.
   - Both Option A and Option B skip the exact same hidden Shiki diffs (`871 KB` on `dd1d2a23`), file highlighting, and `ProjectPathIndex` path-link scanning (`631 ms` → ~50–80 ms on `dd1d2a23`, `216 ms` → ~15–30 ms on `7a60de38`).
2. **Option B achieves an additional ~12–17% gzipped wire reduction (200 KB → 28 KB on `dd1d2a23`) and shrinks client compile input (`3,109` → ~230 objects),** but introduces deep architectural invariants around stream-to-persisted dedupe, cursor signaling, client-only display state, shell-folding seams, and display-object anchors (detailed below).
3. **Read and normalization cost (`readMs`, e.g., 187 ms on `dd1d2a23`) is untouched by response filtering.**
   - That bottleneck is owned by the companion provider-history acquisition work documented in [`gaps/conversation-window-acquisition-cost.md`](../../gaps/conversation-window-acquisition-cost.md) and [`gaps/v0-conversation-unavailable-for-long-claude-session.md`](../../gaps/v0-conversation-unavailable-for-long-claude-session.md).
4. **Server `augmentMs` is still high on warm reloads.**
   - Even on an immediate warm reload of `7a60de38`, `ya-augment` took `216 ms` (`changed=68`, `cache-hit=5`, `cache-miss=5`). Tool augments (`_editHtml`, `_projectPathLinks`) are not backed by `markdown-augments.ts`'s single-flight cache, and `markdownCacheKey()` keys on callback identity (`fileExistsIdentity`) and `index.sourceRevision()`.

## Current Pipeline Audit

### Server Read Path (`packages/server/src/routes/session-detail-routes.ts`)

```
GET /api/projects/:projectId/sessions/:sessionId
  1. sessionReader.getSession(...)               // indexed tail slicing (tailCompactions, tailTurns, beforeMessageId, afterMessageId)
  2. pagination & orphan marking                 // paginationInfo built only when afterMessageId absent or anchor missed (:962-997, :1048-1055)
                                                 // orphan incomplete marking only when wasEverOwned && !process (:603)
  3. toolResultMediaStore.materializeMessages()  // :1093 (skipped for public shares)
  4. detachSessionMessageProjection(messages)    // structuredClone of whole window (normalization.ts:413)
  5. augmentPersistedSessionMessages(messages)   // citation-sources over full list (:162-170), basename alias seeds (recentProjectPathLinks.ts:37-51),
                                                 // markdown HTML, Shiki Edit/Read/Write, ProjectPathLinks
  6. overlay messages merged after augmentation  // :1148-1181
  7. JSON response { session, messages, pagination?, ... }
```

### Live Stream Path (`packages/server/src/subscriptions.ts` + `packages/client/src/hooks/useSessionStream.ts`)

- The client sends subscription hints (`wantsLiveDeltas`, `wantsLiveToolOutput`) in `useSessionStream.ts:70-122`.
- In `subscriptions.ts:176-222`, finalized-message augmentation is already **per subscription** (not shared across all subscribers).
- When a client subscribes, the server replays its 15–30 s live buffer (`subscriptions.ts:585-620`, `Process.ts:3138-3160`).
- Note: when a `tool_use` message finalizes on the live stream, its `tool_result` has not yet arrived, so error status is not known until the later `tool_result` arrives.

### Client Projection Path (`packages/client/src/lib/sessionDetail/` & `packages/client/src/components/MessageList.tsx`)

```
GetSessionResult { messages, pagination? }
  → SessionDetailCoordinator & transcriptReducer:
       • merges SDK stream rows with persisted rows (mergeJSONLMessages, pruneSupersededSdkSiblings, maybeReconcileApprox)
       • replayCoveredByPersisted checks exact persisted ID (Codex/Antigravity) or timestamp watermark
       • presence of pagination on an afterMessageId catch-up triggers replaceTailWindow (:609-625)
       • trimLoadedWindow recomputes returnedMessageCount from messages.length (:239) and prunes agentContent (:127-177)
  → compileTranscriptProjection(messages)        // browser-free, packages/shared/src/transcript/
  → buildSessionDetailRenderItems / getDisplayRenderItems (MessageList.tsx:2093-2100):
       • insertTranscriptDisplayObjects (requires loaded anchor message ID, transcriptDisplayObjects.ts:35-50)
       • rewoundGroupId grouping (reads sourceMessages[].rewoundGroupId)
       • claude-gateway "Thinking..." drop (renderItems.ts)
       • thinking toggle strips thinking items BEFORE Conversation View projection
  → projectConversationView(items, options)      // conversationView.ts (emits one ConversationActivityItem per turn group)
       • ConversationActivityItem type lives in packages/shared/src/transcript/items.ts:156-191
       • thinkingPreviews (array, up to 2 slots) depends on global lastCompleteThinkingId, dismissed slots, and last-group status
       • recentActivities / tooltipActivities use toolRegistry.prepare & getToolSummary (inside ~28 .tsx renderer files; summaries.ts:44-82 reads tool results too)
       • toolDeclaresCommentary (toolCommentarySource.ts:6-7) imports prepareDisplay & bashResult from client
  → MessageList.tsx (view mode is currently local useState at :1434-1438; SessionPage also reads raw messages for right pane/speech vocab at :684-745 and activity projection at :1373)
```

### Public Shares Are a Separate Path

Public share viewers do **not** read through `GET /api/projects/:projectId/sessions/:sessionId`: they read stored, integrity-witnessed frozen chunks via `/api/public-shares/:secret/session-chunks` (`public-shares.ts:1703`). Only share capture and live reads call the session-detail route internally (`public-share-mounting.ts:121`), and public shares already skip path-link augmentation and media materialization (`session-detail-routes.ts:1093, 1121`). Frozen shares also have no backing server to hydrate stripped/condensed turns on demand, and share representations require a scoped capability (`topics/server-capabilities.md:447-450`). **Public shares should therefore stay out of scope for initial condensed-feed work.**

## Why Not Reuse `experimental/conversation` Directly?

`packages/server/src/experimental/conversation-projection.ts` (`topics/simple-client-api.md`) is not a drop-in replacement for `SessionPage`:

| Capability | `GET /sessions/:id` (`SessionPage` pipeline) | `experimental/conversation` |
| --- | --- | --- |
| Large-session indexed windowing (`tailCompactions`, `tailTurns`, `beforeMessageId`, `afterMessageId`) | Mature, indexed JSONL tail reads | Hard intake ceiling: **10,000 records / 8 MiB** (`conversation-projection.ts:34-35`; see `gaps/v0-conversation-unavailable-for-long-claude-session.md`) |
| Per-turn expand & full-transcript toggle | Supported in `SessionDetailCoordinator` | Incompatible `ConversationItem[]` schema; no raw messages |
| Tool commentary, MCP Apps, workflow tags, media, quote anchors, rewound groups, display objects | Full parity | Incomplete / missing |
| Route snapshot cache, active-window trimming, warm delta refresh, SDK stream reconciliation | Mature (`SessionDetailCoordinator`) | None |

## Architectural Options Compared

### Option A (Recommended Stage 1): Envelope-Preserving Heavy-Body Stripping + Post-Filter Augmentation (`GET /sessions/:id?view=conversation`)

Keep every canonical `Message` envelope in `messages`, but for completed hidden messages in Conversation View:
- Strip heavy payload fields (`tool_use.input` bulky fields such as `old_string`/`new_string`/`content`/`Content`, `tool_result.content` above a compact threshold, historical `thinking` bodies outside the tail) and tag stripped blocks/messages with an explicit stripped marker (`_bodyStripped: true`).
- Compute full-window metadata **before** stripping (citation sources from `citation-sources.ts:162-170`, project-path basename alias seeds from `recentProjectPathLinks.ts:37-51`, error/media/commentary/pending classification).
- Run stripping **before** `detachSessionMessageProjection()` (`structuredClone`) and **before** `augmentPersistedSessionMessages()`, skipping Shiki diffs, file highlighting, and per-message `ProjectPathIndex` scanning on stripped hidden messages.
- Retain compact facts needed by existing client projections: canonical IDs, `rewoundGroupId`, display-object anchors, compact tool input keys (filename/path/pattern/short command), small result summary / shell-fold tokens (session/cell IDs, exit codes), and full unstripped payloads for every visible/pending/unpaired/error/media/commentary/plan/question/MCP-app item.
- Hydrate stripped messages on demand via a dedicated hydration route (`POST .../messages/hydrate` or `GET .../messages/range`) when the user expands a single turn's `N activities hidden` row, or refetch `view=full` when toggling **"Show full activity transcript"** ON.

**Why Option A is dramatically cleaner and safer as Stage 1:**
- **Measured 77–84% gzipped wire reduction** (`1,022 KB → 200 KB` on `dd1d2a23`; `194 KB → 31 KB` on `7a60de38`) and the **full 85–90% server `augmentMs` reduction**.
- **Eliminates every hard identity & reconciliation hazard** identified in review:
  - SDK stream-to-persisted dedupe (`mergeJSONLMessages`, `pruneSupersededSdkSiblings`, `maybeReconcileApprox`) and 15–30 s replay suppression (`replayCoveredByPersisted`) stay 100% intact because canonical IDs and timestamps never disappear.
  - `pagination` presence semantics on `afterMessageId` deltas (`sessionDetailCoordinator.ts:609-625`) stay 100% untouched.
  - Client-only display state (`getDisplayRenderItems` thinking toggle, dismissed slots, global `lastCompleteThinkingId`, deterministic `summaryId` across prepends, `ConversationActivityItem` grouping) keeps working with zero server duplication.
  - Display-object anchors (`transcriptDisplayObjects.ts:35-50`), `rewoundGroupId`, `claude-gateway` `"Thinking..."` filtering, `returnedMessageCount` units, `trimLoadedWindow` `agentContent` pruning, and cross-window shell folding all keep working seamlessly.
  - Avoids migrating ~28 React `.tsx` tool renderers (`renderers/tools/index.tsx`) and `summaries.ts` into `@yep-anywhere/shared`.

### Option B (Optional Stage 2 Only If Measured Needed): Per-Turn Collapsed Fact Stubs

Collapse completed hidden runs (strictly before the newest user turn, never on `afterMessageId` deltas) into synthetic fact-carrying stub messages.

- **Incremental upside over Option A:** Further reduces gzipped wire size on extreme 3,000-message sessions (`200 KB → 28 KB` on `dd1d2a23`) and reduces client `compileTranscriptProjection` / JS heap object count (`3,109 → ~230` objects).
- **Substantial complexity cost:** Requires solving stream-replay suppression, non-`pagination` cursor transport, fact-vs-display stub splitting, rewound-group/display-object anchor splitting, cross-seam shell-folding parity relaxation, `returnedMessageCount` unit separation, and extracting pure tool summaries from ~28 `.tsx` renderers.
- **Decision gate:** Only pursue Stage 2 if profiling after Stage 1 shows client compile/parse time or 200 KB gzipped payloads on 3,000-message sessions remain a user-visible bottleneck.

### Option C (Rejected): Separate v2 Conversation Feed Endpoint

Duplicates pagination, ownership, pending-input, warm-refresh, and coordinator state logic for no benefit over Option A/B.

## Critical Invariants & Related Gaps

Every stage of this design must uphold these codebase-verified invariants:

1. **Structural pending/unpaired invariant (not ownership-based `incomplete`):**
   - `messageProjection.ts:872` marks a tool call `"incomplete"` only for server-marked orphans (`wasEverOwned && !process`, `session-detail-routes.ts:603`). Unfinished calls in active or external sessions and long-running background commands are `"pending"`, which `conversationView.ts:108` hides.
   - **Invariant:** Any `tool_use` without its matching `tool_result` in the same response, and any `tool_result` without its matching `tool_use` in the same response, MUST NEVER be stripped or condensed regardless of ownership. Otherwise a later error result is dropped as an orphan (`messageProjection.ts:939-948`).
2. **Full-window metadata before stripping (`gaps/project-path-basename-alias-pagination-seam.md`):**
   - Prose citations (`citation-sources.ts:162-170`) read hidden `WebSearch` tool results across the full window.
   - Bare-basename file links in prose (`recentProjectPathLinks.ts:37-51`) are seeded from earlier tool calls' path links across the window.
   - **Invariant:** Extract citation sources and basename alias seeds across the full window **before** stripping hidden tool bodies and skipping per-message tool augmentation, so visible prose HTML is identical to full mode.
3. **Media detection & materialization ordering (`gaps/code-mode-forwarded-image-duplication.md`):**
   - Detect raw media blocks before stripping and run `toolResultMediaStore.materializeMessages()` (`session-detail-routes.ts:1093`) on media-bearing messages before final serialization; never strip a tool call whose result contains media.
4. **Clone ordering (`normalization.ts:413`):**
   - `detachSessionMessageProjection()` performs `structuredClone` over the entire window. Stripping must run **before** (or replace) cloning multi-megabyte hidden bodies so server CPU and GC pressure actually drop.
5. **Shell-folding & commentary preservation (`gaps/conversation-view-zero-match-grep.md`):**
   - `enrichWriteStdinWithCommand`, `coalesceDetachedPollContinuations`, `hideContextFreeEmptyShellPolls`, and `annotateBackgroundCommands` (`shellFolding.ts`) inspect shell session/cell IDs, commands, and exit/status cues in tool results.
   - `toolDeclaresCommentary` (`toolCommentarySource.ts`) inspects code-mode / `acli` commentary markers in tool outputs.
   - **Invariant:** Classify commentary-bearing tool calls before stripping (never strip them), and for stripped routine shell calls retain the compact fold tokens (or only strip tool results exceeding a size threshold like 1–2 KB while preserving fold-relevant header/footer metadata).
6. **View mode in the data layer & cache keying:**
   - Currently Conversation View toggle state is local `useState` inside `MessageList.tsx:1434-1438`, invisible to `useSessionMessages.ts`.
   - Lifting the view preference into the data layer and making `view: "full" | "conversation"` part of `SessionDetailKey` (`sessionDetailKey.ts:3-10`, alongside `tailTurns`/`tailFrom`) prevents stale condensed snapshots from leaking into Full Transcript mode and avoids mutating snapshots in place.
   - **Honest UX trade-off (`topics/conversation-view.md:103-108`):** Expanding a stripped turn or toggling Full Transcript ON becomes network-dependent (with an inline loading state while hydrating), whereas today both are offline/instant from the first painted frame. Once hydrated, collapse/re-expand and toggling back to Conversation View remain instant locally.
7. **Other raw-message consumers to audit:**
   - `trimLoadedWindow.ts:127-177, 279-298` (`agentContent` pruning by scanning retained messages) — stays intact under Option A because envelopes and subagent tool-use references remain.
   - `SessionPage.tsx:684-745` (right pane / speech vocabulary) and `SessionPage.tsx:1373` (activity projection) — verify they tolerate `_bodyStripped` messages gracefully (paths/commands remain available; large bodies are omitted).
   - `useSessionMessages.ts:1622` (older-page search window) — in Conversation View, search already targets projected visible items (`topics/conversation-view.md:135`); full-transcript search triggers full mode.
8. **Related open gaps:**
   - [`gaps/conversation-window-acquisition-cost.md`](../../gaps/conversation-window-acquisition-cost.md) & [`gaps/v0-conversation-unavailable-for-long-claude-session.md`](../../gaps/v0-conversation-unavailable-for-long-claude-session.md) (acquisition-side cost — complementary, not solved by response stripping)
   - [`gaps/project-path-basename-alias-pagination-seam.md`](../../gaps/project-path-basename-alias-pagination-seam.md) (basename alias seeding)
   - [`gaps/conversation-view-zero-match-grep.md`](../../gaps/conversation-view-zero-match-grep.md) (grep/shell classification)
   - [`gaps/conversation-thinking-row-vertical-squirm.md`](../../gaps/conversation-thinking-row-vertical-squirm.md) & [`gaps/long-session-old-content-motion-recurrence.md`](../../gaps/long-session-old-content-motion-recurrence.md) (thinking preview & scroll stability)
   - [`gaps/live-user-turns-missing-until-reload.md`](../../gaps/live-user-turns-missing-until-reload.md) & [`gaps/prose-font-lost-until-reload.md`](../../gaps/prose-font-lost-until-reload.md) (live vs persisted reconciliation)
   - [`gaps/workflow-skill-metadata-activation.md`](../../gaps/workflow-skill-metadata-activation.md) (client-side workflow tag schemas)
