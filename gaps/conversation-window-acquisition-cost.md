# Conversation windows still need bounded native acquisition

The v0 conversation basics select a bounded normalized tail through the app's
incumbent Claude/Codex readers, report partial coverage rather than refusing
oversized projected input, and expose native backing-store descriptors. This
establishes the API contract without claiming efficient acquisition for every
provider or source shape.

The proposed [provider history facts and queries](../topics/provider-history-facts.md)
architecture now supplies the consumer inventory, common ownership
boundary and staged qualification. This gap remains open until native
acquisition is implemented and measured; the indexer runner is not a dependency.

The [headless v0 replay](../docs/research/190-mixed-provider-navigation-audit.md#headless-v0-session-reads)
isolates population size from history size. At a fixed 8,160 unrelated sessions,
an unchanged Claude follow on the longer synthetic fixture read about
1.27 MB per request with zero full catalog reads.

Remaining work belongs in this provider-history effort:

- Codex conversation reads pass the indexed summary hint (2026-11-14), so
  ordinary uncompressed rollouts with enough compactions take the compact
  tail. Rollouts below the reader's size estimate, reference-backed forks and
  compressed rollouts still take the complete reader.
- Claude's durable index handles accepted ordinary windows, but a first unseen
  source or an exceptional branch/rewind can still require a history scan.
- Message-count selection happens after native normalization. Large tool bodies
  and thinking can consume acquisition time and transient memory even though
  v0 excludes them. A byte-limited source suffix can return fewer visible
  messages than requested. Shared SQL facts should locate recent logical
  messages/compactions without copying full payloads into another store.
- `getSession` has no acquisition cancellation parameter. Conversation demand
  and publication stop at the existing deadline, but a native read already in
  progress can finish afterward. Keep in-flight ownership bounded; carry the
  cancellation/budget contract through the common reader rather than adding
  request-owned scanners or permanent retry loops.
- Readers are shared, but different compaction scopes use separate bounded
  observation leases. Consolidate equivalent source-version work when a native
  window interface is available. The legacy experimental file acquisition
  implementation still hashes its complete committed prefix after appends;
  production conversation reads now use the incumbent provider readers.
- Only Claude/Codex conversation acquisition is qualified. Backing-store
  metadata already describes file, shared database and provider-managed
  locations. Extend bounded history through the same interface for other
  providers, preserving branch/lineage evidence and explicit unsupported
  coverage. A path alone is not a complete-history guarantee.

Use [compact-tail pagination](../topics/session-compact-tail-pagination.md),
the [portable transcript direction](../topics/portable-transcript-compiler.md)
and [transcript indexer](../docs/tactical/192-transcript-indexer.md) as the
existing owners. The indexer's forward-ingest runner is not a prerequisite for
these request-path windows. Do not independently fix each lightweight consumer
with another whole-history cache.

Qualify cold/restart, unchanged and append reads by bytes acquired, records
parsed, retained memory, cancellation and source mutation, including no
compactions, oversized records, inherited Codex histories and Claude rewinds.
Keep native storage authoritative and derived SQL state in YA app data.

Found 2026-11-14 while implementing the requested v0 conversation API basics;
index and performance work was explicitly deferred for a holistic follow-up.
