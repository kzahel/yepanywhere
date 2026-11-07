# Client Asset Delivery

> Client asset delivery makes a built YA entrypoint and every chunk it names
> compact, cache-correct, and available across a deployment generation without
> caching mutable HTML as immutable application code.

Topic: client-asset-delivery

Status: Immutable recognition and hosted one-generation retention are
implemented. API response compression is implemented; production static
encoding, validators, and direct-server generation retention are not.

## Current demonstrated behavior

The production static handler reads the requested file completely with
`fs.promises.readFile`. Hono compression is mounted only for `/api/*` and
`/public-api/*`, so the application JavaScript and CSS bypass it.

The handler now treats the Vite-owned `/assets/` namespace as immutable instead
of guessing at Rollup hash characters. Current Vite names include hashes such
as `D3zWbkxu` and `BPXPYV9_`; both direct/LAN responses and the latest hosted
Cloudflare Pages deployment serve these paths with a one-year immutable browser
lifetime. HTML, the service worker, manifests, and other entry resources remain
revalidated. Before this correction, a fresh isolated build served the
2,668,843-byte application JavaScript response with:

```text
Content-Length: 2668843
Cache-Control: public, max-age=0, must-revalidate
```

It sent no `Content-Encoding`, `ETag`, or `Last-Modified`. The 565,170-byte CSS
response had the same delivery shape. A cache-disabled browser therefore
transferred both files in full. Ten repeated JavaScript requests added about
26.70 MB of server logical reads even though the operating-system page cache
prevented physical storage reads; each request still created whole-file read
work and a transient buffer.

The older assumption in tactical 022 that static assets were cacheable is
false for these generated filenames and headers. Cloudflare may compress or
cache the edge-to-browser response under its own policy, but it does not repair
the direct/LAN path or make origin delivery/versioning correct.

Both browser entrypoints are now route-split at semantic page and shell
boundaries. In the 2026-08-10 warning cleanup, the hosted entry's eager
JavaScript fell from 2,938,667 bytes to 477,061 bytes. The local entry fell from
about 2.84 MB to 472,214 bytes. The 2026-08-23 builds isolate the shared React
runtime: the local build emits a 193,530-byte runtime, a 304,690-byte entry, and
a 432,570-byte largest deferred chunk; the hosted build emits a 193,580-byte
runtime, a 310,990-byte main entry, and a 432,820-byte largest deferred chunk.
Every emitted JavaScript chunk from both builds remains below Vite's 500 kB
warning boundary, and every future Vite warning fails the owning production
build. Both builds bind `tssrp6a`'s Node `crypto` probe to the browser Web
Crypto API, preserving the existing secure-context requirement without a Node
compatibility shim.

The personal Pages publish path keeps earlier content-addressed assets instead
of deleting them, so its old entrypoints retain the chunks they name. The latest
hosted deployment reads the currently deployed `asset-generation.json`, copies
every previous runtime asset absent from the new build, and publishes a
manifest containing only the new generation. Version 2 manifest entries bind
each path to its byte size, SHA-256 digest, and media type; all three are checked
before a fetched prior asset is written. The legacy path-only manifest remains a
transition input but requires the fetched asset's path-derived media type, so a
200 HTML fallback still fails.

A missing manifest or the legacy HTML SPA fallback is accepted only when the
operator explicitly sets the one-time `ASSET_RETENTION_BOOTSTRAP=true` publish
variable. That flag fails if a valid prior manifest already exists and must be
removed after bootstrap. Without it, missing, malformed, non-JSON, mismatched,
or unavailable prior metadata/assets fail the deployment. This does not
complete direct/LAN static-server generation retention or static encoding.

For an initial New Session URL, both browser entrypoints resolve the app,
layout and page component wrappers before mounting React. The hosted entry
also resolves the applicable direct or relay connection gate. Downloaded
modules must not introduce another series of loading fallbacks merely because
their component wrappers have not yet observed the resolved imports. Connection
and data readiness keep their existing boundaries; the preboot composer retains
typing until the real form adopts it. Other initial routes remain lazy.

The local New Session entry starts version/capability discovery alongside its
settings, projects and recent-visit reads while route modules load. Mounted
consumers join the same retained query, including when it already completed.
Capability-dependent requests still require the returned current-source facts;
early acquisition neither invents support nor delays mounting on its response.
Typing does not wait for it, but Start stays disabled, and every submit path
refuses, until that first read settles. Unknown capabilities must not select
the older-server creation route or drop a saved router preference.

For New Session and Settings URLs, the local entry starts settings and version
HTTP reads before loading the React runtime. Only New Session then acquires the
selected provider as soon as current settings resolve; opening Settings does
not start a provider probe through this entry.
Their state owners are independent of React and the remote transport
implementation; mounted hooks consume the same accepted snapshots and query
identities. Desktop authentication still uses the canonical plain HTTP helper.
Remote clients acquire through their connected transport, and direct access to
the wrong Vite port starts no early API reads. Speech-validation follow-ups
remain retained only while a version consumer is mounted.

