# Indexed Claude transcript windows

Topic: catalog-identity-projection-cost

Plan 190 stage 3, 2026-11-10. Recent Claude 2.1.3xx transcript shapes are the
implementation target. This slice makes ordinary warm updates independent of
historical payload size, preserving current YA branch/rendering behavior. It
does not complete cold index construction, persistence or full-host acceptance.

## Ownership and behavior

The existing process-wide Claude transcript cache owns either a complete parsed
snapshot or a compact source index for one file. These representations share
one source owner and budget; incompatible joined callers retry for the requested
representation. A summary peek joins the current representation. No second
payload owner, dependency, background scanner or timer is introduced.

`claude-source-index.ts` retains original row order, byte offsets/lengths,
UUID/parent/timestamp/connector facts, tool correlations, full-projection row
ranks and turn facts. Historical user/assistant text, thinking, images and tool
output are omitted. Task inputs/results needed by the existing task reducer and
recognized nested-harness launch evidence are retained and charged. The existing
forest/visible-entry selector remains the reference for initial selection,
rewind records, changed branches and uncertain histories. The index records
compaction positions in that selected sequence, rather than treating the last
physical compact marker as an unconditional cutoff.

Unique rows extending the current winning tip with a nondecreasing timestamp
extend the selected sequence and summary witnesses. Progress rows extend source
metadata without changing the visible tip. Tool completion updates orphan state;
a completion affecting a sibling branch rebuilds the metadata selection. Common
new queue delivery updates a bounded suffix of positions/turn numbers; older or
uncertain deliveries rebuild metadata. Late-delivered queues preceding a cursor
remain in catch-up replies. Renderer turn ordinals and pagination live-turn
counts use their respective existing predicates.

The task reducer folds the complete visible metadata sequence, including grouped
rewind history, before window payload hydration. Selected messages reuse the
original Claude converter with global sequence positions. The converter and its
queue-content helper move unchanged into `claude-message-conversion.ts` as a
separate preparation slice (`a01253af4`, exact converter-body comparison and
17 existing normalization/selection cases pass). Actual payload is decoded only for selected row
references, with one cache window. Indexed selections can be noncontiguous;
private `indexed-selection` metadata describes logical pagination rather than
claiming a contiguous source range. Public reply fields, IDs, turn numbers,
counts and pagination semantics remain unchanged. Complete history, oversized
windows, unsupported structural shapes and task results preceding their calls
retain the complete-reader fallback.

Summary aggregation keeps the exact active-branch count plus the bounded
witnesses used by the existing summary selectors: title/creation context, model,
positive usage, pre-compaction usage/overhead, content/human timestamps and agent
excerpt/tool fallback. It is memoized per source generation; current context-window
configuration is still resolved by the existing projection. Summary and renderer
branch membership remain separate. When adding a summary field, update its
witness selection and full-rebuild parity coverage together.

The complete-source metadata projection also feeds the existing historical
nested-harness extractor, preserving original row and content-block slots,
eligibility flags, recognized scoped Bash launches and success/error flags.
The detail DTO references that metadata weakly so only the source cache owns
its lifetime. Expired evidence is skipped; partial visible rows never substitute
for complete-source proof. It uses the same committed-row fence, source identity,
native copy witness and admission policy; bounded detail no longer needs
historical tool output to preserve relationship discovery. This is specialized extractor evidence, not a
replacement raw transcript.

## Freshness and bounds

Shared framing reports exact byte positions/lengths and newline commitment.
Valid unterminated rows remain provisional and replay before commitment;
malformed continuation can retract them. `null` rows are skipped as in the
complete reader. A provisional view shares immutable source metadata and clones
the summary fold rather than mutating accepted committed state.

Snapshots capture the exact index object and source generation. Selection checks
that token before using the index; hydration checks projection generation before
publication. Competing reads/appends retry instead of pairing a new projection
with an old summary or source version. Selection totals are captured before
awaits, including descriptor closure. Hydration owns/closes its descriptor and
validates the accepted device/inode and head/end probes around reads; this
retains the existing append-only assumption between observed rewrites, not an
arbitrary whole-prefix hash guarantee.

The process cache keeps its 128-file ceiling and 192 MiB budget. An explicit
zero budget disables indexed acquisition immediately. Complete mode
charges source bytes. Indexed mode estimates retained source metadata, lightweight
projections, task/rewind context and provisional payload, plus decoded-window source bytes.
The legacy diagnostic field is still named `retainedSourceBytes`; it is not an
exact heap measurement in indexed mode. Charges are refreshed after metadata
selection and hydration. A single oversized index/provisional row/window is not
retained. Metadata itself remains O(history), bounded by this shared budget;
there is no claim of constant historical index size or completed memory target.

## Evidence and qualification

Final measurements use external server builds, profiler off, Node 25.8.2, and
fresh task-owned worlds from `scripts/perf-repro/transcript-ingestion.mjs`.
The real-reader/Hono fixture uses 55 turns per compaction, 20 versus 200
compactions, and eight appended cursor requests per run. Equal-length labels
keep paired source byte counts identical. The final fresh-world interleave compares previous commit `9f3efbed1` with
the exact reviewed source: before20 → after20 → after200 → before200. There is no browser, 50,000-row catalog,
provider process, watcher/publication fan-out or client polling in this probe.
The initial request includes source-index construction; summary-hint preparation
is outside its timing. Raw host CPU/swap, capacity, runtime, source/compiled and
harness fingerprints belong in the accompanying evidence JSON.

