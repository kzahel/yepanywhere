# A new routed session whose commit reply is lost leaves a committed binding behind

`AgentAuthRouter.launch` in
`packages/server/src/services/AgentAuthRouter.ts` cancels a fresh allocation
only when the router answers 400, 404 or 409. When AAR applies
`/v1/bindings/commit` and the reply never arrives, the control client reports
"Router unavailable" and the catch block keeps the allocation, on the stated
ground that a lost reply stays recoverable through the persisted allocation.

That holds for a resumed session and for a Project Queue item, whose retry
launches the same session id again. It does not hold for a session created
through `POST /api/projects/:projectId/session-creations`: the creation ends
`failed` / `not-admitted` / `router-refused`, the session id never becomes a
session (`/resume` answers 404 "Session not found"), and a new attempt mints a
new id and a new allocation. The first binding stays `committed` in AAR with a
live token that only YA's private state holds, YA's allocation is never marked
cancelled, and the recovery view reported two bindings on the account with one
session running. Nothing later cancels it.

Not fixed in place because the remedy has to tell the two callers apart:
cancelling every fresh allocation on an uncertain failure would break the
queue's same-id retry. The likely fix: when a creation attempt ends
`not-admitted` without a retry that can reach it, mark its allocation
cancelled so the existing durable cancellation flush revokes it. Cancel is
valid for a committed binding. Cover a lost commit reply on a plain creation
and on a queued item that retries.

Observed with real YA and AAR through a control-socket relay that dropped the
commit reply, while extending agent-auth-router's
`integration/yepanywhere` suite. That suite covers the lost reply on a
resume only. The behavior predates plan 198.

Found 2026-11-25 while extending the cross-repository suite for plan 198.