The question badge and menu used by navigation are separate from the inline
question-message renderer. Showing the sidebar must not load KaTeX, Markdown
renderers or file viewers through that badge. Session messages still acquire
their rich rendering code with the session route. A built-client browser check
requires New Session to mount without requesting the KaTeX chunk.

## Selected-Route Module Ownership

The initial client module graph contains the stable source/authentication,
navigation, error, and layout shell plus the selected page. A page that is not
selected must not be evaluated merely because its route exists. Local and
remote entrypoints apply the same rule; login and public bearer-link entry do
not reach the authenticated session-management page graph.

A route-level loading boundary preserves the shell and final page geometry.
It never flashes an unauthenticated surface, loses the URL, or substitutes a
temporary 404. A module generation has one shared acquisition promise, and a
failure becomes an actionable route error rather than an indefinite spinner.

A selected session starts its remote app, connection gate, navigation layout,
page, transcript, and composer acquisitions together from the initial URL. Its
module and connection boundaries render the same full-viewport session shell;
status changes stay in the transcript slot while header and composer geometry
remain reserved. Once the real session header or composer is visible, a lazy
descendant must not hide it or return the route to a generic page fallback.

Session DOM linger belongs outside the module-acquisition boundary. Making
`SessionPage` lazy must not create a second module instance, tear down a view
that `NavigationLayout` is deliberately retaining, or convert an already-warm
back/reselect into a remount.

Ordinary Settings entry loads the layout and selected category. Search may
load every pane because its results are operable instances of the same controls;
it starts those acquisitions progressively only when search begins and keeps
already found results stable.

Cold Settings entry starts its app, navigation-layout, and Settings module
downloads together in both local and remote clients. Settings navigation,
search, and available category controls do not wait for sidebar session data.
An inactive category's module is acquired only when selected or searched.
Each search pane has its own loading/error boundary, so a delayed or failed
pane cannot hide other results or disable their controls and jump links.
Search remains marked busy while panes are incomplete, and does not claim
there are no matches until all panes have loaded. A failed module exposes the
existing diagnostic and Reload Page recovery within that pane.

A local new-session tab acquires its app, navigation layout and form modules
together, then mounts those ready components in its first React commit. The
inline composer retains typing during acquisition. Successful startup does
not insert a module loading fallback between that field and the real form:
doing so adds React's minimum fallback display delay even after code is ready.
Acquisition failures still reach the route error boundary. Later navigation
retains lazy acquisition and the normal route boundaries.

Dynamic route assets remain part of one deployed entrypoint generation. Old
loaded entrypoints must be able to acquire chunks they name after a deployment,
or recover once through a state-preserving fresh entry. The retention and
recovery contract is below; the implementation handoff is
[`docs/tactical/096-client-route-module-loading.md`](../docs/tactical/096-client-route-module-loading.md).

## Shared package initialization

The shared package declares its library modules free of import-time effects
outside their own exports. Bundlers can therefore omit unused modules reached
through its root barrel and load provider schemas with their actual consumers.
This preserves validation when a consumer imports a schema; it avoids eagerly
constructing unrelated schemas merely to import a helper or constant.

The frame-search agent is the explicit exception in both source and compiled
paths: importing that entry installs browser listeners. Its package metadata
preserves that installation. Build tests exercise a helper-only initial graph,
a deferred validator with valid and invalid data, and the frame-agent installer.

## Development dependency graphs and manual reload

Local and remote Vite development servers keep separate optimized-dependency
caches, additionally separated by their configured ports. Starting one must
not replace React or other dependency chunks still referenced by another.
Browser-test fixtures supply their own temporary cache through
`e2e/support/vite-server.ts`. Optimized modules remain under `node_modules`
so React transforms treat them as dependencies.
The local dev server fails when its configured Vite port is occupied instead
of silently moving to a port the backend does not proxy.

`NO_FRONTEND_RELOAD=true` keeps source edits manual: the reload-notification
plugin tells the backend about changes and prevents application HMR updates.
Notifications use `VITE_API_PORT` when explicitly set, otherwise the launch's
`PORT` (default 3400).

Manual mode preserves the current page only while it can use its loaded code.
Before acquiring a dynamic module, the browser checks the Vite source
generation. If source has changed, the import rejects with an instruction to
reload the tab when ready. It must not navigate or reload the document:
background imports cannot opt every open tab into a frontend update. A route
that needs changed code offers the existing error boundary's manual Reload
Page action; already loaded code continues until the user chooses to refresh.
Only a
change to a file in Vite's served module graph moves the generation; a file no
page has loaded (a test, scratch output, a doc under the client root) cannot
leave a page stale, and treating it as a change made every booting tab reload
and restart its load while peers wrote unrelated files. The generation is
checked again after acquisition (including failed imports), so a concurrent
edit cannot return a stale module to the caller. An unchanged generation does
not reload; a manually refreshed document adopts the new generation. An
unreachable generation endpoint retries before allowing the import with an
explicit warning; unavailability alone does not prove a version mismatch.

