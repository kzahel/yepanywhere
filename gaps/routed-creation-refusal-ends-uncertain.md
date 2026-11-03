# A router refusal at routed session creation ends as an unexplained `uncertain` creation

Creating a routed Claude session through `POST
/api/projects/:projectId/session-creations` returns 202. If AAR then refuses
the launch, for example because the pinned account's login lapsed, the
creation status settles at `state: "uncertain"`, `delivery: "uncertain"`.
The status carries no failure code or message, and nothing is logged:
`structuredErrorHandler` logs `agent_auth_router_refused` only for
synchronous routes. The synchronous resume path does report "The pinned
router account (name) needs to sign in again" (topics/agent-auth-router.md).

The router launch runs inside `Supervisor.runCreationAttempt`
(`packages/server/src/supervisor/Supervisor.ts`) after `beginDispatch`, so its
catch block calls `markUncertain` rather than
`failBeforeEffects(..., "launch-refused")`. A router refusal happens before
any provider effect, so a definitive refusal could fail before effects, and
the safe failure enum (`SessionCreationStore` `failure`) could gain a router
reason the client can explain. This was not changed here because creation
fencing, its failure vocabulary and client recovery fall under
[YA-owned session identity](../topics/session-identity.md), which needs that
review.

Found 2026-11-03 while verifying AAR lapsed-login errors against a standalone
YA server.
