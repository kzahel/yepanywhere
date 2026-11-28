# Tactical Plan 199: Condensed Session Detail Feed for Conversation View

**Date:** 2026-11-28
**Status:** Revised after adversarial review (Claude Fable 5.2 session `d68e42cd-0691-4df9-8ea5-34b39e883e9e`)
**Research:** [Research 199: Condensed Session Detail Feed](../research/199-condensed-session-detail-feed.md)
**Contracts:** [Conversation View](../../topics/conversation-view.md), [Server Capabilities](../../topics/server-capabilities.md), [Remote & Hosted Compatibility](../../topics/remote-hosted-compatibility.md)

## Goal

Eliminate **77–84% of gzipped wire bytes** and **85–90% of server augmentation CPU** when loading sessions in Conversation View ("Show full activity transcript" off), using a staged design that starts with low-risk **envelope-preserving heavy-body stripping (Stage 1)** and gates more invasive **collapsed turn stubs (Stage 2)** on measured post-Stage-1 profiling.

## Strategy Summary (Why Staged)

Measured against three real sessions (`7a60de38`, `94699e38`, `dd1d2a23`):
- **Stage 1 (Envelope-preserving heavy-body stripping + post-filter augmentation)** cuts gzipped transfer by **77–84%** (`1,022 KB → 200 KB` on a 3,109-message Codex session; `194 KB → 31 KB` on `7a60de38`) and eliminates the **exact same 85–90% of server `augmentMs`** (`631 ms → ~50–80 ms`) while keeping every canonical message ID, `rewoundGroupId`, display-object anchor, `afterMessageId` cursor, SDK stream-to-persisted dedupe rule, `returnedMessageCount` unit, and client `projectConversationView()` logic completely intact.
- **Stage 2 (Optional follow-up: collapsed completed-turn fact stubs)** is only pursued if post-Stage-1 measurements show client `compileTranscriptProjection` time or 200 KB gzipped payloads on 3,000-message sessions remain a noticeable bottleneck.

## Non-Goals

- Replacing `SessionPage`'s `Message[]` / `SessionDetailCoordinator` pipeline with `experimental/conversation`.
- Changing what rows Conversation View surfaces (visible prose, errors, media, commentary, plan updates, user questions, MCP Apps, and thinking previews must match `topics/conversation-view.md`; if Stage 2 is later implemented, minor count/label differences at page-prepend seams are explicitly acceptable and covered by seam tests).
- Changing public shares (frozen integrity-witnessed chunks at `/api/public-shares/:secret/session-chunks` already skip path links/media and have no hydration server; excluded from Stages 1–2).
- Supporting condensed mode when `workflowTagsEnabled` is enabled on the client (safe fallback to `view=full`).
- Solving provider-reader acquisition time (`readMs`, e.g., 187 ms on Codex), which belongs to [`gaps/conversation-window-acquisition-cost.md`](../../gaps/conversation-window-acquisition-cost.md).
- Altering on-disk JSONL formats or provider readers.

## Compatibility Review

Per [`topics/server-capabilities.md`](../../topics/server-capabilities.md) and [`scripts/capability-releases.json`](../../scripts/capability-releases.json):

- **Supported compatibility baseline:** `0.8.0` through current releases (`0.8.x`, `0.9.x`, `0.10.0–0.10.2`, `0.11.0`, and pre-change source builds, including hosted relays and older desktop/remote servers).
- **Capability registration:**
  - Allocate a new permanent server capability in [`packages/shared/src/capability-ids.ts`](../../packages/shared/src/capability-ids.ts) (`condensedSessionDetail`, `name: "condensed-session-detail"`, `direction: "server"` — do not hardcode the numeric ID in prose).
  - Register it in [`packages/shared/src/server-capabilities-sessions.ts`](../../packages/shared/src/server-capabilities-sessions.ts) with:
    - `advertisement: { kind: "version-implied" }` (default for fixed server features per `topics/server-capabilities.md`, accompanied by a `sourceIntroductions` entry in `scripts/capability-releases.json`; switch to `optional-bit` only if runtime feature-flagging is required during rollout),
    - `kind: "transitional"`,
    - `serverContract` declaring:
      - `GET /api/projects/:projectId/sessions/:sessionId` query field `view` (`"full" | "conversation"`),
      - Dedicated hydration route `POST /api/projects/:projectId/sessions/:sessionId/messages/hydrate` (request `{ messageIds: string[] }` or `{ fromMessageId, toMessageId }`; separate route so any older server returns `404` instead of silently ignoring query params and returning a tail window),
      - Response fields: `view` (`"full" | "conversation"`) on the detail response and `_bodyStripped?: true` on stripped blocks/messages.
