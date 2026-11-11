# Shared authoritative Projects and ProjectQueue updates

Topic: catalog-identity-projection-cost

Plan 190 stage 4, 2026-11-11. This extends the
[session/Inbox query update slice](190-collection-query-updates.md) to the two
remaining collection requests observed during native transcript writes.
The [owning contract](../../topics/session-catalog-observation.md#project-and-projectqueue-query-extension)
records bounds, authorization, capability rollout and fallback semantics.

## Ownership and remaining population work

Projects and global ProjectQueue reuse the source-owned client stream, shared
server view owner and canonical authenticated routes. Project rows, queue items,
recovered patient rows and scheduler statuses use qualified row identities;
statuses reconstruct their original project-keyed map. Changed fields, removals,
ordered memberships and dispatch state publish through existing client stores.
The older session/Inbox contract retains its original groups, including project
choices in metadata. Capability 157, `project-collection-updates`, gates the
extension independently of capability 156. Supported stable v0.8.0–v0.11.0
servers keep their existing reads/events/backstop and receive no new query.

The server admits only canonical whitelisted query paths. URL normalization is
also applied before codec/event/deadline classification, so dot-segment aliases
cannot turn a project collection into unbounded metadata. Existing per-profile
limits remain: 64 views, 32 streams, 32 MiB accepted snapshots, 2 MiB per view
and pending wire queue, eight interests per stream and 500 total rows per view.
Clients retain the complete REST path for collections above that row bound.
No new catalog, provider reader, SQLite connection or migration is introduced.

Project views react to project publications and live overlays, not every native
file event. Queue views react to queue/catalog/metadata and relevant scheduler
inputs. Identical authorized viewers share acquisition and one server wake for
future quiet/retry deadlines. Only ready/dispatching states retain the existing
five-second missed-event guard; expired inactive deadlines do not spin. A live
queue releases the browser backstop contribution. Failure restores REST and its
backstop; reconnect starts with a canonical replacement. Manual reads and queue
mutations fence pushed admission through accepted responses and release holds
on failures. Final unused interest releases subscriptions and its wake.

Canonical retained project materialization and native SQL project aggregation
still visit their eligible populations. This slice shares/diffs those reads
and removes repeated client acquisition; it does not establish changed-row cost
inside project aggregation. Oversized complete consumers, full prompt search,
transcript delivery/rendering and full combined-scale qualification remain open.

## Correctness and diagnostic observations

The existing real-browser regression now opens session, Inbox and Projects pages
on a disposable 401-session world with tied timestamps. It enqueues and pauses
owned test work, requires a standalone caption change before native writes,
then changes caption and queued text during 250 ms native appends and 25 actual
sequential keystrokes. It checks all visible changes, Inbox seen/unseen changes,
final transcript marker, every exact typed prefix and the unchanged 100 ms gate.
No assertion can pass by freezing either new collection.

A same-build control explicitly denies capability 157 while retaining session
and Inbox updates. Across 11 native writes it makes six Projects and 30
ProjectQueue GETs; the live Node and Bun scenarios make zero collection GETs.
Only the capability differs in that control; it is request-work attribution,
not an immutable old-build CPU comparison. Exact samples, request arrays,
source hashes, runtimes and failing-before proofs are in
[the evidence](190-project-collection-updates.evidence.json).

The existing browser case remains one case; its owned setup/build and typing
run costs about 24–30 seconds locally, with the case itself about 8–11 seconds.
Server tests exercise shared acquisition, relevant-event filtering, one-time
expired deadlines, active guard cleanup and direct/relay limited-user filtering
through actual canonical routes. Codec tests protect map/array parity,
cross-group id collisions, omitted fields, 500-row limits, path aliases and
older session wire shape. Hook tests protect separate capability withdrawal,
late HTTP/source/lifecycle behavior and retiring/restoring the browser backstop.

## Independent review and qualification limits

Sol 6.1 high reviewed through the user's YA API with bypass permissions,
review-only. Review found two real issues: aliases could disagree between route
and codec classification, and the existing project equality whitelist omitted
caption/code-name/owner/queue-count changes. The alias classifiers now agree;
the route refuses aliases before allocation. Project equality now compares all
Project data except internal observation clocks. The frozen state module shrank
from 2,222 to 2,199 lines and its budget was ratcheted. New reducer and browser
checks isolate display-only changes from concurrent transcript activity.
A final compatibility check also found that pausing an unretained, fallback-only
query could restart the supported session/Inbox stream. Pausing an unknown key
now does nothing; the regression protects the existing connection and request
count. Final static review confirms that guard and reports no remaining
must-fix, should-fix or nit findings.

The new retained regressions fail against copied-aside old code, including both
review corrections, then pass after exact restoration. No stash is used.
Full server tests pass: 7,355 passed / 94 skipped across 644 files (172 s).
Shared tests pass 986 cases; other non-Android workspaces and all 16 root checks
pass. Final client tests pass 7,382 cases across 691 files (133 s). Lint,
formatting, typecheck, source budgets, console scan and capability audit pass.
Final Node/Bun browsers both make zero collection GETs across 11 native writes;
25 sequential keys peak at 16.9/16.4 ms against the 100 ms gate. Existing unowned jsdom navigation diagnostics remain
tracked in [their gap](../../gaps/client-unit-navigation-diagnostics.md).

These are shared-host macOS correctness/request-work observations with Node
25.8.2 and Bun 1.3.14, no CPU profiler. Desktop/phone captures are inspected
for the session draft and updated project/queue controls. Only desktop typing
is timed. No full 50,000-session/200-compaction CPU, memory, cold-open or sustained
latency target is certified. Test-owned backends are reaped; the user's port
3400 server is never restarted or stopped, and clients build only externally.

The next highest-value step is combined-scale qualification and attribution of
the remaining work, followed by durable regression gates. Candidate architectural
slices are changed-project SQL aggregation, incremental transcript delivery and
rendering, and quiet-host observation cleanup. No next slice starts here.
