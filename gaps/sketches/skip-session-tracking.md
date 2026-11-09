# Server-side Skip for provider sessions and demand-filled caches

Status: maintainer-requested sketch, not an approved migration. Start with a
performance simulation POC, preferably at the YA backend boundary; no POC or
performance measurement has been run for this sketch.

## Aim and placement

Evaluate [SkipLabs/skip](https://github.com/SkipLabs/skip) as the incremental
computation owner for provider-session tracking and derived server views.
The main quantity of interest is whether maintaining state this way enables
clients to selectively hold an authoritative view of their active sessions,
project worktrees, and related state. Routing overhead is the first feasibility
check; backend speed alone is not the principal outcome.
Consider embedding its TypeScript API in the provider service, in the YA
server, or running a separate reactive process. A provider-side graph could
survive Hono reloads; a YA-side graph is closer to catalog queries and rendering
metadata. A separate process adds serialization, failure, recovery, and
deployment costs. Choose ownership from the measured workload rather than
maintaining equivalent graphs in both services by default.

The maintainer reports the provider service as currently usable only on Linux.
For scope, treat Linux as the practical baseline. The checked-in
[runtime architecture](../../ARCHITECTURE.md#provider-runtime-ownership-and-reload)
also describes an opt-in macOS implementation, disabled by default because of
[active-turn interruptions](../macos-provider-host-turn-interruptions.md).
A backend-level POC avoids coupling this experiment to provider-host platform
repair; a whole-provider-service mock remains an alternative.

Candidates include session inventories, project/session joins, summary
projections, and lazy-filled caches such as project-path membership. Preserve
canonical YA session identity, provider-native history, source revisions,
field fidelity, and exact watcher invalidation. Skip should replace an owning
derivation mechanism where useful, not become another cache layered over the
same invalidation problem.

## Main evaluation: selective authoritative client views

Here, an **authoritative view** means the client provably holds the relevant
state for its declared scope at an accepted source revision. Covered queries
and rendering can therefore execute locally without introducing a server query
or waiting for validation. The maintainer explicitly accepts slight real-time
staleness from update propagation; proving coverage does not require proving
that no newer server update exists at the instant of a local read.

Establish completeness when admitting a snapshot and maintain it through
ordered updates, with a detectable gap/replacement boundary. Initial hydration
or expanding the scope may require acquisition; ordinary reads within an
already-covered scope must not reintroduce that wait. A disconnected client can
still know its coverage at the last accepted revision while losing its freshness
assurance. Exact acceptable propagation-delay bounds remain to be measured and
chosen. The provider transcript, filesystem, Git state, and YA-owned ancillary
stores retain their respective write authority. These are POC requirements,
not claims that Skip or YA already supplies the complete protocol.

The desired selectable scopes include:

- **Active sessions:** provider JSONL records and their interpreted transcript
  state, with explicit retained history coverage and correct append,
  truncation/replacement, and resubscription behavior.
- **Project worktrees:** subscribed filesystem paths, directory membership,
  and requested file contents. Selection must not imply copying an entire
  worktree or watching every historical project.
- **Ancillary state:** pending asynchronous-question counts and their underlying
  question identities/state, source-control status and requested diff views,
  and other summaries that depend on session or worktree changes.
- **Rendering inputs and open viewers:** substring highlighting and auto-linking
  facts that remain current as their dependencies change, plus optional automatic
  refresh of open file viewers without a manual refresh action. Preserve the
  user's position/selection where possible and distinguish changed, deleted,
  and replaced files; refreshing a viewer must not overwrite unsaved edits.

Evaluate whether these consumers can share a small set of maintained inputs
and derived subscriptions, with small immutable updates propagating only to
affected views. The client selects sessions, paths, and projections of interest;
closing or changing that interest should release unnecessary observation and
delivery work. A lazy query can populate a requested scope, while a subscription
keeps an active scope current. This distinction should be explicit in the API.

After the overhead stage, demonstrate a narrow end-to-end slice: a selected
session, its pending-question count, and one open worktree file with auto-refresh
enabled. Exercise transcript appends, question creation/resolution, file edits,
interest changes, and reconnect. Then extend to source-control and recognition
projections. Verify local query results against the selected authoritative
source revisions and measure update-to-visible latency, stale intervals,
round trips avoided, initial/delta bytes, client/server memory, and work done
outside the subscribed scope. Mixed filesystem/provider/Git inputs need an
explicit consistency boundary; a graph alone cannot make their observations
one atomic snapshot.

The principal success criterion is useful, correctly scoped client views with
bounded freshness and resource costs, and less bespoke synchronization logic.
The experiment must establish which guarantees come from Skip and which still
require YA source adapters, reconciliation, and client lifecycle management.

## Selection criterion: maintained computed state

The maintainer relays the Skip founder's advice: when update handling is simple
routing, such as delivering IRC messages, Skip adds no advantage over that
simple routing. Its value arises when updates must keep meaningful computed
state in sync, such as counts or relationships describing who converses with
whom. This is attributed design guidance, not a measured YA performance claim.

Apply that distinction before selecting a migration target. Provider event
forwarding alone is not a reason to introduce Skip. Session counts by project
or status, relationship joins, and dependent summary projections are better
candidates because they maintain computed properties across changes. A cache
qualifies only if its dependency maintenance benefits from the graph; merely
retaining or forwarding a value does not establish that benefit.

A routing-only POC is nevertheless a useful first stage: it quantifies framework
overhead on YA's expected workload without claiming to demonstrate the
framework's value. Model many retained sessions with usually only 1–5 active,
routing their updates into the chosen authoritative inputs and indexes, together
with filesystem notification subscriptions. Compare the same work with and
without Skip before implementing meaningful derived views.

The maintainer's hypothesis is that, if this overhead is acceptable, queryable
derived state and summaries can then fit naturally into the framework with
less application-level update logic. Place each derivation deliberately as
incrementally maintained/subscribed state or a lazy cached query, using correct,
small immutable updates in either case. Test this hypothesis with a second
workload that names the derived properties, their source dependencies, and the
existing update logic being replaced. Good performance and freshness depend
on that graph placement and correct source observation; routing throughput
alone establishes neither.

## Existing work and consumer boundaries

- [DuckDB transcript queries](duckdb-transcript-queries.md) is a separate,
  mostly orthogonal investigation of on-demand file queries and derived tables.
  The shared discovery context is persuasive Developer Voices interviews,
  not a proposed technical dependency between the two experiments.
- [Session catalog observation](../../topics/session-catalog-observation.md)
  already defines retained collections, bounded reconciliation, shared work,
  and freshness. Its [reconciliation plan](../../docs/tactical/093-provider-session-reconciliation.md)
  is the starting point, not a blank-slate catalog replacement.
- [Server cache publication](../../topics/server-cache-publication.md) owns
  cold-load sharing, revision fences, and durable publication ordering.
- [Project-path links](../../topics/project-path-links.md) use a demand-driven,
  in-memory directory cache backed by shared watcher leases. No eager tree
  crawl occurs on index construction. Unwatched facts require fresh probes.
  Inspect `packages/server/src/projects/projectPathIndex.ts` and
  `packages/server/src/augments/project-path-links.ts` for a second POC seam.
- Some recognition data is delivered in bulk to the session-render UI, notably
  glossary artifacts. Include these consumers when inventorying caches and
  measuring publication costs. Do not conflate them with a full project-path
  corpus: the current path-link contract deliberately sends bounded confirmed
  targets or annotated HTML. `TextBlock.tsx` consumes both `projectPathLinks`
  and a glossary artifact. Preserve that distinction when considering shared
  snapshots, deltas, or demand-based queries.
- [SQLite-backed cold storage](../sqlite-backed-cold-storage-startup.md) is the
  related proposal for moving large JSON metadata/index stores to bounded SQL
  reads. [Slow sidebar after restart](../sidebar-slow-after-server-restart.md)
  tracks the visible startup/reconnect cost. These overlap with session-history
  tracking, but neither means that all provider transcripts should move to SQL.
- [Per-session versus shared SQLite](prefer-per-session-sqlite-over-global-keyed-by-session.md)
  records the storage-layout trade-off, including the cross-session-query
  exception. Follow [runtime-portable SQLite](../../topics/required-sqlite.md)
  if the experiment adds a SQLite source adapter.

## What Skip provides, and what still belongs to YA

Source inspection on 2026-09-26 used upstream revision
[`56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10`](https://github.com/SkipLabs/skip/tree/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10).
These are framework capabilities, not measured YA benefits.

**Runtime.** The [upstream README](https://github.com/SkipLabs/skip/blob/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10/README.md)
describes a TypeScript API over Wasm or native runtimes, rather than a pure-JS
engine. Wasm is the default and is documented for Node and Bun, with a 32-bit
address-space limit; native installation is more involved. Verify the selected
package version and packaged YA platforms before adopting either. In-process
API use and a separate HTTP service are distinct deployment choices.

**Push: fully subscribed/populated within a defined scope.** Eager collections
maintain derived values as input changes arrive. A resource exposes an eager
result collection that clients can read or subscribe to. This fits compact
session inventories and active subscriptions. Fully populated must name its
scope: an eager project resource need not ingest every transcript or every
filesystem path. Initialization and ongoing maintenance still cost work.

**Pull: lazy cached query-back-to-truth.** `LazyCollection` computes keyed
values on demand and memoizes dependency-tracked work. Its truth is the inputs
represented in the graph; a lazy function is not an automatic asynchronous
filesystem/database read-through cache. External reads and change observation
need an adapter. The [core API](https://github.com/SkipLabs/skip/blob/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10/skipruntime-ts/core/src/api.ts)
requires resource outputs to be eager and documents lazy collections as
intermediate computations, with eager wrappers needed to expose them. An HTTP
GET instead of a subscription is another axis: it does not by itself make the
underlying graph lazy. Keep computation pure and bring mutable external truth
through explicit inputs or external services.

For path membership, a possible adapter would hydrate only requested
directories or exact candidates, feed versioned facts into Skip, and invalidate
them through the existing watcher owner. The POC must establish whether this
actually simplifies the current mechanism, including cached absence,
incomplete listings, missed events, and eviction. A zero-I/O warm cache hit is
the baseline to preserve, not a benefit Skip gets credit for introducing.

**Filesystem subscriptions.** The inspected [external-source documentation](https://github.com/SkipLabs/skip/blob/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10/www/docs/externals.md)
provides `ExternalService.subscribe`/`unsubscribe`, initial/update callbacks,
and shutdown integration. It lists Skip, PostgreSQL, Kafka, and polled HTTP
adapters. No ready-made filesystem watcher adapter was found in the inspected
runtime, helper, example, and documentation sources. The useful support is
the adapter lifecycle and downstream incremental propagation; YA would still
own OS watches, race-free initial snapshots, rename/delete interpretation,
overflow repair, source-version fencing, and release of unused watches.
Do not replace existing watch sharing with one watcher per resource or client.

**Persistence is a separate decision.** The repository also contains SKDB, a
reactive SQL database; it is distinct from the Skip reactive-service framework.
The inspected service API and deployment docs do not establish a switchable
in-memory/on-disk persistence backend for the framework's computation graph.
Treat configurable graph persistence as unverified, not an assumed feature.
External durable storage can feed a graph, but storage choice, hydration,
restart recovery, and migration remain explicit design work.

Using more on-disk database reads/writes may be strictly slower or otherwise
worse for hot, small, already-cached workloads. It may nevertheless be desirable
for bounded RAM, cold history queries, and restart readiness. Separate durable
user metadata from disposable derived caches and provider-owned transcripts.
Compare an in-memory graph with durable-source variants; do not infer that Skip
requires a database or that adding one improves performance.

## PostgreSQL, product history, and client replicas

**PostgreSQL change subscriptions are real, with a narrower adapter contract
than arbitrary SQL-query subscriptions.** The inspected
[PostgreSQL adapter](https://github.com/SkipLabs/skip/blob/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10/skipruntime-ts/adapters/postgres/src/index.ts)
initially reads a table, installs row triggers calling `pg_notify`, and listens
with `LISTEN`. A notification carries a key; the adapter queries that key's
current rows and updates the reactive collection. Skip can then maintain
derived query results and stream their changes. This is not evidence of a
general PostgreSQL arbitrary-query change-feed API. The maintainer notes that
YA does not use PostgreSQL yet; this integration is useful precedent, not a
reason to add a PostgreSQL deployment requirement to the first POC.

**Reported SKDB product history.** The maintainer reports that SkipLabs built
a SQLite reimplementation with acceptable performance, then abandoned it as a
product because it was hard to sell. Preserve this as attributed background;
the product decision, performance assessment, and exact SQLite-compatibility
scope were not independently verified here. The inspected repository still
contains SKDB source, which does not establish continued commercial focus.

**Client replicas motivate the main evaluation.** The maintainer reports that a
common use is keeping a client replica of server state for snappy incremental
search and edits whose immediate UI response needs no round trip. The
[client protocol](https://github.com/SkipLabs/skip/blob/56e6a3bed3f4e804cbf4f705f8a9f0c9d1533e10/www/docs/client.md)
does document a complete resource `init` followed by keyed `update` events over
server-sent events. Clients can maintain a local projection from that stream
without importing the Skip runtime. Local filtering/search over the replicated
subset is a plausible YA use; prevalence and turnkey optimistic-edit support
are not established by those docs.

The proposed end-to-end model puts the relevant server projection under Skip's
reactive collections and treats mapper-visible values as immutable or tracked,
so changes flow through declared dependencies. For Skip to keep that projection
current, every relevant source change must reach its inputs or external-source
adapter. This does not require the authoritative database or all server state
to be implemented in Skip: PostgreSQL integration is a counterexample. Nor is
Skip a general prerequisite for synchronizing replicas; the requirement is
specific to using its maintained graph and update stream for this purpose.

Separate local draft/optimistic edits from accepted server state. Snapshot and
update delivery alone do not settle write acknowledgement, rejection, conflicts,
ordering, reconnect, or reconciliation with pending local edits. A later client
POC should exercise those cases, initial replica size, subset/search coverage,
and authorization changes. Compare a lightweight client projection with a
client-side Skip graph before adding runtime or memory costs to mobile clients.
The initial backend POC remains an overhead check. Follow it with the selective
client-view slice above to evaluate the main objective, without requiring a
wholesale client state rewrite.

## Initial performance simulation POC

1. **Choose the backend seam and retain a baseline.** Prefer mocked provider
   events, catalog reads, and filesystem facts feeding the real YA backend
   acquisition/publication path. Replay the same deterministic trace through
   today's implementation and a Skip-backed candidate. A whole-provider-service
   mock is useful later for ownership/reload behavior; neither mock proves real
   SDK or native watcher correctness.
   The first deliverable may stop at routing and index/input updates with
   filesystem subscription setup, delivery, and teardown. Use many retained
   sessions and 1, 3, and 5 active sessions as the ordinary workload, plus an
   all-idle case and separately labelled higher-concurrency stress. Hold
   storage, event traces, and index semantics equivalent across implementations
   so this stage isolates overhead rather than a storage redesign. Simulated
   notifications give reproducible schedules; a bounded real-filesystem check
   is still needed before claiming native notification costs or correctness.
2. **Vary demand and churn independently.** Exercise small and large histories,
   sparse hot sessions, broad list reads, many idle sessions, simultaneous
   reconnects, repeated keyed queries, and bursts of updates. Include cold
   startup, warm hits, project switches, rename/delete/recreate, missed watcher
   events, and unsubscribe/re-subscribe. Count unnecessary untouched-row work.
3. **Separate the choices.** First compare current caches with an in-process
   Skip graph over equivalent in-memory facts. Then vary eager versus lazy
   derivation, durable SQLite-backed facts versus memory, and finally a separate
   process. Avoid attributing a multi-change result to Skip alone. Pin runtime,
   package revision, trace, and cache state for every comparison.
   After the overhead stage, add counts, relationships, or queryable summaries
   using keyed immutable changes rather than whole-corpus replacement. Compare
   eager/subscribed maintenance and lazy recomputation under identical demand;
   inspect how much manual dependency/invalidation logic each actually removes.
4. **Measure the full cost.** Record startup-to-first-usable-catalog, cold/warm
   query and update-to-consumer p50/p95/p99, CPU/event-loop delay, total memory
   including Wasm/native/process overhead, filesystem calls, DB reads/writes,
   bytes written, watcher count, graph/resource retention, and transport bytes.
   For bulk recognizers, include initial serialization, repeated publication,
   client parse/match cost, and whether one changed fact resends the corpus.
5. **Check correctness and lifecycle before claiming a win.** Compare each
   result against a from-scratch oracle over authoritative fixture state.
   Test mutation during hydration, stale completion, reconnect/restart, errors,
   and final unsubscribe. Preserve explicit unknown/stale states and access
   boundaries. Verify no idle scans, retained orphan resources, or leaked
   watchers. Backend timings alone do not prove UI responsiveness; a later
   consumer check must include real sequential typing under concurrent updates.

An overhead-only result is a valid first POC outcome, with derived-state value
and selective authoritative client views explicitly untested. Proceed to
production adoption only when the POC shows a useful measured trade-off and
names which existing cache/invalidation owner it
can replace. Keeping the current mechanism, using Skip only for one projection,
or adopting bounded SQL storage without Skip are all valid outcomes. This sketch
changes no roadmap priority and authorizes no production migration.

Captured 2026-09-26 at the maintainer's request.
Contributing-model: 6-Astra
