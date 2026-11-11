# Cheap sidebar SQL reads and fresh membership

Status: production foundation qualified, 2026-11-11. Default aggregate client
adoption remains deferred by its end-to-end performance gate.

The maintainer selected cheap authoritative reads before further client membership
optimizations. Pointer/focus retention is not behavior to preserve. The architecture
is one SQL-owned catalog/query projection, bounded selected-row reads and existing
canonical metadata/seen/runtime authorities, without another session mirror.

This follows [plan 190](../tactical/190-active-session-cost-at-scale.md),
[active-session costs](../../gaps/active-session-tab-background-cost.md) and
[remaining catalog costs](../../gaps/session-catalog-rewrites-whole-generation-per-change.md).

## Implemented boundary

All retained session/Inbox selections now hydrate selected rows in batches of at
most 256, preserving canonical timestamp/locale tie order. No unselected payload
is decoded. The existing query owner and statement ceiling are unchanged.

`GET /api/sessions/sidebar` synchronizes that owner once, then selects independent
recent, starred and categorized windows. Limits default to 50 and accept integers
1–500. Rows are deduplicated across windows. The response contains `rows`,
`windows` (IDs/hasMore), `catalog` and an optional archive deadline; it omits
repeated project dictionaries/global stats. Grants apply before limits. The real
limited-user middleware treats this as a collection and projects visible rows
and window IDs together. `Server-Timing` exposes synchronization, selection,
hydration, serialization and total route clocks.

The exact optional `sidebar-session-snapshot` bit names this API and retained
`/api/sessions` timestamp/identity cursors. JSON `[updatedAt,id]` continuations
select remaining locale-ordered ties, then strictly older rows, without skipped
anchors or whole-tie payload decoding. Malformed cursor JSON preserves the old
empty-page behavior; SQL failures propagate. No schema migration is needed.

The client retains existing three-feed/collection-update acquisition. On capable
servers it renders accepted window membership, so cached old stars/categories
cannot resurrect omitted rows. Pointer/focus holds are removed. Hidden navigation
releases acquisition. Compact rows compare display values independently of
freshness clocks; their delivery decoration uses a shallow value subscription.
Callbacks, changed DTO values, context and local input remain live. Detailed
cards retain existing age refreshes; compact hover ages update when opened.
There is no second row cache or provider-specific optimization.

A whole-snapshot client was implemented and tested as an experiment. Its
acquisition hook, bulk publication, alternate deep-pagination provider and new
revalidation machinery are not shipped. Adoption requires a verified client/server
win as well as cheap SQL. Existing updates already carry canonical server query
membership; the browser does not infer it from one changed session.

## Compatibility

Current core stable corpus: 0.9.0, 0.9.1, 0.9.2, 0.10.0, 0.10.1, 0.10.2, 0.11.0
(60 days plus latest two). Optional corpus: 0.10.2 and 0.11.0. None has this new
contract. Absent/unknown support preserves date cursors and older window-selector
behavior; there is no new default aggregate request. Unreleased 0.12.0 source
builds without the exact bit do not imply support. Existing route/stream meanings
and the hosted floor are unchanged. Sunset locations are recorded separately.

## Correctness and checks

Real SQL/API tests cover granted windows, bounded reads, edits, mixed timestamp
ties, independent limits and real authorization middleware. Node 25.8.2 and pinned
Bun 1.3.14 execute Unicode/mixed-case pagination and injected continuation failure.
Client tests cover pointer/focus changes, a missed-event star omitted from fresh
windows, hidden acquisition, compact-row rendering, live callbacks and cloned
marker/source isolation. The desktop 1000×600 and phone 375×812 browser test injects
activity through WebSockets and replaces canonical feed data through HTTP.
Captures are inspected individually and presented through the capture facility.

Five copied-source negative controls reach their intended assertions: absent
endpoint, old per-row hydration (76 reads against a 32-read budget), the old hold
(three rows retained instead of two), redundant compact-row rendering and a
swallowed SQL failure. Copies are restored exactly; no working-tree stash/swap.

Final source checks pass: lint, formatting, type checking and budgets. Full server:
7,382 passed / 94 skipped; current full client: 7,389 passed; shared 986 / root 22 pass.
An intermediate optional-bit denial broke version encoding; it was fixed before
the final complete server run. The Sidebar budget shrinks 1,602 → 1,590 lines; the
frozen app hub is unchanged. Final Sol 6.1 high/bypass review through YA 3400 is clean,
session `c49edfb8-c00b-4603-a298-0bd6c3d4beab`, review-only without edits, tests,
builds, restarts or primary-store access.

## Measurement and provenance

