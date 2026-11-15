# The /btw aside poll reads full history where a status and tail would do

`pollBtwAside` in `packages/client/src/hooks/useBtwAsides.ts` requests the
aside session with `fullHistory: true` every 1.5 s, for up to 160 polls,
while the aside runs. Each reply rebuilds the aside's turns from every
message, including the parent transcript cloned into the fork. It needs only
the ownership status and the turns after the fork point. A cloned long session
makes each poll a whole-history server read and transfer.

The poll now stops when its view goes away, but this cost remains while it
runs. The source API's `getSession` takes no abort signal either, so a request
in flight at teardown still completes on the server; its reply is discarded.

The poll was left as it is because the right read belongs with the aside
feature, not with timer teardown. Candidates are a tail read (`tailTurns`, or
`afterMessageId` from the last seen message) with ownership. Another is the
live session stream the main view already uses. Check
[provider history facts](../topics/provider-history-facts.md) before choosing
a history-derived read.

Found 2026-11-15 while fixing the aside poll's teardown.
