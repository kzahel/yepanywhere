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

Found 2026-11-04 while verifying the shared input-queue FIFO repair.
