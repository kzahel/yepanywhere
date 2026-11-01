# Forked recap lifecycle

> Server-side lifecycle of the `fork` recap strategy: how a forked
> away-recap request is gated, deduped, deferred while the parent is
> busy, and cancelled when the parent becomes active again.

This is the supervisor-level companion to [recaps.md](recaps.md), which
owns the product contract (what a recap is, the on-wire `away_summary`
shape, the native/tailed/forked modes, the no-extra-provider-turns rule,
and the durable YA overlay). Read recaps.md first; this doc is the worker
lifecycle for the high-fidelity fork path, plus the current implementation
handoff.

See also: [side-session-config.md](side-session-config.md) (shared helper
config), [fork-from-turn.md](fork-from-turn.md) (the fork-after-summary
strategy this reuses), [session-hovercard-recent-activity.md](session-hovercard-recent-activity.md)
(where an emitted recap surfaces as the session's current agent line).

Forked recap generation shares the supervisor's native helper-source boundary
with retitle and handoff summaries. The archived generator and overlay keep
public ids; provider input uses the captured native reference and original
project. Cancellation during acquisition cannot dispatch another helper query.
See [session identity](session-identity.md#current-implementation).

## Recap modes (recap of recaps.md)

The [recap disposition](recaps.md#house-cleaning-disposition) retains this
implementation. Cleanup is limited to concise, expandable configuration and a
provider-specific warning about fork cost; current Codex measurements do not
justify promising warm-cache economics from a timely fork.

`RecapMode` ∈ `off | native | side-session | fork`. The UI labels them
**Off / Native / Tailed / Forked** (`side-session` == "Tailed"). Dispatch
is by mode in `Supervisor.requestRecap` (`Supervisor.ts:3059`):

- `fork` → `Supervisor.requestForkedRecap` (this doc).
- `native` / `side-session` / `off` → `Process.requestRecap`
  (`Process.ts:1593`): `off` declines; `native` returns
  "provider-owned" (the provider emits its own `away_summary`, YA does
  not synthesize); `side-session` runs the cheap recent-text helper,
  guarded by a `recapInFlight` boolean (`Process.ts:446`).

## Lifecycle contract (fork path)

The forked path creates an archived/hidden generator fork, runs one
helper turn there via `provider.generateSummary({strategy:"fork", …})`,
and emits only the resulting text as a synthetic `away_summary`. For a
provider that can emit native `away_summary` rows, the forked path is a
native-preferred fallback: wait a bounded grace window, use a native recap
if it arrives, and only synthesize when native does not arrive in time. The
supervisor must uphold:

- **Inherit the source model.** The generator's one helper turn uses the
  source session's exact selected model, or its provider-reported model when
  the source selected `default`. Provider-specific helper effort remains
  independent and may be lower than the source effort.

1. **At most one fork worker per process.** A second concurrent request
   while one is in flight is refused with reason "recap already in
   flight" (`requestForkedRecap`, `Supervisor.ts:2098`).
   **Accepted limitation:** keyed by **process id**, not session id. A
   replaced/reactivated process for the same session would not see the
   prior in-flight flag. This is acceptable — one live process per
   session in practice — and will not be changed.

2. **Never start a fork while the parent is mid-turn.** If
   `process.state.type === "in-turn"` at request time, the request is
   *deferred* (`pendingForkedRecapRequests.set`, `Supervisor.ts:2106`)
   and flushed when the parent next returns to `idle`
   (`flushPendingForkedRecapRequest`, called from the state-change
   handler at `Supervisor.ts:3374`).

3. **Cancel an in-flight/deferred fork when the parent turns active.**
   `forkedRecapInFlight: Map<processId, AbortController>`
   (`Supervisor.ts:510`); the controller's `signal` is passed into
   `generateSummary` (`Supervisor.ts:2124`+call). On a parent transition
   to `in-turn` the handler calls `cancelInFlightForkedRecap`
   (`Supervisor.ts:3379`), which aborts the generator-fork helper turn
   and drops any not-yet-started deferred request
   (`Supervisor.ts:2193`). Process teardown also aborts
   (`unregisterProcess`, `Supervisor.ts:3470`). An aborted generation is
   reported as "cancelled by new activity", not logged as a failure
   (`Supervisor.ts` catch in `requestForkedRecap`).

   Stop/Interrupt and Terminate are stronger cancellation boundaries: both
   abort an in-flight fork, drop a deferred request before the parent reaches
   idle, and persist a session-level recap pause. Away-timer requests remain
   rejected across process replacement or server restart until a fresh
   user-authored turn is accepted. Hidden control and automatic heartbeat turns
   do not lift the pause.

4. **Suppress empty recaps.** No recent assistant text since the user
   left ⇒ no recap (`getRecentAssistantText`). The floor is raised to the
   latest persisted recap for the session (`recapFloorMs`, applied at
   `requestForkedRecap` entry and at the tailed dispatch in
   `Supervisor.requestRecap`), so a second return event with no assistant
   output since the last emitted recap is also suppressed rather than
   regenerating the same summary. **Exception:** a process
   revived for this recap (`{revived:true}`) has an empty in-memory buffer
   even though its transcript has content, so the revived path skips both the
   native wait and this emptiness gate and forks straight from the transcript;
   the fork's own empty-text fallback handles a genuinely empty transcript.

5. **Favor native rows when they arrive in time.** A provider-native
   `system/away_summary` observed before fallback emission resets the return
   event: YA persists that native row as an overlay mirror, updates the
   list/hover excerpt, cancels or suppresses any fork fallback, and does not
   emit a duplicate synthetic recap. If native does not arrive by the bounded
   grace window, the fork fallback guarantees eventual recap visibility.

6. **Persist only the YA overlay, never a provider turn.** A synthetic fork
   recap is saved to `SessionMetadataService.recapMessages` and merged into
   session-detail and session-list reads. The provider JSONL/source transcript
   remains untouched, so future provider context is not polluted. Native rows
   may also be mirrored into the overlay when observed live so the
   native-preferred result survives `reyep`/server restart and another
   device reopening the session; merge logic dedupes against provider rows
   that later appear in the persisted transcript.

The provider honours the abort: `generateForkBackedSummary`
(`claude.ts:1106`) wires `request.signal` to an `AbortController` plus a
60 s `SUMMARY_TIMEOUT_MS` hard cap (`claude.ts:1117-1125`).

## Trigger model (where "away" is decided)

There is **no server-managed idle timer.** The trigger is **client view
presence**, owned by `useSession.ts`: hiding the tab — or navigating away from
/ unmounting the session view — arms a `setTimeout`; when it fires after the
session's `recapAfterSeconds` threshold (default 5 min) it POSTs the recap.
Returning to the visible/mounted view before the threshold cancels the pending
timer. The request is **session-keyed, not process-keyed**
(`POST /api/projects/:projectId/sessions/:sessionId/recap`, `sessions.ts`), so
it survives a server restart that killed the process. The older process-keyed
`POST /api/processes/:id/recap` (`processes.ts`) still exists for a live process.

The session-keyed route resolves the trigger:

- A **live** process recaps directly in its own mode
  (`Supervisor.requestRecap`).
- A **cold** session (no live process) is revived and recapped **only when its
  durable `recapMode` is `fork`** — `side-session`/`native` recaps need the
  in-memory recent-text buffer a revived process lacks, while `fork` reads the
  transcript from disk. A persisted `autoResumeDisabled` marker blocks this
  automatic revival; only a fresh explicit user action such as Activate or Send
  may continue a terminated session. Otherwise revival uses
  `reactivateSession(..., {preempt:false})`: a background recap must **never
  evict a live worker** to revive a different session, so at capacity it skips
  rather than preempts. The revived recap passes `{revived:true}` to bypass the
  native-wait + emptiness gate (point 4).
- A durable `recapPausedUntilUserTurn` marker blocks both live dispatch and
  cold revival after Stop/Interrupt or Terminate. A fresh user-authored turn on
  the current or replacement process clears that marker; hidden/internal turns
  and automatic heartbeat turns do not. Terminate's separate
  `autoResumeDisabled` and heartbeat settings are unchanged by this
  recap-specific clear.

Because the timer only exists for the session a client is *displaying*, an
unfocused / list-only session never time-triggers a recap — the focus scoping
is structural, and process-absence is the accepted correlate for "revive."

The client also suppresses the POST when recaps cannot act, so it does not fire
for sessions with recaps off. It learns the live process's `recapMode` from the
`connected` stream event and keeps it in a ref (surviving the owner→none flip
when the process dies), then arms only when that mode is enabled: any non-off
mode while live, or `fork` once cold (the only mode that revives). A session
never seen live this view has an unknown mode and does not fire.

`recapMode` is durable (persisted in `SessionMetadataService`, mirroring
`recapAfterSeconds`); the recap-config route and reactivation read/write it,
and a resume that names no recap mode (including a `/clearloop` iteration)
reads it.
This is what lets a cold session report whether/how to recap, and it also fixes
a prior bug where reactivation reset a session's recap mode to the default.

The server *does* track per-session last activity — `updatedAt` from JSONL
`stats.mtime`, cached in `SessionIndexService`; that is the source of the
"4m ago" hovercard line — but nothing on the server fires a recap from it.

## Status and remaining gaps

- **Done:** dedup (1), in-turn deferral (2), cancellation-on-activity
  (3), empty suppression (4). Cancellation landed in
  "Cancel in-flight forked recap when the parent turns active".
- **Done:** native-preferred fallback (5). Tailed and forked modes wait
  briefly for provider-native `away_summary`; native wins if observed before
  fallback emission, otherwise YA synthesizes.
- **Done:** durable recap overlay (6).
  Synthetic recaps and live-observed native recaps are stored under
  session metadata and merged into session detail, session summary, global
  lists, project lists, and the hovercard's `lastAgentText`.
- **Done:** configurable away threshold. `recapAfterSeconds` is part of
  new-session defaults, process/session metadata, ownership/status
  payloads, and the process recap-config route. The new-session/settings
  Recap blocks and session Recap modal surface the value; the client
  visibility trigger consumes it.
- **Done:** cold-session revival. The away trigger is session-keyed; a
  displayed fork-mode session whose process died (e.g. `reyep`/restart) is
  revived (`reactivateSession`, never preempting a live worker) and recapped
  from its transcript via `{revived:true}`. `recapMode` is now durable in
  session metadata so the cold session can report whether/how to recap.
- **Verified:** focused server tests, full typecheck, lint, and a real Codex
  fork-recap smoke across `reyep` restart, and `pnpm i18n:scan`.
  Smoke session
  `019ef8cf-0f1a-7a51-9c9c-e1426aa88433` emitted one
  `system/away_summary`, session detail returned it with `messageCount: 3`,
  the global list returned the same text in `lastAgentText`, and verify-only
  reads after `reyep` returned the same detail/list recap.
- **Done:** since-last-recap suppression + display supersede
  (2026-07-04, after a live double-recap: a hide during a long turn
  deferred one recap to turn-end, a second hide near turn-end fired
  another 103 s later, and both summarized the same finished work).
  `recapFloorMs` raises the gate floor to the latest persisted recap,
  and `mergeRecapMessages` collapses an older overlay recap that has no
  provider content after it — which also cleans up already-persisted
  duplicate pairs at read time.
- **Gap — revived path bypasses the since-last-recap gate.** The
  `{revived:true}` fork skips the emptiness gate (empty buffer), so a
  cold fork-mode session revived twice with no new content can still
  duplicate a recap across server restarts. Closing it needs a reliable
  last-provider-content timestamp for a cold session; the index's
  `updatedAt` is JSONL mtime, which YA sidecar rows (ai-title,
  queue-operation) also bump, so it over-reports freshness. The display
  supersede masks the duplicate row meanwhile.
- **Gap — server-driven trigger (optional, not comprehensive).** YA is
  explicitly allowed to leave unattended sessions alone instead of trying to
  generate a recap for every stale session. If a server idle trigger is ever
  added off the existing activity timestamp, it should use a separate much
  longer threshold than the client return trigger — for example about 5x the
  default away timeout (25 min today), clamped below 55 min — and remain a
  distinct decision from the current visibility-based recap flow.

## 2026-06-24 implementation handoff

Current worktree state:

- New durable type: `DurableRecapMessage` in
  `packages/shared/src/app-types.ts`, exported from shared. Because the
  shared package's `"types"` entry points at `dist/index.d.ts`, refresh
  declarations with `pnpm --filter @yep-anywhere/shared build` before
  server-only typechecks that import a new shared type.
- Durable store: `SessionMetadataService.recapMessages`, with capped,
  deduped `getRecapMessages()` / `addRecapMessage()` and focused metadata
  tests.
- Overlay merge: `packages/server/src/sessions/recap-overlays.ts` converts
  native/synthetic `away_summary` rows to durable overlay rows, dedupes them
  against provider messages, merges them into session detail, and updates
  summary `updatedAt` / `lastAgentText` when the latest recap is fresher.
- Emission path: `Process.generateAndEmitRecap()` and
  `Supervisor.requestForkedRecap()` return `RecapRequestResult`; a
  `syntheticMessage` in that result is persisted by `Supervisor`, while
  provider-native `away_summary` events are mirrored as `provider-native`
  overlay rows when observed live.
- List freshness: persisted or newly emitted overlay rows call through the
  existing `session-updated` path with recap text formatted by
  `formatAgentRecapExcerpt`, so the session list hovercard shows the recap
  immediately as the ending text.

Verification evidence:

1. `pnpm --filter @yep-anywhere/shared build`
2. `pnpm --filter @yep-anywhere/server exec tsc --noEmit`
3. `pnpm --filter @yep-anywhere/server exec vitest run test/process.test.ts test/metadata/service.test.ts`
4. `pnpm typecheck`
5. `pnpm lint`
6. `pnpm i18n:scan`
7. Real Codex smoke with `.tmp/fork-recap-smoke.mjs`:
   session `019ef8cf-0f1a-7a51-9c9c-e1426aa88433`, model
   `gpt-5.4-mini`, `recapMode: "fork"`, `recapAfterSeconds: 1`. Before
   `reyep`, the script observed `RECAP_RESPONSE.emitted: true`,
   `MESSAGE_COUNTS.systemAwaySummary: 1`, detail recap text, and global-list
   `lastAgentText` with the same recap. After `reyep`, verify-only mode
   returned the same detail recap and same list `lastAgentText`.

Smoke gotcha: Codex can initially return a temporary session id and then report
the canonical session id through process state. The scratch smoke normalizes by
waiting for idle and then using `process.sessionId` for detail/list assertions.

## Tests that should fail on regressions

- Two concurrent fork requests for one process ⇒ at most one generator
  fork created.
- A fork request while `in-turn` does not start a generator until idle.
- A parent turn starting mid-generation aborts the generator turn (no
  late `away_summary` emitted after the new turn began).
- Stop/Interrupt or Terminate drops a deferred or in-flight fork and keeps
  session-keyed away requests suppressed across process replacement/restart
  until a fresh visible user turn is accepted.
- A recap with no assistant output since the user left emits nothing.
- A recap with no assistant output since the last emitted recap emits
  nothing, even when the away window reaches back before that recap.
- If a native `away_summary` arrives before the fallback emits, tailed/forked
  use the native text and do not run/commit the synthetic fallback.
- A synthetic recap survives server restart/session reopen through the YA
  metadata overlay, while the provider JSONL remains free of YA helper turns.
- A cold (process-dead) fork-mode session is revived and recapped on the
  session-keyed away trigger; a cold non-fork session is not revived; a
  background recap never preempts a live worker (skips at capacity).
- A forked recap request carries the resolved source model into the provider;
  gateway model settings and native Codex resume params receive that same
  model while helper effort remains independently configurable.
- `recapMode` round-trips through `SessionMetadataService` (persist on
  recap-config, read on reactivation), surviving server restart.
- A revived process with an empty recap buffer still emits a forked recap
  (the `{revived:true}` bypass), and reactivation no longer resets recapMode.
- A forked recap landing on a fully-seen session does not mark it unread
  (no bold sidebar title / inbox unread tier): `hasUnread` compares
  pre-overlay `updatedAt` (see recaps.md § Invariants).
