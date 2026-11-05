# Hosted native browser typing acknowledgements exceed 100 ms

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

## Recurrence on Linux and macOS

At `568d097dd`, [run 42126184144](https://github.com/kzahel/yepanywhere/actions/runs/42126184144)
passes all twelve native app cases on both default worker profiles. Browser
checks still fail their unchanged 100 ms gate:

| Job | Case | Observed acknowledgement |
| --- | --- | --- |
| Linux 127590883985, artifact `native-app-ubuntu-24.04-1` | Claude reload during streaming | 104.9 ms |
| macOS 127590884296, artifact `native-app-macos-latest-1` | Claude reload during streaming | 114.5 ms |
| Same macOS job/artifact | Codex reload during dense tool output | 271 ms |

Linux passes the Codex reload and grouped-input cases; macOS passes grouped
input. All three macOS initial mounts succeed. The failed cases reach the
latency assertion after their per-prefix value and acknowledgement-count
checks, so there is no reported dropped-character assertion. They stop there;
later reload/final-history assertions in those cases are not qualified by this
run. The local three-case browser pass remains a separate sample.

The retained traces/error contexts confirm the failure locations but contain no
main-thread CPU profile establishing a cause. No product input change, relaxed
limit or retry is justified by those samples alone. Record first/second-frame
marks and main-thread work alongside an owned plain-input control when
investigating this streaming-output latency. Full hosted browser acceptance
remains incomplete; it is separate from durable metadata/native app acceptance.
