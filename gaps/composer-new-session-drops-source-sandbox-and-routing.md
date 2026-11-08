# Session composer "New session" drops the source session's sandbox and router pool

The session page composer's New session action (start now and Project Queue)
builds the new session from mode, model, thinking, provider and executor only
(`packages/client/src/lib/sessionComposerSend.ts`, the `plan.startsNow`
options and the `createProjectQueueItem` new-session target). It never sends
`sandboxLevel`/`sandboxNetworkFirewall`, the router pool/account/policy, the
service tier or machine control.

Consequences, most severe first:

- **Sandbox:** from a `project-write`, firewalled `bypassPermissions` session,
  the new session runs with bypass, no sandbox and open network; the server
  treats an absent level as `none` (`Supervisor.ts` sandbox resolution,
  `SessionCreationStore.ts`). The session header still shows the sandbox
  badge, and `NewSessionQueueOptions.tsx` describes absent settings as "the
  composer's own session settings". Limited users are safe because the server
  forces their sandbox.
- **Account:** from a pool-routed session the new session runs on the owner's
  direct login, with the routed model id, which may not exist in the direct
  catalog. `SessionPage.tsx` gates restart, handoff and fork on
  `routedSession` but not this action.
- **Tier/machine control:** the tier falls to the provider default (cost);
  machine control is dropped (safer direction).

Fix: carry the source session's sandbox level/firewall and service tier, and
either carry its router binding (start now accepts router fields; queue needs
[the queue router gap](project-queue-drops-router-pool.md)) or refuse the
action for routed sessions the way restart/fork do.

Found 2026-11-08 while auditing launch paths for dropped session settings
after a queued session ran on the maintainer's personal account.