- **Absent-support fallback:** When `hasServerCapability(serverCapabilities, "condensedSessionDetail")` is false (or not yet known before handshake), the client sends the existing `GET /api/projects/:projectId/sessions/:sessionId` request with no `view=conversation` parameter and never calls `/messages/hydrate`.
- **Older clients talking to newer servers:** `view` defaults to `"full"`, so existing clients receive the unchanged full response.
- **Dropped parameter:** Do **not** add an `mcpAppViews` query parameter — always treat `mcpApp`-bearing tool calls as visible/unstripped (they are rare and small).

## Stage 1 Wire Contract (Envelope-Preserving Heavy-Body Stripping)

### Request (`GET /api/projects/:projectId/sessions/:sessionId`)

- `view=conversation` (optional; default `"full"`): Allowed on initial loads and `beforeMessageId` older-page loads. **Not** requested on `afterMessageId` incremental deltas (deltas are already small and lack pre-anchor pairing context).

### Response Behavior in `view=conversation`

1. **Every canonical `Message` envelope remains in `messages` in original order** with its exact canonical `id`/`uuid`, `parentUuid`, `timestamp`, `type`, `rewoundGroupId`, `tool_use.id`, `tool_use.name`, and `tool_result.tool_use_id`.
2. **Never stripped (kept at 100% full fidelity + full augmentation):**
   - All `user` prompts, `session_setup`, `system` (non-`subagent_activity`), and any message containing assistant `text` prose.
   - Any `tool_use` or `tool_result` where **any** of the following hold:
     - **Unpaired / pending structural invariant:** `tool_use` has no matching `tool_result` in the same response, OR `tool_result` has no matching `tool_use` in the same response (regardless of session ownership — protects `"pending"` calls and background commands across turns so later errors never become dropped orphans).
     - `is_error === true` or failed/errored `task_notification`.
     - Canonical tool is `UpdatePlan` or `AskUserQuestion` (across Claude, Codex, Antigravity aliases).
     - Result contains media/images (detected before stripping; materialized by `toolResultMediaStore.materializeMessages()`).
     - Result declares tool commentary (code-mode / `acli` commentary markers).
     - Tool call carries `mcpApp` metadata.
     - Tool call belongs to the active tail (at or after the newest user prompt / active thinking boundary so live thinking previews and active-turn UI need zero special cases).
   - The last 2 thinking blocks in the window (for the 2-slot `thinkingPreviews` array).
3. **Stripped on completed routine hidden messages:**
   - `tool_use.input`: Retain only compact keys needed for `getToolSummary`, shell folding, and right-pane/path indexing (`file_path`, `path`, `Path`, `TargetFile`, `pattern`, `query`, `description`, `subagent_type`, `session_id`, `chars`, `yield_time_ms`, and truncated `command`/`cmd`/`CommandLine` up to 240 chars); drop large bodies (`old_string`, `new_string`, `content`, `Content`, `Replacement`, `Target`, `CodeContent`, etc.) and mark `_bodyStripped: true` on the block/message.
   - `tool_result.content`: If body length exceeds a compact threshold (e.g., 512 bytes) and is not error/media/commentary/pending, replace with a short stripped marker (`_bodyStripped: true`) while preserving compact shell-fold metadata (exit code, session/cell ID, process state) and compact result summary text (e.g., first ~200 chars or pre-extracted 1-line summary for `summaries.ts:44-82` such as match count / line count) so `recentActivities` details and shell folding stay accurate!
   - Historical `thinking` blocks outside the tail: clear large `thinking` text and mark `_bodyStripped: true` (keeping the block envelope so `activityCount`, timestamps, `thinking` toggle filtering, and `summaryId` remain 100% identical).
   - **Skip per-message heavy augments** (`_editHtml`, `_fileHtml`, `_projectPathLinks`, Shiki highlighting) on stripped messages.
4. **Preserve full-window prose fidelity (H4):**
   - Compute `citationSources` (`citation-sources.ts:162-170`) and project-path basename alias seeds (`recentProjectPathLinks.ts:37-51`) over the **full unstripped window** BEFORE stripping, then pass those precomputed sets into `augmentPersistedSessionMessages()` for the surviving unstripped messages. Visible prose HTML (including citations and bare-basename file links) stays byte-for-byte identical to `view=full`.

### Dedicated Hydration Route (`POST /api/projects/:projectId/sessions/:sessionId/messages/hydrate`)

