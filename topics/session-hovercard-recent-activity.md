# Session Hover Card: Recent Activity

> The session hover card (the rich Themed-mode pane used instead of a clipped
> row's ordinary title hint) shows the **opening user request** today. This adds the
> **most recent regular agent turn** as a second excerpt so a glance answers
> "where did this land?", and fires the same card on the all-sessions page
> and its search box — not just the sidebar. Records the content/layout/data
> proposals considered and the choices currently opted into.

Topic: session-hovercard-recent-activity

See also:
[ui-architecture](ui-architecture.md) (share the card and its data at the
render boundary; one component, all surfaces),
[sidebar-session-ordering](sidebar-session-ordering.md) (the rows this card
annotates),
[session-liveness](session-liveness.md) (`activity` = `in-turn` /
`waiting-input`, which gates the phase-2 live tail),
[provider-abstraction](provider-abstraction.md) (per-provider readers must each
populate the new snippet; absence degrades gracefully),
[session-catalog-observation](session-catalog-observation.md) (the server
observer, interest, generation, and cold-row freshness hierarchy),
[recaps](recaps.md) (the away-summary that overrides the excerpt when it is the
freshest agent line).

## Goal

Hovering a session row with a hover-capable pointer should let the supervisor
read, without opening the session, both ends of the conversation:

- **What it's about** — the opening user request (already shown).
- **Where it is now** — the most recent regular agent turn (new).

"Regular agent turn" = the last assistant message with visible prose. Skip
pure tool-call turns, thinking-only turns, and `<synthetic>` turns — entries
Claude Code shapes like an assistant reply but no model produced, identified by
`isSyntheticNoResponseTurn` (`packages/shared/src/claude-sdk-schema/guards.ts`).
Quoting one reports words the agent never said and hides its real last turn. If
the latest turn *ends* on a tool call with no trailing prose, fall back to the
prior text block or a short tool label (see Content below).

## What exists today

- **The pane** — `packages/client/src/components/SessionHoverCard.tsx`.
  Portaled, `position: fixed`, pointer-selectable, self-positioning from the
  row geometry (below/above vertically and beyond the right/left row edge when
  horizontal room permits, with cursor-relative clamping as the fallback). A
  column flexbox:
  - `styles.turn` — the opening request, styled like a user
    message, `white-space: pre-wrap`, line-clamped via an inline
    `-webkit-line-clamp` (`maxLines`) computed from available vertical space.
  - `styles.meta` — a `flex-wrap` row of chips: provider+model
    badge, project, age (`5m ago (est. 2d)`), status badge.
- **Width** — `.root { width: max-content; max-width: min(700px, 92vw) }`, and
  `.wide { max-width: min(880px, 96vw) }` when
  neither below nor above fits and the card trades reading width for fewer
  lines (`placement.loosened`). CSS lives in
  `packages/client/src/components/SessionHoverCard.module.css`.
  **Consequence that drives the layout below:** the card already sizes to its
  widest child's longest line, i.e. the opening request sets the width; any
  second block wraps within that same width for free.
- **Body source** — `SessionListItem.tsx`:
  `hoverPrompt = (initialPrompt || fullTitle || displayTitle || "").trim()`
  (the *first* user turn). No agent-turn text reaches the client today.
- **Firing surface** — every provider-backed `SessionListItem` in Themed mode:
  sidebar compact rows plus All Sessions/search card rows. Native mode mounts
  no rich card or refresh handler on session-list rows; it exposes the ordinary
  browser title only when the visible row title is clipped. Explicit non-list
  confirmation targets may retain the shared custom card in either mode.
- **Data cost is near-zero server-side.** `reader.ts:getSessionSummaryFromDir`
  already reads the whole jsonl, builds the DAG, and holds the active-branch
  `conversationMessages` in memory; it already scans assistant messages
  backwards for model (`extractModel`) and context usage (`extractContextUsage`).
  A backward scan for the last regular agent text is a sibling of those,
  cached in the session index alongside `fullTitle`.

## Decisions (currently opted)

| Dimension | Opted choice |
|---|---|
| Content | **Last ~3 lines** of the last regular visible agent turn, light-stripped; **tool-call fallback** label when the turn ends with no trailing prose. Long one-line excerpts clip at the end, never by taking a middle/tail slice with a leading ellipsis. |
| Source | **Persisted assistant→user text excerpt or provider recap** from the session index. Not hidden thinking and not the live thinking/tool tail (that is phase 2). |
| Layout slot | A dedicated block **below the badge/meta line** (`turn` → `meta` → `reply`). Deliberate "nice separation"; slightly unconventional vs. putting it directly under the request. |
| Width | **Same treatment as the request.** The card is `max-content`; the request already forces the width, the reply wraps in it. `--wide` (880px) applies to both. No special narrowing, no one-line-beside-badges. |
| Vertical budget | **Equal small caps**, not greedy. Cap the now-greedy opening body (≈4–5 lines) and clamp the reply (≈3 lines); the reply must not exceed the opening request's allocation. |
| Surfaces | Sidebar (compact) already fires. **Also fire in card mode** so all-sessions + search get it. |
| Appearance ownership | **Themed session-list rows only.** Native rows stay free of rich hover panes and use an ellipsis-aware native title fallback. Non-list confirmation targets remain explicit exceptions. |
| Timing | **Pointer rest, not entry.** First reveal waits 3× the configured tooltip delay; warm row-to-row reveals retain the 1× base delay rather than becoming instant. |
| Horizontal placement | **Prefer outside the target row.** Use the open right or left side before falling back to cursor-relative viewport clamping. |
| Providers | **Excerpt is provider-independent** via the on-demand refresh (normalized `Message[]`). Claude additionally populates it in the cheap summary/live path; other providers populate on focus/hover. Recaps stay Claude-only. |
| Freshness | **Rides live `session-updated` events for owned/observed sessions; an explicitly requested stale unowned card gets one exact coalesced refresh.** Never poll every visible or neighboring row. |

### Requested-card loading contract

Accepted 2026-08-05. Neither desktop pointer movement nor tablet sidebar
adjacency justifies transcript scanning before a particular preview is
requested. Desktop refresh begins only after the pointer has rested and that
row's card is due to display; Native-mode list hover never requests a rich
preview. Touch refresh begins only when the user explicitly opens that row's preview.
Pointer-velocity and adjacent-row prefetch remain deferred until measurement of
requested-card update delay shows a need.

The card opens immediately from compact list fields. Its opening user request
and metadata occupy their final coordinates and do not jitter, flash, or repaint
when the recent-agent excerpt arrives. Allocate the bounded reply region below
that stable top before asynchronous content is applied, including when the card
is flipped above its trigger. The later reply fills only that region; failure or
absence leaves it empty without moving the opening block.

This is distinct from Inbox reconciliation. Inbox starts a provider-wide scan
eagerly at server boot and publishes progressive count/tier deltas because it
must observe outside-YA activity. Hovercards have no corpus-wide requirement
and may never trigger an adjacent or all-row transcript pass.

## Proposals considered

### Content version (what text)

1. **Last N lines of the last agent turn** — *opted*. Agents put the
   actionable payload ("Done X — want me to Y?") at the *end*, so last-N beats
   first-N for "where did this land?". ~3 lines.
2. First N lines — never dangles at the top, but usually catches preamble /
   task-restatement; less informative for agent turns.
3. Head + tail elision — first line · `…` · last 2 lines; captures topic +
   conclusion for long turns, slightly more logic.
4. **Trailing-question / tool-aware** — prefer the final paragraph/question;
   if the turn ends on a tool call (still working), fall back to the prior text
   block or a label (`⚙ editing reader.ts`). *Folded into the opted choice as
   the fallback*, since the data is right there and it covers the
   "mid-task, no closing prose" case the others render blank.
5. Last exchange (last user line + last agent N lines) — shows start→now in one
   block; rejected as redundant with the opening-request body the card already
   carries.

### Source (where the text comes from)

- **Persisted excerpt from the index** — *opted*. Free (already parsed),
  cached, available offline in the list. Answers "what did it tell me",
  correct for idle/done sessions.
- **Live bottom-of-session tail** (recent visible thinking when enabled,
  `Running Bash…`, streaming
  partial) — *phase 2*. Answers "what's it doing right now", correct for
  running sessions, but **not in the list data**: `GlobalSessionItem` carries
  only `activity`/`status`/`pendingInputType`, no live text. Mirroring the
  session view means streaming a running process's tail into the hover (new
  plumbing) plus honoring the thinking-display gate. The existing status badge
  already covers "running / awaiting input" for v1.

