# Deferred & Tactical Roadmap

> A prioritized backlog of high-value deferred items already framed in `topics/`
> plus near-term tactical rendering/tracking work. Each top-level item is
> independent and can land on its own. This doc is a planning surface for
> discussion, not a contract; the per-item topic docs it links remain
> authoritative for design detail.

Topic: deferred-roadmap

Ordering is value-per-effort. Items 1–2 are the named tactical wins; 3 is a
correctness bug; 4–5 are rendering polish; 6–7 are larger strategic
provider work; 8 is housekeeping.

## 1. Backgrounded-jobs badge with expandable list

A count badge of in-flight background jobs for a session, expanding to list
them. Most of the data already exists server-side — this is mostly UI.

- **What already exists (do not rebuild):**
  - `ClaudeProviderRetentionTracker`
    (`packages/server/src/sdk/providers/claude-retention.ts`) already tracks
    `backgroundTaskCount` (from the Stop-hook `background_tasks` array),
    `sessionCronCount` (Stop-hook `session_crons`), and a live `retainedTasks`
    map of `{status, isBackgrounded}` keyed by task id (fed by `task_started` /
    `task_progress` / `task_updated` / `task_notification` system messages).
  - The snapshot rides to the client as `providerRetention` on the
    session-liveness payload (`packages/shared/src/session-liveness.ts`).
  - `ProcessInfoModal.tsx` already prints `bg=` / `crons=` / `tasks=` for
    debugging — proof the counts reach the client today.
- **1.1 Define what a "backgrounded job" is** (decision, do first). Three
  distinct mechanisms exist; the badge should reconcile them:
  - **Background bash shells** — `Bash` with `run_in_background` →
    `result.backgroundTaskId` (rendered in `BashRenderer.tsx`), polled via
    `BashOutput` (`bash_id`), killed via `KillShell`.
  - **Background agent / Monitor tasks** — `Task*` / `Agent run_in_background`
    → `<task-notification>` (`packages/shared/src/transcript/parseTaskNotification.ts`)
    and the retained-task counts above.
  - **Session crons** — Stop-hook `session_crons`.
  - Recommended: one combined count, grouped sections on expand.
- **1.2 Per-session badge** (first version): small count next to session status
  (`SessionListItem.tsx` / session header), shown only when count > 0. Reuse the
  inbox-count badge pattern in `Sidebar.tsx`.
- **1.3 Expandable list (popover):** bash shells (command + id, link to latest
  `BashOutput`), agent tasks (subject + status), crons.
  - **Gap to close:** `retainedTasks` stores only `{status, isBackgrounded}` —
    no subject/label. Capture the task `subject` (from the `Task*` input /
    `task_started` system message) into the retained record so the rows are
    meaningful. Bash-shell rows already have the command string.
- **1.4 Optional global aggregate** (second version): dashboard-level badge
  summing per-session counts; same popover grouped by session.
- **1.5 Verification:** `sessionActivityUi.test.ts` already exercises retention
  counts; extend for label rendering and grouping.

## 2. Task-list rendering from incremental `Task*` events

See [`task-list-rendering.md`](task-list-rendering.md) (authoritative framing).
The old `TodoWrite` snapshot still renders; the new delta-based `Task*`
namespace currently falls through to the raw-JSON fallback. Two phases:

- **2.1 Minimal stopgap renderers** (tiny, ship first): register lightweight
  `TaskCreate` / `TaskUpdate` renderers producing one-liners (`+ Task: <subject>`,
  `✓ Task 1 → completed`) instead of the `{success, taskId, statusChange}` blob.
  First confirm coverage against existing `TaskRenderer.tsx` /
  `TaskOutputRenderer.tsx` so this isn't duplicating a renderer.
- **2.2 Reconstructed list — server-side injection** (recommended path):
  - Fold every `TaskCreate` (id ↦ subject) and `TaskUpdate` (id ↦ latest status)
    into a resolved list; inject a `_taskSnapshot` field, mirroring the existing
    `_diffHtml` / `_`-augment pattern (see
    [`rich-text-rendering.md`](rich-text-rendering.md)).
  - Run reconstruction over the **full** `Message[]` *before* the tail slice so
    off-window `TaskCreate`s (under the `tailCompactions: 2` default) still
    resolve subjects — free because the full array is transiently materialized
    in `reader.getSession`.
  - Implement in **both** the live (`stream-augmenter`) and cold-GET
    (`persisted-augments`) paths so live and reload agree.
  - Client stays a pure renderer drawing `_taskSnapshot` as a checklist.
- **2.3 Open decisions** (from the topic): snapshot granularity (every event vs.
  latest-surviving only — recommend latest-only to bound wire size); drift
  self-heal via `TaskUpdate.statusChange.from` and `TaskGet`/`TaskList` resync;
  whether the representation generalizes to other providers' plan constructs
  (`UpdatePlan`).

## 3. Queue survival across compaction

See [`queue-across-compaction.md`](queue-across-compaction.md) § "Fix directions
(not yet implemented)". A real correctness bug: verified-idle/patient queued
turns are silently lost when a Claude compaction terminates the process —
`markTerminated` does not drain or hand off `Process.deferredQueue`.

