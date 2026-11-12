# Long-session frontend performance with automatic unloading

Follow-up to [frontend calibration](190-frontend-renderer-calibration.md),
plan [190](../tactical/190-active-session-cost-at-scale.md), stage 4 / step 6.
The maintainer requested the normal long-session case in which older compaction
windows can leave browser memory. The earlier history-retaining experiment is
not a measurement of that setting.

## Workload and boundary

The existing frontend fixture now accepts `--retention rolling` or `growing`
with `--views page`. Both use the actual full session page, normal initial-history
preferences (two compaction windows and 20 real user turns), and the same
normalized recent window of 82 messages: 20 prompt/tool/result/answer turns and
two compaction boundaries. Backing history is represented by metadata; the fake
source does not allocate all 1,000 or 10,000 historical turns inside the browser.
This does not measure provider transcript reads, a large file's cold load, or
backend/server memory.

Each update goes through the real page's focused watch subscription, catch-up
scheduler, incremental fetch and session-detail coordinator. The fixture does
not directly dispatch updates into the store for this workload. Its in-browser
source returns appended messages after the requested cursor, without a replacement
pagination fence, and emits a unique watch change. No rendered component or
production retention rule changes. The synthetic source retains its small replay
buffer independently of the page's active window, so store charge is not whole
browser heap or RSS.

One update per second completes a Read call/result/answer. Every fifth update
also begins a new real user turn; tool results do not count as human turns.
Updates 10 and 30 append compaction boundaries. New messages and compactions use
real current timestamps, while the initial history is old. No clock override
or backdating makes new boundaries prematurely eligible.

An 85-update run lasts long enough for both a first trim against an old initial
boundary and a second trim after the first live boundary becomes more than
60 seconds old. `rolling` enables the existing automatic-unload preference;
`growing` disables only that preference. Neither selects Load older or scrolls
away from the live tail. A long rolling run must observe at least two accepted
trim revisions, exactly two retained compaction boundaries, and a changed oldest
message ID. The growing control must observe no trim. Every visible reply saves
an O(1) retention observation (message count, prefix/suffix IDs and trim revision), so DOM virtualization alone
cannot satisfy the unload check. Compaction count and approximate store charge
are read only at the start and end. Fixed mode does not sample per-reply retention.

The same frame, native-input, visible-marker, build/harness/host identity and
failure-evidence checks from the earlier harness apply. Typing duration scales
with the run rather than stopping at a fixed phrase-repeat cap, so it overlaps
the age-guarded trim. Its timestamps establish whether overlap actually occurred.
The old fixed-history mode remains available with its original direct-store
measurement boundary; numbers from the different delivery paths must not be
attributed to automatic unloading alone.

## Run

