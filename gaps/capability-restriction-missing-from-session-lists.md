# The restricted capability badge is missing from session lists

The [restricted capability](../topics/provider-runtime-status.md#restricted-capability)
badge shows in an open session's header only. The sidebar, All Sessions and
Inbox rows do not show it, so a session that fell back to another model after
a refusal has to be opened to find out. The request that added the badge
asked for a list surface comparable to the async question button.

The fact already exists where lists cannot see it: Claude's full session
summary carries `capabilityRestriction`, but list rows are built from the
session catalog, which stores a fixed set of columns. The path to follow is
the one `asyncQuestions` takes:

- a JSON column on `session_catalog` (a new migration under
  `packages/server/src/storage/migrations/`), read and written in
  `services/session-catalog-sqlite.ts` and validated in
  `services/session-catalog-rows.ts`;
- `SessionListSummary` and `toSessionListSummary` in `sessions/types.ts`,
  the Claude rows in `sessions/catalog-adapters/collection-catalog-adapters.ts`,
  and the list routes (`routes/global-sessions.ts`,
  `routes/retained-session-item.ts`, `routes/inbox.ts`);
- the client collection record (`lib/clientSummaryCollections.ts`,
  `lib/sessionCollectionRecords.ts`, `lib/clientSummaryState.ts`,
  `hooks/useGlobalSessionsFeed.ts`), then `CapabilityRestrictionBadge` with
  `compact` in `components/SessionListItem.tsx` beside the provider badge.

Two things need deciding there. A Claude catalog row is rebuilt from a
bounded tail read while its summary is stale, and that read cannot see an
older fallback, so the row must keep its last known value rather than drop
it. And `clientSummaryState.ts` is at its line budget, so its wiring needs a
move-only extraction first.

Found 2026-11-24 while adding the badge to the session header.