### Layout slot (where the block sits)

- **Below the badge line** (`turn` → `meta` → `reply`) — *opted*. Clean
  separation between "the request + its metadata" and "the latest reply".
  Slightly unconventional (recent content usually sits adjacent to the title),
  judged defensible for the separation it buys.
- Between request and badges (`turn` → `reply` → `meta`) — conventional
  "reply under the prompt" reading order; rejected for weaker separation.
- Inline, one line to the right of the badges (next to `(est Xh)`) — rejected:
  prose in the `flex-wrap` chip row wraps among badges, and a single ellipsised
  line throws away the multi-line payload. (Width is *not* the objection — see
  below — placement among chips is.)

### Width

- **Same as the request** — *opted*. Card is `max-content`, so the opening
  request already drives card width; the reply is another column child and
  wraps within that width at no cost. `pre-wrap` + the existing `--wide`
  loosening apply to both blocks uniformly.

### Vertical budget

- **Equal small caps** — *opted*. Today `turn` greedily consumes available
  height (`maxLines` from space). Split the budget: cap the opening body
  (≈4–5 lines) and clamp the reply (≈3 lines), remainder unused so the tooltip
  does not grow tall. The recent block must not exceed the opening request's
  allocation. The actual change is *capping the now-greedy opening body* — that
  is what currently starves a second block.