- Request body: `{ messageIds: string[] }` (bounded cap, e.g. max 500 IDs per request; avoids Codex byte-offset cursor mismatches in `session-detail-routes.ts:1009-1027` because the client already has the exact canonical message IDs of the stripped envelopes inside the clicked `ConversationActivityItem`!).
- Server loads the window covering those IDs (reusing the indexed reader + overlay merge from `session-detail-routes.ts:1148-1181`), runs full `toolResultMediaStore.materializeMessages()` + `augmentPersistedSessionMessages()` (with full-window citations/alias seeds if needed) on the requested IDs, and returns `{ messages: Message[], missingIds: string[] }`.
- If `missingIds.length > 0` (e.g., after a session rewind invalidated old IDs), the client falls back cleanly to refreshing the session window.

## Implementation Plan

### 1 — Server Structural Classifier, Full-Window Seed Extraction, and Strip-Before-Clone Pipeline

Implement the pure server-side stripping pass without touching React tool renderers:

- Create [`packages/server/src/sessions/strip-conversation-hidden-bodies.ts`](../../packages/server/src/sessions/strip-conversation-hidden-bodies.ts):
  - Single-pass structural index over the sliced `Message[]` window (no need to run full React renderers; benchmark single-pass vs `compileTranscriptProjection` on `dd1d2a23` to ensure <10 ms synchronous event-loop cost):
    1. Pair `tool_use.id` ↔ `tool_result.tool_use_id` across the window. Mark any unpaired `tool_use` or unpaired `tool_result` as **must-keep** (C2 structural invariant).
    2. Identify always-visible/unstripped messages: user prompts, assistant prose (`text`), system (non-`subagent_activity`), errors (`is_error` / failed `task_notification`), canonical `UpdatePlan`/`AskUserQuestion`, `mcpApp`, raw media blocks, commentary-bearing tool results (extracting the tiny pure `decodeCodeModeOutput` / `initialAcliFormat` check into `packages/shared/src/transcript/` without dragging in `prepareDisplay`/`bashResult` from client), and the active tail (messages at/after the last user turn + last 2 thinking blocks).
    3. Compute full-window `citationSources` (`citation-sources.ts`) and basename alias seeds (`recentProjectPathLinks.ts`) BEFORE stripping (H4).
    4. Clone-and-strip in one pass **before** `detachSessionMessageProjection()` (`normalization.ts:413`), avoiding `structuredClone` of multi-megabyte hidden tool bodies. Retain compact tool-input summary keys, shell-fold cues (session/cell IDs, exit codes), and short result summaries while dropping bulky inputs/outputs and marking `_bodyStripped: true`.
- Update [`packages/server/src/routes/session-detail-routes.ts`](../../packages/server/src/routes/session-detail-routes.ts):
  - Accept `view=conversation` (default `"full"`). Ignore `view=conversation` if `afterMessageId` is set (deltas always return full).
  - Run `toolResultMediaStore.materializeMessages()` only on messages containing raw media blocks (detected in step 2).
  - Pass a `skipAugmentMessageIds` set (or check `_bodyStripped`) into `augmentPersistedSessionMessages()` so Shiki diffs, file highlighting, and per-message `ProjectPathIndex` scanning run **only** on unstripped messages, while still using the precomputed full-window citation sources and basename alias seeds.
- Add `POST /api/projects/:projectId/sessions/:sessionId/messages/hydrate` in `session-detail-routes.ts` (including overlay message merge parity and `missingIds` reporting on rewind).
- Register `condensedSessionDetail` capability in `capability-ids.ts`, `server-capabilities-sessions.ts`, and `scripts/capability-releases.json`.
- **Verification:**
  - Server unit & route integration tests verifying:
    - Exact visible-row and `summaryId` parity between `projectConversationView(compileTranscriptProjection(full))` and `projectConversationView(compileTranscriptProjection(stripped))` across Claude, Codex, and Antigravity fixtures (including zero-match grep, shell folds, background pending commands, unpaired calls, errors, media, commentary, plan updates, user questions, rewound groups, and display-object anchors).
    - Prose HTML parity for citations (`WebSearch` hidden in same window) and bare-basename project path links (`recentProjectPathLinks`).
    - Server `augmentMs` / Shiki diff call count drops proportionally to stripped tool calls.
    - `/messages/hydrate` reproduces full augmented messages byte-for-byte and handles `missingIds` after rewind.

### 2 — Lift View Mode into `SessionDetailKey` and Wire Client Fetching + On-Demand Hydration

Connect the client data layer cleanly to `view=conversation`:

