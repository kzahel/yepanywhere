# A session launched by another session's background command shows no link back to its launcher

An agent can start a whole second harness process with a backgrounded Bash
call — `claude --resume <uuid> --print ... < task.md` — instead of a subagent.
The launcher now links out to that session: `detectNestedHarnessLaunch` reads
the resumed id from the command text and `NestedHarnessLaunchLink` renders it
under the command. See [`topics/nested-harness-launch.md`](../topics/nested-harness-launch.md).

The reverse edge is now presented in Session Info for accepted, resolved local
launches on supported servers. Unnamed launches and histories not acquired by
the bounded observer can still appear orphaned; those sources remain the open
part of this finding.

It cannot be derived from the child's own transcript. The evidence lives in
some other session's Bash command. The durable relationship owner now indexes
qualified command evidence; the public page reads SQL without scanning other
transcripts. Acquisition remains separate and deliberately incomplete rather
than blocking session delivery on a whole-project scan.

The maintainer approved the compatible reverse presentation on 2026-11-06:
one temporary capability check, omission on older servers and no legacy loader.
The [owning contract](../topics/session-relationships.md#session-info-and-reverse-navigation)
records its desktop/phone and source-lifetime behavior.

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
contract were open; this defect was not closed by the internal producer.

2026-11-06: bounded historical acquisition, qualified live Claude/Codex launch
sources and the operator Session Info projection are implemented. Arbitrary
unseen histories, unnamed launches, legacy copy boundaries and other parent
harness families remain unqualified; this entry stays open for those sources.
