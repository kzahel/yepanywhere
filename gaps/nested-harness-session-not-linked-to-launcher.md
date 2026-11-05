# A session launched by another session's background command shows no link back to its launcher

An agent can start a whole second harness process with a backgrounded Bash
call — `claude --resume <uuid> --print ... < task.md` — instead of a subagent.
The launcher now links out to that session: `detectNestedHarnessLaunch` reads
the resumed id from the command text and `NestedHarnessLaunchLink` renders it
under the command. See [`topics/nested-harness-launch.md`](../topics/nested-harness-launch.md).

The reverse edge is still missing. Open the launched session directly and
nothing says another session started it, so it still reads as orphaned work
from that side.

It cannot be derived from the child's own transcript. The evidence lives in
some other session's Bash command, so answering "who launched me" needs launch
edges indexed across a project's sessions and a server contract to carry them
to the client. `SessionIndexService` is the plausible home — the Claude summary
parse already streams every line, so collecting launched ids there is close to
free, and `enrichSessions` in `packages/server/src/routes/projects.ts` already
maps over a whole project's summaries and could invert them.

Not fixed with the outbound direction because the new response field is a
client/server compatibility decision under `topics/server-capabilities.md`,
needing a release corpus, a capability gate, and a stated missing-gate
fallback approved before implementation.

Also unrecovered: a launch with no `--resume`/`--session-id` names no session
at all. The child announces its new id in the init event of its
`--output-format stream-json` output, but that file is a harness-local
temporary under `/tmp/claude-<pid>/`, so reading it needs a new source with its
own lifetime and cleanup story.

Found 2026-08-17 while tracing why an "Opus 5 task btthdjvcf" reported by one
session appeared nowhere in YA's subagent visualization; narrowed the same day
when the launcher→child direction landed.


2026-11-05: plan 176 adds a scoped live Claude command-evidence producer using the
existing durable relationship index. It qualifies named same-project launches and
keeps pending correlation across API replacement. Historical corpus acquisition,
unnamed sessions, other parent families and a compatible reverse presentation
contract remain open; this defect is not closed by the internal producer.
