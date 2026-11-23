# An Antigravity wake's partial snapshot is published as settled

A detached wake has no prompt result in ACP, so the adapter publishes each
snapshot of its reply as it streams, and it strips `_isStreaming` from
those snapshots before publishing them (the passive branch of `onUpdate`
in [antigravity.ts](../packages/server/src/sdk/providers/antigravity.ts)).
A partial wake reply therefore looks settled to every consumer of the
owner's rows. The frozen-share capture ends its completed prefix before
the first `_isStreaming` row (plan 195 step 6) and counts every row when
the Process is idle, so a frozen capture taken while a wake streams into
an idle session can include an unsettled wake row as completed history.

This predates step 6; the step 6 review (round 3) found it while probing
the frozen prefix. It was not fixed there because the right signal is
unsettled: marking the snapshots changes what every client keeps for a
wake, and the wake's end has no ACP event of its own (`usage_update` and
the root settlement probe are what the adapter uses today). A fix would
keep the mark until the wake settles and clear it in a final commit, and
qualify that against the browser's and v0's handling of a mark that
outlives a turn.

Found 2026-11-23 while fixing plan 195 step 6 (review round 3).
