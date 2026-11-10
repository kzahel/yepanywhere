# Shared transcript ingestion and resolved-provider catch-up

Topic: catalog-identity-projection-cost

Plan 190 stage 3, first implementation slice, 2026-11-10. This follows the
SQL catalog ownership slices. It establishes shared source acquisition and
append semantics for both providers, then repairs a real consumer of the
existing bounded Codex reader. It does not complete the bounded Claude reader
or qualify the full active-tab scenario.

## Ownership and resulting behavior

`sessions/transcript-ingestion.ts` owns byte framing, not retained transcripts.
Plain JSONL is read in 1 MiB chunks, carrying the current line across chunks
and retaining absolute byte positions through UTF-8, BOM and CRLF. The two
provider adapters keep decoding and semantic projection. Existing reader
owners retain decoded rows under their source-byte budgets (Claude 192 MiB,
Codex 256 MiB), now also capped at 128 files. No second payload cache, timer,
SQL projection, protocol message or dependency is added.

Valid unterminated rows are provisional. They may be visible, but the next
append reparses them before committing a newline. If a continuation makes the
joined line malformed, the former provisional row disappears, matching a fresh
rebuild. Reference-backed Codex leaves apply the same metadata/ordinal filter
to visible entries and committed counts. Visible provisional rows are validated
for ordinal continuity without prematurely advancing the committed ordinal.

An append carries its previously accepted device/inode and bounded head/end
probes through acquisition. Evidence is checked before and after reading;
replacement, truncation or changed probes discard the candidate and retry.
Descriptor acquisition and pathname disappearance receive the same append
mismatch classification. Unrelated errors propagate. This assumes provider
history is append-only between observed rewrites: fixed probes do not verify
arbitrary historical interior edits. Each Claude acquisition closes its owned
descriptor on all paths. Cache invalidation retires only the affected path's
owner; cancelled waiters retry the current owner even if obsolete work rejects.

Claude summary projection is memoized per parse-state version and request
context, with at most four variants under a weak owner. Model-window resolution
is rechecked before reuse, and returned DTOs are cloned to isolate mutation.
This avoids repeated summary walks within one version; the first projection
and visible-branch normalization still depend on retained history.

The Codex baseline cause was route dispatch: the project's default Claude
provider stripped `afterMessageId` and window intent before the actual Codex
source was resolved. Both managed and unbound Codex sessions now retain that
intent. Actual Claude sources still receive complete forest context before
route slicing. The existing source-start-aware Codex cache and window fallback
remain the sole catch-up implementation. A bounded suffix can read fixed head
probes of at most 1 KiB without parsing the omitted history.

## Measurement protocol

`scripts/perf-repro/transcript-ingestion.mjs` exercises real readers and the
Hono detail route with an actual metadata/native identity, a Claude-default
project and one generated Codex transcript. It prepares the same summary hint
for both builds, cold-opens the tail, then makes eight cursor updates after
append. Compare 20 and 200 compactions at 42 turns per compaction. Source files
and profiles are task-owned and deleted after each run; JSON records runtime,
build fingerprints, request times/counts and host capacity/raw CPU/swap samples.
Profiler is off. This is a detail-path diagnostic, with no browser, 50,000-row
catalog, provider process, watcher publication or polling fan-out.

Before: external server build at `cdeb3f24e`. After: external server-only build
of the reviewed working source. No working-tree client build. Runs use Node
25.8.2 on Darwin arm64. Commands:

```sh
node scripts/run-with-safe-home.js --temporary-home node --max-old-space-size=8192 \
  scripts/perf-repro/transcript-ingestion.mjs \
  --server-dist <external>/packages/server/dist --work <scratch> \
  --label <unique> --provider codex --compactions 200 --turns 42 --samples 8
```

Fresh-world interleave: before20 → after20 → after200 → before200. Equal-length
labels make each before/after generated source byte count identical.

| Codex history | Source bytes | Before median update | After median update |
|---|---:|---:|---:|
| 20 compactions | 48,983,872 | 4.48 ms | 2.63 ms |
| 200 compactions | 487,535,162 | 1,249.54 ms | 2.15 ms |

At 200 compactions the old full source exceeds its 256 MiB cache budget, so
every cursor update rebuilds it. The repaired path retains a bounded suffix.
Cold tail request times were 187/196 ms before/after at 20 compactions and
181/181 ms at 200. These already use the existing bounded cold-tail path and
exclude summary-hint preparation. They do not establish cold-start latency.
Eight samples and one interleave are diagnostic evidence, not tail-latency or
CPU ratchets. Raw records and source/compiled/harness fingerprints are in
[the evidence JSON](190-transcript-ingestion.evidence.json).

