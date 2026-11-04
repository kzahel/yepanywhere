# A merged queued turn leaves its later chunks' "sent" echoes behind

`Process.queuePreparedMessage` (`packages/server/src/supervisor/Process.ts`)
emits a user echo for every message it queues, so the client shows each one as
"sent" while it actually waits in the provider queue for the turn to end. At
that boundary `concatUserMessages` (`packages/server/src/sdk/messageQueue.ts`)
joins them into one turn that keeps only the first message's `uuid`; other
chunks survive only as `tempIds`. A batch without temp ids (server-made
messages such as rendez uploads) therefore leaves every chunk after the first
with no durable counterpart, as a stale
"sent" bubble above the merged turn, which repeats their attachments. That
breaks the "one turn, no stale sent copy" contract in
`topics/message-control-steer-queue-btw-later-interrupt.md` § Deferred queue
reconciliation.

Observed 2026-10-21 in Codex session `01a156bf-2f81-75a3-a970-063e53ecfc2c`:
nine rendez screenshots uploaded over ten minutes of one turn arrived as a
single nine-attachment turn at its end, below the two latest uploads still
shown individually as "sent". Rendez uploads no longer take this path: they
steer, or wait as queued chips with temp ids, per `rendez.delivery`. Any other
id-only message queued during a turn (other `allowSteer: false` callers, a
steer the provider declines) still merges this way.

Cheap fix: record every chunk's `uuid` on the combined message beside
`tempIds` and clear echoes by either identity; or show a non-steered in-turn
message as queued instead of "sent" until the provider consumes it. A
regression should queue two id-only messages during a turn, drain at turn end,
and assert one rendered user turn.

Investigation update, 2026-11-04: real owned Claude 2.1.312, Codex 0.166.0
and Pi 1.4.0 runs reproduce the implicit `MessageQueue` join before the native
request. Actual captured echoes/history replayed through the client transcript
reducer retain B beside combined A+B for Claude/Codex, and A/B beside the native
combined row for Pi. This is native/reducer evidence, not a new browser pass.
Separately acknowledged native steers show Codex retaining both supplied IDs;
Claude writes a grouped row with B's UUID and `mergedSendUuids: [A]`. The field
survives normalization but is not used by reconciliation.
[Plan 175's recommendation](../docs/tactical/175-native-provider-integration-scenarios.md#input-batching-investigation-and-recommendation)
is ordinary FIFO transport plus authoritative native identity reconciliation.
Explicit opt-in/interrupt grouping and Pi's durable mapping remain separate
obligations. No production repair is included in this investigation.

Found 2026-10-21 while diagnosing batched rendez uploads.
