# Server Cache Publication Safety

> Retained server caches may be stale only within their declared freshness
> contract. Async completion order must not duplicate source ranges, replace
> newer state, erase invalidation, or persist an older mutable revision.

Topic: server-cache-publication-safety

Status: Accepted correctness contract; the first transcript, discovery-index,
summary-index, project-snapshot, and Gemini mapping owners landed on
2026-08-24. Remaining audited surfaces are tracked in
[`docs/tactical/116-server-cache-concurrency-safety.md`](../docs/tactical/116-server-cache-concurrency-safety.md).

See also:

- [`architecture-mandates.md`](architecture-mandates.md)
- [`session-catalog-observation.md`](session-catalog-observation.md)
- [`session-index-validation.md`](session-index-validation.md)
- [`codex-metadata-scanner.md`](codex-metadata-scanner.md)
- [`server-performance-observability.md`](server-performance-observability.md)

## Ownership rules

An async cache lookup is not made safe by the JavaScript event loop. Any state
observed before an `await` can be obsolete when the continuation resumes. A
retained server cache therefore uses the smallest ownership mechanism that
matches its state:

- An immutable projection has one in-flight promise per complete key and
  source revision. Invalidation changes the revision accepted for publication.
- A mutable index has one canonical object per logical key. Cold callers join
  one load instead of loading separate objects that can both be mutated.
- Dirty work records a monotonically increasing change revision. A scan or
  validation may acknowledge only the revision it observed before starting;
  an invalidation arriving during work remains pending.
- Durable writes for one canonical file are serialized, use unique temporary
  files, and replace the canonical path by rename. A newer write becomes one
  trailing obligation rather than racing the active write.
- Promise cleanup checks owner identity. An older completion cannot remove a
  newer registered owner.

These rules are per logical cache key. They do not require one global lock or
serialization between unrelated projects, sessions, roots, or files.

## Implemented mutable-store contracts

### Codex discovery shards

`SessionDiscoveryIndexRegistry` resolves one process-local
`SessionDiscoveryIndex` for each normalized `(baseDir, provider, sourceRoot)`.
The project scanner, session readers, and watcher-side session index receive
the same registry from server startup. Within that owner, concurrent cold
access to one shard joins one disk load and all subsequent mutations target
the same canonical shard object. The existing per-shard save tail and atomic
replacement remain the durable publication boundary.

The discovery index remains derived and non-authoritative. Provider-file
enumeration decides visibility; an absent or discarded discovery row may cost
another bounded head read but may not resurrect or hide a provider session.

The registry is process-local. Running independent YA servers against one data
directory is not a distributed mutation protocol; atomic replacement prevents
partial files but does not merge arbitrary stale state between processes.

### Session summary indexes

All list, title, cached-summary, and single-summary APIs for one index scope
join one cold `SessionIndexState` load. They cannot publish separate mutable
objects from the same disk revision.

The server persists summary scopes and per-session rows atomically in SQLite.
Selected-session reads may query one durable row without hydrating a mutable
scope. They do not clear dirty revisions or advance complete-summary freshness.
An interrupted publication leaves the previous SQL scope intact. Writes touch
only rows whose summary or full title changed. A cold load stores the scope
again only when it repaired, upgraded or started it fresh; a scope read back
unchanged is not rewritten.

Every watcher or explicit invalidation advances the scope's dirty revision,
including repeated invalidation of an already-dirty session. Incremental,
full, and single-summary validation capture that revision before async work.
They clear dirty state only when no newer invalidation arrived. A request that
started before a change may return its coherent pre-change result; the newer
dirty work remains pending and the next applicable validation converges the
index.

### Project snapshots

`ProjectScanner` assigns every invalidation a new cache revision. A scan may be
returned to the caller that started it, but it becomes the retained fresh
snapshot only if no invalidation arrived during the scan. Otherwise the next
ordinary project read starts or joins work for the new revision rather than
waiting for the obsolete scan; completion cannot turn the dirty cache back to
clean.

Project snapshot persistence has one writer and at most one latest trailing
snapshot. Writes use unique temporary files and rename, and an invalidated
revision is discarded before canonical replacement. The disk snapshot remains
a disposable startup optimization and is accepted only when its recorded
source state still matches.

App disposal closes the project scanner after its consumers stop. Closing
unsubscribes observations, rejects new scans, drops the queued disposable
snapshot and awaits the active writer. A scan already in flight may finish for
its caller but cannot schedule persistence after close. No snapshot filesystem
work remains after disposal resolves, so its app-data directory can be removed.

### Gemini project mapping

The Gemini hash-to-project map is durable identity-adjacent state rather than
a disposable performance cache. One initial load is shared. `set`, `remove`,
`clean`, and explicit `save` operations run through one mutation tail; each
operation builds a private candidate, persists it atomically, and publishes it
to memory only after the rename succeeds. Reads wait for mutations already in
the tail. A persistence failure rejects the originating mutation, leaves the
last accepted map in memory and on disk, and does not prevent a later mutation
from retrying.

## Required deterministic tests

Concurrency tests use barriers around the relevant read, parse, scan, or write
boundary rather than sleeps. For every converted mutable store, cover:

- concurrent cold callers and one physical load;
- invalidation after work captures its input but before it publishes;
- an older durable write held while a newer mutation arrives;
- exact retained and restarted state after the overlap; and
- failure cleanup without leftover temporary files or a poisoned mutation
  tail.

The failing schedule should be understandable from the test itself. Random
stress may supplement these contracts, but it is not a substitute for them.
