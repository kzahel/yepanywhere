# Windows host-awake CI probe can time out

`windows-host-awake-smoke` in `.github/workflows/ci.yml` failed once on
`main` (run 38528251377, commit "Keep queued messages queued when recalling
in the composer"). `executes the real Windows PowerShell probe` in
`packages/server/test/services/WindowsHostAwakeBackend.test.ts` hit
`WINDOWS_HELPER_START_TIMEOUT_MS` (20 s) on the first attempt and on the
`--retry=1` attempt, rejecting with `Windows power probe timed out`
(`packages/server/src/services/host-awake/WindowsHostAwakeBackend.ts:410`).

It was the only failure of this job in the preceding 100 `main` CI runs, and
later runs passed. The probe compiles its C# interop type with `Add-Type`
before calling `GetSystemPowerStatus`; a slow compile on a cold runner is a
plausible stall point but is not established. The log carries no helper
stderr or timing, so on the next occurrence capture the helper's stderr and
elapsed time before choosing a fix. No timeout change or retry was added.

The same 20-second stall appeared outside the unit test on 2026-10-14: in
runtime run 38540391834 (attempt 1, Windows Node 23.11.0), server startup
logged `hostAwakeService initialized (+20029ms)` before a later
`/api/version` readiness timeout, recorded in
[windows-validation-baseline.md](windows-validation-baseline.md).

On November 24 the smoke job switched to a single attempt. The real probe
still uses its production startup deadline, and a first-attempt timeout is
reported as a job failure.

Found 2026-10-14 while triaging CI failures.
Contributing-model: claude-opus-5-5
