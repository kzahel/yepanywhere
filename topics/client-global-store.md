# Client Global Store

> YA's client global store is a coarse, normalized cache of server-visible
> summary state. It is the place UI surfaces read shared facts about sessions,
> projects, queues, and inbox membership. It is not a transcript cache.

Topic: client-global-store

See also:

- [`ui-architecture.md`](ui-architecture.md)
- [`project-queue.md`](project-queue.md)
- [`sidebar-session-ordering.md`](sidebar-session-ordering.md)
- [`session-catalog-observation.md`](session-catalog-observation.md)
- [`session-summary-fidelity.md`](session-summary-fidelity.md)
- [`../docs/tactical/025-zustand-client-summary-store.md`](../docs/tactical/025-zustand-client-summary-store.md)
- [`../docs/tactical/026-client-summary-long-tail.md`](../docs/tactical/026-client-summary-long-tail.md)
- [`../docs/tactical/027-client-summary-source-registry.md`](../docs/tactical/027-client-summary-source-registry.md)

## Purpose

YA has several UI surfaces that render overlapping summaries of the same
underlying work:

- Sidebar;
- All Sessions;
- Inbox;
- Projects;
- New Session project chooser;
- Session Page composer affordances;
- Agents/process views.

When each surface fetches and caches its own row arrays, small feature work tends
to create inconsistencies: a badge appears in one place, a liveness hint appears
in another, and a stale response can undo a newer activity event. The global
store should be the center of gravity for shared summary facts so UI features
compose from the same records and projections.

The code uses the `clientSummary` name for this widened store shell. "Summary"
is intentional: it is a shared cache for coarse server-visible facts, not a home
for full session message data or provider transcript payloads.

In hosted remote mode, each connected backend host has its own summary cache.
Default hooks read from the current host's cache; future multi-host views must
use explicit cross-source selectors instead of making ordinary session surfaces
aggregate by accident.

## Boundary

The store owns coarse summary state:

- session summaries and query membership;
- project summaries and project list membership;
- project queue summaries;
- inbox tier membership;
- shared settings snapshots, once migrated;
- local lightweight decorations such as draft badges;
- observation timestamps for stale snapshot protection.

The store does not own heavy or page-local state:

- full messages;
- provider JSONL;
- streaming transcript deltas;
- rendered transcript bodies;
- composer text;
- upload progress internals;
- per-page filters, selection, expansion, and scroll state.

The Session Page can keep detailed live transcript state local while reporting
summary updates into the store. In particular, the complete composer string
stays in `MessageInput`/draft persistence. A stable session-scoped signal may
publish draft edits to narrow page-local consumers such as quote
reconciliation, and queued action leaves may subscribe to a primitive
composer-availability snapshot; neither belongs in the summary store.

Reactive primitive browser preferences also stay outside the summary store.
Their shared `localStorage` external-store interface lazily initializes an
in-memory snapshot, updates it through application setters, and reconciles
cross-tab storage events. A migration, settings import, or test that writes
storage directly must explicitly invalidate the affected key or all preference
snapshots. Unrelated React renders and direct same-tab DevTools writes do not
implicitly reread storage.

## Source Model

The store is per backend source. A source is the YA server that produced the
facts, such as:

- `local`;
- `host:<SavedHost.id>` for saved relay/direct remote hosts;
- `direct:<normalized-ws-url>` for unsaved direct remote fallbacks;
- `remote:none` while a hosted client is unauthenticated or switching hosts.

`ClientSummaryState` remains normalized per source. The registry above it maps
source keys to Zustand store instances. Current UI hooks select from the current
source only.

The store is fed by multiple inputs:

- REST snapshots from sessions, projects, inbox, and project queue APIs;
- settings API snapshots and successful settings mutations, once migrated;
- activity-bus events;
- successful local actions such as star/archive/rename and queue mutations;
- local browser facts such as draft presence, where appropriate.

REST snapshots are authoritative for what they queried, but they are not allowed
to overwrite newer field groups observed from events or local successful
actions within the same source. Missed activity events are healed by later REST
snapshots for that source.

Collection snapshots and activity events may contain only a subset of one
session's facts. Omitted fields preserve richer values already in the
normalized record; producers must not send compatibility placeholders for
facts they did not observe. The cross-layer fidelity and nondowngrade rules
live in [`session-summary-fidelity.md`](session-summary-fidelity.md).

The activity bus remains the fast event transport. The global store does not
replace it and does not make events durable. Activity events that reduce into
summary state must carry or capture their backend source so a host switch cannot
apply an old host event to the new host's cache.

### Catalog generations

