# YA still knows AAR's URL layout for routers without binding transport

`legacyRouterTransport` in
`packages/server/src/services/agent-auth-router-transport.ts` synthesizes an
`http-gateway-v1` description for a router that does not advertise
`binding-transport-v1`. It rebuilds `/<provider>`, Codex's `/codex/models`
catalog and the gateway-header auth method from the provider name and older
capabilities. That is the coupling
[plan 198](../docs/tactical/198-aar-binding-transport.md) removes everywhere
else. It was kept deliberately so routed sessions launch and resume whichever
of YA and AAR is upgraded first.

Remove it once the AAR desktop update and the Docker image that advertise
`binding-transport-v1` have both been released. The capability first appears
in AAR commit `d5623a7`, which is unreleased as of 2026-11-25. Record the AAR
version and release date here when it ships.

The removal commit:

- deletes `legacyRouterTransport` and this entry;
- checks `binding-transport-v1` in `AgentAuthRouter.launch` and
  `AgentAuthRouter.switchBinding` beside their other capability checks,
  before an allocation is persisted, and fails a Claude or Codex launch or
  switch with an "Update AAR" error;
- turns the existing router-test cases that run without the capability into
  cases for that error, and does the same for the old-router case in AAR's
  cross-repository suite;
- updates the "Older routers" paragraph of the
  [binding transport contract](../topics/agent-auth-router.md#binding-transport-2026-11-25).

Found 2026-11-25 while implementing plan 198 step 2.
