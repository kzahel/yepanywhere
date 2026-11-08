# Retained session reads re-project the whole catalog per read

`readRetainedSessionItems`
(`packages/server/src/routes/retained-session-collections.ts`) and the other
`projectCatalogIdentities` callers
(`packages/server/src/sessions/catalog-identity.ts`) project the whole published
catalog to public identities on each read, then apply per-row overlays. The
work is O(catalog), even when the catalog generation and identity store are
unchanged since the previous read.

## Measured

On the maintainer's macOS host (about 7,400 Claude and Codex rows), the
server's saved event-loop stall profiles from 2026-11-08 attribute 8–11 s of
every 30 s window to `readRetainedSessionItems`, alongside 1.5–2.3 s
event-loop stalls. About 6–9 s of that was in identity projection, which ran
a `SessionIdentityStore.lookupNative` point query per row and then a second
one per row inside `adoptDiscoveredBatch`. The rest (about 2.5 s) was the
per-row metadata, recap and runtime overlays. The callers are ordinary list
and project reads that clients repeat on `session-catalog-updated`.

## Bounded so far

Projection now reads existing bindings with one indexed query per provider
store (`lookupNativeBatch`, which selects only the requested ids through
`json_each`), and only rows without a consistent binding enter adoption. The
shared native-reference check tests for control characters with one regex
instead of iterating each path character. Nothing is retained between reads,
so the contract in [session identity](../topics/session-identity.md) is
unchanged. `pnpm --filter @yep-anywhere/server benchmark:catalog-identity`
(7,400 bound rows, `node:sqlite`) measured a warm projection at 115 ms before
and 29 ms after; cold adoption went from 147 ms to 110 ms, and a one-row
projection (session-source resolution) takes 0.02 ms. Bun was not measured.

Concurrent readers of one generation are not coalesced. The projection is
synchronous unless an OpenCode row needs a `realpath`, so concurrent calls do
not overlap and an in-flight owner would rarely join anything. Sharing work
across a burst of reads means retaining the result past completion.

## Remaining

Each full-catalog read still pays the 29 ms projection plus the overlays,
once per caller. The intended fix is the design in
[session catalog observation](../topics/session-catalog-observation.md#generations-and-coherent-projections):
project identities once per accepted catalog publication and serve
conditional deltas. Retention must be fenced by the catalog generation and by
identity-store state. That state includes `session_identities`,
`native_session_allocations` and OpenCode `realpath` evidence, so an
allocation, adoption or binding invalidates the projection.

Found 2026-11-08 while profiling Codex scanner fan-out on the maintainer's
host.
