# Source Review new sessions drop the opening session's router, sandbox, tier and instructions

`packages/server/src/review/reviewSessionLauncher.ts` `start` builds
`modelSettings` from provider, model, thinking and effort only; the client
copies those four from the session that opened Source Control
(`packages/client/src/pages/SessionPage.tsx`,
`lib/sourceControlNavigationState.ts`).

Dropped:

- Router binding: a review opened from a routed session runs on the owner's
  direct login.
- Sandbox level/firewall: a review from a `project-write` session runs
  unsandboxed. Owner-only (`routes/review-comments.ts` refuses limited
  users), so not an escalation, but it leaves the boundary the user chose.
- Service tier (cost), requested model alias, permission mode.
- `globalInstructions`: `Supervisor.startSession` does not fill it from
  server settings and the launcher has no source for it, so review sessions
  run without Global Instructions.
- Compact settings; see
  [the compact settings gap](compact-settings-resolved-only-on-project-start-route.md).

The reaped follow-up at `resumeSession` (same file) passes no settings, so it
also hits [the resume provider fallback](resume-without-provider-falls-back-to-default.md).

Fix: pass the source session id and inherit its settings server-side
(router via `inheritRouterBinding`, sandbox, tier), and supply global
instructions and compact settings as the creation route does.

Found 2026-11-08 while auditing launch paths for dropped session settings.