Capacity key: `host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`.
Raw host busy fractions were 23.7%, 35.6%, 22.8%, 21.8% in run order. Minimum
available memory was 21.1 GiB or more; native swap remained 249.75 MiB. The
suite Darwin CPU/swap fields remain unavailable and other services share the
host, so these figures remain diagnostic. No concurrent task-owned test,
profile or build workload ran during these four measurements. A separate
pinned Bun 1.3.14 functional run passes the same real reader/route with 20
compactions and three append updates; it is not performance qualification.

## Correctness and review

`scripts/perf-repro/transcript-replay-parity.mjs` replays 80%, 90% and 100%
prefixes of task-owned real transcript copies through a warm candidate owner,
then compares each summary and normalized message digest/count with a fresh
full rebuild from the old reader. It records only counts and digests, never
private transcript contents or original source paths. Copies are read-only
inputs to this harness; replay files live in its disposable directory.

Real-copy parity is a correctness check, not timing evidence. The Claude copy
is 81,477,404 bytes and the Codex copy 111,753,758 bytes. Three cut points include
unterminated source tails. The final build matches summaries and normalized message digests/counts at all
three cuts: Claude 5,119 / 5,859 / 6,816 messages; Codex 4,807 / 4,808 / 5,038.
Synthetic integration coverage additionally covers
fork metadata replay, malformed continuation, ordinal gaps with and without a
newline, atomic replacement, append admission/acquisition interleavings,
truncation back to the accepted prefix, unrelated-path invalidation, obsolete
waiter rejection, and managed/unbound source dispatch. A >1 MiB Unicode record
checks split-codepoint framing and absolute byte positions.

The new dispatch and malformed-continuation checks fail on the old reader;
cancelled waiter, truncation and provisional-fork replay checks fail against
their earlier implementations. The provisional ordinal-gap case fails before
its validation fix. Files were copied aside and restored; no stash was used.

YA API review session `96181883-50f1-4713-b978-064c32b0cf07` used
`gpt-6.1-sol`, high reasoning, `bypassPermissions`, review-only. Verified and
fixed: disconnected append admission evidence, global Claude invalidation,
rejected cancelled waiters, truncation/missing-source recovery, and provisional
fork metadata filtering/ordinal state. Final scoped static review reports no
must-fix, should-fix or nit findings. The preparation extraction was separately
reviewed in the same session. The user's port 3400 server was never restarted.

## Checks

Root lint, formatting, typechecking and source budgets pass. Lint retains one
unrelated informational diagnostic in the existing client design checker.
The Codex reader shrinks from 3,903 to 3,867 lines; its budget ratchets down.
Final server suite, in the foreground under Node 25.8.2: 7,282 pass, 94 skipped,
11 failures, all existing Claude executable guards (expected 2.1.322,
installed 2.1.321). Native Codex cases pass. An earlier shell selected Node 27
prerelease and produced runtime rejection failures; the supported-runtime rerun
above supersedes it. One incorrect expectation in the new fork regression
initially counted root metadata instead of canonical child metadata; corrected
before the final run. The corrected regression fails on the earlier code at
the actual inherited-message replacement, then passes fixed code.

Root Node tests and other non-Android workspaces pass. The isolated final client
suite passes all 7,350 tests across 685 files in 127.9 seconds. The initial
concurrent run failed browser cleanup/capture hooks and Vite invalidation
expectations; these did not recur in the isolated run. The exact cause was
not established. No client source, timeout or retry policy was changed.
Existing jsdom navigation diagnostics remain. SQLite schema and SQL contracts
are unchanged.

## Remaining work and target status

No full plan 190 target is newly certified. Claude over 192 MiB is still
uncached; repeated full reads start at byte zero, and branch/normalization work
still scales with history. The next high-value slice is a compaction-boundary
index plus bounded, incrementally extended Claude visible-branch projection,
with full-rebuild parity for rewinds, dead branches, connectors and catch-up.
Old/unknown Codex anchors and omitted tool dependencies still use the complete
reader. Source-byte budgets are not exact decoded-heap measurements. Summary
construction outside the detail request and catalog publication remain separate
costs. Client list reloads/polling, transcript deltas/rendering, idle/startup
qualification and end-to-end memory/typing targets are open.
