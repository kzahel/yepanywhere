# A queued stale-session handoff never gets its handoff title

`POST .../stale-handoff` in `packages/server/src/routes/sessions.ts` starts a
new session seeded with a handoff of a cold one. When a worker is free, the
route titles the new session after the source (`deriveRestartTitle`) and
emits `session-metadata-changed`. When every worker is busy, the Supervisor
queues the launch and the route answers 202 with the queue position; the
client says the session will appear when it starts. Nothing writes the title
when the queued launch later starts, so that session falls back to whatever
title its transcript yields, whose first message is the handoff text,
instead of the source's title. The lineage (`continuedFrom`) is recorded
either way, through the creation record.

Not fixed in place: step 3 of
[the session launch service plan](../docs/tactical/177-session-launch-service.md)
only consolidated how routes read a launch result, and step 5 left a
handoff's title with the route because admission is not told it. The fix
needs the title to travel with the queued launch: a title on the creation
request that `SessionCreationStore` records at admission, as it already does
for a transcript copy's title
([launch metadata owners](../topics/core-service-api.md#session-launch-metadata-owners)).

Found 2026-11-06 while consolidating the launch-outcome mapping (plan 177
step 3).
