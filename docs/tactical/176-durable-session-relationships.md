# Durable session relationships implementation

Topic: session-relationships

Status: implementation authorized 2026-11-04. The owning contract is
[durable session relationships](../../topics/session-relationships.md).

This work removes provider discovery from transcript delivery and records
accurate creation, lineage and native child evidence in the existing required
profile SQLite database. Existing identity, common admission and API receipt
owners remain authoritative. It follows [plan 171](171-durable-session-identity-and-creation.md)
and uses [plan 175](175-native-provider-integration-scenarios.md) for native
qualification. The [nested-harness reverse-link defect](../../gaps/nested-harness-session-not-linked-to-launcher.md)
is an acceptance input; a command that names a resumed harness proves launch,
not creation. The native fixture's Claude pin drift must be repaired before
claiming full-app qualification of the declared runtime.

## Substantial delivery slices

1. Shared SQL foundation: migration, typed scoped resources and edges, separate
   producer evidence, atomic durable checkpoints, replay, source replacement,
   restart, rollback and bounded incoming/outgoing queries. No wire changes.
2. Authoritative YA writers: common creation/copy/aside admission and trusted
   v0 receipts, identity resolution, peer scoping and durable reconciliation.
   Never infer trusted creators from descriptive client provenance.
3. Native child acquisition: qualify actual child spawning with real pinned
   executables and scripted local model APIs, then persist provider observations
   and resumable progress. Cover each retained native source; do not mistake
   Pi transcript-node parents for session children.
4. Nonblocking read integration: serve accepted SQL projections immediately,
   coalesce bounded discovery by exact source, reconcile source changes, and
   preserve existing child navigation. Remove the old independent cache owners
   as their consumers migrate. No per-session pollers or catalog scans.
5. Complete consumers and qualification: generic relationship query adapters,
   bounded nested-harness indexing, authorization, legacy projections, restart
   and source-change coverage, mobile loading/typing and measured detail latency.

Choose coherent implementation boundaries within these slices rather than
committing individual helpers. Update this ledger with completed behavior and
remaining qualification, including unsupported or unavailable provider/platform
cases. A foundation alone is not completion of the full design.

## Review and publication loop

At each substantial commit point, freeze the intended diff and request a
read-only review through the local YA API. The maintainer requested Claude
Opus 5.5, Work pool, Weekly pace policy, bypass permissions and high thinking /
effort. Discover these settings from the running server; do not substitute a
different account or provider. Retain private review/session evidence under
ignored `tasks/session-relationships/`, address actionable findings and rerun
affected checks before committing and pushing. Keep pool/account identifiers
and private histories out of this document and the repository.

Use actual executables against scripted local model APIs first. Live inference
is authorized when necessary for missing evidence, including small sanitized
fixtures, but is not a fallback that turns failed local-routing tests green.
Old Chrome-extension frontend against a newer server is excluded by the
maintainer. New hosted/mobile clients against supported older servers retain
their capability/fallback requirements. An internal SQL migration alone adds
no wire capability and changes no access grants.

## Progress

- Slice 1 implements additive schema v26 and the internal shared store: scoped
  typed resources, independently supported edges, immutable owner replay, fenced
  reconciliation, bounded last-observed evidence, atomic checkpoints and indexed
  incoming/outgoing reads. Partial replacement preserves last-known facts until
  completion. Real-SQL tests cover upgrade/reopen, rollback, stale/replayed work,
  scopes, repeated reconciliation and mixed-direction pagination. Node 22/24 and
  pinned Bun probes exercise the portable SQL boundary. There are no writers or
  wire changes yet. Ordering is stable hash/key order; provider-child projections
  must preserve their own established display order. Full evidence-history
  cursor navigation remains a query-adapter concern.
- Design and native qualification strategy recorded. Existing provider-child
  discovery still blocks detail until the read-integration slice lands.
