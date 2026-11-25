# New Session does not say when AAR has a provider turned off

AAR leaves experimental Antigravity routing off until its owner turns it on
in AAR Settings. While it is off, `/v1/selection` and `/v1/overview` list no
Antigravity account or pool and carry `disabledProviders: ["antigravity"]`.
YA passes the reply through, and `RouterPoolSelector` hides itself when there
are no pools, so New Session shows Antigravity as direct-only with no reason.
Settings → Providers gives none either.

A launch does say why. A resume of a routed session, or a creation that
names a router account or pool, is refused with "Antigravity routing is
turned off in AAR…" (`routerProviderDisabled` in
`packages/server/src/services/agent-auth-router-control.ts`), and the
session keeps its pin.

Not fixed in place because the hint needs a field on
`AgentAuthRouterOverview`, a line in the picker and in Settings → Providers,
and strings in six locales. The likely fix: type `disabledProviders` in
`packages/shared/src/agent-auth-router.ts` and render one line where the
selector would have been, naming AAR Settings. The v0 selection read could
report it the same way.

Found 2026-11-25 while adding the opt-in for plan 198 step 4.
