# A tail replacement drops the client's loaded older pages and scroll position

When a catch-up's anchor is missed, the detail route answers with the
latest page and its pagination, and the client replaces its whole window
with it (`replaceTailWindow` in
[transcriptReducer.ts](../packages/client/src/lib/sessionDetail/transcriptReducer.ts),
reached from `applyIncrementalRefresh` in
[sessionDetailCoordinator.ts](../packages/client/src/lib/sessionDetail/sessionDetailCoordinator.ts)).
Older pages the user had loaded, and the scroll position among them, are
lost; only unconfirmed sends are kept. The same happens when "Load older"
gets an empty page for a stale cursor and the client takes its tail again
(`loadOlderMessages` in
[useSessionMessages.ts](../packages/client/src/hooks/useSessionMessages.ts)).

This is shared by every provider whose IDs can change under a client:
Codex's stream and rollout IDs drift, and since plan 195 step 6 an
Antigravity owner that passes its soft budget moves rows into the brain log,
after which a client whose last fetched row left memory gets one such
replacement ([live memory](../topics/antigravity.md#live-memory)). Fixing it
in the server per provider would need a per-client record of what each
client holds, which the step 6 review showed to be the expensive part.

A client-side fix has a narrower premise than "keep the rows the
replacement lacks": an older loaded row whose ID is absent from the
replacement may itself be a pre-move live ID (an Antigravity row that has
left memory), which would show twice once an older page returns the log's
ID for the same step. So a loaded prefix may be kept only where verified
overlap (rows present in both windows, continuing without a gap) or
durable coordinates (log step IDs, which do not change) prove its
continuity with the replacement; otherwise fall back to today's
replacement. Keeping the scroll anchor on a row present in both is part of
that fix; recovering the exact scroll position after a miss with no such
row stays open.

Found 2026-11-23 while reworking plan 195 step 6 (review round 1).
Corrected 2026-11-23 from plan 195 step 6's review round 2.
