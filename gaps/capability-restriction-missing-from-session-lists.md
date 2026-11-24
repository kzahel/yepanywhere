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

The catalog takes a Claude row's facts from the summary cache in
`indexes/SessionIndexService.ts`, whose persisted entries copy a fixed list
of fields, so the fact has to be added there too, and to the live
`session-updated` event (`watcher/EventBus.ts`,
`supervisor/ExternalSessionTracker.ts`, `supervisor/Supervisor.ts`).

This was not done with the header badge for two reasons.

- `SessionIndexService.ts`, `Supervisor.ts` and `clientSummaryState.ts` are
  each exactly at their line budget, so the wiring needs a move-only
  extraction from each first, as its own commit.
- A Claude catalog row is rebuilt from a bounded tail read while its summary
  is stale, which is the usual state of a session being worked in. That read
  cannot see an older fallback, so the row must continue its last known
  value through the new tail rows (`CapabilityRestrictionFold` takes an
  earlier summary for this) rather than drop it.

Found 2026-11-24 while adding the badge to the session header.
