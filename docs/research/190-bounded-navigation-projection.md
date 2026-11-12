# Bounded navigation projection

Plan: [190](../tactical/190-active-session-cost-at-scale.md), stages 2 and 4.
This follows the [current-cost investigation](190-current-cost-regroup.md).

## Change and ownership

Known session IDs now drive indexed identity reads instead of filtering a
population timeline. Empty queued-ID sets return immediately. The existing SQL
query owner still applies grants, filters, archive policy, ordering and cursor
ties before hydrating selected payloads.

Selected-parent child information uses the existing profile-owned relationship
store in bounded batches. The policy projector remains shared: exact scoped
native anchors, one structural parent, the first 20 active evidence rows before
provider-trust filtering, partial/unknown versus accepted-empty checkpoints,
public parent aliases and live activity overlays. No provider I/O or resident
per-session answer cache is added. Project Queue counts are grouped from one
request-local queue snapshot using canonical project identity.

Collection changes optionally replace/remove individual top-level metadata
fields. A catalog freshness token no longer causes an unchanged project
dictionary to cross the wire or acquire a new browser reference. The server
continues to determine complete membership and order; the client does not infer
where a changed session belongs. Initial, reconnect and backpressure replacements
remain complete. One query acquisition and revision serve both protocol variants.

Compatibility is additive: exact optional capability `collection-metadata-fields`
(bit 159), explicit `metadata=fields`, and legacy complete-metadata fallback.
The current core horizon includes 0.9.0/0.9.1/0.9.2,
0.10.0/0.10.1/0.10.2 and 0.11.0; the optional horizon contains the latest two,
0.10.2 and 0.11.0. The additional supported 0.8.0/0.8.1 floor also predates
this source-only extension. None advertises it. A 0.12.0 source version alone
does not imply support. The existing collection-stream version gate
and hosted compatibility floor are unchanged. The fallback is inventoried for
retirement. Collection capability definitions move into a domain module to keep
the sessions registry below the source-size threshold.

Legacy relationship page/evidence statements now prepare only on use, with five
fixed shapes. The bulk reader owns four lazy statements. Both live with the
existing store; request maps are released after projection. Disposal cannot
recreate statements, even through a held reader reference. The SQLite guard
remains at 64. This avoids allocating unused legacy reads alongside bulk reads.

## Measurement

The comparison freezes `e1ef3fc59` and the reviewed working source into separate
external archives, each with its own shared SDK build and private package links.
The working-tree client is never built. The actual server, client and shared
artifacts are fingerprinted before and after every run. The previous report's
older pre-rebase runtime is not reused as the baseline.

Both providers use 50,000 idle sessions over 200 projects, one 200-compaction
transcript, and one append per second. Each fresh canonical-path world measures
180 active seconds and 60 seconds of real sequential typing, with warm-up and
quiet/settle windows. Run order is before Claude, after Claude, after Codex,
before Codex, then after Claude and before Claude again. Optional CPU/browser
profiling is off. Claude has two repetitions per build; Codex has one. These are matched points,
not a statistical flatness, additional-tab, cold-open or memory qualification.

The append figures measure total CPU during a phase divided by appends; they
are not title/star/unread edit latency. Wire figures count the collection stream,
separately from transcript responses and activity events.

## Observed results

[Raw-result references, runtime hashes and analysis](190-bounded-navigation-projection.evidence.json)
retain every run. Claude entries below average two repetitions; Codex entries
are one pair. CPU units are milliseconds per transcript append; collection
traffic is encoded body KiB per append (HTTP/activity/transcript traffic separate).

| Active phase | Claude before → after | Codex before → after |
|---|---:|---:|
| Server main CPU | 74.8 → 64.1 (14% lower) | 95.1 → 84.7 (11% lower) |
| Server process CPU | 89.6 → 79.1 (12% lower) | 138.3 → 129.0 (7% lower) |
| Browser task work | 55.9 → 58.6 (5% higher) | 59.1 → 61.7 (4% higher) |
| Collection stream KiB | 123.81 → 3.43 (97.2% lower) | 124.60 → 4.23 (96.6% lower) |

Claude process samples are 90.0/89.2 before and 77.4/80.8 after; browser samples
are 54.8/57.0 before and 60.1/57.1 after. This supports a server/traffic win,
not a demonstrated browser CPU improvement or statistically established regression.
The small sample count does not certify population/history flatness.

Typing is measured separately because it adds input and editor work:

| Typing phase | Claude before → after | Codex before → after |
|---|---:|---:|
| Server process CPU ms/append | 124.5 → 117.1 | 166.5 → 165.2 |
| Browser task ms/append | 68.6 → 70.9 | 64.3 → 70.7 |

