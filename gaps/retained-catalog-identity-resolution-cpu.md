# Retained session reads resolve every catalog row's identity per read

`readRetainedSessionItems`
(`packages/server/src/routes/retained-session-collections.ts`) calls
`projectCatalogIdentities` (`packages/server/src/sessions/catalog-identity.ts`)
over the whole published catalog on each read. That performs a
`SessionIdentityStore.lookupNative` SQLite lookup per row and runs
`adoptDiscoveredBatch` in a transaction, even when the catalog generation is
unchanged since the previous read.

On the maintainer's macOS host (about 7,400 Claude and Codex rows), the
server's saved event-loop stall profiles from 2026-11-08 attribute 8–11 s of
every 30 s window to `readRetainedSessionItems`. Most of that time is in
`projectCatalogIdentities` and `lookupNative`, alongside 1.5–2.3 s
event-loop stalls. The callers are ordinary list and project reads that
clients repeat on `session-catalog-updated`.

It was not fixed with the Codex scanner work because it is a separate
subsystem with its own identity contract
([session identity](../topics/session-identity.md)). The likely fix is to
retain the projected identities per catalog generation (and identity-store
revision), so an unchanged generation is not re-resolved, and to adopt only
rows new to that generation.

Found 2026-11-08 while profiling Codex scanner fan-out on the maintainer's
host.
