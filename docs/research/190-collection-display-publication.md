# Collection bookkeeping and display publication

Plan: [190](../tactical/190-active-session-cost-at-scale.md), stage 4.
This follows [bounded navigation projection](190-bounded-navigation-projection.md).

## Boundary

The existing collection owner accepts and validates every wire revision, keeping
its latest complete decoded query view. The existing query controller still
advances coverage/freshness and excludes older REST completions on every frame.
Ordinary bookkeeping updates publish a normalized UI snapshot only when its
observable data changes; authoritative replacements always publish.
No server-side membership rule, wire format, capability, renderer, timer or
per-session cache is added.

A scalar display version lives with the retained query entry. A consumer marks
that version published only inside successful query-fence acceptance, after its
synchronous destination callback returns. Thus a bookkeeping frame overtaking a
pending row frame still publishes the newest complete body; it cannot silently
cancel the row update. Callback failure leaves the version outstanding. Resets,
visibility/reconnect recovery and pagination replacements always publish and heal
local state, even when their row data is identical.

The default comparison preserves rows, removals, authoritative groups and all
metadata except a same-epoch nondecreasing catalog counter. Global Sessions and
Inbox additionally select their existing initial-loading/error presentation:
`catalogLoadState` does not display background refresh once the catalog is
complete. Only a boolean `refreshing` toggle between two complete observations
can then be ignored. Completion, cold loading, errors, deadlines, unknown
metadata, lineage changes and counter regression remain live. Recents and raw
status consumers retain their existing behavior.

All consumers of a shared entry must opt in before the background-refresh
projection applies. Widening or narrowing their presentation needs changes the
existing stream signature and reacquires an authoritative replacement. The raw
query view keeps all metadata; the normalized catalog describes the last display
publication, not the live wire cursor. There is no second retained row snapshot.

## Why the first attempt was insufficient

The preceding diagnostic called six of eight frames per append “catalog-only.”
That did not prove they changed only the counter: the catalog object also carries
background refresh state. The initial counter-only experiment preserved every
status change and produced no useful browser improvement: Claude active work was
64.3→63.3 ms/append, typing 73.1→73.5; Codex active 63.6→65.0, typing 72.2→70.1.
These samples motivated the explicit view-presentation boundary above. The
counter-only candidate is retained as rejected experimental evidence, not as a
separate runtime path or a claimed gain.

## Measurement and limits

Both variants use the exact frozen server/shared runtime from `34a8c2e54`.
External client archives use private shared SDK links; the working client is
never built. Frozen production sources differ only in five client files.
Actual server/client/shared runtime fingerprints are checked at both run
boundaries. Optional CPU/browser profiling is off for accepted figures.

Every fresh canonical-root world has 50,000 idle sessions over 200 projects and
one 200-compaction transcript, written once per second. Each run measures 180
active seconds plus 60 seconds of native sequential typing after warm-up and
quiet/settle periods. The final Codex client follows its baseline; the final
Claude client is followed by a fresh baseline control. Each final comparison is
one pair. Earlier candidate runs are excluded from final gains.

These are active/typing observations, not population/history flatness,
additional-tab, idle, memory, restart or cold-open acceptance. No server CPU or
wire-volume improvement is claimed: the server runtime and protocol are the
same. The original 5 ms browser-work target remains the goal.

### Observed result

| Metric (ms) | Claude before → after | Codex before → after | Target |
|---|---|---|---|
| Browser work per append, active | 62.9 → 57.1 (9.2% lower) | 63.6 → 58.7 (7.7% lower) | ≤5 |
| Browser work per append, typing | 73.2 → 65.8 (10.1% lower) | 72.2 → 67.5 (6.5% lower) | ≤5 |
| Active visible latency p95 | 52 → 51 | 41 → 41 | ≤250 |
| Typing visible latency p95 | 50 → 50 | 41 → 59 | ≤250 |

The accepted runs are `display-control-claude` versus `display-final-claude`,
and `display-before-codex` versus `display-final-codex`. All 716 sampled visible
markers arrive. Each measured phase crosses one compaction. Across these four
runs, all 312 sequential keystroke acknowledgements match their exact expected
prefix within 100 ms; the worst is 44.1 ms (after-build worst 39.1 ms). These
observed p95 values pass; compaction outliers reach 322/324 ms after the change,
so this is not a guarantee for every write.

