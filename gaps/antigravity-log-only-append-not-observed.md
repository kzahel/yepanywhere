# A brain-log append without a database write is not observed

Since plan 195 step 4, cold Antigravity history comes from the brain log
(`brain/<id>/.system_generated/logs/transcript_full.jsonl`), but YA's
provider-root watcher still observes the conversation databases, their WALs
and the summaries index
([`antigravity-summaries.ts`](../packages/server/src/sessions/antigravity-summaries.ts#L109)),
not the brain directory. A stopped page refreshes only after one of those
changes. One sampled workload per `agy` version (1.5.13 and 1.5.14) found
the log complete before a refresh debounced 200 ms after a nearby WAL
change; on 1.5.13 the last log change came 0.1 ms after the last
foreground WAL change, and the next database change only at stop
([write order](../topics/antigravity-native-storage.md#write-order-and-refresh)).
That is sampled timing, not a write order for every turn, and an earlier
stale page seen on a shared server is still unexplained.

A log append with no later database write, from another program or a
future `agy`, would leave an open stopped page stale until its next
refresh. Not fixed in step 4: watching `brain/<id>` needs a recursive or
per-conversation watch outside the existing root watcher's bounded
non-recursive design, and the focused watch manager only accepts companion
files beside the main file. Plan 195
[step 7](../docs/tactical/195-antigravity-native-history.md#7--warn-on-an-external-writer),
which feeds native file changes for conversations YA does not own into
external-session tracking, is where log changes must be observed.

Found 2026-11-22 in plan 195 step 4, review round 2.
