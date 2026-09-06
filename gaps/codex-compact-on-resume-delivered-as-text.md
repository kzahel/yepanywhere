# Codex /compact on resume is delivered as model text

A manual `/compact` submitted while resuming a stopped Codex session can run
as ordinary user text. The model can then claim to be compacting and finish a
normal turn without producing a compaction boundary.

Observed locally on 2026-09-06: YA registered a replacement process at
06:00:14 UTC; the Codex rollout recorded a user message containing `/compact`
at 06:00:17 and an assistant reply, "Compacting with the active work and latest
guidance preserved.", followed by `task_complete` at 06:00:39. No compacted
record accompanied that turn. An earlier request on the already-running
process invoked native `op.dispatch.compact`, demonstrating different routing.

`packages/server/src/routes/sessions.ts` dispatches native slash commands in
the active-session messages route. The resume route instead passes its message
to `Supervisor.resumeSession`. In
`packages/server/src/supervisor/Supervisor.ts`, `queueProcessMessage` dispatches
only `/goal` natively and otherwise calls `Process.queueMessage`; new-provider
startup and existing-process resume both use this helper. Deferred delivery
also needs review because the messages route bypasses native dispatch for
deferred commands other than `/goal`.

Unify native command dispatch across delivery paths after provider readiness;
never substitute model text for a provider-owned command. Add regression
coverage through the resume route requiring `thread/compact/start`, no
`turn/start` carrying `/compact`, and compaction progress/completion without
another user message. Preserve providers that intentionally process slash
commands through their ordinary input queue.

Captured during a diagnosis and version audit; implementation was not requested.
This differs from the upstream WebSocket compaction timeout and from
[idle compaction event consumption](codex-idle-compaction-event-consumption.md).

Found 2026-09-06 while investigating a misleading manual-compaction reply.
