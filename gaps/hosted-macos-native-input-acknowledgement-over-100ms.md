# Hosted macOS native grouped input exceeds 100 ms acknowledgement

At `ddda13a4a`, [run 42115449136](https://github.com/kzahel/yepanywhere/actions/runs/42115449136),
macOS job 127553758255, passes all twelve app cases and both browser reload
cases. `native-input-identity.spec.ts` then fails its sequential-key check:
maximum keydown-to-double-animation-frame acknowledgement is 126.2 ms against
the unchanged 100 ms requirement while native streaming output is arriving.
This occurs after the composer has mounted, so extending cold readiness does
not repair it.

The retained `native-app-macos-latest-1` artifact contains the Playwright trace
and error context. Inspection confirms the complete `IDENTITY_UNSENT_DRAFT`
value at the assertion; no missing-character failure is reported. The trace
is not a browser CPU profile and does not establish whether React work, native
output, browser scheduling or host contention caused the delay. Sparse host
samples report maximum load per effective CPU 6.037; CPU busy and swap are
unavailable. Those samples are not causal evidence.

Keep the 100 ms gate and concurrent-output scenario. Capture browser main-thread
work and per-key input/frame marks on the affected capacity before choosing a
product or harness repair. A later passing run does not explain this miss.
This qualification finding is separate from the cold composer bootstrap and
two-worker app-case timeouts; source metadata correctness passed its app cases.

Found 2026-11-05 while qualifying durable session relationships on hosted macOS.