Build the fixture in an external archive as described in the
[original calibration](190-frontend-renderer-calibration.md#run). For example:

```bash
node scripts/perf-repro/transcript-browser.mjs \
  --client-dist <archive>/packages/client/dist --views page \
  --retention rolling --turns 1000,10000 --appends 85 --repeats 1 \
  --typing --out /tmp/frontend-rolling
node scripts/perf-repro/transcript-browser.mjs \
  --client-dist <archive>/packages/client/dist --views page \
  --retention growing --turns 1000 --appends 85 --repeats 1 \
  --typing --out /tmp/frontend-growing
```

Use separate fresh output directories. The two rolling history sizes test
whether the represented old corpus changes frontend cost when the same recent
window is loaded. The growing control isolates automatic unloading with the
same initial window and delivery path. These are calibration controls, not full
50,000-session acceptance or high-rate streaming qualification.

## Outcome

All four accepted commands exit zero on the same frozen fixture and harness,
Node 25.8.2 / sandboxed Chromium 148.0.7778.96. Checks, reviewer and builds are
idle during accepted windows. All host baseline/measured windows pass the
existing capacity/headroom/memory/swap policy. This is one run per case,
85 updates each, not a statistical timing ratchet. The
[evidence](190-rolling-transcript-window.evidence.json) preserves identities,
source/raw/log hashes, per-update retention traces, trim times and key latencies.

Append-only results, all using the same actual frontend ingestion path:

| Backing history represented | Automatic unloading | CPU ms/update | Reply visible p95 / maximum | Frame gap p95 / maximum | Final retained messages / compaction markers |
|---|---|---|---|---|---|
| 1,000 turns | On | 59.0 | 39.3 / 42.8 ms | 10.3 / 43.0 ms | 242 / 2 |
| 10,000 turns | On | 58.2 | 39.5 / 43.5 ms | 10.3 / 26.4 ms | 242 / 2 |
| 1,000 turns | Off | 55.4 | 41.5 / 62.9 ms | 10.3 / 22.1 ms | 356 / 4 |

The normal cases both start with 82 messages and reach an observed maximum of
267. The first compaction at about 10 seconds advances the retained prefix from
the first old compaction window to the second, leaving 78 messages after that
update. At about 70 seconds the first live boundary passes the 60-second age
guard; the page advances its prefix to `compact-live-10`, leaving 198 messages.
It then grows to 242 by the final update. These are actual store trim revisions
and prefix changes, not merely fewer mounted DOM rows. The retention-off control
keeps its initial prefix and grows to all 356 messages without a trim.

The 1,000-turn normal case with continuous native typing also passes: all 85
reply markers and 1,292 exact input/acknowledgement prefixes are present.
Key-to-frame latency is 8.5 ms p95 / 13.2 ms maximum, below the 100 ms requirement.
Typing continues until 87.158 seconds, after the second unload at 70.034 seconds.
Reply visibility is 42.1 ms p95 / 48.7 ms maximum, and frame gaps are 10.5 ms p95 /
39.2 ms maximum. No case records a 50 ms long task. Occasional 26–43 ms frame gaps
remain, so this is not uninterrupted 60 fps or physical-display qualification.

The typed phase accumulates 155.8 ms of browser task time per transcript update,
including all 1,292 key events, draft/input work, observer work and the slightly
longer typed phase. It must not be described as 155.8 ms spent rendering each
answer. The append-only CPU figures likewise include idle/probe/page work and
remain well above the original 5 ms total-work aspiration.

## Interpretation

Increasing represented old history tenfold does not increase this frontend's
loaded recent window; observed append cost and visibility are similar in the
two normal cases. That supports the intended bounded frontend working set.
It says nothing about server parsing/file I/O or its 50k-session CPU/memory targets.

Automatic unloading does not produce a CPU improvement over the paired off
control in this short experiment. The off control crosses the semantic
virtualization threshold and finishes with only ten mounted rows, whereas the
smaller unloaded window finishes with 167 mounted rows below that threshold.
This is an interaction between the data window and render window, not evidence
that keeping more history is generally cheaper. A profile/trace is needed before
attributing the CPU or worst-frame differences to a particular mechanism.
Approximate store charge is recorded only as diagnostic metadata; the synthetic
source's replay buffer means whole-browser heap/RSS savings are not measured.

The earlier 271–278 ms first-reply delay with all 1,000 turns deliberately
retained does not recur in this normal-window workload. The comparisons differ
in initial retained history, ingestion path and human/tool-update cadence, so
no percentage improvement can be attributed to unloading alone. The useful
answer is that this normal configuration kept recent updates visible within
about 40 ms p95 and typing responsive while older compaction content left the
active store.

Next priority is to extend this normal-window workload to actual streaming-tail
replacement and larger tool completion, before treating expanded-history
first-reply delay as the main frontend issue. Normal-path CPU attribution and
the render-window threshold interaction remain candidates if the 5 ms efficiency
target stays a priority; backend acceptance remains separately open.

## Verification

Full safe-home workspace tests pass: server 7,400 (94 skipped), client 7,397,
shared 989, root 23 and the other participating workspaces. Lint, typechecking,
formatting, source budgets and console checks pass. No production changes,
source-budget raises, SQL changes, timing-ratchet changes or new permanent tests.
The existing nine real-browser sampler controls run before each measured case;
new opt-in acceptance checks prove the exact 356-message growing control,
242-message normal suffix, accepted trim revisions and late typing overlap.
The old fixed-history three-append/native-typing regression also passes.

Sol 6.1 high reviews through YA with applied bypass permissions and read-only
instructions. The growing-count false-pass and history-dependent sampler-cost
findings were verified and fixed. Per-reply retention sampling is O(1) and is
absent from fixed mode; statistics/compaction scans happen at snapshots only.
The synthetic source now mirrors activity/session-watch heartbeats with one
source-owned 25-second timer, cleared on disposal. The initial 85-second run
without that keepalive is excluded because its artificial 75-second reconnect
invalidated the timing window. Final source, numerical and provenance review cleared with no remaining findings.
Desktop 1000 x 600 and phone 375 x 812 captures through the artifact facility
were inspected separately after a real accepted prefix trim and native typing;
the newest reply and intact composer text remain visible, with usable controls
and no stale-runtime/error banner.
