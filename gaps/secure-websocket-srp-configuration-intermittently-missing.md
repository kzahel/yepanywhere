# Secure WebSocket suite can resolve missing SRP configuration

The November 6 whole-workspace run while qualifying the Session Info
relationship consumer failed 22 cases in
`packages/server/test/e2e/ws-secure.e2e.test.ts`. Twenty reported
`SRP error: Remote access not configured`; the wrong-password log assertion
also failed, and the unauthenticated-plaintext case exhausted its unchanged
five-second guard. The suite had explicitly awaited its private
`RemoteAccessService.configure` before creating the relay handler.

The same server source passed the preceding whole-workspace run. A focused
run immediately afterward passes 23 cases, with one skipped, in 17.15 seconds
(14.60 seconds test work). This does not establish a cause or repair. The
relationship consumer changes client code; no server transport/configuration
change is included in that slice.

Keep the failed run as evidence rather than weakening SRP expectations or
increasing guards. A targeted investigation should distinguish a missing
service dependency (`server_error`) from absent credentials (`invalid_identity`)
in `handleSrpHello`, then verify which configured fixture/handler accepted the
socket. The current client helper reports only the shared error message.
Do not attribute this to Wi-Fi, input performance or a known configuration race
without that evidence.

Found 2026-11-06 while validating durable relationship navigation.
