# Combined qualification of plan 190

2026-11-11. Runtime revision `be7b474c3`; this checkpoint changes the measurement
harness and records results, without changing production behavior.
[Plan 190](../tactical/190-active-session-cost-at-scale.md),
[remaining active-tab costs](../../gaps/active-session-tab-background-cost.md)
and [catalog follow-ups](../../gaps/session-catalog-rewrites-whole-generation-per-change.md)
own the unfinished work. [Machine-readable evidence](190-combined-scale-qualification.evidence.json)
retains build identity, host samples, phase counters, typing samples, clock
summaries, source log excerpts and raw-artifact hashes.

The combined architecture is substantially more usable than the saturated
historical baseline, but does **not** meet the full goal. Warm bounded lists,
loop delay and typing pass their observed ceilings. Population-dependent project
work, excessive update bytes/browser work and whole-rollout Codex preview reads
remain. This is one repetition per point, not a statistical regression baseline.

## Reproduction and eligibility

The external archive build contains server and client from `be7b474c3`.
The working-tree client was never built. Node `v25.8.2`, Apple M4 Pro, 14 logical
CPUs, 48 GiB RAM; capacity key
`host-v1-darwin-arm64-14cpu-49152mib-ea2afc6d7ef43d47`.
The evidence manifest records source tree IDs, lockfile and server/client dist hashes;
each run records the dirty harness files separately from runtime HEAD.

Review found that the archived server resolved shared JavaScript through the
workspace dependency link. Shared source stayed unchanged during the runs, and
a fresh archived shared build afterward matches all 908 workspace dist files
byte for byte (hash in evidence). **No shared-runtime fingerprint was captured
at run boundaries**, so this is retrospective support, not attestation of the
loaded bytes throughout measurement. These results remain ceiling observations
and attribution evidence, not a certified frozen-runtime ratchet. The final
driver now resolves shared from the actual server entry, fingerprints server,
client, shared dist and shared package metadata at start/end, and rejects numeric
acceptance if bytes changed or identity evidence is absent. Its regression test
exercises the same external-server/live-workspace-link failure mode.

Run the full fixture once with each long provider:

```sh
node scripts/perf-repro/active-session.mjs --work /tmp/p190/w \
  --label qual-be7-claude --long-provider claude --additional-tab --typing \
  --server-dist /tmp/p190/qualification/build/packages/server/dist \
  --client-dist /tmp/p190/qualification/build/packages/client/dist
```

Substitute `codex` for the second run. Both use 200 projects, 50,000 idle
sessions split equally between Claude and Codex, plus one long session with
200 compactions (Claude approximately 470 MB; Codex 488 MB before writes).
The first catalog reconciliation scans/writes exactly 50,001 rows through 201
adapters. The original 180-second idle and active phases remain; an additional
180-second two-tab phase and a separate 60-second typing phase follow. Every
write phase crosses one compaction. Warm-up writes are excluded. All 134
visible markers in each active phase appear (45 user, 89 assistant); tool/user/compaction writes are
included in the CPU denominator but do not all have visible markers.

The three-second baseline and measured phase windows have CPU occupancy, load,
available RAM and swap evidence and pass the existing built-client host policy,
with at least 8 GiB available required for the large fixture. Darwin CPU counters
and swap are now collected explicitly. Lists and restart did not have separate
host windows in this recorded driver revision; their neighboring windows show
headroom, but this is a qualification limitation. The final driver adds separate windows
for those phases and rejects a missing required phase window. Those additions
were made after the recorded runs; recorded assessments retain the measured
driver hashes and have not been recomputed with the later gate logic. No competing tests, build or
review ran during timed experiments. Neither optional CPU nor browser profiling
was enabled in qualification or controls. The normal production stall recorder
remained enabled. These are portable ceiling observations; the old `base2-*`
runs lack capacity keys and are historical context, not a same-capacity ratchet.

All stores, profile, HOME and provider config roots belong to the repro. The
user's port 3400 was untouched; the repro uses 3420/4420 and reaps its processes.
Fresh worlds are cloned for each run and removed afterward; the seed remains.
Raw artifacts are under `/tmp/p190/w/results/<label>/`; they are temporary and
are identified by hashes in checked-in evidence.

## Full fixture results