| Claude history | Source bytes | Before median update | After median update |
|---|---:|---:|---:|
| 20 compactions | 46,636,780 | 25.74 ms | 1.50 ms |
| 200 compactions | 464,741,260 | 2,127.28 ms | 1.46 ms |

The final raw numbers, including actual source byte counts, are authoritative in
[the evidence JSON](190-claude-source-index.evidence.json). Earlier repeated
interleaves gave the same shape; the final pair includes the zero-budget guard.
At 200 compactions, complete mode declines retention and repeatedly rebuilds
payload; indexed mode retains compact facts and selected decoded rows. The
first detail request regresses: 289.5 → 381.5 ms at 20 compactions, and
2,353.6 → 2,930.6 ms at 200. It now constructs metadata and projections once;
summary-hint preparation is excluded in both builds. This cold-build regression
remains explicit and selects durable indexing as the next boundary. A memory
tradeoff remains: the indexed metadata graph stays resident while the complete
oversized reader drops its full snapshot. Retained source-byte estimates and
At 200 compactions, post-GC heap rises from 43.2 to 225.8 MiB, while process
RSS falls from 1,448.8 to 596.1 MiB after repeated requests. The index charge is
about 154 MiB within the 192 MiB cache budget. At 20 compactions, heap falls
97.7 → 63.4 MiB and RSS 406.5 → 375.1 MiB. These are isolated process samples,
not a whole-host memory qualification; the active metadata residency remains
an architectural cost to move out of RAM.

These are one-route wall-time diagnostics with eight updates, not per-write CPU,
p99 latency or browser qualification. The host capacity key is
`host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`. Native busy fractions were 21.8%, 22.1%, 19.5%, 20.2% in run order, with at
least 23.6 GiB available and swap stable at 249.75 MiB. These samples
supplement unavailable suite Darwin fields; shared-host figures remain
ineligible for a regression ratchet. No task-owned test/build/profile workload
ran beside the final timing interleave.

`scripts/perf-repro/transcript-replay-parity.mjs --claude-indexed 1` compares
warm indexed compact-tail messages/task snapshots and summaries at 80%, 90% and
100% of the task-owned 81,477,404-byte real Claude copy with fresh full rebuilds
from the previous build. Canonical per-message hashes avoid property-order noise;
private contents and original paths are not published. Final-build replay passes all three cuts (1,617 / 1,220 / 1,482 selected
messages), including task snapshots and summaries. This is correctness evidence, not timing qualification.

Real-file coverage includes rewinds/group boundaries, sibling tool work,
connectors/progress, queue delivery/global ranks/turns, task state from omitted
history, provisional replay, positive usage before compaction, mixed acquisition
modes, pre-selection and in-hydration generation races, closure-time counts,
null rows, oversized retention and complete-source harness extraction. A guarded
ordinary append/queue case rejects historical metadata/summary walks. The
production-reader hidden-payload regression fails with the old reader retaining
3,251,274 bytes against its <100,000-byte bound. Other review regressions fail
against their respective earlier variants. Source files were copied aside and
restored; no stash was used.

YA API session `96181883-50f1-4713-b978-064c32b0cf07` reviews with
`gpt-6.1-sol`, high reasoning, `bypassPermissions`, review-only. Verified/fixed:
full/indexed acquisition confusion, mutable projection generations and the
pre-selection gap, uncharged provisional payload, positive pre-compaction usage,
closure-time totals, and null parsing. The pure conversion extraction is verified
against the original bodies. Final static follow-up reports no remaining findings. Root lint, format,
typecheck and source budgets pass (one existing unrelated informational client
lint diagnostic). The full server suite reports 7,299 passed, 94 skipped and
11 existing Claude executable guards (expected 2.1.322, installed 2.1.321);
native Codex cases pass. Client: all 7,350 tests across 685 files pass in
124.9 seconds. Root Node and other non-Android workspace tests pass. Focused
source/cache tests pass 38 cases; route/history coverage passes 203 cases.
Pinned Bun 1.3.14 passes the real-reader/Hono fixture with 20 compactions and
three append updates. No client build, primary-store mutation or user-server
restart occurred. No SQL/schema/dependency change was made.

## Next boundary

An unseen file still requires one full streaming metadata-index build. The index
is not persisted, so restart/eviction repeats that build. Rewinds, historical
queue insertions, provisional views and other exceptional changes can revisit
historical metadata. Complete/unknown-anchor fallbacks may still read historical
payload. These are explicit remaining costs, not closed plan targets.

The next high-value architectural step is durable, profile-owned source metadata
and compaction indexing, populated by existing acquisition and restored without
reparsing payload. A SQL-owned index can also avoid retaining the complete active
metadata graph in RAM. It must preserve accepted-prefix/generation fencing,
rewind/task/harness semantics and bounded source queries. Client authoritative
changes/reconnect catch-up follow independently; list polling/reloads, rendering,
idle/startup work and end-to-end typing/per-write CPU targets remain open.
