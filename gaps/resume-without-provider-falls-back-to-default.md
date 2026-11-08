# Resumes that pass no provider fall back to the server's default provider

`SessionActivationCoordinator.resolveColdLaunchSettings` restores model, tier,
thinking, effort and permission mode from saved settings but not
`providerName`, and `Supervisor.resolveProvider` returns the default provider
(`claude`) when none is given.

Callers that pass no provider:

- Wake turns: `packages/server/src/app.ts` (`supervisor.resumeSession` with
  `automaticSource: "wake"`, no model settings).
- Source Review follow-up after the process was reaped:
  `packages/server/src/review/reviewSessionLauncher.ts`.
- Project Queue existing-session items without `target.provider`:
  `ProjectQueueScheduler` fills `providerName ??= session?.provider` only on
  the limited-user path. The session page always sends a provider, so only
  API-created items are affected.

Consequence: `claude-gateway` and `claude-ollama` sessions share the native
`claude` family, so the resume address check accepts them, and they resume on
plain `claude` without the gateway/Ollama base URL, which means on the owner's
direct Anthropic login. Codex sessions fail the family check, so wake and
review follow-up are broken for them. Routed `claude` sessions are safe: the
stored router binding is applied in `startProviderSession` and fails closed.

Fix: restore `providerName` from session metadata in
`resolveColdLaunchSettings` (it already reads `metadata.getProvider` for
recovery) so every resume path inherits it.

Found 2026-11-08 while auditing resume paths for dropped session settings.
The wake and coordinator code was read directly; the gateway/Ollama
consequence was traced by a reviewer and not reproduced.
