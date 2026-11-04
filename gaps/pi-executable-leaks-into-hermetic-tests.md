# An inherited PI_EXECUTABLE overrides Pi test fixtures

`test/sessions/session-identity-pi-resume.test.ts` (packages/server)
configures a fixture Pi through `piPath`, but Pi executable resolution
ranks `PI_EXECUTABLE` / `PI_PATH` above the configured path
([provider version support](../topics/provider-version-support.md#per-provider-facts)).
The server's hermetic test setup does not clear those variables, so a
maintainer shell that exports `PI_EXECUTABLE` runs the real `pi` and the
test fails; it passes with the variable unset. Fix in the hermetic env
setup (clear both variables) or in the test, not by changing resolution
order, which is a documented operator contract.

Not fixed in place: found during a provider refresh, outside its scope.

Found 2026-11-04 while refreshing Pi to 1.5.0.