| Measure | Target | Claude | Codex |
|---|---|---:|---:|
| Main-thread CPU/write | ≤5 ms, flat | 127.7 ms | 169.7 ms |
| Process CPU/write | ≤15 ms, flat | 298.4 ms | 351.5 ms |
| Event-loop p99 | ≤50 ms | 19.6 ms | 24.6 ms |
| List reload GETs/write | 0 | 0 | 0 |
| Detail GETs/write | ≤1 small fetch, or push | 1.97 | 1.97 |
| Collection stream decoded bytes/write | a few KB | 99.03 KiB | 100.01 KiB |
| Tab task work/write | ≤5 ms | 65.8 ms | 68.1 ms |
| Tab task time/core | ≤1% | 6.58% | 6.81% |
| Visible user/assistant write → DOM marker p95 | ≤250 ms | 251 ms | 239 ms |
| Sequential key → RAF/value max | ≤100 ms; exact prefixes | 26.71 ms, 78/78 | 25.41 ms, 78/78 |
| Warm list/Inbox loopback median range | ≤10 ms server time | 0.3–3.1 ms | 0.4–2.9 ms |
| No-write phase CPU / 180 s | about zero | 2.0 s | 2.2 s |
| No-write phase RSS, long tab already opened | ~300 MiB idle host | 711 MiB | 780 MiB |
| Restart, lists complete | ~1 s; no rescan | 1,404 ms | 1,416 ms |
| Restart CPU through +30 s | about zero recurring work | 5.02 s | 5.24 s |
| Restart RSS before opening long tab | ~300 MiB | 291 MiB | 289 MiB |
| Cold open → latest DOM marker | contextual end-to-end clock | 894 ms | 1,420 ms |
| First cold detail server clock | ≤300 ms | 415.5 ms | 872.3 ms |

Loopback medians include network/response delivery, so their passing values
bound the server clock. DOM marker insertion is not a measured presented frame.
The memory row is measured after initial long-session construction with a tab
open; it does not isolate a fresh host containing only idle short sessions.
Post-restart RSS is much lower. Allocator/GC debt, native retention and exact
owners of the difference remain unattributed; neither number proves memory
flatness. Codex demonstrably parses the whole rollout during preview refresh,
so the bounded-history memory requirement remains failed regardless of RSS.

Two tabs produce process CPU/write of 293.6/348.9 ms (Claude/Codex), versus
298.4/351.5 for one. Negative deltas are sequential noise/order effects, **not**
proof of the ≤1 ms extra-tab target. Interleaved repetitions are required.

Claude's first cold detail is 230 ms project lookup + 30.1 ms read + 154 ms
augmentation, 415.5 ms total. Codex is 226.8 + 496.7 + 142.1 ms (plus small
normalization), 872.3 ms total. Its subsequent empty incremental read takes
1,250 ms while a concurrent preview refresh takes 1,259 ms. The cold server
clock and DOM clock are separate; later requests are not added to first paint.

## Independent scale controls

Use `--phases active --seconds 180 --warmup 20 --quiet 60 --settle 10`, keeping
200 projects and the same build/host. Vary only `--sessions 400` (200-compaction
history) or `--compactions 20` (50,000 idle sessions). Each run has one tab,
180 writes and one compaction; no typing or profilers. Run order: full Claude,
full Codex, then Claude population, Codex population, Codex history, Claude
history. The points are fresh worlds but not randomized/interleaved repetitions.

| Provider | Idle sessions | Compactions | Main ms/write | Process ms/write | Tab ms/write |
|---|---:|---:|---:|---:|---:|
| Claude | 50,000 | 200 | 127.7 | 298.4 | 65.8 |
| Claude | 400 | 200 | 89.0 | 153.5 | 75.5 |
| Claude | 50,000 | 20 | 121.6 | 280.3 | 63.1 |
| Codex | 50,000 | 200 | 169.7 | 351.5 | 68.1 |
| Codex | 400 | 200 | 132.4 | 234.2 | 73.8 |
| Codex | 50,000 | 20 | 167.5 | 343.7 | 68.4 |

Population work remains large for both providers. Ordinary Codex writes change
little when history is reduced tenfold. These controls identify priorities;
they do not certify asymptotic flatness or a 1 ms difference. Project count is
held at 200, so even the 400-session control retains project-wide work.

## Attribution, separate from acceptance timings

`attr-be7-claude` and `attr-be7-codex` use the full fixture, ten warm-up and
30 measured ordinary-append seconds, with both optional profilers enabled.
They do not cross a compaction. Three-second native thread samples accompany
the profiles; their timings are diagnostic only. Inclusive stack costs below
overlap and must not be added.

- Claude main profile: Codex project grouping accounts for about 630 ms
  inclusive/30 s, canonical path string normalization 535 ms, reading session
  heads for cwd 382 ms, retained query result/synchronization 323/297 ms,
  relationship publication 171 ms, project-directory facts 160 ms. Even a
  Claude write pays for mixed-host project discovery.
- Codex additionally spends roughly 298/279/246 ms self in code-name prefix,
  automatic-name and associated callbacks, plus reconciliation. Its tab makes
  180 extra single-project GETs in 180 writes, taking 4,756 ms aggregate wall
  time. This is distinct from list reloads, which are zero.
