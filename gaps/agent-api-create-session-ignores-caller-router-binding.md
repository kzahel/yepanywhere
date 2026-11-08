# Agent API createSession launches on the direct login even when a routed session calls it

`packages/server/src/core-api/native-session-commands.ts` `start` passes
provider, model, thinking and tier to `supervisor.startSession`, but the
request schema (`core-api/command-contracts.ts`) has no router fields and
nothing inherits the calling session's binding (`receipt.creator.sessionId`).
`Supervisor.agentApiForLaunch` withholds the Agent API only from sandboxed and
executor launches, so routed sessions have it, including management authority.

Consequence: an agent running on a pool account can start child sessions that
spend the owner's personal, rate-limited login. `topics/agent-auth-router.md`
"Supported slice and limits" does not list this path as refused.

The same launch also skips `resolveCompactModelSettings`; see
[the compact settings gap](compact-settings-resolved-only-on-project-start-route.md).

Fix: when the creator is a routed session, inherit its binding with a child
binding (`Supervisor.inheritRouterBinding` / `AgentAuthRouter.inheritBinding`)
or refuse; optionally accept explicit router fields gated by the caller's
grants. Never fall back to Direct for a routed caller.

Found 2026-11-08 while auditing launch paths for dropped session settings.
