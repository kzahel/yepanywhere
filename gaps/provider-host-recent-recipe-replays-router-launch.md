# A recent Provider Host recipe replays a routed launch without asking the router

The Provider Host stores each runtime's full launch options as
`entry.launchRecipe` (`scripts/provider-runtime-host.mjs`), including
`routerLaunch` with its base URL, model catalog URL and binding token. On
shutdown it publishes claimable runtimes as recent candidates, and a request
with `resumeRecentRuntime: true` cold-starts a worker from that saved recipe.
That start never calls `AgentAuthRouter.launch`, so it does not recheck the
binding, the account or the transport the router currently describes, and the
recipe file holds the binding token while it waits.

Only `scripts/provider-runtime-turns.mjs` sends `resumeRecentRuntime` today;
the server's own routed launches go through `Supervisor`, which calls
`AgentAuthRouter.launch` and reattaches a live worker only when its binding id
matches. Within that script path:

- a recipe can replay a route the router no longer describes;
- a recipe saved before plan 198 has no `modelCatalogUrl`, so a routed Codex
  worker recovered from it starts without model catalog discovery.

[Plan 198](../docs/tactical/198-aar-binding-transport.md) states that a cold
resume gets the binding's current transport. To hold that here, a routed cold
recovery should obtain a checked launch from YA instead of replaying
`routerLaunch`, or the recipe should omit `routerLaunch` and be ineligible for
recovery without one. Not fixed in place because it changes the Provider
Host's recovery contract.

Found 2026-11-25 while reviewing plan 198 step 2.
