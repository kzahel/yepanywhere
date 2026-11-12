# Transcript cost attribution and immutable fact reuse

Plan [190](../tactical/190-active-session-cost-at-scale.md), stages 3/4 and
step 6. Follows [display publication](190-collection-display-publication.md).

## Attribution changes the expectation

The remaining 57–59 ms per append is not mostly transcript compilation. Separate
60-append browser profiles on the full 50,000-session/200-compaction fixture
attribute about 333 ms total to the Claude compiler (5.55 ms/append), versus
22 ms for Codex (0.37 ms/append). These are sampled inclusive compiler times,
not profiler-off acceptance figures. Claude spends most of that time rescanning
old tool output. Its activity and augmented-display projections each compile
roughly half. Existing MessageList phase clocks cover only the display half.

The larger common cost is React/app-shell work. Exclusive sampled self-time
separates application JavaScript, React, shared transcript code, native APIs,
GC and program/native residual; inclusive file/stack totals are not additive.
Separate 30-append traces show repeated script callbacks, layout, style, paint
and layer work. Idle controls have almost no browser work, so this is driven by
updates rather than a constant idle animation load. Traces/profiles are for
attribution only. Their nested inclusive durations must not be added together.

A general incremental compiler rewrite is therefore not justified as a route
to 5 ms on both providers. The safe first slice below removes the measured
repeated decoding at its shared owner. It does not finish incremental transcript
rendering, nor claim that compilation dominates Codex or all browser work.

### Attribution after the change

A separate 60-append Claude profile using the final client measures 36.95 ms
inside the compiler, down from 333.33 ms: about 5.56→0.62 ms/append, or 88.9%
less sampled compiler work. Shell folding falls 264.99→5.14 ms total. This
confirms that the old-output scan was removed; it does not replace the
profiler-off browser figures below. All 249 JavaScript chunks in each hidden
source-map build are byte-identical to their corresponding measured client.

Exclusive sampled React self-time is almost unchanged (766→764 ms), as is
application JavaScript (993→981 ms). The baseline Codex compiler was already
about 0.37 ms/append. Together these observations justify prioritizing the
shared publication/subscription and render boundary over a general compiler
rewrite for this fixture.

The separate trace partitions occupied main-thread wall intervals without
double-counting nested events. Claude/Codex script and callback dispatch account
for 1,176/1,064 ms; layout/style/rendering 258/166 ms; GC 56/84 ms over 30
appends. Against rounded task metrics of 1,670/1,540 ms, approximately 177/224 ms
remains outside the classified occupied spans. Trace intervals, sampled CPU and
profiler-off task metrics are different observations, not additive components.

## One owner for intrinsic facts

The canonical web adapter owns one compiler instance across immutable input
snapshots and both activity/display projections. It shares the existing stages
with the full-rebuild function. Result decoding is keyed by source Message,
ContentBlock and tool name; a replaced envelope invalidates facts even when the
block or public ID is shared. Shell-output facts are keyed by decoded result
identity and parsed lazily, so unused shell metadata does not add cold scans.

Two weak-key tables retain intrinsic facts only. They hold no message arrays,
render rows, source/session-ID index, timers or history graph. One tool-name
variant per block replaces older variants. Facts expire with their input
objects; returned result payloads, source messages and nested blocks remain
immutable. Existing bounded web array caching and source/store lifecycle are
unchanged. No capability, provider normalization, wire field or renderer changes.

Pairing, result-before-call handling, live/final/orphan/approval status, ordering,
configuration acknowledgements, augments, command linkage, detached-cell chains,
background completion, compaction and setup folds still derive from the complete
current window. New completion evidence can change an older row. There is no
heuristic closed-turn barrier, append-only branch guess, provider-specific fast
path or cached final presentation. Cheap window scans remain; repeated old
output decoding does not.

## Correctness and checks

The stateful factory matches fresh-context full rebuilds through append,
result-before-call, streaming/final results, replayed call snapshots, detached
poll folding, orphan/approval changes, configuration acknowledgements, Markdown
augments, rewind/window replacement, compaction and prepend sequences. Previous
outputs and their source objects are frozen to catch mutation. Replaced
metadata envelopes and changed call types invalidate intrinsic decoding.

The reuse case asserts both stable decoded result identity and no reread of old
block output across new arrays. A spy on the real detached-cell parser proves
that unchanged decoded output also avoids rescanning; it first asserts a real
initial parse and restores the spy in `finally`. These checks guard work reuse,
not just the existence of a cache. Existing semantic characterization, compiler,
shell, renderer and reducer coverage still protect the shared stage behavior.

A copied old compiler gains only a factory compatibility shim returning its
full-rebuild function. The same tests then pass full-rebuild parity but fail
reuse. The source is restored in `finally`; the control changes no measured
runtime artifacts or working-tree files. No stash is used.

Initial broad runs accidentally inherited the machine's unsupported Node 27
alpha; the temporary home also hid Playwright's browser cache. Logs identify
missing Chromium and rejected runtime startup, plus one network ECONNRESET.
Verification uses the same Node 25.8.2 as measurements, an explicit installed
Playwright cache and disposable homes. No source workaround, timeout increase,
skip, or warning suppression is introduced. The existing five timer-only jsdom
navigation diagnostics remain in their [own gap](../../gaps/client-unit-navigation-diagnostics.md).