- `ProjectScanner.getProject` obtains a complete snapshot before its catalog
  join. `CodexSessionScanner.listProjects` regroups all cached native sessions
  and normalizes paths. Sharing discovery removed per-project index copies;
  it did not remove this full-population consumer. `nativeCatalogAdapters`
  currently covers Grok, Pi, OpenCode and Antigravity. Thus zero SQL-projected
  native projects in this Claude/Codex fixture is expected, not missing fixture
  coverage or a path-alias configuration error. Path canonicalization here is
  string work, not a filesystem `realpath` operation.
- Native samples show libuv filesystem workers in open/scandir/stat and V8
  workers in concurrent marking/sweeping/compiler work. They explain classes
  of the process-minus-main cost, not an exact additive CPU allocation.
- Browser profiles are predominantly React update/reconciliation stacks.
  Some hot functions are shared tool-output parsing and layout. Bundle chunk
  names are not component ownership: a hot function in the
  `ProviderChildSessionDetail` chunk is actually `extractDetachedCellId`.
- Open collection streams carry about 100 KiB/write despite changed-row
  delivery. `diffCollectionView` replaces the complete metadata object when
  it changes; catalog generation and the project/filter metadata share that
  object. Finished HTTP request sizes alone missed these live-stream bytes.
- On the post-restart Codex open, `codex_entry_read` reports a cache miss over
  495,332,291 bytes / 154,131 lines, with ~493 MB heap growth. The preview route
  falls back to `loadRestartSourceSession` when no excerpt reader is available.
  The neighboring bounded read has only 584 entries / 1.93 MB cached but waits
  behind that full parse. This violates the intended reader contract even
  though normal active writes are bounded. See the
  [preview defect](../../gaps/codex-preview-refresh-parses-whole-rollout.md).

## Gates and next scope

The driver now records open-stream bytes, Server-Timing, host eligibility,
raw per-marker timestamps, sequential typing and a separate extra-tab phase.
The helper tests protect missing evidence, unfinished-stream accounting and
actual runtime dependency identity.
`--check-targets` is an opt-in **numeric subset** guard, not full acceptance or
a machine-specific ratchet. It must reject missing metrics, ineligible hosts
and profiler runs, plus missing/changed runtime identity. Full goal acceptance remains explicitly false while idle
work, flatness, no-rescan restart and parsed-history retention remain open.
No failing measured ceiling is relaxed. The routine fast tests check evidence
integrity; the expensive full fixture remains an explicit performance run.

Recommended next slice: make Claude/Codex project identity, counts and activity
source-owned facts updated from changed records, then serve point lookups from
that owner. Preserve ordering, identity aliases, provider precedence, hidden
projects, code names and current response semantics. Remove the complete
project-discovery fallback from ordinary detail reads only after parity is
proven. Repeat population controls and the full fixture afterward.

Other valuable bounded slices are routing preview/summary consumers through
bounded shared ingestion, then separating collection metadata by ownership and
carrying transcript changes through rendering. Quiet-host/restart lifecycle
work remains independently useful. Avoid another per-request cache as the
substitute for removing complete consumers.

## Validation and review outcome

Sol 6.1, high effort, bypass permissions reviewed through the maintainer's YA
server on port 3400 (session `bc99651c-05f5-4197-8331-a653d77309ab`). Review
was read-only. One should-fix (shared runtime provenance) and one nit (mixed
marker population) were verified and addressed. Follow-up review reports no
remaining must-fix, should-fix or nit findings. Old measured assessments were
not rewritten after either correction.

Lint, formatting, type checking and source budgets pass. All 22 root Node
checks pass, including six measurement tests. Copy-aside/exact-restore negative
controls prove the live-stream test fails when unfinished responses are ignored
and the runtime-link test fails when shared fingerprints are omitted. The final
full-phase small smoke verifies separate typing, additional tabs, list/restart
host windows and cleanup. A further small smoke verifies the resolved workspace
shared dependency and identical start/end runtime fingerprints. Smoke timings
are functional evidence, not target acceptance.

Before benchmarks, the full non-Android suite passed (server 7,355; client
7,382; shared 986). Final client/shared/root and other workspace checks pass.
Two later complete server runs each report 7,354 passed, 94 skipped and one
failure in the unchanged Antigravity admission test: a process is still absent
at its default wait deadline. The eight-test file passes immediately alone;
the second complete server run reproduces the assertion without the initial
smoke/typecheck workload. This remains an unresolved suite limitation, recorded
in the [admission-test gap](../../gaps/antigravity-admission-test-startup-window.md);
full-server acceptance is **not** reported green. No production or provider-test
code was changed to mask it.
