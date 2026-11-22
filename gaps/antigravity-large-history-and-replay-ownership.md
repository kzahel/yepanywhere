# Antigravity history is size-limited and replay ownership is process-local

Opening a stopped root conversation, even for its latest messages, and resuming
it both use ACP `session/load`. That operation streams the whole conversation
and can rewrite native continuation files. YA's bounded native tail read checks
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
[Read-only native log reader](../packages/server/src/sessions/antigravity-subagent-links.ts#L1050) ·
[Replay completion gap](antigravity-acp-replay-completion-signal.md)

Found 2026-11-22 while investigating Antigravity reload continuity and large histories.
