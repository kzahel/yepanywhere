# Authoritative bounded session and Inbox updates

Topic: catalog-identity-projection-cost

Plan 190 stage 4, 2026-11-11. The server's canonical retained SQL queries now
own live session-feed and Inbox membership, ordering and counts through client
publication and reconnect. Provider decoding remains outside this transport.
The [observable contract](../../topics/session-catalog-observation.md#authoritative-session-and-inbox-query-updates)
owns admission, resource bounds, lifecycle and compatibility.

## Boundary and scope

One source-owned client stream unions up to eight queries. The server shares
identical reads within a principal/grant/credential scope, publishes a bounded
replacement first, then changed rows/removals and changed ordered memberships
and metadata. Up to 500 sessions or five 20-row Inbox tiers are retained per
query. Existing filtered canonical routes still authorize and answer the read;
this is not another collection projection or a provider-specific loader.

The profile permits 64 views, 32 streams, 32 MiB accepted snapshots and 2 MiB
per view. Each stream has one pending frame per query and a 2 MiB wire queue;
coalescing deltas into a replacement keeps revision chains valid. An event during
acquisition survives into a trailing pass. Departed-reader completion cannot
publish into surviving peers, whose next acquisition uses a live read context.
Independent deadlines share one wake; hidden Inbox frontiers use indexed grant
scope, and automatic archive clocks preserve UTC-midnight semantics. Filtered
pages include global accessible statistics in their archive deadline.

Client publication fences older HTTP, cancels queued query revalidation and
preserves normalized row references where unchanged. Live pagination enlarges
the first window through 500, avoiding timestamp-cursor ambiguity. React effect
coverage handovers preserve the entry and pending expansion. Failed expansion
coverage is also honored by REST fallback. Explicit refresh pauses stream
admission; reconnect/visibility starts a fresh bounded replacement. Final unused
entries retire after the synchronous handover microtask, aborting subscriptions.

The new capability is `collection-query-updates` (156), introduced in 0.12.0,
with explicit withdrawal on app instances without the event owner. Supported
stable servers retain existing REST/event behavior; the compatibility review and
90-day fallback sunset are recorded in the owning topic and capability registry.
Complete prompt search and coverage beyond 500 retain their existing reads.
Projects, ProjectQueue and transcript delivery/rendering remain separate work.

## Browser evidence and limits

The real browser scenario starts a disposable full app with 401 sessions sharing
one timestamp and opens session and Inbox pages. It changes title/star metadata,
marks the active row seen, then appends native transcript rows every 250 ms while
typing 25 characters sequentially. It requires the Inbox row to disappear after
mark-seen and reappear after native writes, plus final transcript text and every
exact typed prefix within 100 ms. A frozen collection view therefore fails.

| Condition | Native writes | Session/Inbox GETs during typing | Slowest key |
|---|---:|---:|---:|
| Existing fallback, capability explicitly denied | 11 | 9 (5 session, 4 Inbox) | 17.6 ms |
| Live updates, final Node | 11 | 0 | 16.4 ms |
| Live updates, final Bun | 11 | 0 | 13.7 ms |

The fallback control uses the same candidate server and build with capability
156 denied at the version boundary. It isolates request work, not an immutable
old-build CPU comparison. An exploratory tied-row run exposed 220 repeated
cursor reads; the final live-window regression protects against that interaction.
Desktop and 375 px phone captures were inspected: complete draft, current text
and fitting composer controls. Only desktop sequential typing is timed.

Raw request arrays, typing samples, source hashes, runtime provenance and
failing-before proofs are in [the evidence](190-collection-query-updates.evidence.json).
Node 25.8.2 and Bun 1.3.14 run on a shared macOS host, profiler disabled. These
short work-count/correctness observations do not certify plan 190's full
50,000-session/200-compaction CPU, memory, cold-open or sustained latency targets.
Project/project-queue requests remain visible as independent follow-ups.

## Verification and review

Sol 6.1 high, bypass permissions, reviewed through the user's YA API in a
review-only session. Findings led to fixes for departed in-flight reader
publication, consistent SQL archive clocks, grant-index deadline seeks,
coalesced NDJSON parsing, global statistics expiry, browser freshness assertions,
coverage handover, final-window clamping and failed-expansion fallback coverage.
Final review confirms the expansion corrections and reports no new must-fix
findings. Regression proofs restore the earlier behavior on copied-aside files, observe
failure, then restore source; no stash is used.

Full server tests pass: 7,353 passed / 94 skipped across 644 files (172 s).
The final client suite passes 7,378 across 691 files (130 s). Lint, formatting,
typecheck, source budgets, console scan and capability audit pass. Shared tests
(984), other non-Android workspaces and all 16 root Node checks pass. The Node
and Bun discovery SQLite contracts and a real Bun-backed browser scenario pass.
Existing unowned jsdom navigation diagnostics remain tracked in
[their gap](../../gaps/client-unit-navigation-diagnostics.md).

The retained browser case takes about 8–9 seconds plus the existing isolated
client-build/startup overhead (22–25 seconds total). Its unique value is native
file-to-catalog-to-stream-to-Inbox correctness during actual typing; focused
hook/server tests own malformed frames, lost revisions, late HTTP, source
switches, lifecycle races, auth/grant isolation and clock boundaries.

Next candidates are project/ProjectQueue authoritative query ownership,
combined-scale qualification with request/retention ratchets, incremental
transcript delivery/rendering, and quiet-host observation cleanup. None starts
as part of this slice.
