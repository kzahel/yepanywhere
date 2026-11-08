# Server child launchers each hand-roll process-group signalling

`signalProcessTree` and `processTreeSpawnOptions` in
`packages/server/src/utils/processTree.ts` own "start a command as its own
process group and signal the whole tree" (POSIX `detached` plus
`process.kill(-pid)`, Windows `taskkill /T /F`). Only
`ArtifactRebuildService` uses them. Three older launchers keep private copies
that already differ:

- `ProjectQueueReadinessCheck.stopChild` — bounded `taskkill`, then kills the
  child and destroys its pipes; POSIX group SIGKILL, rethrowing non-`ESRCH`.
- `BangCommandService.signalEntry` — group signal with a silent fallback to
  the child; no Windows tree kill.
- `signalGatewayChild` in `sdk/providers/claude-gateway-launcher.ts` — group
  signal on POSIX, plain `child.kill` on Windows.

So a Windows bang command or gateway start command that starts helpers leaves
them running when YA stops it, while the readiness check and rebuild do not.
Not fixed in place: each caller's stop sequence (grace, pipe handling,
disposal waits) is its own contract, and migrating them was outside the
rebuild-timeout fix. The cheap fix moves each caller onto the shared helper,
keeping its own timing, and checks on Windows that the tree is stopped.

Found 2026-09-27 while fixing harsh review 69501d94..f2daae2c item [14-7]
(rebuild timeout left grandchild processes running).

## Provider processes (added 2026-11-08)

Provider adapters stop their own child processes in at least four different
ways, checked against `packages/server/src/sdk/providers/` on 2026-11-08:

- `codex.ts` keeps a private `terminateChildProcess`. It spawns the
  app-server `detached` on POSIX and sends the group SIGTERM, then SIGKILL
  after a grace period. On Windows it uses `taskkill /T /F`.
- `acp/client.ts` (Gemini ACP, Grok ACP) uses the shared
  `signalProcessTree`, SIGTERM then SIGKILL.
- `antigravity-runtime.ts` hand-rolls a group signal on POSIX and a plain
  `child.kill` on Windows.
- `claude.ts` (both the routed and local provider abort paths), `pi.ts`,
  `pi-rpc-client.ts`, `opencode.ts` and `codex-oss.ts` send a plain
  `child.kill("SIGTERM")`. They do not spawn a process group and never
  escalate. A provider CLI that ignores SIGTERM, or that started its own
  helpers, can outlive the stop.

`utils/processTree.ts` is the obvious owner. Besides ACP it is used by
`ArtifactRebuildService`, `ProviderLoginService`, `ProjectServiceProcess`
and `projects/template-runtime.ts`. Not fixed in place: this was found during
a move-only split of `codex.ts` (058 slice 4.4). Each provider's stop timing
also interacts with its own abort and turn contracts. Move one provider at a
time onto `processTreeSpawnOptions` and `signalProcessTree` with an
escalation timeout. Start with opencode and pi, which own long-lived server
or RPC processes. For each one, add a native-provider scenario that stops a
turn and checks that no child outlives it.