- **Lift view mode out of `MessageList.tsx` (`:1434-1438`):**
  - Expose the active view preference (`"conversation" | "full"`) at the `SessionPage` / `useSessionMessages` boundary so the fetch layer knows the requested view before initial load.
  - Add `view?: "full" | "conversation"` to `SessionDetailKey` (`packages/client/src/lib/sessionDetail/sessionDetailKey.ts:3-10`) alongside `tailTurns`/`tailFrom` (per M1). This isolates `"conversation"` and `"full"` route snapshots cleanly without in-place snapshot mutation or stale-view leakage.
- **Capability-gated request (`useSessionMessages.ts`):**
  - Request `view: "conversation"` on initial load and `beforeMessageId` older pages when:
    1. Conversation View is active (`!showFullActivityTranscript`),
    2. `hasServerCapability(serverCapabilities, "condensedSessionDetail")` is true,
    3. `workflowTagsEnabled` is false.
  - Never pass `view=conversation` on `afterMessageId` warm catch-ups (so deltas remain full and reconcile cleanly with SDK stream rows).
- **Per-turn lazy hydration (`MessageList.tsx` `toggleConversationActivity`):**
  - When the user clicks a `ConversationActivityItem` (`4m · 17 activities hidden`):
    - Collect the canonical source message IDs in that turn group that carry `_bodyStripped: true`.
    - If none are stripped (e.g., already hydrated, active tail, or older server), toggle immediately offline as today.
    - If any are stripped, show an inline loading state on the summary row, call `POST .../messages/hydrate` with those exact IDs, dispatch `mergeHydratedMessages` on `SessionDetailCoordinator` (replacing those messages in-place by canonical ID while preserving order and all other state), and open the group inside `preserveScrollAfterTranscriptHeightChange(..., itemId, true)`.
    - If `missingIds.length > 0` (session rewound), trigger a clean window refresh.
    - Subsequent collapse/re-expand of that turn is instant in memory.
- **Full-transcript toggle ("Show full activity transcript" ON):**
  - Switching view to `"full"` switches to the `"full"` `SessionDetailKey` (hydrating from cache if already loaded, or fetching `view=full` with a non-blocking transition while keeping scroll anchor).
  - Toggling back OFF to Conversation View is instant locally if the `"full"` window is already in memory (or reuses the loaded full messages without refetching).
- **Audit raw-message consumers (`M2`):**
  - Verify `trimLoadedWindow.ts` (`agentContent` pruning), `SessionPage.tsx:684-745` (right pane / speech vocabulary), `SessionPage.tsx:1373` (activity projection), and `useSessionMessages.ts:1622` (older-page search) behave cleanly on `_bodyStripped` messages (in particular, if a user opens full-transcript search while in Conversation View, keep Conversation View search scoped to visible items as documented in `topics/conversation-view.md:135`).
- **Verification:**
  - Coordinator & reducer tests: `afterMessageId` delta after stripped initial load, SDK stream replay dedupe with stripped initial load, older-page prepend in stripped mode, `mergeHydratedMessages` splice + rewind `missingIds` recovery, `SessionDetailKey` isolation between `"conversation"` and `"full"`.
  - Browser E2E tests (Playwright): click `N activities hidden` → verifies hydrated diff/output + scroll anchor stability; toggle "Show full activity transcript" → verifies full augmented diffs; verify sequential typing latency (`topics/ui-testing.md#sequential-typing-latency`) under concurrent updates and hydration.
  - Compatibility test: verify client against a mock server without `condensedSessionDetail` never sends `view=conversation` or calls `/messages/hydrate`.

### 3 — Measure Real-World Performance and Decide on Stage 2 (Optional Collapsed Turn Stubs)

After Stage 1 ships, benchmark on real large Claude, Codex, and Antigravity sessions (`7a60de38`, `94699e38`, `dd1d2a23` and larger):

- Measure end-to-end:
  1. Server `readMs`, `stripMs`, `augmentMs`, and total response latency.
  2. Gzipped and raw wire payload bytes.
  3. Client JSON parse + `compileTranscriptProjection` + first-paint time on desktop and mobile/throttled CPU.
