# Stale hosted HTML can leave a gray screen after its bundles expire

On 2026-11-23, a relay Inbox tab on a Pixel 9 running Chrome 157 stayed
gray after returning to the foreground. DevTools found a completed, visible
document with zero children under `#root`, no loading UI, and a background
paint. The document reported a `back_forward` navigation. HTML arrived in
47 ms and the load event finished at 222 ms.

The document referenced `main-CINDhIZn.js` and `base-BtSUD7Z2.js`. The latter
received HTTP 200 with `Content-Type: text/html`. Chrome logged a module MIME
error and the app never mounted. Independent requests to both old asset URLs
returned bytes identical to the current SPA HTML. An ordinary reload picked
up the current entrypoint and dependency, received JavaScript for both, and
restored the Inbox with first contentful paint at 388 ms.

The latest hosted deploy includes the current build and copies assets listed
in the preceding deployment's manifest. The new manifest describes only the
current build. A bundle unique to a build can disappear after two subsequent
deploys. The incident confirms that a browser can still use HTML referencing
expired assets. The navigation timing recorded service-worker involvement.
The reason this navigation received the older document is still unknown.
[Retention script](../packages/client/scripts/retain-previous-asset-generation.mjs) ·
[Asset-generation contract](../topics/client-asset-delivery.md#deployment-generations)

Reproduce with an old hosted entrypoint and a missing static module dependency
that receives the SPA fallback. Verify that the page either renders with its
retained assets or recovers once with fresh HTML and preserves the route and
draft. If startup still fails, the initial HTML needs to offer a recovery action.
Choose a retention window and an HTML-level failure response before changing
the deployment. The [background reconnect gap](background-relay-reconnect-blank-page.md)
records a tab whose app was already issuing session requests while blank. The
shorter 5–10 second blackouts also need their own trace before attribution.

Found 2026-11-23 while inspecting the affected phone tab before reloading it.
