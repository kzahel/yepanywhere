# Antigravity permission requests from a child conversation are unqualified

YA has no evidence of how `agy` asks permission for a child (subagent)
conversation's tool. Real `agy` 1.5.13 and 1.5.14 were not seen to send a
`session/request_permission` for a child. In a default-mode research child
run, both versions recorded the attempted command in the child's planner log
but sent no ACP permission frame and no follow-up model request.

YA's handling is therefore set by the root session alone. The supervisor
routes every Antigravity approval to the root YA Process
([`Supervisor.ts`](../packages/server/src/supervisor/Supervisor.ts#L2956)),
which shows one approval queue and goes idle when the root's result is
published. The provider matches that: one runtime connection is one YA
session. A root Stop withdraws every waiting request on the connection,
and a request raised during a root turn is withdrawn when that turn ends,
so none is left waiting but hidden
([permission owner](../packages/server/src/sdk/providers/antigravity-permission-requests.ts)).
If `agy` does ask for a child, the request is put to the user while the
root turn runs, or after the root's result if it arrives between the root's
last prompt response and that result (it is held and asked once YA is
idle). Either way a root Stop cancels it. The provider remembers at most 256
running tool calls, forgetting the oldest first. A delayed request for a
call it has forgotten, or one that arrives after that call's terminal update,
is treated as new work and can ask after Stop.

Controlled repro from the step 2b review, round 2. During one root prompt,
the peer sent requests naming the root (`"1"`) and a child conversation ID
(`"2"`). With the round-1 provider, which let the child request survive a
root Stop, YA's Process then cleared it and answered Deny. After an ordinary
root completion it stayed in Process's map while Process was idle, and
`getPendingInputRequest()` and the v0 input endpoint
([`native-session-control.ts`](../packages/server/src/core-api/native-session-control.ts#L20))
had nothing to show or accept. The current provider withdraws both; the
controlled case is in `antigravity-permissions.test.ts`.

Not fixed here: plan 195 step 2b changes no Process or supervisor approval
handling. Qualify a native child that emits an ACP permission frame first,
then route its approvals to a surface that can show them independently of
the root's turn, if that is the wanted behavior.

Found 2026-11-22 while reviewing plan 195 step 2b.