This is a development-only import guard, not a server restart or a
minimum-server-version requirement. It neither interrupts provider sessions
nor adds requests to production/hosted clients. The runtime upgrade notice
remains advisory for older servers. The chosen boundary is module acquisition
instead of recovering after a render crash or automatically restarting the
server on every edit: an unopened page must never consume new code against
objects from an older loaded module graph.

Vite's HMR machinery remains enabled so that notification hooks, config
restarts, and dependency-graph invalidation still run. Configuration or
dependency changes may require Vite's full page reload to keep the module graph
consistent; ordinary application source edits wait for the user to reload.
Development server reload actions replace Vite alongside Hono, adopting fresh
startup configuration while the provider host and its workers remain alive.
If Vite exits or cannot start, the wrapper keeps Hono and the provider host
running, reports the failure, and allows the next reload request to retry.

## Global Reload Notice Placement

The shared backend/frontend reload notice preserves page identity and
navigation rather than claiming the full top edge. On desktop and tablet it is
an intrinsic-width card at the lower viewport edge, where unused space is more
likely; it must not cover a session title, page-level navigation, or session
composer controls or another fixed lower-corner action. The notice stack
measures live fixed occupants as one allocation problem: it occupies the
lower-right space when that space is clear and lifts the entire stack above
the session composer or floating action button when it would collide. A second
notice must not grow underneath a higher-z-index occupant. On phone it may
remain at the top, but stays inset from both viewport edges instead of becoming
a full-width bar.

Every form has an explicit × dismiss control with at least a 36×36 pixel hit
target. Visible copy stays compact; complete restart-risk and action wording
remains available through accessible names and hover titles. All
`ReloadBanner` callers inherit this placement and interaction contract.
An empty notice stack stays mounted for future notices but does not measure
geometry or schedule placement for composer mutations. A later visible notice
still receives the same collision-aware placement.
Choosing any action consumes the current notice instead of morphing it into a
status or confirmation panel. The requested reload or safe-restart schedule
continues; after a reload, later source changes may produce a fresh notice.

## Response contract

Treat build-owned `/assets/` filenames as immutable only when the build
pipeline proves they are content-addressed. Prefer a manifest/build assertion
or the exact Vite output namespace over a hand-written guess at allowable hash
characters. An immutable response has a long lifetime and `immutable`; bytes
at that URL never change.

HTML, the service worker, manifests, and other mutable entry resources are not
immutable. Give them explicit revalidation/no-cache semantics so a new entry
can name a new asset generation. Do not cache HTML under the asset contract.

Serve compressible generated assets with a negotiated representation:

- prefer build-generated Brotli and gzip sidecars so request handling performs
  no runtime compression of a multi-megabyte file;
- select only an encoding accepted by the request and set
  `Content-Encoding` plus `Vary: Accept-Encoding`;
- fall back to the identity representation when required;
- never compress already-compressed fonts, images, archives, or media merely
  because they live under `/assets/`; and
- ensure range, `HEAD`, content type, and content length describe the selected
  representation correctly.

Stream the selected file or use an equivalently bounded send primitive. A
request for a large cached asset must not require a new full raw-file buffer in
process memory (Node `Buffer` storage is generally external to V8's managed
heap, but still raises resident/transient memory). Runtime gzip middleware is
an acceptable measured first slice for transfer size, but it does not satisfy
this allocation contract by itself.

## Deployment generations

An HTML entrypoint and every dynamic chunk it names form one generation. A
long-lived tab may request a route chunk only after a newer build is deployed.
The deployment must keep at least the preceding complete immutable asset
generation available for the supported tab lifetime, or the client must have a
single state-preserving fresh-entry recovery. The recovery keeps the URL and
unsent composer/draft state and must not loop.

Immutable assets may coexist safely because their URLs are content-addressed.
Cleanup removes only generations that no retained entrypoint can still name
under the declared support window. A deployment that deletes old chunks
immediately is incompatible with route-level dynamic imports even when a fresh
load works.

## Verification contract

Tests and release checks cover:

- real generated filenames, including mixed-case and underscore hash tokens;
- immutable headers only for build-proven immutable assets;
- mutable HTML/service-worker revalidation and no stale entrypoint;
- Brotli, gzip, and identity negotiation with byte-for-byte decompression;
- `Vary: Accept-Encoding`, correct `HEAD`/length/type/range behavior, and no
  double compression of fonts/images/media;
- bounded server heap/resident/transient allocation during repeated large-file
  requests; and
- an old loaded entrypoint requesting an uncached dynamic chunk after the next
  generation deploy.

See [`docs/tactical/022-api-response-compression.md`](../docs/tactical/022-api-response-compression.md)
for the implementation plan and
[`docs/tactical/096-client-route-module-loading.md`](../docs/tactical/096-client-route-module-loading.md)
for the first consumer of the generation-retention contract.