Server collection snapshots and deltas carry the catalog lineage described in
[`session-catalog-observation.md`](session-catalog-observation.md): a
`catalogEpoch` plus monotonic `catalogGeneration`. The client keeps that pair
per source/query coverage. It can conditionally reconcile an already accepted
generation rather than asking the server to rebuild the same projection.

For collection streams, the source-owned decoded query view retains the latest
wire catalog/revision. Query coverage and request fencing advance on every valid
frame. The normalized display snapshot is republished for row, membership,
error/deadline or lineage changes and authoritative replacements. Raw-status
consumers also publish refresh status; Sidebar and Inbox explicitly select
initial-loading/error presentation and ignore boolean background-refresh toggles
between complete catalog observations. A catalog-counter-only update need not
reobserve unchanged rows. The normalized catalog clock therefore describes the
last display publication, not the live stream cursor.
See [session collection queries](session-collection-queries.md#bounded-navigation-enrichment).

Generation ordering does not flatten observation fidelity. A newer partial
event can advance selected field groups without proving a full list membership
or complete transcript summary. Source changes, catalog epoch changes, and
schema changes make a persisted generation incomparable and require a new
snapshot.

Within one tab, one retained `(sourceKey, queryKey)` entry owns acquisition,
event invalidation, debounce/deadline timers, and in-flight work. Component
subscriptions express coverage and render state; mounting the same hook twice
must not install two revalidation owners.

Session-list refreshes cover the already loaded window, including pages loaded
by scrolling. They publish the refreshed window atomically rather than
temporarily replacing it with the first page. Windows beyond the server's
500-row page limit refresh through bounded cursor pages before publication.

**Landed instance: the session-collection generation.** `GET /api/sessions`
carries one, and `useGlobalSessionsFeed` replays it as `knownGeneration` behind
`progressive-session-catalog` to be told `unchanged` instead of re-reading rows
it holds. That clock is the *list's*, not the catalog's — it advances on
anything that can change a rendered row, including metadata, unread state, and
ownership, which the catalog's row-oriented generation does not cover. Do not
conflate the two or persist one under the other's key.

A collection feed validates when its first client retainer becomes active and
when a connected client returns from background visibility. Local time-based
freshness cannot prove that the client observed events while it was inactive;
the conditional server generation makes this healing check cheap when the
collection is unchanged. Additional consumers of an already-retained query
reuse that query's live coverage rather than issuing their own activation read.

Offering an accepted generation claims the client still holds those rows, which
binds it to coverage and not only to content. A consumer widening its window
past the rows it retains needs rows; `unchanged` would answer it truthfully and
leave it short forever. The accepted generation is therefore stored per
`(source, query)` at module level — like any other shared per-source snapshot,
because `applySnapshot` runs in whichever consumer owns the request — and read
only together with a coverage check.

An optional browser-persistence adapter may store bounded, serializable compact
summary snapshots in IndexedDB, keyed by source/auth scope, schema, and catalog
epoch/generation. `BroadcastChannel` or a small `localStorage` notice can tell
sibling tabs that a newer generation exists; supported cross-tab locking may
elect one fetcher. This is only a cold-start optimization. Missing/evicted
storage, another device, or failed election falls back to the server, whose own
single-flight computation remains authoritative. Do not persist full
transcripts or provider payloads in the summary adapter.

### Recent-visit membership

Recent visits are bounded source-scoped membership: ordered session id,
project id, and visit timestamp records. They do not contain or require a
transcript or provider-aware session summary. A surface that displays recent
session rows composes membership with existing normalized session/project
records; a surface that only chooses a recent project reads project ids
directly.

Fetching recent membership must not resolve every visited session. In
particular, New Session project defaulting performs no provider, session-index,
or transcript work and does not delay its composer/provider/model regions.
Successful visit/clear/remove mutations update the captured source. A browser
recent-project shortcut is source-scoped as well; the same encoded path on two
hosts is not one preference.

A New Session URL already carries its requested project path. The form may
display that path before project discovery finishes, without inventing a
project record or session counts. An unchanged requested path remains a
selection awaiting resolution, not a request to create a new folder. Start
and Queue still require the resolved server project; an arriving canonical
path replaces the requested path only when the user has not edited it.

The implementation handoff is
[`docs/tactical/095-new-session-recent-project-readiness.md`](../docs/tactical/095-new-session-recent-project-readiness.md).

## Fetch Model

The retained query controller owns shared fetch mechanics:

- remote connection readiness;
- source/query key capture and compatible coverage;
- one in-flight acquisition and revalidation owner;
- event invalidation plus debounce/deadline timers;
- accepted server catalog epoch/generation;
- request start timestamps and loading/error state; and
- snapshot reporting into the store action supplied by the feed.

Feed hooks bind a component's need to that retained entry:

- current summary source key;
- pagination;
- required coverage; and
- controls/selectors exposed to the surface.

Store selectors own UI data:

```ts
const feed = useGlobalSessionsFeed(options);
const rows = useSessionQueryRecords(feed.query);
```

The UI should not render authoritative session/project row arrays returned
directly from data hooks. Feed hooks may expose query descriptors and controls;
selectors return the shared records/projections.

Feed hooks that publish snapshots capture the current source key when starting a
request and pass that key to report functions. A late response from
`host:macbook` updates the MacBook cache, even if the visible current source has
since changed to `host:winnative`.

### Retained query invariants

Five contracts hold the shared-fetch mechanics together. They are easy to
"simplify" into something that looks equivalent and is not.

**Coverage is a partial order, not a total one.** A request answers a need when
its coverage satisfies that need — more rows, stats included, more pages. Two
consumers of one key can therefore be mutually non-dominating, differing on
unrelated dimensions. Anywhere the code picks "the widest" it must tolerate
selecting several and fall back to running each; first-subscriber-wins silently
narrows coverage for everyone else.

Capable sources also retain [authoritative session/Inbox query updates](session-catalog-observation.md#authoritative-session-and-inbox-query-updates).
A pushed snapshot publishes through this controller, fences older HTTP results,
and cancels its queued activity revalidation. Membership and counts remain
server-owned. Reconnect starts with a bounded replacement; unsupported sources
retain the REST/event owner below.

**One revalidation owner per `(sourceKey, queryKey)`.** Retaining a query shares
its result; the machinery deciding *when* to refetch is shared separately, in
`lib/clientQueryRevalidation.ts`. Subscribers declare the events they care about
and how to run a revalidation; the owner unions the events, subscribes once to
each, keeps one debounce timer, and runs the widest subscribers. A feed hook
must not install its own activity listener and debounce timer beside the owner —
per-hook timers make one event cost one refetch per mounted consumer, and
whether those refetches collapse into one request depends on response latency.

**Deadline demand is per retainer; acquisition is source-owned.** Each Project
Queue consumer contributes its own server deadline or active-fallback need. One
source scheduler arms the earliest deadline and owns the pending acquisition and
bounded failure retry. Updating or releasing one contribution cannot cancel
another contribution's deadline, the shared request, or a still-needed retry;
the last remaining demand releases that ownership.

**A request's admission generation is immutable.** Each entry carries an
invalidation generation; a request records the generation under which it was
admitted and never changes it. Demand arriving after invalidation cannot join or
relabel that older request. Within one generation, accepted coverage also owns
publication: a narrower late success or failure cannot overwrite a broader
accepted result, while incomparable coverage remains independently applicable.
These rules keep a response from erasing the invalidation it raced or replacing
newer shared state merely because it settled last.

**A shared fetch needs a shared place to put the result.** `applySnapshot` runs
in the retained owner's closure, so a hook that keeps the value in its own
`useState` only ever sees the responses it happened to own — every other
consumer stays empty and refetches to fill itself in, which is the duplication
the retained query was meant to remove. Server-side facts therefore live in a
module-level per-source snapshot that consumers read through
`useSyncExternalStore`; the hook keeps only view state that genuinely differs
per consumer. `lib/devReloadStatusStore.ts` is the worked example: reload mode,
the persisted dirty flag, worker activity, and safe-restart state are shared,
while which banners are pending and which the viewer dismissed stay in the hook.
Moving a globally-mounted hook onto the controller without this step looks like
it works and quietly fetches once per mount.

**The app shell mounts each feed once.** Where a component both needs a feed and
is unmounted by ordinary navigation, the feed belongs in a provider above it
rather than mounted twice — once to retain coverage and once to read it. The
sidebar's `SidebarSessionFeedsProvider` is the worked example; its hook throws
when the provider is absent rather than falling back to mounting its own pair,
because a silent fallback restores the duplication it exists to remove.

### Startup ordering

A fresh tab mounts every app-shell hook in one commit, so without an ordering
the selected page's own facts compete with global feeds and diagnostics for
connection slots and the server's first turn. `lib/clientQueryBootstrap.ts`
gives each source one coordinator, and retained work declares a tier: `route`
for what the selected page needs to paint, `navigation` for shell counts and
coverage retained across routes, `supplementary` for diagnostics, enrichment,
and usage telemetry. A tier starts only once every earlier tier's registered
work has settled.

The project collection normally serves navigation, but New Session requests it
in the route tier: both its project selector and its default project selection
need that collection. A route consumer and the sidebar still share the same
source/query request; priority does not create a second collection cache or
fetch. An unrelated pending route request cannot hold this selector's request
behind the navigation gate.

These properties are load-bearing and easy to lose:

- **Only the first acquisition is gated.** Revalidation — reconnect, visibility
  restore, explicit refetch — never waits, so a stalled bootstrap cannot also
  stall recovery. Once the last tier opens the source is done and never gates
  again.
- **Opening is deferred by at least a microtask.** Everything in the mount
  commit registers before any tier is evaluated. Advancing eagerly lets a
  navigation hook that mounts first find no route work registered and open the
  gate on itself, which silently restores the unordered shape.
- **Lazy route modules retain priority until their hooks register.**
  `RouteModule` owns a route slot while suspended and settles it from a sibling
  after the selected page commits. Nested route boundaries hand the hold to
  each other before the ordering microtask; fast shell responses cannot finish
  bootstrap before a lazy page registers. Decorative Suspense boundaries do not
  join this hold. Revalidation retains the first-acquisition-only rule.
- **A blocked tier has a deadline.** Withholding decorative work is the goal;
  losing the shell to a hung route request is not.

A hook that owns its own acquisition rather than going through
`useRetainedClientQuery` joins by acquiring a slot directly;
`useGlobalSessionsFeed` is the worked example. Tiering is advisory ordering, not
a dependency graph: it must never be used to make one query's *correctness*
depend on another having run.

## Shape

Each per-source store should remain normalized:

```ts
{
  sessions: {
    entities: Map<sessionId, SessionRecord>,
    queries: Map<queryKey, SessionQueryState>
  },
  projects: {
    entities: Map<projectId, ProjectRecord>,
    queries: Map<queryKey, ProjectQueryState>
  },
  projectQueues: {
    byProject: Map<projectId, ProjectQueueSummaryState>
  },
  inbox: {
    tiers: Record<InboxTier, sessionId[]>
  }
}
```

The source registry wraps this shape:

```ts
Map<ClientSummarySourceKey, StoreApi<ClientSummaryState>>
```

Do not copy project facts onto every session. Compose them at selector time.
For example, a session card can read its session record, its project record, the
project queue summary, and local draft state to produce badges.

## Performance Contract

The registry may be global internally, but components should subscribe narrowly
to the current source's store.

Selectors should return stable values whenever the selected data did not change.
Hot row surfaces should not subscribe to the whole store. Updates should replace
only changed records and changed query membership arrays.

Changing the current source key must cause current-source hooks to resubscribe
to the new source's store. They must not keep rendering records from the
previous host while the new host is connecting or loading.

When new slices are added, add tests for:

- unchanged entity object identity after unrelated updates;
- unchanged query array identity when membership and record refs are stable;
- row render isolation for common list surfaces.

## Current Direction

The first widened-store step migrated the existing session collection substrate
to Zustand, then renamed the aggregate shell to `clientSummaryState` /
`clientSummaryStore` once project and queue slices made the older name too
narrow. The next slice added project summary records and project-list membership
to the same store, with `useProjects` and `useProject` feeding snapshots while
keeping request lifecycle local.

The next slice added project queue summaries. `useProjectQueues` remains the
feed/mutation hook, but queue snapshots, mutation responses, and
`project-queue-changed` events now reduce into the shared store. Sidebar keeps a
queue feed mounted for visible projects and reads `Q` badges from a store-owned
targeted-session selector.

All Sessions and Inbox now use the same Project Queue decoration path for
visible session cards. Session draft badges also read from client-summary local
decorations: the store wrapper owns the mounted `draft-message-*` localStorage
initial scan, cross-tab storage listener, and owned same-tab presence-event
subscription. It tears down both listeners when the last draft-decoration
consumer unmounts; no draft-decoration polling timer remains. Draft discovery
uses one private presence marker per `(source, session)` rather than a shared
read/modify/write set, so simultaneous tabs cannot overwrite one another's
index additions. Every successful envelope write reconciles its marker, even
when text remains nonempty, so a failed first marker write is repaired by the
next edit. Scans verify markers against their envelopes, prune stale markers,
and migrate the retired aggregate index when encountered.

The original session collection fields are now nested under `sessions`, matching
the documented normalized shape.

Inbox tier membership now lives in the summary store as ordered session ids.
`InboxContext` remains the feed/lifecycle boundary for remote readiness,
loading/error, stable tier ordering, debounced refetch, and refresh controls,
but accepted `/api/inbox` snapshots report partial session facts plus tier ids
into the store. Existing consumers still read through `useInboxContext`, whose
arrays are selected from the shared store.

The next likely work is tracked in
[`027-client-summary-source-registry.md`](../docs/tactical/027-client-summary-source-registry.md):
move the singleton Zustand store to a per-backend-source registry so hosted
remote host switches cannot leak Sidebar, Inbox, Project, or queue summary data
between machines. After that source boundary is in place,
[`026-client-summary-long-tail.md`](../docs/tactical/026-client-summary-long-tail.md)
continues the selector narrowing and hook retirement work.
