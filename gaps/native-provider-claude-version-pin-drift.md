# Full-app native Claude fixture pin lags the declared SDK/runtime target

`packages/server/test/native-provider/app-fixture.ts` validates the real Claude
executable against `expectedVersions` from `runtimes.ts`, which still says
2.1.312. The root package now declares audited Claude 2.1.318 / SDK 0.3.318.
The full-app API/browser fixture can therefore reject the newly provisioned
runtime before scenarios execute. A checkout still using older dependencies
cannot qualify the new target.

The ordinary Process-level `fixture.ts` already derives Claude/Codex expectations
from root compatibility markers; that baseline is not affected by this stale
table entry. Keep that distinction in the qualification report.

Align the fixture pin with the declared bundled runtime, then run the unchanged
native semantic scenarios against that executable and record the versions.
Prefer one declared version source where appropriate so future SDK updates
cannot silently leave the harness target behind. Do not weaken the exact-version
check, use the primary CLI as a fallback, or merely accept new snapshots.

Captured during relationship-design qualification, rather than repaired in the
read-only harness/compatibility review. See
[native provider testing](../topics/native-provider-testing.md) and
[the relationship qualification strategy](../topics/session-relationships.md#native-harness-and-independent-evidence).

Found 2026-11-04 while auditing inference-free native child-session coverage.
