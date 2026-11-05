# Antigravity native cold-resume qualification can exhaust ten seconds under load

The real Antigravity cold-resume scenario in
`packages/server/test/native-provider/native-lifecycle.test.ts` exhausted its
10-second budget when the full workspace suite and all-provider native suite
ran concurrently on macOS arm64 / Node 24.22.1. The all-provider suite reported
64 passes and that single timeout. The unchanged scenario passed in a later
standalone all-provider run (65 cases, 57.84 s total). No timeout, assertion or
native retry policy was changed to get that pass.

The scenario launches the actual runtime twice and reloads native persisted
history. Keep provisioning/start/load/reader/cleanup phases attributable before
choosing to accelerate it or derive a larger case-specific budget from the
observed 10-second limit. This is separate from FIFO input correctness and
from the already wider Antigravity rate-limit recovery case. Evidence is in
ignored `tasks/input-boundaries-implementation/fifo-{all-native,all-second}.log`.

Reproduced 2026-11-05 while qualifying cross-provider native v0 creation. The
all-provider run overlapped the workspace and eight native-app cases: this
case exhausted 10 seconds again. Its diagnostic already contained the expected
cold-resume reply and result with idle state, so total startup/reader/cleanup
cost still needs attribution. Two OpenCode cases also exhausted their separate
five-second envelopes, tracked in the [OpenCode native scenario gap](opencode-native-scenario-budgets-under-concurrent-load.md).

With the same source and no competing workspace/native-app run, all 68 native
cases passed in 41.66 seconds wall / 97.09 aggregate test work. Automatic host
samples reported maximum load 0.34 per effective CPU and at least 31 GiB
available memory; Darwin CPU-busy/swap counters were unavailable. The earlier
red run remains evidence of the load limit, not a repaired flake. No timeout
or assertion in this scenario changed. Local logs are
`tasks/session-relationships/slice-14-{qualified,quiet}-native-all.log`.

Found 2026-11-04 while verifying the shared input-queue FIFO repair.
