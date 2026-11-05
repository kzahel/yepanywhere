# Hosted OIDC/native workflow exhausts its five-second case budget

[CI 42040040396](https://github.com/kzahel/yepanywhere/actions/runs/42040040396)
at `a0627fb63` fails
`packages/server/test/core-api/identity-service-oidc.test.ts:64`,
`uses actual OIDC code/PKCE/JWKS then the shared key-bound enrollment and protected native workflow`.
The case exhausts Vitest's default 5,000 ms. The server job reports one failure,
7,143 passes and 27 skips in 565.76 seconds. No phase of the OIDC/enrollment/
native workflow is identified by the timeout alone.

The source being qualified changes native test lifecycle and diagnostics,
not this test or authentication runtime. Retain the hosted failure and attribute
fixture, cryptographic, HTTP and native-workflow phases before changing its
budget or calling it a flake. This is separate from the relationship native
qualification job and its provider/startup findings. Local passing workspace
checks do not close this hosted failure.

The complete retained log is under ignored
`tasks/session-relationships/slice-22-main-ci21-unit.log`.

Found 2026-11-05 while qualifying durable session relationships on hosted runners.
