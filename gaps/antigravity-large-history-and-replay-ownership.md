# Antigravity history is size-limited and replay ownership is process-local

Since plan 195 step 4, opening a stopped conversation reads a bounded page of
its brain log and starts no `agy`
([cold history from the log](../topics/antigravity.md#cold-history-from-the-log)).
Since step 5, resuming it uses ACP `session/resume`, which replays nothing:
the resumed session's earlier history is read from the log through its
resume point ([resume](../topics/antigravity.md#resume-and-the-live-view)).
Since step 8, nothing uses ACP `session/load`: a missing or unknown log is
one row saying its history cannot be shown, and such a conversation resumes
with `session/resume` too
([history YA cannot show](../topics/antigravity.md#history-ya-cannot-show)).
No history read starts `agy`, and the replay's 8 MiB / 10,000-message limit
is gone with it. Since step 6 a live session has no history limit: its owner keeps a bounded
recent window (a 2 MiB / 2,000-row soft budget), moves its boundary to a
proven split point past it once Process's replay buffer has let go of the
rows before it, and a cap of 8 MiB / 10,000 rows evicts the oldest row
instead of failing ([live memory](../topics/antigravity.md#live-memory)). See the
[reader](../packages/server/src/sessions/antigravity-reader.ts).

The owner registry uses the physical store and native ID as its key and
lives in process memory. Since step 8 readers never load, so a reader can no
longer start a competing `session/load` beside an owner in another process;
what remains for a Provider Host worker is that the backend reader joins the
log with a hosted owner's rows, which it reads from this registry today.
Concurrent use by independent YA servers or a separate native editor or CLI
is unqualified.
[Owner registry](../packages/server/src/sdk/providers/antigravity-owners.ts)

The [saved long-session repro](../topics/native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
reopened 820 YA messages on `agy` 1.5.14. Its native database is about 41 MiB,
and its full JSONL log is about 5 MiB with three completed system checkpoints.
Records from before all three checkpoints remain in the log. Cold ACP history
in YA omits checkpoint boundaries. This sample leaves native behavior on
hundreds-of-megabytes histories unmeasured. A separate short `agy` 1.5.14 probe
with scripted inference verified that `session/resume` emitted no prior
messages and preserved prior context in the next model request. That was
the evidence before plan 195; since step 5, YA's cold continuation of a
conversation with a readable log uses `session/resume`, and since step 8
every conversation does.

Before selecting a fix, reproduce the size limit and the ownership races with
controlled replay, then qualify real `agy` on a large compacted conversation.
A latest-page read should be bounded and read-only, older pages should remain
available, and concurrent open, resume, and backend replacement should never
start a competing load beside a live owner. Evaluate the existing read-only
log reader for that view and measure native `session/resume` on large histories.
Replay completion for ambiguous tails had its own gap, closed with the
replay in step 8.

Plan 195 step 2 reproduced both limits with the controlled peer, as tests
named "today: …" in `antigravity.test.ts`: a replay over 8 MiB fails open and
resume, and a live session that passes the cap is stopped mid-turn. Step 4
flipped the open half: a history over 8 MiB opens and pages from the log
with no `session/load`. Step 5 flipped the resume half: it resumes with no
replayed message retained. Step 6 flipped the live half: a session keeps
running past 8 MiB with its window bounded, and its history stays readable
while its split points can be proven from the log (a log that is replaced,
truncated or malformed at a split proves none, and past the cap the oldest
rows are then missing from the view, marked incomplete, until a later
split is proven). Step 2 also
measured real `agy` 1.5.13 and 1.5.14 on a 7,261-step compacted
conversation: `session/resume` answered in 37 ms with no replayed history
and kept the compacted context. Step 5 also tests the ownership races it
could reach with the controlled peer: a history read in the interval
between a resumed process's registration and its native lease waits and
issues no `session/load`, and one admitted just before the resume claims
the conversation is refused right before `session/load`. Step 8 removed
that fallback and those races with it: a missing or unknown log is a row
saying so, and every resume uses `session/resume`, qualified on real `agy`
1.5.13 and 1.5.14 for a missing log, an unknown one and a conversation
never prompted. What remains is that the owner registry and its window are
in one process's memory (step 9). Concurrent independent YA servers and
other native programs remain unqualified.
[Measurements](../topics/antigravity-native-storage.md#measurements--plan-195-step-2)
[Read-only native log reader](../packages/server/src/sessions/antigravity-subagent-links.ts#L1050) ·
[Native storage and log format](../topics/antigravity-native-storage.md) ·
[Plan 195](../docs/tactical/195-antigravity-native-history.md)

Found 2026-11-22 while investigating Antigravity reload continuity and large histories.
