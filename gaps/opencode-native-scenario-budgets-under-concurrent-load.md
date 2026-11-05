# OpenCode native scenarios can exhaust five seconds under concurrent suites

The actual OpenCode cancellation/continuation and controlled rate-limit recovery
cases in `packages/server/test/native-provider/{native-lifecycle,native-recovery}.test.ts`
exhausted their five-second envelopes while all-provider, workspace and eight
native-app scenarios ran concurrently on macOS arm64 / Node 24.22.1. The
all-provider run reported 65 passes / three timeouts; the third is the existing
[Antigravity cold-resume finding](antigravity-native-cold-resume-under-concurrent-load.md).

The cancellation diagnostic had no model requests, provider errors or
diagnostics yet: it had not reached initial model dispatch. No unexpected
protocol or synthetic-credential rejection was recorded. This points to a
startup/resource budget, but retry and teardown phases still need attribution.
The model-listener change under review has equivalent single-protocol behavior;
do not label these timeouts a protocol-regression proof or a fixed flake.

The same source passed all 68 native cases without competing workspace/app
suites: 41.66 seconds wall / 97.09 aggregate test work. Automatic host samples
reported maximum load 0.34 per effective CPU and at least 31 GiB available
memory; Darwin CPU-busy/swap counters were unavailable. The earlier red remains
retained in `tasks/session-relationships/slice-14-qualified-native-all.log`;
the control and host evidence are under `slice-14-quiet-native-all*`.

Not changed alongside the cross-provider fixture work: native startup,
recovery and teardown belong to their existing runtime/scenario owners.
Measure those phases and the slowest supported runner before accelerating
them or deriving a case-specific budget. The five-second limits and semantic
assertions remain unchanged; a later quiet pass does not close this defect.

Found 2026-11-05 while qualifying native cross-provider v0 creator relationships.
