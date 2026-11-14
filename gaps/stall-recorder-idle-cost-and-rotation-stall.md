# The stall recorder costs idle CPU and stalls the loop it watches

`startStallRecording` (`packages/server/src/logging/stall-recording.ts`) keeps
V8's CPU profiler running at a 10 ms sampling interval for the life of the
server, wakes every 100 ms to measure loop delay, and every 30 seconds stops
the profiler, receives the whole profile through the in-process inspector
session, and starts it again. The profile is kept only when the window held a
stall of a second or more; otherwise it is discarded after it was built.

Measured with `scripts/perf-repro/active-session.mjs` (10,000 idle sessions,
one tab, production build of `68cc52815`, Node 25.8.2, Apple M4 Pro),
comparing the default against `YEP_RESOURCE_SAMPLE_SECONDS=0`, which turns
the resource sampler and the recorder off together:

| | Recorder on | Recorder off |
|---|---:|---:|
| Server main-thread CPU, 60 s with nothing written | 0.8, 0.8, 0.6 s | 0.2, 0.3 s |
| Event-loop delay maximum, idle | 96.5, 96.7, 103.2 ms | 8.6, 14.7 ms |
| Event-loop delay maximum, one write a second | 122, 110.1, 90.4 ms | 29.7 ms |
| Main-thread CPU per write | 50.1, 57.8 ms | 49.9 ms |

Where a row has three "on" figures the third is the Codex-session run; the
rest are Claude. A second "off" active run overlapped an unrelated CPU-heavy
job on the host and is left out.

Two effects reproduce in every run:

- **Idle cost.** About 0.5 s of main-thread CPU a minute, three quarters of
  what an idle server with one open tab uses. Plan 190's idle target is
  "about 0 CPU", and an on-device Android host pays this on battery.
- **A stall of about 100 ms every 30 seconds.** The rotation's
  `Profiler.stop` is synchronous. A separate 1 ms profile of the same
  scenario attributes about 115 ms per rotation to `rotate` →
  `session.post` → `dispatch`. The recorder exists to explain stalls and is
  the largest regular one on a healthy server; its own loop-delay maximum
  never reaches the 1 s threshold, so it does not record itself.

Per-write CPU while a session is active does not differ beyond run-to-run
noise.

Not fixed in place: the recorder is deliberate diagnostics (`e92b1c56e`,
"profiling started afterward misses it"), and each cheaper shape gives
something up, so the choice is the feature owner's:

- Rotate less often. The stall becomes rarer and longer, and the retained
  window grows.
- Sample less often than 10 ms. Smaller profiles, coarser stacks; whether
  the stop gets proportionally cheaper is unmeasured.
- Start profiling only after a first stall is seen. No cost on a healthy
  server; the first stall of a run has no stacks.
- Make the recorder an opt-in setting, default off, beside the resource
  sampler.

The split between the sampler and the recorder is not measured: the
environment switch disables both. The sampler is one line every interval and
is unlikely to account for a 100 ms stall.

Found 2026-11-13 while profiling plan 190's scenario for remaining
per-write costs.
