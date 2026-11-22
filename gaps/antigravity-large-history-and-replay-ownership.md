# Antigravity history is size-limited and replay ownership is process-local

Opening a stopped root conversation, even for its latest messages, and resuming
it both use ACP `session/load`. That operation streams the whole conversation
and writes store-wide native files. Snapshots around a load of a stopped
conversation found its database content and log unchanged. YA's bounded native tail read checks
that replay reached the saved text. YA still accumulates normalized history in
memory and rejects replay beyond 8 MiB or 10,000 messages. The live projection
has the same cap. The limits apply to what YA retains, so the native database's
size alone cannot tell whether a session fits. See the
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
[Ownership guard](../packages/server/src/sdk/providers/antigravity-runtime.ts#L159)

The [saved long-session repro](../topics/native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
reopened 820 YA messages on `agy` 1.5.14. Its native database is about 41 MiB,
and its full JSONL log is about 5 MiB with three completed system checkpoints.
Records from before all three checkpoints remain in the log. Cold ACP history
in YA omits checkpoint boundaries. This sample leaves native behavior on
hundreds-of-megabytes histories unmeasured. A separate short `agy` 1.5.14 probe
with scripted inference verified that `session/resume` emitted no prior
messages and preserved prior context in the next model request. YA's cold
continuation still uses `session/load`.

Before selecting a fix, reproduce the size limit and the ownership races with
controlled replay, then qualify real `agy` on a large compacted conversation.
A latest-page read should be bounded and read-only, older pages should remain
available, and concurrent open, resume, and backend replacement should never
start a competing load beside a live owner. Evaluate the existing read-only
log reader for that view and measure native `session/resume` on large histories.
Replay completion for ambiguous tails has its own gap.

Plan 195 step 2 reproduced both limits with the controlled peer, as tests
named "today: …" in `antigravity.test.ts`: a replay over 8 MiB fails open and
resume, and a live session that passes the cap is stopped mid-turn. It also
measured real `agy` 1.5.13 and 1.5.14 on a 7,261-step compacted
conversation: `session/resume` answered in 37 ms with no replayed history
and kept the compacted context. The ownership races remain unreproduced.
[Measurements](../topics/antigravity-native-storage.md#measurements--plan-195-step-2)
[Read-only native log reader](../packages/server/src/sessions/antigravity-subagent-links.ts#L1050) ·
[Native storage and log format](../topics/antigravity-native-storage.md) ·
[Plan 195](../docs/tactical/195-antigravity-native-history.md) ·
[Replay completion gap](antigravity-acp-replay-completion-signal.md)

Found 2026-11-22 while investigating Antigravity reload continuity and large histories.
