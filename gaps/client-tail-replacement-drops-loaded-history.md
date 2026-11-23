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

A client-side fix: when replacing the tail, keep the loaded rows older than
the replacement's first row whose IDs the replacement does not contain
(they are history the server still serves under those IDs), and keep the
scroll anchor on a row present in both; fall back to today's replacement
only when no row overlaps.

Found 2026-11-23 while reworking plan 195 step 6 (review round 1).