## Implementation sketch (v1)

Server:

- Add `lastAgentText?: string` to `SessionSummary`
  (`packages/server/src/supervisor/types.ts:69`), populated in
  `reader.ts:getSessionSummaryFromDir` by a backward scan over the active branch
  for the newest provider recap or assistant message with visible prose (sibling
  of `extractModel`). **Cap at the server** (~500 chars / ~3 lines) so the index
  stays small and content is fixed; the client clamps further. Cached by the
  session index (mtime/size) like `fullTitle`.
- Thread it into `GlobalSessionItem` on both sides
  (`packages/server/src/routes/global-sessions.ts:68` and the
  `allSessions.push` at ~424; client mirror at
  `packages/client/src/api/client.ts:86`, plus the WS-event builder in
  `packages/client/src/hooks/useGlobalSessions.ts`).
- Other providers' readers (`codex-reader`, `gemini-reader`, `opencode-reader`,
  `grok-reader`) populate it as they're touched; absent → no reply line.

Client:

- Pass `lastAgentText` from `SessionListItem` to `SessionHoverCard` as a new
  optional prop; render `styles.reply` below `styles.meta`.
- Apply the tool-call fallback (label the trailing tool when no trailing prose).
- Split the line budget between `styles.turn` and `styles.reply`.
- Drop the `mode === "compact"` gate on `showCompactPreview` (or widen it to
  card mode) so all-sessions + search rows fire the card.

## Freshness: live updates plus exact requested refresh

The list is **not** all-visible or fixed-interval polling.
`useGlobalSessions` fetches once on mount
(and on filter change / WS reconnect via `onReconnect: fetch`), then YA keeps it
live through pushed events from `useFileActivity`: `session-status`,
`process-state`, `session-created`, `session-metadata-changed`, `session-seen`,
and `session-updated`. The last already updates `title` / `messageCount` /
`updatedAt` / `contextUsage` / `model` in place.

For owned/live-observed sessions, `lastAgentText` is wired onto that **same live
channel** rather than a bespoke refresh:

- Server builds `SessionUpdatedEvent` from a freshly re-read `SessionSummary`
  (`Supervisor.emitReconciledSessionUpdate`, and the two
  `ExternalSessionTracker` emit sites), which now carries `lastAgentText`. The
  event object is forwarded whole to clients (`subscriptions.ts`: `emit(type,
  event)` — no field-picking), so no serializer drops it.
- The event's existing triggers (messageCount / contextUsage / title / model
  changed) fire on essentially every agent turn, so the excerpt refreshes with
  them. Emit-payload-only: the change-detection set was left untouched (a new
  agent turn reliably moves messageCount/contextUsage).
- Client `handleSessionUpdated` applies `event.lastAgentText` to the row.

This makes an owned/live-observed hover excerpt exactly as live as the
context-usage chip already is. A mouseover-exit repoll or sidebar-visible
recompute is still unnecessary. An unowned cold row follows the exact on-demand
path below; reconnect conditionally reconciles the retained catalog generation
rather than granting every old row a transcript read.

