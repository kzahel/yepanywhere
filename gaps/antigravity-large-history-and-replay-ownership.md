# Antigravity history is size-limited and replay ownership is process-local

Since plan 195 step 4, opening a stopped conversation reads a bounded page of
its brain log and starts no `agy`
([cold history from the log](../topics/antigravity.md#cold-history-from-the-log)).
Since step 5, resuming it uses ACP `session/resume`, which replays nothing:
the resumed session's earlier history is read from the log through its
resume point ([resume](../topics/antigravity.md#resume-and-the-live-view)).
Only the fallback for a missing or unknown log, for viewing or resuming,
still uses ACP `session/load`. That operation streams the whole conversation
and writes store-wide native files. Snapshots around a load of a stopped
conversation found its database content and log unchanged. YA's bounded native tail read checks
that replay reached the saved text. For the fallback, YA still
accumulates normalized history in memory and rejects replay beyond 8 MiB or
10,000 messages; that limit applies to what YA retains, so the native
database's size alone cannot tell whether a fallback replay fits. Since
step 6 a live session has no history limit: its owner keeps only what the
log does not serve yet, moving its boundary as the log holds each turn,
and a cap evicts the oldest row instead of failing
([live memory](../topics/antigravity.md#live-memory)). See the
[reader](../packages/server/src/sessions/antigravity-reader.ts#L359),
[replay](../packages/server/src/sdk/providers/antigravity-replay.ts#L32),
and [history limits](../topics/antigravity.md#identity-and-history).

One backend already protects ordinary multi-browser viewing. Controlled ACP
probes showed four concurrent requests through one reader sharing a single
cold load, and three live requests across two readers issuing zero loads. A
different reader instance that encounters the held cold load returns no result
instead of sharing it. The ownership guard uses the physical store and native
ID as its key and lives in process memory.
If Antigravity moves to a Provider Host worker, the backend must be able to see
that worker's ownership before opening history. Otherwise it can start a
competing `session/load` against the same conversation. Concurrent use by
independent YA servers or a separate native editor or CLI is unqualified.
A resuming owner is visible to readers from the moment its provider
iterator runs, so a fallback read never loads ahead of it (step 5).
[Ownership guard](../packages/server/src/sdk/providers/antigravity-owners.ts)

The [saved long-session repro](../topics/native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
reopened 820 YA messages on `agy` 1.5.14. Its native database is about 41 MiB,
and its full JSONL log is about 5 MiB with three completed system checkpoints.
Records from before all three checkpoints remain in the log. Cold ACP history
in YA omits checkpoint boundaries. This sample leaves native behavior on
hundreds-of-megabytes histories unmeasured. A separate short `agy` 1.5.14 probe
with scripted inference verified that `session/resume` emitted no prior
messages and preserved prior context in the next model request. That was
the evidence before plan 195; since step 5, YA's cold continuation of a
conversation with a readable log uses `session/resume`, and only a missing
or unknown log still continues through `session/load`.

Before selecting a fix, reproduce the size limit and the ownership races with
controlled replay, then qualify real `agy` on a large compacted conversation.
A latest-page read should be bounded and read-only, older pages should remain
available, and concurrent open, resume, and backend replacement should never
start a competing load beside a live owner. Evaluate the existing read-only
log reader for that view and measure native `session/resume` on large histories.
Replay completion for ambiguous tails has its own gap.

Plan 195 step 2 reproduced both limits with the controlled peer, as tests
named "today: …" in `antigravity.test.ts`: a replay over 8 MiB fails open and
resume, and a live session that passes the cap is stopped mid-turn. Step 4
flipped the open half: a history over 8 MiB opens and pages from the log
with no `session/load`. Step 5 flipped the resume half: it resumes with no
replayed message retained. Step 6 flipped the live half: a session keeps
running past 8 MiB, retaining nothing once each turn is in the log, and
its whole history stays readable. Step 2 also
measured real `agy` 1.5.13 and 1.5.14 on a 7,261-step compacted
conversation: `session/resume` answered in 37 ms with no replayed history
and kept the compacted context. Step 5 also tests the ownership races it
could reach with the controlled peer: a history read in the interval
between a resumed process's registration and its native lease waits and
issues no `session/load`, and one admitted just before the resume claims
the conversation is refused right before `session/load`. What remains is
the fallback itself (a missing or unknown log, for viewing or resuming),
whose replay is still retained under the 8 MiB / 10,000-message cap, and
whose owner has no boundary, so only the live cap bounds it afterwards; a
v0 observer that held the log's rows when a fallback owner attached
replaces them at its next read (step 5 review round 1). The owner registry,
the cursor aliases and the replay retirement are in one process's memory
(step 9). Concurrent independent YA servers and other native programs
remain unqualified.
[Measurements](../topics/antigravity-native-storage.md#measurements--plan-195-step-2)
[Read-only native log reader](../packages/server/src/sessions/antigravity-subagent-links.ts#L1050) ·
[Native storage and log format](../topics/antigravity-native-storage.md) ·
[Plan 195](../docs/tactical/195-antigravity-native-history.md) ·
[Replay completion gap](antigravity-acp-replay-completion-signal.md)

Found 2026-11-22 while investigating Antigravity reload continuity and large histories.
