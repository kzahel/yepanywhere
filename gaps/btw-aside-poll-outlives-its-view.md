# The /btw aside poll keeps fetching full history after its view is gone

`pollBtwAside` in `packages/client/src/hooks/useBtwAsides.ts` rearms itself
with `window.setTimeout(poll, 1500)` and keeps no handle. Each poll requests
the aside session with `fullHistory: true`. It stops only when the aside
completes or after 160 polls, about four minutes.

Leaving the session, or unmounting the hook for any other reason, does not
stop it: the requests continue and their results are written through
`updateBtwAside`. That is a client catch-up path with no teardown, which
[the architecture mandates](../topics/architecture-mandates.md#review-checklist)
require, and a repeated full-history read where a status read would do.

Cheap fix: keep the handle (or an abort flag) per aside and clear it in the
hook's cleanup and when the aside is dismissed. Whether the poll should read
full history at all belongs with the aside feature. Remove the file's
`detached` entry from `scripts/timer-ownership.json` in the same commit.

Found 2026-11-15 while recording the timer ownership baseline.