Sol 6.1 high/bypass reviews through the user's YA 3400 API in session
`acbbf6b3-9e59-4066-b380-b0670c875fff`. Source review is clear after documenting
factory ownership/immutability and verifying lazy cached absence/false handling.
The reviewer performs read-only inspection, no edits/tests/builds/probes or
server lifecycle actions. Final scoped source and numerical/evidence review is
clear: no must-fix, should-fix or nit findings remain. Runtime/source/raw/log/map
identities, arithmetic and input/delivery observations were checked separately
after the timed runs.

## Measurement boundary

Fresh external archives use `245530262` before and the reviewed working source
after, with private shared-package links. Only five production files differ:
the web adapter, shared compiler, result projection, shell folding and memo.
The working client is never built. The exact same frozen baseline server/shared
runtime serves both client variants, isolating browser changes. Shared compiler
changes also affect the unretained server producer through the full function;
workspace tests cover semantics, but no server performance gain is claimed.

Each accepted run uses a fresh canonical-root 50,000-idle-session/200-project
world and one 200-compaction transcript, written at 1 Hz. Profiler-off active
and native sequential typing phases remain separate. Runtime/harness hashes,
source equality, capacity, host headroom and swap evidence are retained.
Optional profiles, tracing and diagnostic taps are excluded from acceptance.
One pair per provider does not qualify statistical flatness, additional-tab
cost, idle/restart/cold/memory or whole-plan acceptance. Original targets stay
unchanged.

## Observed result

| Metric (ms) | Claude before → after | Codex before → after | Target |
|---|---|---|---|
| Browser work per append, active | 56.9 → 51.7 (9.1% lower) | 59.2 → 58.7 (0.8% lower) | ≤5 |
| Browser work per append, typing | 66.6 → 64.8 (2.7% lower) | 68.8 → 67.7 (1.6% lower) | ≤5 |
| Active visible latency p95 | 52 → 46 | 41 → 41 | ≤250 |
| Typing visible latency p95 | 50 → 47 | 43 → 42 | ≤250 |
| Server main CPU per append, active | 69.4 → 69.6 | 88.7 → 85.6 | ≤5 |
| Server process CPU per append, active | 84.1 → 84.0 | 132.0 → 117.2 | ≤15 |

The four accepted runs are transcript-before-claude, transcript-final-claude,
transcript-final-codex and transcript-before-codex, in that order. Both variants
use identical server/shared runtime hashes. One pair per provider supports an
observed Claude browser improvement; the small Codex differences are not a
meaningful gain claim. Server process variation is substantial despite unchanged
code, so those point values do not establish a server improvement.

Every phase crosses one compaction. All 716 sampled visible markers arrive,
and all 312 sequential native keystroke acknowledgements match their exact
expected prefix within 100 ms. The worst key is 42.7 ms (after-build worst
35.4 ms). After-build loop p99 is 14.9–16.7 ms. Visible p95 passes; after typing
compaction maxima are 324/319 ms, so every-write latency is not guaranteed.

Encoded collection traffic is exactly unchanged: 3.43/4.23 KiB per active
append, with eight collection frames and one incremental detail GET
per append (the existing Codex project GET also remains). The target for the
complete request/push pattern remains separate from those collection bytes.

The same host capacity key passes baseline eligibility in all runs. Measured
CPU busy fractions are 0.113–0.127, available memory stays above 22 GiB, and
measured swap growth is zero. Checks and reviewer work are idle during all
accepted windows. The [checked-in evidence](190-transcript-fact-reuse.evidence.json) retains runtime/source/harness hashes,
commands, typed prefixes, marker observations and raw-summary/log hashes.

Full final workspace checks pass: server 7,391 (94 skipped), client 7,393,
shared 989 and root 22, plus the other participating workspaces. Lint is
warning-free; formatting, typechecking, source budgets and console scanning pass.
No source budget or SQL statement ceiling changes. The two focused new cases
raise the compiler suite from four tests/171 ms to six/183 ms in one isolated
local sample; that is diagnostic cost evidence, not a CI guarantee.

## Next priority

The remaining common cost is the publication/subscription boundary feeding
React, including app-shell and navigation consumers. Attribute why one append
causes repeated commits and context propagation, then make unchanged consumers
stay quiet through the existing source/store owners and narrow selectors.
Preserve server-owned query membership and freshness/recovery fences. Further
compiler rewrites are a lower priority for this fixture, especially for Codex.

Other independent candidates remain bounded Codex preview acquisition and
quiet-host/restart/memory qualification. The original 5 ms browser target,
server CPU, full delivery/flatness, additional-tab and lifecycle/memory acceptance
remain open.

Repro ports 3420/4420 and generated stores belong to this task and are reaped;
worlds are removed after runs while seed/raw evidence remain. The user's 3400
server is never restarted/stopped, and primary stores are never directly written.