**Latency floor.** The remaining lag is not a YA poll interval. For sessions YA
runs (owned), updates come off the live SDK stream. For sessions an external TUI
runs (the lag the user sees), YA learns of changes by watching the JSONL file:
the global `FileWatcher` over the Claude projects dir uses `debounceMs: 200` and
`periodicRescanMs: 0` (only Codex enables a periodic rescan), so the YA-side
floor is ~200 ms after a write. The dominant, variable delay is how often the
CLI flushes its JSONL — the writer's cadence, which YA cannot shorten. Initial
post-create reconciliations fire at 1 s and 3 s (`INITIAL_RECONCILE_DELAYS_MS`)
to catch the SDK's async first writes; there is no steady-state periodic poll
for Claude.

## Recaps override the excerpt when they are the freshest line

A **recap** (away-summary; see [recaps.md](recaps.md)) is a better "where is it
now?" line than the raw last turn. YA supports two recap sources: provider-native
recaps and YA-synthesized recaps. Rather than a separate field + client-side
recency compare, the freshest recap is **folded into `lastAgentText`**:

- Persisted provider `system` entries with `subtype: "away_summary"` are
  treated as provider-supplied recaps when they are on the active branch. They
  override an older assistant reply in summary reads and the fast reverse-scan
  refresh. YA strips the provider hint suffix `(disable recaps in /config)`
  before display.
- YA-synthesized recaps, and live-observed native recaps, are persisted as
  YA-owned metadata overlay rows. The same overlay is merged into session
  summaries, so list rows and hovercards continue to show the recap after
  `reyep`, server restart, or reopening the session from another device.
- Hidden thinking/reasoning summaries are not recaps. They stay out of
  `lastAgentText` unless a future live-tail feature explicitly opts into
  showing visible thinking under the user's thinking-display setting.

- `Supervisor.requestRecap` and deferred recap flushes publish a partial
  `session-updated` event with `lastAgentText = <recap text>` when a recap wins.
  It rides the live path already built; the client applies it in place (no
  flicker), and the metadata overlay makes the same text durable.
- A recap is, at emission, newer than any prior turn, so it is the current line.
  The **next real turn** overwrites `lastAgentText` from the provider transcript
  via the normal summary read, so the recap naturally expires — matching "show
  the recap only if there is no later activity."
- Tailed and forked recaps are native-preferred fallbacks. If a native recap row
  arrives before the fallback commits a synthetic row, YA uses the native text,
  mirrors it into the overlay, and suppresses the synthetic fallback.

### On-demand refresh of idle previews (focus / hover)

Idle (owner `none`) sessions get no live `session-updated` events, so their
excerpt can be stale — blank for sessions whose index cache predates this
feature, or simply behind whatever was cached. They are refreshed **on demand**
when the user expresses interest:

- **Provider-independent by construction.** The shared extractor
  `extractLastAgentExcerpt(messages)` (`sessions/agent-excerpt.ts`) operates on
  the uniform `Message[]` that every provider's reader yields through
  `normalizeSession`, so one implementation covers Claude, Codex, Gemini,
  OpenCode, Grok (and pi via whichever reader serves it).