All 468 sequential keystrokes retain their exact expected prefixes and appear
within 100 ms; the maximum is 38.3 ms. Every sampled transcript marker appears.
After active visible p95 is 51–52 ms for Claude and 41 ms for Codex; typing p95
is 51–54/54 ms. Compaction outliers reach roughly 338 ms, so this is a p95
qualification, not a maximum-latency guarantee. After loop p99 stays at 12–14.5 ms
across the measured phases. All runtime fingerprints are unchanged within runs;
host eligibility and phase capacity/memory/swap checks pass.

Main CPU still misses 5 ms, process CPU misses 15 ms, and browser work misses
5 ms. No list reloads occur, but there remains one incremental detail GET per
append plus a Codex project point GET; the collection stream still sends eight
query frames per append. Few-KiB collection bytes alone do not close the original
one-change delivery target. Idle, restart, cold open, memory and additional-tab
qualification are not rerun or claimed here.

## Attribution and next boundary

Separate 30-append Claude diagnostics wrap SQL and tap collection frames; their
CPU/latency figures are excluded from the table above. Total SQL calls drop
19,534 → 7,715 (651 → 257 per append, 60.5% lower). Relationship reads drop
12,120 → 360 (404 → 12 per append, 97.0% lower). These are native adapter calls,
not a claim that a correlated batch performs no per-parent index seeks.

Both runs carry 240 query frames: four queries, twice per append. The old run
repeats the unchanged project dictionary in 180 frames; the new run carries it
in none of those frames and does not patch it. Metadata patches contain only changed catalog/deadline
fields; row changes continue through the existing channel. There are no replacement resets in that measured window.

In the new run, 180 of 240 frames change only catalog freshness, with no row,
membership or other metadata changes. Both runs still record 202 message-list
commit effects. Reducing bytes has not reduced publication/render frequency.
The strongest next shared boundary is to update query bookkeeping without
republishing unchanged display state, while retaining authoritative server
membership and existing recovery. This needs a measured browser win; it does
not approve a new client membership engine or a wholesale renderer rewrite.
Bounded Codex previews and quiet-host/restart work remain other high-value
options from the preceding investigation.

## Correctness and review

Retained checks cover real SQL scope/window/cursor semantics, actual route and
owner acquisition, legacy/opt-in sharing, metadata deletion, malformed-frame
recovery, capability withdrawal, checkpoint uncertainty, multi-page children,
scoped aliases and conflicting parents. Portable Node/Bun parity compares batch
reads with the existing store, including more than 20 ordered mixed-trust
observations. A real projector check rejects provider evidence at position 21
when the first 20 are untrusted, even with a complete checkpoint.

Copied-source negative controls show 500 relationship reads for 250 childless
parents on the old path versus eight now (64-parent chunks); two projects fetch
the queue twice on old code versus once now. Old metadata code fails the
field-preservation test. The decoder rejects stale/missed revisions and accepts
an authoritative full replacement. Old lifecycle code fails the new disposed
reader check. SQL query plans seek candidate primary keys on both runtimes.

The allocation integration test initially exposed the existing
[statement headroom gap](../../gaps/server-sqlite-statement-ceiling-has-no-headroom.md).
An isolated eager-read control logs a 65th statement in the catalog catch;
lazy allocation passes the same fixture under the unchanged ceiling. This does
not fix the separate general problem of catalog errors being caught into
freshness state.

Sol 6.1 high with bypass permissions reviewed through YA on port 3400, session
`f4454a73-d68c-4404-b301-84cbc0d84aa2`. The missing-row gate and evidence/disposal
findings were verified and fixed. Final source review has no must-fix,
should-fix or nit findings. Review was read-only, without tests/builds/probes,
server restarts or store writes. Final numerical/evidence review is also clear;
the sole range nit was corrected to include Codex's 41 ms active p95.

The user's server and primary stores are untouched by repro control. Generated
worlds are removed after runs; seed and raw evidence remain outside the repo.
No statement ceiling, source budget, test timeout or retry is raised.


Final checks pass: warning-free lint, formatting, typechecking, source budgets,
Node 25.8.2/Bun 1.3.14 portable SQL contracts and the complete safe-home workspace
suite. Server has 7,386 passes/94 skips, client 7,390, shared 987 and root 22,
plus the other workspace suites. The five existing timer-only jsdom navigation
diagnostics recur; see the [existing gap](../../gaps/client-unit-navigation-diagnostics.md).
No suppression or unrelated navigation change is made. The focused batch/stream checks take 2.55 seconds and the lifecycle checks
3.37 seconds in separate local runs. The final full workspace's server portion
takes 163.7 seconds and client portion 138.8 seconds; these are diagnostic local
samples, not a sustained CI-cost claim.


Comparable isolated file checks: provider-child coverage grows 15→16 cases,
1.16→1.17 seconds total (365→418 ms test bodies); client stream coverage grows
10→11 cases, 1.28→1.32 seconds total (436→479 ms test bodies). Setup, imports and
teardown remain included. These single local samples bound the added check cost;
they do not establish sustained CI improvement.
