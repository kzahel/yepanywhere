# Antigravity detached wakes can appear idle while the agent is working

On 2026-11-21, the Antigravity background-review session showed resume
wording while the agent was processing a completed review. Its native
transcript recorded new model and tool steps during the period in which
YA reported the owned process as `idle`. Later, while waiting on another
review, the native conversation summary reported
`CASCADE_RUN_STATUS_IDLE` with `not_fully_idle = 1`.

The [Antigravity adapter](../packages/server/src/sdk/providers/antigravity.ts)
publishes unsolicited ACP output as passive because ACP supplies no prompt
result for a detached wake. The [background tracker](../packages/server/src/sdk/providers/antigravity-background.ts)
removes shell work on its terminal tool event. If that was the last tracked
item, [liveness](../packages/server/src/supervisor/liveness.ts) derives
`verified-idle` whenever `state.type === "idle"` and `!providerRetention?.retained`
— even when `lastProviderMessageAt` / `lastVerifiedProgressAt` is newer than
`lastVerifiedIdleAt` (observed live with `lastVerifiedIdleAt` 30 minutes earlier
than `lastVerifiedProgressAt`). That status allows idle teardown during
detached work. [Antigravity patient delivery](antigravity-patient-queue-promotes-during-background-work.md)
currently bypasses the verified-idle gate altogether.

Separately, session `/metadata` in
[session-detail-subresource-routes.ts](../packages/server/src/routes/session-detail-subresource-routes.ts#L410)
returns raw `process?.state.type ?? null` (`"idle"`) rather than applying the
retention-aware activity logic used for sidebar and inbox rows in
[session-runtime-overlay.ts](../packages/server/src/sessions/session-runtime-overlay.ts#L58-L73).
Until a WebSocket liveness snapshot overrides it on the client, that raw `"idle"`
state lets the composer render `"Send a message to resume..."` even when
provider retention is active.

The investigation was interrupted by a backend reload before the gap was
written. The adapter still needs a verified boundary for the root
conversation's detached activity. Validate whether the existing bounded
native summary reader can supply that boundary for a live-owned root.
Check publication lag around the task-completion event, distinguish pending
background work from active generation, and preserve uncertainty when the
summary is missing, stale, or unsupported. Reuse existing observation
ownership and avoid a per-session poll. See
[session liveness](../topics/session-liveness.md) and
[provider waits and background work](../topics/provider-wait-and-background-work.md).

## Reproduction

The [opt-in native app cases](../packages/server/test/native-app/app-antigravity-gap-repros.test.ts)
run real `agy acp` against a scripted loopback model endpoint. They assert
the current failures, including the patient timing and reload cases.

```bash
pnpm test:providers:install antigravity
YEP_NATIVE_ANTIGRAVITY_GAP_REPROS=1 pnpm --filter @yep-anywhere/server test test/native-app/app-antigravity-gap-repros.test.ts --maxWorkers=1
```

Reproduced on 2026-11-22 at `eb520d058` with `agy` 1.5.13, Node 24.22.1,
and macOS arm64. While the schedule was pending, v0 reported `background`
and metadata reported `idle`. The native wake then reached the held model
request and streamed a partial reply to the WebSocket. A fresh subscription
reported `verified-idle`. After both subscribers left with idle reap set to
zero, the owner disappeared and the held native response was cancelled.

An isolated YA instance also reproduced the false-idle interval with live
Gemini 3.8 Flash Low and installed `agy` 1.5.14. The initial prompt asked `agy`
to call `schedule` once for 14 seconds, reply with a marker, and end the turn.
The scheduled prompt requested a reply with a distinct marker and a list of
short facts, with no tools. Metadata reported `idle` while v0 showed
`background`. When the wake's assistant text began streaming on the session
WebSocket, its latest status was `verified-idle` and v0 also reported `idle`.

Fix acceptance also needs a quiet end to the wake and a delayed summary
update, with the session settling without further model output.

Found 2026-11-21 while checking an Antigravity session running background
Codex reviews.