- **3.1** On compaction-driven termination, re-enqueue `deferredQueue` onto the
  replacement process, the way `recoverDeferredMessagesAfterHardAbort` already
  handles hard aborts.
- **3.2** Preserve eager-`deferred` vs `patient` intent across the hand-off; the
  topic notes eager `deferred` items should flush at the new turn boundary.
- **3.3** Codex needs no fix here (its process survives compaction, so
  `deferredQueue` is never dropped) — scope to the Claude termination path.
- **3.4** Test: queue across a forced compaction boundary; assert no silent loss
  and correct ordering.

## 4. Rich-text rendering known gaps

See [`rich-text-rendering.md`](rich-text-rendering.md) § "Known gaps / future
work". Small, self-contained polish:

- **4.1** GitHub-flavored Markdown footnotes (`[^id]` / `[^id]: …`) unsupported.
- **4.2** Edit-diff rich render does not inline-expand image links — useful when
  a diff touches an image/asset.
- **4.3** Catalogue per-provider Markdown conventions currently "not yet
  catalogued" (Claude detailed conventions; OpenCode formatting + durable reload
  handling).

## 5. Provider-refresh informational-message rendering surface

See [`provider-refresh.md`](provider-refresh.md) (known follow-up). A dedicated
render surface for provider informational/notice events, so they map to a
non-tool render path instead of being dropped.

## 6. OpenCode provider fleshout

See [`opencode-backend.md`](opencode-backend.md) § "Gaps To Close" (ten items;
the integration is well under half complete) and
[`opencode-copilot.md`](opencode-copilot.md), which now re-prioritizes this item
around a primary goal — exposing GitHub Copilot models with copilot auth — and
adds a **gating baseline review** (the integration was never well-tested and the
`opencode` binary jumped 1.15.13 → 1.17.9). Related: copilot-as-a-Claude-backend
is scoped in [`copilot-oauth-claude.md`](copilot-oauth-claude.md). OpenCode is
integrated over HTTP/SSE via `opencode serve` (not ACP — the ACP family is
`gemini-acp` and `grok`). Highest-value gaps:

- **6.1** Durable reasoning: map stored/export `reasoning` parts to YA
  `thinking` blocks (with a reload fixture) — currently dropped on history view.
- **6.2** Tool-name aliases: map OpenCode lower-case `bash` / `task` to YA's
  rich `Bash` / `Task` renderers; keep unknown tools explicit.
- **6.3** Permission bridge: wire `permission.asked` / `GET /permission` /
  `POST /permission/:id/reply` into YA's normal approval UI.
- **6.4** Durable event-shape parity (old stored `tool` vs newer live-style
  `tool-use`/`tool-result`), tool-result pairing correctness, native command
  inventory, thinking/effort option mapping, graceful interrupt/steer, and the
  `ses_*` vs YA session-id split — remaining items in the topic.
- Sibling concern: the ACP providers (`gemini-acp`, `grok`) have their own
  maturity gaps; track those in their topics, not here.

## 7. pi (Zechner) provider + progress tracking

See [`pi-provider.md`](pi-provider.md) (new) and the existing research
[`../docs/research/opencode-vs-pi-mono-provider-backend-comparison.md`](../docs/research/opencode-vs-pi-mono-provider-backend-comparison.md),
which already recommends pi-mono as YA's primary agnostic backend with a
three-phase integration plan. Two tracks:

- **7.1 Integration** (strategic, larger): add a `pi` provider. Plan A (likely
  first version): subprocess RPC mode (`pi --mode rpc`, typed protocol, stable
  process boundary) — pi ships this headless front-door, so no TUI driving is
  involved. Plan B (deeper-bypass alternative): in-process SDK
  (`createAgentSession`). Both bypass the TUI; the post-#339 refactor makes that
  the supported design, not a hack. Plus a `PiSessionReader` for
  `~/.pi/agent/sessions` JSONL trees. Pin to the fork `graehl/pi` (we are not
  upstream maintainers) for a bundled YA permission-bridge extension and version
  control. Details in `pi-provider.md`.
- **7.2 Progress tracking** (lightweight, periodic): watch Mario Zechner's pi
  refactor of web UI vs TUI and the third-party remote web UI, since a remote
  pi supervisor overlaps YA's value prop. Anchors: `earendil-works/pi#339`
  (agent-loop → `pi-agent`, `AppMessage` throughout — closed) and
  `VVander/pi-remote-web-ui` (SSH-tunneled in-process single-`AgentSession`
  web client). Re-check periodically; details and what-to-watch in
  `pi-provider.md`.

## 8. Lower-priority housekeeping

- **8.1 Attachment retention / cleanup** — see
  [`attachment-storage.md`](attachment-storage.md) § "Deferred: retention /
  cleanup"; no retention policy yet for uploads.
- **8.2 Trusted-client packaging verification** — see
  [`trusted-client-packaging.md`](trusted-client-packaging.md) § "Deferred
  Verification Setup"; relevant only when pursuing signed/local installs.
