# A backend reload interrupted active Antigravity work

On 2026-11-21 at 20:27:52 CET, the macOS development backend on
localhost:3400 (PID 54479) received `SIGHUP`. The shutdown log records two
Antigravity sessions losing their owners:

- **Checking Session Status** (YA `89d34ab1-e9cf-4c89-b000-edb8e76bfd02`)
  was unregistered `in-turn` while investigating the background-work gap.
- **Anti-Gravity Testing Background Task** (YA
  `233c7697-6083-469a-a9c8-73a3a2bf77e7`) was aborted with foreground
  state `idle`. At the interruption, native verification and a Codex review
  were pending. It later resumed and finished. The
  [cold replay gap](antigravity-cold-replay-drops-the-transcript-tail.md)
  explains why its final report was missing from reopened history.

The replacement backend (PID 73150) reported both as `not-running`. The
shared provider host stayed up and hosted Codex sessions detached. Antigravity
is explicitly [routed to the backend-local owner](../packages/server/src/sdk/providers/index.ts)
even with the host enabled, so [backend shutdown](../packages/server/src/server-provider-shutdown.ts)
cannot detach its processes.

The source of this reload is unconfirmed. The shutdown trace does not identify
a **Reload When Safe** request or its blocker snapshot. The
[safe restart contract](../topics/reload-safe-provider-runtimes.md#reload-ux-and-compatibility)
requires an active backend-local turn to block a scheduled reload.
`Supervisor.processHasInterruptibleActiveWork` in
[Supervisor.ts](../packages/server/src/supervisor/Supervisor.ts) counts
an `in-turn` local session. The related
[detached-wake gap](antigravity-detached-wakes-look-idle.md) can hide
background activity from that decision when foreground state is `idle`.

## Reproduction

The [opt-in native app cases](antigravity-detached-wakes-look-idle.md#reproduction)
reproduced two scheduled-reload failures on 2026-11-22 at `eb520d058` with
`agy` 1.5.13 and a scripted model. Both used private app instances.

- **Detached wake.** **Reload When Safe** correctly blocked an already-active
  foreground turn. While a later scheduled wake streamed a held native reply,
  the same endpoint reported zero blockers and accepted a restart. The wrapper
  logged an API-requested reload, the backend received `SIGHUP`, and the new
  backend reported `not-running` after the held response connection closed.
- **Late foreground work.** The test paused its own wrapper before reload
  acknowledgement. After [SafeRestartService](../packages/server/src/services/SafeRestartService.ts)
  changed to `restarting`, an ordinary message was accepted and reached the
  native model. The service then reported an active-session blocker while
  still `restarting`. Resuming the wrapper replaced the backend and closed
  the still-held foreground response.

The detached case also reproduced with live Gemini 3.8 Flash Low and installed
`agy` 1.5.14 in a disposable backend. Start the
[live schedule probe](antigravity-detached-wakes-look-idle.md#reproduction),
ask the wake to emit a longer list with an explicit end marker, and choose
**Reload When Safe** after the first wake text arrives while YA reports
`verified-idle`. The endpoint accepted with zero blockers, the backend took
`SIGHUP` and unregistered the owner with `reason: idle`, and the replacement
reported `not-running`. The live stream and native model steps both lacked the
end marker.

The November 21 reload source remains unconfirmed. A scheduled reload must
wait until non-detachable Antigravity work settles. An explicitly interrupting
reload should report the interruption.

Found 2026-11-21 while investigating an unfinished Antigravity turn after a
localhost backend reload.