[Evidence](190-sidebar-snapshot.evidence.json) records raw samples, statement
attribution, host windows and frozen runtime/harness/source hashes. The accepted
baseline is the exact parent `cb9efef7f`. An earlier `ec45cae96` archive predates its
rebase and contains unrelated changes: those comparisons are superseded and
excluded. Before/after clients resolve their own frozen shared source SDKs,
matching their server SDKs. The working client is never built. No profiler is
used for comparison figures.

The isolated API fixture has 200 projects, mixed Claude/Codex rows and three
independent 50-row windows at 5k/50k. SQL, metadata, seen state and Hono routes are
real; warmed discovery/transcript reads throw. The seed array is released before
forced GC/measurement. Repetitions are before/after/after/before on fresh profiles,
1,000 refreshes each. Timings include route handling, serialization and fixture
JSON decoding/assertions, not network round trips. SQL counting is separate.

The browser fixture has 50k mixed idle sessions and a roughly 1 MB Claude session
(3 compactions × 6 turns), 30 seconds of writes and 60 seconds of sequential typing.
Each phase crosses a compaction. The aggregate experiment uses the same after
server/shared SDK with a separate frozen client. No Codex/200-compaction,
additional-tab, idle or restart qualification is claimed.

The exact-parent results reproduce the SQL and rendering improvements:

| Boundary | Before | Shipped foundation |
|---|---:|---:|
| 50k full three-feed REST median | 3.113 ms | 2.589 ms |
| SQL calls for that refresh, counted separately | 201 | 51 |
| Alternative aggregate API median | 3.216 ms for three old reads | 1.110 ms |
| Aggregate API SQL calls | 201 | 20 |
| Aggregate response bytes | 217,542 | 172,738 |
| Browser task, active write | 60.6 ms/write | 48.5 ms/write |
| Browser task while typing | 71.6 ms/write | 55.9 ms/write |
| Server process CPU, active write | 86.7 ms/write | 83.7 ms/write |
| Server process CPU while typing | 116.0 ms/write | 109.6 ms/write |
| Worst typed-key acknowledgement | 38.1 ms | 24.4 ms |

The final sample observes a 20–22% browser reduction and about 3–6% less process
CPU. All 78 exact-key samples pass 100 ms, and all expected visible markers arrive.
Frozen runtime hashes stay unchanged. All baseline/phase headroom checks pass:
14 effective CPUs, at least 20.4 GiB available memory, no swap growth, identical
capacity key and Node 25.8.2 executable. API timing runs have 1,000 samples each;
statement counting is a separate attribution-only run.

The matched snapshot experiment uses the same after server/shared SDK. It takes
55.3/64.2 ms of browser work per write (active/typing), versus 48.5/55.9 with the
shipped transport. Process CPU is 80.1/112.4, a mixed result against 83.7/109.6.
Direct encoded snapshot-plus-collection traffic falls from about 99 KiB/write
to 38 KiB/write, but decoded traffic grows. The snapshot cutover does not beat the simpler shipped
foundation overall, so its client scaffolding is removed and adoption deferred.
Earlier pre-rebase comparisons are excluded, not used to justify this decision.

Observed against plan targets in this smaller-history browser slice:

| Target | Observation after | Status in this slice |
|---|---|---|
| Main/process CPU ≤ 5/15 ms per write | 68.3/83.7 active; 84.3/109.6 typing | Miss |
| Tab work ≤ 5 ms/write | 48.5 active; 55.9 typing | Miss |
| Loop p99 ≤ 50 ms | 12.6 active; 12.2 typing | Pass observed |
| Visible p95 ≤ 250 ms | 195 active; 347 typing | Mixed |
| Every key ≤ 100 ms | 78/78 exact keys; 24.4 ms max | Pass |
| Paged server read ≤ 10 ms | Three-feed 2.589 ms; aggregate 1.110 ms | Warm fixture meets ceiling |

Warm selected-row JS remains about 21 MiB at 5k/50k; process RSS after construction
is about 200/735 MiB. These are isolated API-owner diagnostics, not whole-server
idle memory qualification. First construction is about 0.32/3.8 seconds and is
not a measurement of unchanged restart readiness. Current collection traffic
remains about 99 KiB/write. Full plan acceptance is open.


## Remaining architecture work

The full plan 190 CPU, render, traffic, memory and startup acceptance remains open.
First projection construction/restoration and exceptional tie-key selection still
have population work. The API working set can be bounded while process RSS after
construction still scales; attribute native/transient retention and remaining
complete consumers before introducing another cache. A lightweight navigation-row
versus hover-preview boundary and unchanged filter/metadata delivery are other
useful next steps before retrying aggregate client acquisition.