Active process CPU is 83.6→82.4 ms/append for Claude and 121.0→118.5 for Codex,
against the 15 ms target. Typing process CPU is 117.5→125.2 / 166.0→164.5. These
small, mixed differences are not a server improvement claim. Encoded collection
traffic is unchanged at 3.43/4.23 KiB per active append, with eight collection
frames and one nonempty detail GET per append. The existing Codex project GET
also remains. Whole-wire acceptance is separate from these collection bytes.

The host capacity key is identical across runs; baseline eligibility passes,
measured host CPU busy fractions stay 0.115–0.132, available memory exceeds
23 GiB and measured swap growth is zero. No heavy checks or reviewer work overlap
the accepted measured windows. Runtime hashes, exact source hashes, commands,
raw-summary hashes, input samples and host evidence are preserved in the
[checked-in evidence](190-collection-display-publication.evidence.json).

### Separate attribution

A fresh 30-append Claude pair uses the same frozen runtimes, with a fetch-stream
tap and existing browser performance events. Timings from this instrumented pair
are excluded above. Both receive 240 query frames: 120 report complete/refreshing
and 120 complete/not-refreshing. Of those, 180 have only catalog metadata and no
row, removal or group change. Thus “catalog-only” includes status transitions,
not merely counter increments.

Message-list commit effects decrease from 202 to 172 (14.9%). Transcript
preprocessing remains once per append (30 starts and ends in each build), as
does the one nonempty incremental detail fetch. These are effect-event counts,
not exact publication or render counts; there is no claim of 75% less rendering.
The evidence records the diagnostic patch, event counts and raw-file hashes.

### Next high-value work

Profile the remaining per-append transcript projection and message-list
preprocessing, then make appended messages extend the existing normalized view
without rebuilding unchanged content. This is shared stage 3/4 ownership work
and should have a clear full-rebuild correctness oracle. First verify the
dominant remaining cost in both providers; do not assume fewer sidebar commits
can close the remaining 5 ms browser target. Bounded Codex preview acquisition
and quiet-host/restart work remain separate candidates.

## Correctness and review

The real hook/transport/query-controller checks cover both complete and field
metadata, fresh coverage without a fetch, stale REST exclusion, pending row plus
bookkeeping bursts, individual status/error/deadline/unknown-field/lineage
transitions, full-reset healing and missed-revision fallback. Another controlled
case covers cold loading and error display, completion, quiet background refresh,
simultaneous raw-status consumers, consumer departure and presentation changes.
Old-source copied tests fail the publication assertions; no stash is used.

Sol 6.1 high/bypass reviews through YA 3400 in session
`85a39e47-64c6-4d92-b156-8e055e4230da`. Source review is clear after isolating
individual metadata transitions in the tests. No tests, builds, probes, edits or
server lifecycle operations are delegated to the reviewer. Final source/numerical review has no remaining findings. A contract
wording nit is corrected and rechecked: the global-store topic now explicitly describes the
loading-presentation exception for completed background refresh. Source and raw
summary/log hashes, accepted pairs and calculations are verified by the reviewer.

Full safe-home workspace checks pass: server 7,391 (94 skipped), client 7,393,
shared 987 and root 22, plus the other participating workspaces. Warning-free
lint, formatting, typechecking, source budgets and console scanning pass. No
source budget or SQL statement ceiling changes. The three new regression cases
fail against copied old production source and pass after restoration. Isolated
hook-suite runtime is 1.47 s before (11 tests) and 2.01 s after (14 tests), a
single local diagnostic rather than a CI latency guarantee. The added cases
exercise async fencing, recovery and shared-consumer interactions. The existing five timer-only
jsdom navigation diagnostics remain in their [own gap](../../gaps/client-unit-navigation-diagnostics.md);
no unrelated navigation code or suppression is changed. Real sequential typing
under concurrent updates protects the 100 ms input contract.

Repros own 3420/4420 and generated stores. Worlds are removed after runs; seed
and raw evidence remain outside the repository. The user's 3400 server is never
restarted or stopped, and primary stores are not directly written.