- **Stage 2 Decision Gate:**
  - **Stop at Stage 1** if client parse + compile over 3,000 stripped envelopes is already fast (e.g., <100 ms on mobile) and 100–200 KB gzipped payloads meet our mobile/relay targets.
  - **Proceed to Stage 2 (Collapsed Completed-Turn Fact Stubs)** *only if* client envelope count / `compileTranscriptProjection` time remains a real bottleneck. If pursued, Stage 2 must adhere to these tightened rules from review:
    - Condense **only** completed turns strictly before the newest user turn, on cold loads and `beforeMessageId` older pages — **never** on `afterMessageId` deltas.
    - Stubs carry **mergeable raw facts** (separate tool and thinking counts, first hidden ID with and without thinking, time bounds, last complete thinking ID, newest activity entries, `rewoundGroupId`), NOT pre-rendered display fields or fixed `summaryId`s; stubs never span rewound-group boundaries or cover display-object anchors.
    - Never place `lastSourceMessageId` on `pagination` (preserve `pagination`'s anchor-miss signal in `sessionDetailCoordinator.ts:609-625`); carry source boundaries on the stub or a top-level response field, and separate `returnedEnvelopeCount` from `returnedMessageCount`.
    - Relax exact-parity expectations for counts/labels across page-prepend/delta seams and add explicit cross-seam parity tests.

### 4 — Optional Live Stream Routine-Tool Augment Deferral (Separate Follow-Up)

If profiling shows server CPU spikes during active autonomous runs when viewers are watching in Conversation View:

- Add a per-subscription `deferRoutineToolAugments` preference alongside `wantsLiveToolOutput` (`useSessionStream.ts` → `subscriptions.ts:176-222`, where augmentation is already per-subscription).
- Defer Shiki diffs and `ProjectPathIndex` path-link scanning on finalized routine `tool_use` / `tool_result` events while Conversation View is active, marking deferred messages with `_augmentsDeferred: true`.
- **Late-augment on error (M7):** Because error status is not known when `tool_use` finalizes, if the later `tool_result` arrives with `is_error: true` (or media/commentary), either augment the pair immediately before sending the `tool_result` or have the client call `/messages/hydrate` for that `tool_use` ID.
- On turn expand or Full Transcript toggle, hydrate any `_augmentsDeferred` message IDs via the same `/messages/hydrate` route.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Pending / background `tool_use` stripped before its later errored `tool_result` arrives | Medium | High | Structural unpaired invariant (C2): never strip any `tool_use` without its `tool_result` in the same response, or vice versa, regardless of ownership |
| Visible prose loses citations or bare-basename project path links | Medium | Medium | Compute `citationSources` (`citation-sources.ts`) and basename alias seeds (`recentProjectPathLinks.ts`) over the full window BEFORE stripping (H4) |
| Stripped tool result breaks shell folding or tool summary details | Medium | Medium | Preserve compact shell-fold tokens (`session_id`, exit codes, command prefix) and short result summaries (or only strip bodies >512 B); test against `shellFolding.ts` and `summaries.ts` fixtures |
| Media-bearing tool call accidentally stripped before materialization | Low | High | Detect raw media blocks before stripping and run `toolResultMediaStore.materializeMessages()` on media-bearing messages |
| Toggle to Full Transcript or single-turn expand feels sluggish over relay | Low | Medium | Show immediate non-blocking inline loading state on the summary row; hydrate only the clicked turn's stripped IDs (typically 5–50 KB); keep subsequent expand/collapse and toggle-back instant in memory |
| Synchronous server classification/stripping adds event-loop latency on huge windows | Low | Medium | Single-pass structural classifier + strip-before-`structuredClone` (`detachSessionMessageProjection`); explicitly benchmark `stripMs` on 3,000+ message sessions |
| Older servers ignore `view` or mishandle hydration | Low | High | Gate behind `condensedSessionDetail` capability (`version-implied` + `sourceIntroductions`); use a separate `POST .../messages/hydrate` route so older servers return `404` cleanly |

## Open Decisions for Maintainer Sign-Off

1. **Start with Stage 1 (Option A: envelope-preserving stripping) before deciding on Stage 2 (collapsed stubs)?** *(Strongly recommended: empirical measurements show Stage 1 already cuts gzipped wire size by 77–84% and server `augmentMs` by 85–90%, while avoiding all stream-dedupe, cursor, display-state, and React-registry migration risks.)*
2. **Result-body strip threshold & summary retention:** Should Stage 1 strip routine `tool_result.content` above **512 bytes** (preserving tiny results like exit codes, short grep outputs, and shell-fold tokens intact with zero risk to shell folding), or strip all routine result bodies while retaining explicit extracted fold metadata? *(Plan recommends 512 B threshold — tiny results compress to nearly nothing and preserve shell folding & `summaries.ts` automatically.)*
3. **Capability advertisement kind:** Use `version-implied` (default for fixed features in `topics/server-capabilities.md`) with a `sourceIntroductions` entry, or `optional-bit` behind a server feature flag during initial rollout?
4. **Live stream augment deferral (Step 4):** Defer to a separate follow-up after measuring Stage 1 in production (recommended), or include in the first milestone?
