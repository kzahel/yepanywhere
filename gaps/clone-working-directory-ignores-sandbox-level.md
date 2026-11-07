# Clone uses the sandbox working copy even when the source is not sandboxed

The Claude clone path in `packages/server/src/routes/sessions.ts` passes
`originalMetadata?.sandboxProjectPath ?? project.path` to
`Supervisor.cloneSession`. Every other successor launch (fork, restart,
stale-session handoff, recap, retitle, fork-summary, and the Codex clone)
uses the sandbox working copy only when the source's sandbox level is
`project-write` (`sandboxWorkingProjectPath` in
`sessions/session-sandbox-inheritance.ts`). A source that is not
project-write but carries a `sandboxProjectPath` is cloned into it. A
session cannot leave project-write, but the state arises another way: a
fork, the helpers, a restart and a fork-summary continuation of an
unsandboxed source store the folder they were made in as
`sandboxProjectPath`, and moving such a session to another project keeps
it, so a clone made afterwards runs in the original project's folder. The
difference may be deliberate, but nothing documents it, and it is why the
restarts keep their sandbox records ("Remaining" under step 5 of plan
177).

Not fixed in place: step 1 of
[the session launch service plan](../docs/tactical/177-session-launch-service.md)
is a behavior-preserving consolidation. The cheap fix is to call
`sandboxWorkingProjectPath(originalMetadata, project.path)` there too, with
a clone case for a non-sandboxed source that carries a stale
`sandboxProjectPath`.

Two other differences noticed while mapping launch paths turned out not to be
drift: the Codex clone and the stale-session handoff record fewer fields from
the route than fork and restart do, but `SessionCreationStore.admit` already
records the provider, requested model, preferences and sandbox for every
durable creation and transcript copy.

Found 2026-11-06 while mapping session launch paths for plan 177.