- **Endpoint** `POST …/sessions/:id/refresh-preview` asks the session's
  reader for `getLastAgentExcerpt`. Claude and Codex answer with a bounded
  backward read of the native file (`sessions/latest-agent-excerpt.ts`): at
  most 4 MiB from the end, independent of session length, one read per file
  version shared by concurrent callers and retained until the file changes.
  Claude first peeks its warm transcript cache. Codex re-normalizes the read
  window with the full reader's rules and the shared extractor, so its excerpt
  equals the complete-read excerpt whenever it answers. Antigravity scans the
  latest page of its brain log back to the last checkpoint (a live session,
  its owner's projection); a tool label answers only when that page starts
  the log. Pi uses its own reader.
  When a text is found it emits a `session-updated` carrying `lastAgentText`.
  The result arrives at the client through the live path (not the HTTP
  response), so the row/hover updates **in place — no flicker, no whole-list
  refetch**.
- **Unknown is an answer.** A bounded reader answers unknown when no prose lies
  within its budget, when only a tool label was found but the read stopped
  before the start of the file, when a Codex rollout's own file has no prose
  and its parsed metadata does not show it is self-contained (a fork's parent
  may hold prose), when the file changes during the read, and for compressed
  Codex rollouts. The route then
  returns `lastAgentText: null`, emits nothing, and leaves the card as it was;
  it never retries with a complete read. Only providers whose readers have no
  bounded excerpt yet (Gemini, Grok, OpenCode) take the named
  complete read through `loadRestartSourceSession`. See
  [provider history facts](provider-history-facts.md).
- The extraction helpers (`formatAgentExcerpt`, `assistantContentParts`,
  `scanAgentExcerpt`) live in `sessions/agent-excerpt.ts` and are shared by the
  Claude summary path (`reader.ts`), the bounded scans, and the normalized
  path, so all of them produce identical output.
- **Triggers:** opening a non-running session (`useSession` `handleLoadComplete`
  when `owner === "none"`) and resting a non-touch pointer on a Themed-mode
  non-running row until its card is due. Native list hover, touch entry, and
  touch compatibility mouse events neither show the card nor refresh its data.
  Owned/external sessions are skipped — they already update live, and
  refreshing them could clobber a fresh recap with the JSONL's last turn.
- **One hover controller:** list rows and non-list destinations share one hook
  for refresh deduplication, pointer-rest delay/warmth, global visibility
  ownership, anchoring, suppression, pointer intent, and departure into the
  card. Its unpublished intent also shares the global YA tooltip publication
  slot: another text, rich, or session target preempts it, and publication
  rechecks the browser's current `:hover` state before refreshing or opening.
  A caller owns only policy specific to its surface: list menu suppression and
  scroll-ancestor dismissal remain in `SessionListItem`; a non-list target may
  dismiss on any scroll.

The current exact refresh deliberately does not persist (no index write), so it
does not survive reyep; the cold-cache excerpt repopulates on the next
focus/hover or when the file next changes. Tactical 093 may later retain the
bounded excerpt with its source version in the compact catalog. Either form
preserves the accepted "old sessions may be stale until touched" tradeoff and
never reparses unrelated rows.

## Mobile preview access via the row menu (proposal — not built)

Hover does not exist on touch devices, so the recent-activity preview is
effectively **unreachable on mobile**. Touch-generated compatibility mouse
events previously surfaced the card accidentally when a session row or its
`…` menu was tapped. `SessionListItem` now listens at the pointer boundary and
rejects touch entry, so activating a row remains pure session navigation. If a
mobile preview is built, the `…` menu is the place to present it explicitly,
deliberately laid out with its actions.

Direction (agreed in discussion; not yet built):

- **Drop Clone.** Tested non-functional ("does nothing"); it is wired
  (`handleClone` → `POST /clone`) but fails silently (catch only logs).
  Removing it takes the row menu from 7 items to **6**, which fits a grid
  exactly. Note `SessionMenu` is shared — removing Clone there affects every
  context that renders it (gated already by `supportsCloning`); confirm that is
  intended vs. fixing the underlying clone failure.
- **3 columns × 2 rows grid** for the row-menu actions: Star, Archive,
  Read/unread, Rename, Copy, Share. Share is conditional
  (`publicShareControlsVisible`); when hidden, 5 items reflow (one empty cell).
- **Label/icon changes:** "Copy prompt" → "Copy"; "Mark as unread" → "→ unread"
  with an **arrow** glyph (suggesting the action) replacing the circle. Reduce
  horizontal padding and font size so the grid stays compact.
- **Preview above or below** the grid (full width), choosing above vs. below
  from the `…` button's screen position — the same flip logic the hover card
  already uses.
- **Position the menu close to `…`, in the opposite direction** from where the
  preview sits, so the whole cluster stays near the tapped button and on-screen
  (the hover card MAY position relative to the menu rather than the cursor).
- **Keep the tapped `…` visible** — not covered by the menu/preview — so tapping
  it again is an obvious no-action dismiss.
- **Dismiss** when: a tap lands outside, a menu option is chosen, the preview
  itself is tapped, or `…` is tapped again.

Open sub-questions: whether the tap-preview reuses `SessionHoverCard` (already
portal/fixed and self-positioning) or a menu-embedded variant; and whether the
grid layout is a row-menu-only mode of the shared `SessionMenu` (the session-page
header menu keeps its taller list with compact/handoff/clear/etc.).

## Open questions / phase 2

- **Live tail** for running sessions (thinking/tool/streaming) — needs live
  process text in the list; honor the thinking-display setting. Decide whether
  it *replaces* the persisted excerpt while `activity === "in-turn"` or sits as
  a third state.
- **Markdown handling** — opted to light-strip syntax + collapse blank lines
  rather than render markdown in a tooltip; confirm the strip is good enough on
  code-heavy turns.
- **Per-provider parity** — the snippet's notion of "regular agent turn" must
  hold across providers whose readers structure assistant content differently.
