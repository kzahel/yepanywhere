# Router account switch kills in-flight turns and background work

`POST /api/agent-auth-router/sessions/:id/switch`
(`packages/server/src/routes/agent-auth-router-session-switch.ts`) moves the
session to a new pin by calling `abortSessionWithVerification` right after
saving the binding. The provider process has to be replaced, because the
routed credential is fixed at launch. This works, but it happens
"whatever its state" (docs/tactical/185, Behaviour), so a switch made while
the session is busy silently destroys:

- a streaming turn and any tool call that is running (a Bash command, an
  edit sequence half applied);
- provider background work that outlives the turn: Claude
  `run_in_background` shells, background subagents, monitors; Codex
  background terminals;
- queued or deferred input that the process held.

The next message resumes the transcript on the new account, but the killed
work is not resumed and nothing tells the user what was lost. The Account
pane gives no warning either.

The supervisor already knows when a session is not quiet: the project-idle
predicate (`packages/server/src/services/projectWorkIdle.ts`) checks
`in-turn`/`waiting-input` state, `isRetainingProviderWork()`, queue depth,
deferred queue and pending input. Fix direction, to decide before
implementing:

1. **Deferred switch (preferred).** Prepare and commit the new pin as now,
   but leave the old process running. Replace it at the first moment the
   per-session version of that predicate is quiet, before the next message
   would launch. The pane shows "switching after current work finishes",
   with a "switch now" control that keeps today's kill.
2. **Refuse while busy.** Return 409 with the blocker list. Simpler, but the
   user has to come back and retry.

Either way, the old allocation's cancellation has to wait until the old
process has actually exited. The existing late-registration refusal must
keep covering a resume that raced the switch.

Found 2026-11-10 while gating the Direct chip on a router that serves the
session's provider.
