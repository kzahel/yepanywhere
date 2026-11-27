# v0 session lists and single-session misses still read the whole catalog

`GET /v0/servers/{serverId}/sessions` reads, reassembles, projects and sorts
every catalog row to return one page, on the server's main event loop
(`packages/server/src/core-api/production-sources.ts` `sessions`, through
`RetainedSessionCollections.read`). On a host with 8,160 sessions
`sessions?limit=1` took about 155 ms, and one client issuing it back to back
moved an unrelated `/api/version` request from 0.9 ms to a 333 ms median, with
60 of 60 probes over 100 ms.

A single-session read whose id the native-id index cannot establish takes the
same complete read: a missing, inaccessible or cross-project-ambiguous id, or
one its live owner disputes. That fallback is deliberate, because only the
complete read knows whether the catalog can establish absence
(`404 session_not_found` versus `503 catalog_not_ready`), but a caller polling
such an id pays it on every request.

Other population readers share the cost outside v0, including
`routes/session-content-search.ts` and callers of `retainedCollections.read()`
in `app.ts`. Retained recent visits now use indexed public sources. The
[mixed-provider replay](../docs/research/190-mixed-provider-navigation-audit.md#bounded-recent-visits)
records the separate first-build and warm costs.

The query itself is not the cost. All 8,160 rows came back from a copy of the
catalog database in about 17 ms, against the 155 ms list read above; on a
synthetic catalog of the same size one complete read with its projection cost
about 70 ms. The remainder is not profiled. Reading the code, `SessionCatalogService.remember`
serializes every row to size a 256-row cache and hands back a new object for
each row outside it, so the per-row-object cache in
`projectCatalogIdentityResult` misses and bindings are looked up again on
every read. Take a CPU profile before acting on that.

Not fixed with the single-session lookup because both remedies are larger and
belong to [plan 190](../docs/tactical/190-active-session-cost-at-scale.md):

- Serve the list from the retained SQL query owner
  ([collection queries](../topics/session-collection-queries.md)), which
  filters, orders and pages in SQL. It must keep v0's ordering, grant and
  hidden-project filtering, ambiguity omission and offset cursors.
- Or make the complete read itself cheaper, which also helps the non-v0
  readers above.
- For misses, decide catalog completeness without rows, from catalog state and
  the query owner's indexed withheld-conflict status.

Found 2026-11-20 while moving v0 single-session reads to the native-id index.
