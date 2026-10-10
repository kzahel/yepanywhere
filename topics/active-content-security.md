# Active Content Serving and Origin Isolation

> Agent- or project-authored active content must never execute with YA's
> authenticated server origin or hosted-client origin. Ordinary HTML viewing is
> rendered and scriptless; applications that intentionally execute need a
> separate untrusted-content origin with no YA credentials or ambient API
> authority.

Topic: active-content-security

Status: **raw-file containment and opt-in isolated HTML artifact serving
implemented (2026-09-07).** Active local, project,
upload, and public-share file responses now share a lightweight native-
navigation policy. Browser-active HTML, XHTML, SVG, XML, and XSLT responses
are attachments with `nosniff`, an inert response CSP, no-referrer policy, and
a restrictive permissions policy. Interactive previews use the separately
configured artifact origin described below; the normal raw endpoints remain inert.

See also:

- [security](security.md) — the broader authenticated, relay, and public-share
  trust boundaries.
- [media-rendering-and-routing](media-rendering-and-routing.md) — the shared
  file/media viewer and transport rules.
- [interactives](interactives.md) — the proposal most directly constrained by
  executable-content isolation.
- [session-sandboxing](session-sandboxing.md) — why a confined provider must
  not be able to borrow the operator browser's authority through a file it
  writes.
- [rich-text-rendering](rich-text-rendering.md) — sanitized HTML fragments are
  a different trust class from standalone active documents.
- [active-content-security evidence](active-content-security.evidence.md) —
  reproduced behavior and the dated source audit.
- [active-content origin-isolation plan](../docs/tactical/078-active-content-origin-isolation.md)
  — implementation ledger and remaining origin-isolation verification matrix.

## Evidence and remediation state

The confirmed same-origin execution trace, why existing browser defenses did
not contain it, the route audit, and the 2026-08-21 containment evidence live
in the [evidence companion](active-content-security.evidence.md). The remaining
viewer, preview, and isolated-application work lives in
[tactical 078](../docs/tactical/078-active-content-origin-isolation.md).

## Design Decisions

- **Apply metadata-only classification and response headers everywhere** (vs.
  globally parsing or sanitizing contents): extension/MIME checks close native
  navigation cheaply, while compute-heavy precautionary inspection is useful
  only when an enforced project-write sandbox creates the extra boundary.
- **Preserve original active bytes behind attachment handling plus an inert
  CSP** (vs. rewriting the response as source text): explicit downloads remain
  faithful, and the viewer owns source presentation without making the raw
  endpoint an executable navigation target.

### Client viewer mitigation — 2026-08-09

The shared file context menu now distinguishes Source from Preview without
navigating either selection to a raw active response. Ordinary HTML opens as
a rendered preview; an explicit Source choice remains available. Either viewer uses the same
client-owned `srcdoc` wrapper with a scriptless iframe sandbox, no-referrer
policy, and a restrictive meta CSP that denies scripts, connections, frames,
objects, workers, forms, base URLs, and ambient image/media loads. Markdown
keeps its sanitized preview default and can be requested as source.

Since 2026-09-25 that sandbox is `allow-same-origin` rather than empty, so the
trusted viewer can search the preview (find in this view,
[media rendering](media-rendering-and-routing.md)). This was a
maintainer-approved trade. The preview still cannot run code: the sandbox
withholds `allow-scripts` and the CSP denies scripts, and a browser test adds a
script element to the preview and checks it does not run. What changes is that
the preview's origin is YA's rather than opaque. A link the reader clicks
inside it navigates the frame with YA cookies, so a GET to a YA route can
display its response in the frame; nothing in the frame can read or act on
it. `allow-same-origin` must never be combined with `allow-scripts` here:
that pair would run previewed HTML with YA's authority.
`SCRIPTLESS_PREVIEW_SANDBOX` in `ArtifactPreview.tsx` is the one definition,
and component tests pin its literal value.

A srcdoc document resolves URLs against the embedding YA page, and it
inherits YA's own `base-uri` policy, which refuses a `<base href=
"about:srcdoc">`. The wrapper therefore rewrites fragment-only link targets
(`#section`) to `about:srcdoc#section` in an inert parse, so a
table-of-contents or cross-reference link scrolls within the preview instead
of navigating the frame to the YA route (2026-09-25).

A relative link such as `paper.pdf` had the same defect: it loaded a YA route
beside the embedding page, which the scriptless frame shows blank. When the
viewer knows the previewed file's absolute path, the wrapper resolves each
relative link against that file's folder, as a linked-site walk does, and
rewrites it to a local-file resource link naming the resolved file. The
same-origin sandbox lets the trusted viewer listen for clicks inside the
frame; a primary click on a rewritten link opens that file through the
viewer's ordinary local-resource path, where the server's file-access checks
still apply. External, root-relative and scheme links are unchanged. The
public-share play frame already routes relative links the same way through
its injected handler (2026-09-30).

This is defense in depth at the client presentation boundary. The later server
containment protects old clients, address-bar visits, modified browser
navigation that escapes interception, redirects, and copied raw endpoints.
The client also deliberately withholds a **Viewer link** for arbitrary
allow-listed local files rather than mislabeling `/api/local-file`; a stable
standalone coordinate is future server-backed work.

## Content Trust Classes

The implementation and future designs must keep four classes separate.

### Trusted YA application documents

YA-owned entry documents, scripts, service workers, and narrowly scoped
diagnostic pages are application code. They may execute on a YA origin only
when they are shipped as reviewed build inputs and carry the intended
production CSP. Project files, uploaded files, provider output, plugin output,
and agent-created files never become trusted merely because a YA route serves
them.

A third-party library fetched at runtime is a build input on the same terms
as a lockfile dependency only when the source pins both its version and its
content hash, and the server verifies that hash before writing any of it to
disk. The opt-in pdf.js renderer (2026-09-25,
[media rendering](media-rendering-and-routing.md#pdfs-in-the-file-viewer)) is
the one such input: `PdfjsAssetCache` pins the `pdfjs-dist` tarball's
registry integrity, extracts only its runtime assets, and serves them from
`/api/pdfjs/<version>/`, so the client loads them under the unchanged
same-origin script policy. Loading them from a CDN was rejected because it
would need the app policy to admit a third-party script origin, or `blob:`
scripts for hash-checked text, for every page. Bumping the version is a code
change that must carry the new hash.

### Sanitized rich-text fragments

Server-rendered Markdown, syntax highlighting, diffs, and declared rich-input
forms may be inserted into an existing trusted YA document as inert fragments.
Their renderer/sanitizer must reject executable elements, event handlers,
unsafe URL schemes, active embeds, and other DOM authority. This class does not
need a separate origin. CommonMark embedded HTML may enter the Markdown parser
only when the resulting fragment immediately crosses the same sanitizer as
renderer-generated markup. It is never unsanitized pass-through or a standalone
HTML preview.

`dangerouslySetInnerHTML` describes a React insertion mechanism, not a trust
decision. Only output from the owning reviewed renderer/sanitizer belongs in
this class.

A reviewed renderer that converts agent-authored text into markup belongs to
this class even when its output is SVG, and even though the SVG rule under
untrusted active documents below reads as a blanket prohibition. That rule
governs SVG *bytes* YA received and cannot reason about — a project file, an
upload, a share. It does not govern markup a renderer YA chose and ships
produced from text. KaTeX is the standing example: `renderSafeMarkdown`
buffers its `span`/`svg` output past the sanitizer rather than growing the
allowlist to cover it. The trust rests on renderer selection and upkeep, so an
advisory against such a renderer is an upgrade-or-drop decision. See
[`code-fence-renderers.md`](code-fence-renderers.md), where this is settled
for Mermaid diagrams.

An unreviewed renderer has no such standing, and YA currently has neither an
SVG sanitizer to hand it nor a mechanical check that separates the two classes.
See
[`gaps/svg-sanitization-for-unreviewed-renderers.md`](../gaps/svg-sanitization-for-unreviewed-renderers.md).

### Untrusted active documents

HTML, XHTML, SVG, and other browser-active formats supplied by a project,
agent, upload, or share are data to YA's normal file-viewing surfaces. They are
shown as source, downloaded, or rendered in a scriptless sandbox (same-origin
for the file viewer's preview, so the viewer can search it). They
must not execute as top-level documents on a YA origin. One viewer-chosen
exception exists for a public file share's HTML root: the hosted play page
runs it with scripts inside an opaque-origin `srcdoc` frame that lacks
`allow-same-origin`, with its assets inlined as data URLs, so it is still
never a top-level document on the hosted origin and has no reach to that
origin's storage; see
[Public File Views](relay-origin-and-share-gating.md#public-file-views).

Initial active-type classification must include at least:

- `text/html` and `.html` / `.htm`;
- `application/xhtml+xml` and `.xhtml` when accepted;
- `image/svg+xml` and `.svg`; and
- XML/XSLT-capable responses until their browser behavior and type policy are
  deliberately narrowed.

Classification uses the final response type plus a conservative extension
check, so a caller-provided MIME type cannot opt an active extension out of the
policy. Lightweight content checks may be added when they materially improve
coverage. Precautionary parsing or sanitization that is computationally heavy
is reserved for enforced project-write sandbox sessions rather than imposed on
every file response. PDF and other document formats need an explicit browser-
capability review; absence from the initial confirmed list is not a declaration
that they are inert.

The YA-origin file viewer (2026-09-24) frames a same-origin PDF's own inline
`/files/raw` response, unsandboxed, so Chromium's viewer runs under that
response's headers rather than the app document's; a `blob:` frame would
inherit the app's `object-src 'none'` and be blocked. Audio, video, and font
files render from typed `blob:` URLs (`media-src`, `font-src blob:`). The
relay-only PDF path remains open in `gaps/file-viewer-relay-pdf.md`.

### Untrusted executable applications

An Interactive or another deliberately runnable agent-built app is allowed to
execute only inside an isolated application environment. An interactive file
preview uses that same boundary and cannot use the authenticated YA or
hosted-client origin.

## Observable Safety Contract

The following behavior is required across direct, desktop-loopback, hosted
relay, and public-share contexts.

1. An ordinary click, modified click, context-menu open, viewer toolbar action,
   copied viewer URL, browser restore, or redirect must never turn an untrusted
   active file into a top-level document on a YA application origin.
2. The normal action for HTML opens the unified viewer's static preview with
   scripts disabled; an explicit Source choice shows its bytes. Other active
   formats retain their source or confined-media presentation.
3. "Open in new tab" means the standalone YA viewer route, not the raw-file
   endpoint. "Download" is the action that returns original active bytes.
4. Raw active responses use attachment disposition, `nosniff`, and the inert
   response policy below. Source display belongs to the viewer rather than a
   native top-level navigation; explicit downloads preserve the original
   bytes and declared type.
5. Client interception is convenience, not containment. Server responses are
   safe when reached by an old client, a copied link, direct address-bar
   navigation, or a non-browser HTTP caller.
6. Scriptless HTML preview does not load network resources, submit forms,
   create workers, open popups, navigate the top level, or access YA APIs.
7. SVG follows the active-document policy even when the UI calls it an image.
   If inline SVG display is required, sanitize/rasterize it or render it under
   equivalent isolation; object URLs alone are not an execution boundary.
8. Public-share and hosted-client routes preserve the same active-type policy.
   A missing local `/api` backend does not make executing content safe because
   the hosted origin can hold browser-local login/resume state.

## Response CSP Is a Backstop, Not the Primary Boundary

CSP belongs in HTTP response headers on the response being protected. YA does
not need to inject a `<meta>` element into an untrusted file. A scriptless
static preview policy can begin from:

```http
Content-Security-Policy: sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The exact asset allowances belong to the preview design. Local/project assets
should be fetched by the trusted viewer and brokered as bounded blob/data
resources rather than reopening authenticated network access inside the
document. Add a restrictive `Permissions-Policy` where browser support makes
it useful.

For source-only responses, `text/plain` or attachment handling is simpler and
stronger; CSP remains defense in depth. For applications that intentionally
run scripts, `script-src` changes cannot create a trust boundary on a shared
origin. Those applications require origin isolation.

The implemented raw-file classifier inspects only the response MIME type and
file extension, then applies headers. It is cheap enough to run for every
session and transport mode. Additional precautionary content parsing,
sanitization, or rasterization that is computationally heavy is enabled only
for enforced project-write sandbox sessions; a feature that promises inline
rendering must still provide its required safety boundary by design.

## Executable Application Origin Contract

Any feature that runs project- or agent-authored JavaScript must satisfy all of
these constraints before it ships:

- **No shared YA origin.** A path such as `/apps/:project/:name/*` on the main
  server or `ya.graehl.org/apps/...` is not isolation. A different port is an
  origin boundary for DOM access but cookies are not port-scoped, so it is not
  the preferred credential boundary either. Use a different host at minimum;
  a dedicated registrable user-content domain is stronger.
- **No YA credentials.** The application host does not receive or accept the
  YA session cookie, Authorization headers, relay resume secrets, public-share
  secrets, or browser-local YA storage. YA auth cookies remain host-only and
  must never acquire a parent-domain scope that includes user content.
- **No YA API namespace.** `/api`, `/public-api`, WebSocket control channels,
  and native/desktop bridges are absent or fail closed on the application
  host. YA does not grant credentialed CORS to it. Mutations remain
  non-GET and require the custom header as defense in depth.
- **Scoped entry capability.** If access control is needed, use a short-lived
  or revocable capability accepted only by the one interactive/asset broker.
  Disclosure by the running app must not grant session, project, or general YA
  API access.
- **Sandboxed embedding.** Default embedding uses an opaque-origin iframe with
  `allow-scripts` only when execution is intended and without
  `allow-same-origin`. A dedicated untrusted origin may later receive narrowly
  justified sandbox tokens for storage/workers; it never gains YA origin.
  The isolated artifact origin's frames and its response `sandbox` directive
  share one token list, `ARTIFACT_SANDBOX` in `packages/shared`:
  `allow-scripts allow-same-origin allow-downloads`. It grants no popups or
  top-level navigation. A popup allowed to escape the sandbox would be
  same-origin with its opener frame, so it could reach `opener.top`, the YA
  tab, and navigate it (reverse tabnabbing) even though it never gains YA's
  origin. Downloads are allowed by maintainer decision (2026-10-09): artifact
  HTML is the operator's own, and a page that saves a file it builds, such as
  a Blob behind an `<a download>`, needs the token. This accepts that any
  artifact may start a download; a download confers no YA origin, opener, or
  navigation of the YA tab.
  Chromium refuses its PDF viewer inside any sandboxed frame, so a frame
  navigation to a PDF is answered with a hand-off page. Its Open and Download
  buttons post a `yep-artifact-tab/1` request to the parent; the viewer opens
  the URL in a new tab with `noopener` only when the request comes from its
  own frame and names a file of that frame's grant, plain or with
  `?download=true`. The browser still requires the click in the frame that
  sent it. The page also shows its own address for a parent that does not
  answer. It takes that address from the browser's location, never from the
  request URL the server saw, which behind a TLS-terminating tunnel is plain
  `http://`.
- **Brokered host communication.** `postMessage` is schema-validated,
  capability-scoped, and tied to the expected child window. With an opaque
  origin, `event.origin` is `"null"`, so the parent must verify `event.source`
  and never send ambient secrets through a wildcard channel. The find
  protocol follows this: the viewer accepts `yep-find/1` reports only from its
  own frame's window and sends requests to the frame's origin; the agent
  accepts requests only from its parent window.
- **Safe top-level opens.** A script-enabled new-tab view exists only on the
  isolated application host and is opened with `noopener`. A blob URL or
  `srcdoc` created by the trusted client is not used as an unsandboxed
  top-level substitute.
- **Worker containment.** Untrusted applications cannot register a service
  worker on a YA or hosted-client origin. Any worker scope remains entirely on
  the isolated application host and is cleaned up/revoked with that app's
  lifecycle where feasible.

One common application origin isolates apps from YA but not from one another.
If applications may hold mutually sensitive state, the design must add
per-app origins or another storage/process boundary.

### Direct and relay delivery

Direct delivery needs a distinct application host/virtual host whose handler
serves or proxies app assets but exposes no YA control routes. A proxy must
strip YA cookies, Authorization, forwarding headers that carry identity, and
other ambient credentials before contacting the loopback app.

Hosted relay delivery cannot place agent content at a path on the hosted YA
client origin. It needs either:

- a dedicated untrusted-content host reachable through a scoped relay/broker;
  or
- a trusted client that fetches the bundle over the encrypted connection and
  constructs a strictly sandboxed opaque-origin iframe with a complete asset
  broker.

The second option is suitable for controlled static bundles but does not
automatically support arbitrary navigation, workers, storage, WebSockets, or
multi-file apps. Optional Tailscale and Cloudflare transport changes
reachability, not this isolation requirement.

A proposed hybrid frames a static, same-site content origin whose service
worker obtains every byte from the trusted client over the encrypted relay. It
was spiked in Chrome and is not implemented; see
[`gaps/sketches/relay-artifact-frame.md`](../gaps/sketches/relay-artifact-frame.md).

## Open Decisions

- The direct and hosted untrusted-content hostnames/registrable domains and how
  local development resolves them.
- Whether static HTML preview needs any network-loaded asset class, or all
  assets should be brokered blobs/data.
- Whether executable Interactives share one untrusted origin or receive
  per-app origins for storage isolation.
- The scoped app-admission token shape and revocation/lifetime policy.
- Which PDF and XML-family capabilities require attachment-only handling.
- Whether the standalone rendered-Markdown document has enough browser-native
  value to retain after unified-viewer convergence.
- The stable standalone viewer coordinate for an allow-listed file outside the
  active project, and whether the server should resolve it to another scanned
  project's viewer without exposing raw paths in URLs.
- The bounded asset-broker contract for relative images and styles in static
  HTML preview across direct and relay connections. The current client preview
  intentionally denies ambient network loads.
- Whether trusted hosted-client headers justify moving the primary static
  deployment; this is hardening, not the active-content fix.

## Interactive HTML artifacts

The operator can enable interactive previews of ordinary `.html`/`.htm` files
from project sessions and allowed local paths. A directory of neighboring
files is sufficient; no YA manifest or ZIP packaging is required. Artifact
producers provide compatible relative asset URLs and any mocked or real
services needed by the application. YA serves original bytes; it does not
rewrite JavaScript, emulate an application backend, or run a project's dev server.
The one addition is find: an HTML response to a frame navigation
(`Sec-Fetch-Dest: iframe`) gets a small script appended after the document,
the find agent generated from `packages/shared/src/find/`. It lets the
embedding viewer search that frame alone. It answers only its parent window,
through the validated `yep-find/1` messages, and reports match counts plus
the reader's selection when they press Ctrl+F. Downloads, top-level tabs,
fetches, range reads and XHTML still receive the original bytes.

### Configuration and delivery

Settings → Apps owns artifact and static-vhost settings. Local Access and
Remote Access link to that category.
Serving defaults off. Enabling local access pre-fills
`http://artifacts.localhost:<YA port>`; the complete address remains editable.
A blank public address disables hosted artifact access. With both addresses
absent, no grants are available and no artifact listener runs.

The main YA listener dispatches the configured artifact Host to the isolated
handler before application routes, authentication, or the development proxy.
Consequently, `localhost:3400` and `artifacts.localhost:3400` can use the same
SSH forward while retaining different browser hosts.

A static vhost table on the Apps form maps a DNS label to a
loopback port. `name.localhost` on YA's port reverse-proxies to
`127.0.0.1:<port>` even when the public vhost root is empty. A public root
such as `example.com` also matches `name.example.com` on the artifact listener.
The operator intends to public-tunnel `*.example.com` to the configured
app-service port, preserving Host and terminating HTTPS. The field has no
default domain and does not create DNS or tunnel configuration.
Optional env names on a row are exported
to new local provider sessions as that port. The computed child environment
names these exports explicitly in `AGENT_VHOST_ENV_NAMES`; the provider-host
boundary carries only those configured names and YA's fixed static markers.
Unrelated environment variables and per-session wake credentials are excluded.
Dynamic `ya-vhost` PATH helpers remain unimplemented. In a session opened
through a public relay page, the client rewrites rendered anchor destinations
from `name.localhost` to `https://name.<public root>`. It does not rewrite
visible prose, code, or link labels, and a direct/local YA page keeps the
localhost destination. **Always rewrite `*.localhost` app links** in Settings
→ Apps deliberately extends that rewrite to direct/local pages for testing or
operator preference; it still requires a configured public root. Browsers
outside these YA transcript links still need ordinary hostname resolution.
The local address's port is the browser's forwarded port, which can differ
from YA's actual listening port.

### File vhosts

A vhost row may serve a file or directory itself instead of a loopback port
(**Serves: File or directory** in the same table). The row maps
`name.localhost` and `name.<public root>` to an absolute server path, read
live on every request.

**A file row serves what the file links to.** The file keeps the short
address `/` (and its own name, `/<file>`), and a reader can follow its links:
the row serves every file reachable from it through references in HTML,
Markdown and CSS documents — element sources, `<a href>`, `srcset`, CSS
`url()` and `@import`, Markdown links, images and reference definitions —
followed transitively through linked documents (`walkLinkedSite` in
`packages/shared/src/linked-site.ts`). A link is an implied grant: its target
may lie outside the file's folder or any project, limited only by the local
file policy. Each target answers at the URL a browser requests for it with the
root at `/`: `../../topics/speech-mt.md` from the root is requested as
`/topics/speech-mt.md` and answers with that file, so the address stays short
with no redirect or rewriting. A leading `/` in a reference names the root's
folder. When two targets resolve to one URL, the first found keeps it. A file
nothing links to answers 404. The walk stops at 2,000 files or 200 documents
read; documents over 8 MiB are served but not followed. A walk is reused for
2 seconds, then for as long as no file it inspected has changed, appeared or
disappeared, so an edit to any linked page takes effect on the next request
after that.

A Markdown target that a browser opens as a page (a navigation, not a script's
fetch) is YA's rendered Markdown page, the same one the local-file viewer
serves. Its own relative links and images stay relative, so they resolve on
the vhost too, and its **Raw** link, like any `?raw` request, returns the text
as `text/plain`.

A directory serves the files beneath it, `index.html` for a folder
(redirecting a slashless folder URL to its slash); dot segments, dotfiles,
backslashes and encoded escapes fail there, and symlinks must resolve inside
the root. Every served file must pass the local file policy. Only GET and HEAD
are served, with the artifact origin's CSP sandbox, `nosniff`, `no-referrer`,
`no-store` and permissions policy.

Settings shows each saved file row's reach beside its path as **N files**
(**N+ files** when a limit stopped the walk), with a tooltip listing the first
20 paths relative to the file's folder. `GET /api/artifacts/vhost-sites`
carries it as `linkedFiles`.

The Apps settings tables sort ascending, then descending, by clicking a
column header. The vhost **Serves** column compares full paths (or numeric
ports); Project apps includes a sortable **Project folder** column. Sorting
changes display order only, preserving saved row order and editor identity.
Both tables share the sort-heading mechanism and responsive path display:
home paths use `~`, long parents elide in the middle, and the final folder
and filename have priority. Hover exposes the full absolute path, also
available in the selected row's editor or project details. Retained project
addresses participate in sorting; a missing project has no known folder.

Names are first come, first served across port rows, file rows and project app
addresses: a claim or save that collides is refused unless a file-address
claim explicitly requests replacement of an existing file row. Port rows and
project app reservations cannot be replaced by a file-address claim.
Also refused is a new row named
`localhost`, `artifacts`, `relay`, `www`, `ya`, one starting `app-` or
`sbx-`, or one whose public hostname is YA's own client or artifact host.
File rows are saved in a separate `vhostSites` list; a save that omits the
list keeps it, so a client or server predating file rows never drops or
misreads one. Releasing a row rotates its app-link generation, so a later
claim of the same name and path does not revive old private links.

Access is one of three: **App link required** (the private-link bearer,
default for Settings rows), **Public**, or **Password**. A password row is
public with a visitor password: without an app link, a visitor must answer the
browser's Basic prompt (any user name). The server stores only a salted scrypt
hash, never returns it (clients see `passwordProtected`), and checks it off the
event loop. A correct password or app link earns the host-only app cookie, so
assets are not re-hashed. The superuser sets, replaces or removes the password
from the row at any time; an app link still opens the page without it. Basic
credentials travel inside the tunnel's HTTPS; on `name.localhost` they are
plain local HTTP.

The File Viewer's public-share dialog offers **Serve at its own address** for
the viewed file: a suggested name from the file name, the
host suffix, and the access choice (Public by default there, since a pretty
public address is the purpose). It claims a file row through
`POST /api/artifacts/vhost-sites`, lists this file's rows, and copies or stops
serving them; Settings → Apps lists and edits every row.

**Replace an existing mapping with this name** defaults unchecked. Checked,
it sends `replace: true`; the suggested name remains deterministic, without a
collision-avoiding suffix, and a manually entered name works the same way.
The form remains available alongside this file's existing mappings. A successful
replacement changes the path and access choice at the same address, clears an
old visitor password unless a new password was selected, and revokes existing
private links and app cookies. Collision and creator checks use the current
configuration at the serialized write boundary, after path validation.

Limited users need **Allow public apps** and Start sessions access to the
selected project. They see only their own mappings in that project and may
replace or release only mappings they created; an older mapping without a
creator belongs to the superuser. Creator identity comes from the authenticated
acting principal, never request fields or the name. It survives settings saves
and restarts. Limited-user file roots, linked files and symlink targets must
remain in the canonical project root. Incoming requests recheck the creator's
enabled account, publication permission and project grant; private mappings
also require Allow private app links. Limited users use the address section
without requests to the administrator-only public-file-share inventory.

Replacement and limited-user file addresses require the separate explicit
`vhost-file-site-replacement` capability (ID 109). Without it, clients hide
the checkbox and retain administrator-only file-address behavior. The supported
optional release corpus v0.9.0–v0.9.2 lacks the file-vhost routes; none of its
existing capability meanings is broadened.

`vhost-file-sites` (ID 105, version-implied from 0.9.4; maintainer approval
2026-09-30, `Qcompat`) owns the `vhostSites` field and the
`/api/artifacts/vhost-sites` routes. v0.9.0–v0.9.2 lack them: without the
capability, clients hide the Serves selector and the dialog section and send
neither.

A configured public HTTPS address additionally starts a plain HTTP listener on
`127.0.0.1:<artifact port>`, default port 4402, for a reverse proxy or tunnel.
The proxy preserves the artifact Host and terminates HTTPS. No second SSH
forward is needed for the local same-port route. The listener port is editable;
changing it also requires updating the operator's proxy route. YA does not
install DNS records or change the tunnel configuration.

`YEP_ARTIFACT_PORT` pins the artifact settings at launch, together with
`YEP_ARTIFACT_LOCAL_ORIGIN` and `YEP_ARTIFACT_PUBLIC_ORIGIN`. An absent port uses
persisted settings; `0` overrides them and disables serving. Positive ports
must be 1–65535. Origins must be bare HTTP(S) origins with separate hostnames;
public origins require HTTPS. The public listener starts only when a public
origin is configured. Address or listener-port changes revoke outstanding grants.
Failed listener binding or settings persistence restores the previous
configuration; a failed startup is reported rather than quietly changing ports.

Grant management uses the current source's authenticated YA transport, including
encrypted relay connections. Artifact documents and assets themselves travel
directly to the selected artifact origin. They are outside YA's encrypted relay
protocol: a TLS-terminating proxy can read them. No session, relay-resume, or
public-share credentials are attached to artifact requests by YA.

### Private app links

Vhosts require an app-scoped bearer by default, including existing rows that
omit `public`. Hostname-only visitors receive 401 before any upstream request.
An explicit saved **Public — no link required** setting bypasses this visitor
gate. **URL = access**: anybody holding a valid URL may use or share it without
a YA login. This does not grant YA API access.

Authenticated YA clients obtain tokens from `GET /api/artifacts/vhosts/links`.
Pane, transcript, copy-link and move-out URLs include `ya_access`. An accepted
URL establishes a host-only HttpOnly, Secure, SameSite=None cookie so ordinary
app assets and requests work without rewriting the app. Requests are checked
again; cookie-only mutations require the same app Origin. The proxy removes
its access query/cookie, YA session cookies, Authorization, desktop token and
Referer before forwarding. Responses prohibit caching and referrer disclosure.
Applications can see their own shared URL; it is intentionally transferable.
Transcript rewriting maps any `name.localhost` anchor through the configured
public root. When the name is a configured vhost, it waits for the access
decision: private rows receive their app-scoped `ya_access` token, public rows
rewrite without one, and a configured row with unavailable authorization stays
local. Artifact-grant URLs preserve their bearer path while changing host.
Their custom link menu includes **Copy public URL**, which forces this host
mapping regardless of the automatic/always-rewrite choice; it appears only when
the configured public root can produce a public destination.

A proxied request tells the app how it was actually reached.
`x-forwarded-host` is the Host the visitor used, and `x-forwarded-proto` is
`https` for a public-root host, whose HTTPS the operator's tunnel terminates,
and `http` for a `name.localhost` visit. `x-forwarded-for` carries whatever
chain arrived — the tunnel names the visitor — with the peer YA answered
appended; YA claims no hop when that peer is unknown, so every address in the
chain is one a proxy on the path really saw. An app may therefore distinguish
a public visitor from a local one, subject to the usual caveat that the
leftmost entry is only as trustworthy as the proxy that wrote it.

**Copy app link** and **Revoke existing links** live beside each saved vhost.
Each saved row in the vhost table also carries a link icon for the same URL:
a click opens it in a new tab, and a right-click (a touch long press where the
browser raises one) offers **Open** and **Copy link**. The icon is absent for
an unsaved or edited row and for a private row whose access token is
unavailable. A saved file row that serves one existing file has a file icon
beside its path with the same gestures, for YA's authenticated file viewer
(`/file-view`) on that path; a directory or missing path has none.
Revocation durably increments that app's generation and rejects old URLs and
cookies on subsequent requests and closes established app WebSockets. It does
not stop the app or erase already
received content. App links have no automatic expiry in this version.
Browsers that prohibit embedded cookies may require opening the signed link
in a new tab; broader browser verification remains tracked in the access gap.
WebSocket upgrades use the same app gate, as described below.

### Hosted vhost sign-in

Hosted vhosts can opt into **Sign-in required** in Apps. This is a visitor
principal scoped to the configured public hostname, not a YA operator account
or a project/session grant. Localhost, session sandbox apps, project apps and
artifact grant URLs keep their existing access rules. OAuth admission runs
before file serving and proxying: a private bearer link, public flag or file
password cannot bypass an enabled sign-in policy. Apps copies the public URL
without a bearer for these hosts. Forwarding the visitor identity to served
content is not implemented; authentication cookies and credentials are stripped
before proxying.

Up to eight confidential OpenID Connect registrations can serve all configured
hosts. Apps lists them with independent enable switches, editable settings and
an add-provider action; additional registrations can be removed. The default
registration can be disabled. Visitors choose among enabled providers using
provider-named buttons on a responsive sign-in page. A denied login offers the
same choices again. These pages need no scripts or external assets; their
stylesheet is authorized by a content hash.
The separate HTTPS callback host must route to this YA server (either its main
listener or artifact listener); a static Pages site cannot exchange codes.
Each pending login binds its chosen provider and callback URL. A callback at
another configured host or path cannot consume that login. Providers may share
the same callback URL; state selects the bound provider, never a callback query
parameter. The callback uses authorization code flow, PKCE, state and nonce, verifies
signed ID tokens, then issues a one-use, one-minute handoff bound to the
initiating host and browser cookie. The return address is stored server-side
and must be relative. Host-only `__Host-` cookies are Secure, HttpOnly and
SameSite=Lax; no parent-domain cookie is used. App sessions last one hour and
are memory-only. Restart requires sign-in again. Access changes, provider
changes and app link revocation reject old sessions; configuration changes
close app sockets. OAuth WebSockets require the same app Origin and close no
later than session expiry.

The initial allow-list is explicitly `*@*`: any authenticated account, not
anonymous access. Rows contain case-insensitive email globs, with `*` as the
only wildcard; an empty list denies everyone. The editor highlights rows
covered by an exact duplicate or a simple full-side wildcard. Opening the
sign-in region selects the first row for replacement. Up to 32 rows per host
and 1024 host policies are retained separately from legacy vhost configuration,
so old clients cannot silently remove protection.

Entra defaults to the `common` authority. Work-account domain authorization
uses Microsoft Graph's tenant-managed member `userPrincipalName`, with `oid`
and tenant issuer validation; it requests `openid profile email` and delegated
`https://graph.microsoft.com/User.Read`. Guests are not accepted as company
domain members. Personal Microsoft accounts can use the unrestricted `*@*`
policy, but their email claims do not establish work-domain membership and do
not satisfy narrower rows. Generic OIDC requires a verified email in the
signed ID token or subject-checked UserInfo response. Provider consent policy
and publisher verification remain external prerequisites.

Without environment configuration, the owner configures the provider and a
masked secret in Apps. The Google preset fills the standard OIDC issuer
`https://accounts.google.com`; it still requires the owner's registered client
ID, secret and callback URL. Custom OIDC issuers remain editable. The preset
uses the existing `oidc` wire format and needs no new server capability.
The full saved secret is never returned; the empty secret field shows only a
masked placeholder with a four-character suffix for values at least twelve
characters long.
Shorter values show no suffix. Settings persist owner-only under
`{dataDir}/artifacts/vhost-oauth.json`. For environment-managed deployments,
set all three required variables:

- `YEP_VHOST_OAUTH_CLIENT_ID`
- `YEP_VHOST_OAUTH_CLIENT_SECRET` (the secret value, not its registration ID)
- `YEP_VHOST_OAUTH_CALLBACK_URL` (the registered exact HTTPS callback URL)

Optional variables are `YEP_VHOST_OAUTH_PROVIDER` (`entra` by default, or
`oidc`), `YEP_VHOST_OAUTH_TENANT_ID` (`common`, `organizations`, or a directory
UUID), `YEP_VHOST_OAUTH_ISSUER` (required for generic OIDC), and
`YEP_VHOST_OAUTH_VISITOR_IP` (`peer`, `cloudflare`, or `x-real-ip`). Any OAuth
environment variable activates this authoritative mode: incomplete/invalid
configuration fails explicitly. The default provider settings become read-only in Apps,
with an environment-management explanation and no provider-save action;
the full environment secret is neither returned nor copied into persisted settings.
Additional providers and host allow-lists remain editable. Provider configuration never enables a host
implicitly. Restart after changing environment variables.

The separate **Enable hosted sign-in** switch defaults on and becomes
effective when environment or manual provider configuration is complete.
Switching off retains credentials and every email list, including across
restart, and remains available when environment settings lock provider edits.
It invalidates sessions, pending sign-ins and app sockets. Hosts requiring
sign-in stay blocked with HTTP 503 while disabled or unconfigured; Apps
highlights those host rows red with the reason. Their saved email lists remain
editable for repair. Re-enabling requires a fresh sign-in. Older OAuth servers
without the `enabled` status field retain their existing behavior and receive
no requests to the enable endpoint.

Disabling or removing any provider invalidates pending logins, app sessions and
sockets. With no enabled configured provider, protected hosts remain blocked.
Existing single-provider storage and API writes address the default provider
and preserve additional providers. This additive storage choice preserves
configured credentials and old-client edits without replacing the saved schema.
Environment credentials are never copied into that storage.

The separate `vhost-oauth-providers` capability gates provider-list management
routes and controls. Without it, clients retain the single-provider form and
make no requests to `/artifacts/vhosts/oauth/providers/:id` or its enable route.
The optional-feature release review checked v0.9.1 and v0.9.2 (the latest two
stable releases; none were released in the preceding fourteen days on
2026-10-10). Both predate hosted OAuth. The original `vhost-oauth-access`
capability keeps its existing meaning and fallback.

Only completed browser-bound OAuth checks are logged, with UTC timestamp,
hostname, account address when available, outcome and optional IP. Ordinary paths,
asset requests, authorization codes and tokens are not logged. Apps provides
per-host history icons after first access, an overall log view, manual refresh
and a download of the latest 500 checks. The owner-only JSONL journal is
`{dataDir}/artifacts/logs/vhost-oauth-access.jsonl`; it rotates at one MiB into
compressed archives. The default IP source is the TCP peer, excluding loopback.
Explicit tunnel modes accept the selected header only from a loopback peer;
the operator must ensure the tunnel overwrites that header. Raw forwarded
headers are not trusted by default.

The optional `vhost-oauth-access` capability gates the new controls and API
requests. The reviewed v0.9.0–v0.9.2 release corpus lacks it; older servers keep
their existing Apps behavior without OAuth requests. Provider and log routes
remain behind YA owner authentication. Tests exercise signed-token rejection,
browser/host binding, expiry, revocation, credential stripping and sequential
email entry under concurrent browser updates.

### App WebSocket access

The Node main listener and separate artifact listener route app upgrades to
`AppWebSocketProxy`, through the same `ArtifactServer` / `ProjectAppDelivery`
authorization path as HTTP. Configured vhosts, session app hosts, project app
hosts and scoped `/p/<launch-token>/` services are supported. Static `/a/`
grants are not socket capabilities; neither artifact hosts nor artifact origins
gain access to YA's control WebSockets.

Private host upgrades require the app bearer or its host cookie. Cookie-only
upgrades additionally require the exact app Origin, preventing cross-site
WebSocket hijacking; an opaque Origin must use the explicit bearer instead.
Path-based service upgrades use the unguessable active launch path, including
from an opaque iframe. All YA credentials and app-access credentials are
stripped before forwarding. Only WebSocket handshake fields return from the
upstream; upstream Set-Cookie is not forwarded in a 101 response.

The upstream is the configured loopback port or the active sandbox's broker,
never a target supplied by the upgrade request. Authorization is checked on
each connection; revocation closes that hostname's established connections and
rejects subsequent connections, without erasing already received data.
Connections are capped at 128, handshakes at ten seconds, and
idle connections at five minutes. Disconnect, upstream exit, app-server close,
and serving-configuration changes tear down owned sockets. Stopping the owned
service closes its broker connections. HTTP/SSE continue through their existing
proxy; a synthetic Fetch upgrade without a raw socket still refuses with 501.

The 32-byte random signing key is created once under
`{dataDir}/artifacts/app-access.key`; generations live in `app-access.json`.
Restart preserves them. Tokens are purpose-, name-, port-, and generation-
scoped HMAC-SHA256 values. Corrupt key/generation state fails closed. A new
installation/data directory creates a new key. Public-share hashes and artifact
bearers keep their existing persisted formats and remain valid; their common
durability contract does not require migrating them to this signing format.
App-process survival and app-dataset deletion are separate concerns.

The separate `vhost-bearer-access` capability gates all new client requests and
the Public field. The approved v0.8.0/v0.8.1 fallback shows protection as
unavailable and sends none of these requests; older capability meanings stay
unchanged. New servers preserve a row's visibility when an old client omits it.

`e2e/app-access.spec.ts` checks hostname denial, assets in top-level and iframe
views, explicit Public access, and full process restart preserving app,
artifact and public-share credentials and their revocations. Existing artifact
tests cover expiry while stopped. The fixture keeps the upstream app alive:
authorization durability does not restart an exited Plannotator process.

### Preview and authority

HTML continues to open as source or scriptless preview. An explicit **Run full
HTML/CSS/JavaScript preview (current view is sanitized)** action first performs
one credential-free `/health` request to the selected origin, with redirects
rejected and a 2.5-second deadline.
Loopback browser access selects the local origin; other browser access selects
the public origin. Failure leaves the static preview with an explicit Retry
action; there is no polling, grant request, or interactive frame on failure.
The client rejects a selected origin sharing YA's hostname and refuses mixed
HTTPS-page/HTTP-frame configuration.

In the full file viewer, the existing toolbar source/preview toggle starts
interactive HTML directly when clicked from source; no second Run button is
needed. Switching back to source unmounts the preview but leaves its borrowed
grant valid until expiry, so another pane or browser tab using that URL remains
available. The context menu's explicit Preview action uses the same path.
Merely opening a file, restoring a source view, or receiving a link does not
request a grant.
An initially requested scriptless presentation retains its explicit Run action.
Older/disabled servers retain scriptless viewing without unsupported requests.

Artifact requests expand home-relative paths with the same rules as source
viewing: `~`, `~/...`, and `~\...` refer to the server user's home directory.
Expansion precedes optional project-relative resolution and the artifact
file-access policy. Equivalent absolute and home-relative HTML paths can be
previewed with or without a project ID; expansion grants no extra file access.

A browser-enforced parent `frame-src` violation replaces the broken frame with
an explanation and an **Open interactive preview in a new tab** link to the
same grant. The new tab has no opener or referrer; stopping/closing the owning
viewer does not revoke that transferable grant. The viewer never relaxes the
browser policy.
A stale frontend policy requires an operator-owned restart and page reload
for embedding to work; the separate artifact tab can be used independently.

The granted directory supports relative stylesheets, images/SVG, webfonts,
classic scripts, modules/dynamic imports, JSON fetches, and linked HTML files.
Root-relative paths address the artifact host itself and are not mapped to a
grant. Directory indexes, history-router fallback, service workers, nested
frames, popups, forms, native bridges, and device permissions are not
supplied, though a page may start downloads (*Sandboxed embedding*); a PDF
reaches a new tab only through the viewer's hand-off
described under *Sandboxed embedding*. External HTTP(S)/WebSocket services remain subject to the
browser's ordinary network/CORS rules and the artifact author's setup.

Both iframe sandbox and artifact response CSP allow scripts and same-origin
behavior on the **separate artifact host**. This deliberate allowance preserves
module fetches and artifact-local storage. Artifact applications share that
origin's storage and authority with each other; this is for an operator's own
artifacts, not mutually hostile tenants. They never receive YA storage or a
host bridge. YA's parent-document CSP permits HTTP(S) frames so configuration
can change without reloading an already open document; only the validated
artifact URL is used by the interactive viewer.

The explicit [source editor](file-source-editing.md) uses a separate static
selection snapshot, not the interactive application's frame. Its opaque sandbox
permits only YA's nonce-authorized selection script and a validated target-id
message to the parent. That message can open source; it cannot write or invoke
a script. Producer scripts and event handlers are removed.

The static artifact handler exposes only GET/HEAD health, granted files, and
the fixed MCP App sandbox proxy at `/.yep/mcp-app-proxy`. The proxy is
YA-authored, holds no secrets, and frames an MCP App view in an opaque-origin
`srcdoc` child under the view's own restrictive policy
([MCP Apps § Isolation](mcp-apps.md#isolation)).
The separate `/p/<launch-token>/` service route supports app HTTP/WebSockets
as described above. `/api`, `/public-api`, desktop bootstrap, and YA control
WebSocket upgrades remain unavailable on artifact hosts.
Registered artifact hostnames stay excluded from YA host/CORS/WebSocket trust
until process exit, including after disable/reconfiguration and with wildcard
allowed-host settings. Opaque `Origin: null` is also rejected once an artifact
host has been registered, preventing a navigated artifact from borrowing that
legacy origin allowance. Native named Tauri origins keep their existing rules.

Admission authorizes the selected HTML file's containing directory, subject to
the current file-access allow-set on every read. Relative traversal, hidden
path components, and symlinks escaping that directory are rejected. A random
256-bit bearer URL permits reads for the configured lifetime or until revocation
or delivery reconfiguration;
the application can disclose that URL, so it is not a secret from the artifact.
Limits are 256 live grants, 1,024 distinct files per grant, and 64 MiB per file.
Responses are streamed, range-capable, and marked `no-store`. Borrowed preview
grants remain valid across viewer close, pane replacement, and browser-tab
handoff, then expire on the server's fixed deadline or explicit revocation.
This does not erase files already read or artifact-origin local storage.

Because borrowed grants outlive their viewers, a borrowing request for an entry
file that already has a live borrowed grant receives that grant again, marked
`reused`, instead of a new one. Reuse requires at least half the configured
lifetime to remain and no more than all of it, so a newly opened viewer is not
cut off soon after, and shortening the expiry setting is not undone by an older
longer-lived link. Reopening a file therefore consumes no additional slot: the
cap bounds distinct files previewed within one lifetime, at most two live
grants each. A requester never revokes a `reused` grant it did not mint, since
another viewer or tab may hold it; an explicit revocation by id still withdraws
it for everyone. A request asking to own its directory always receives its own
grant. At the cap, the refusal is HTTP 429 naming the time the next live grant
expires.

The saved **Link expiry (days)** slider and paired numeric field accept whole
days from 1 through 30, defaulting to 7. The lifetime is fixed when each grant
is created. Changing only expiry preserves existing grants and their original
deadlines; it affects newly created links. Saving unchanged settings likewise
preserves grants. Manual inventory/revocation controls remain deferred in
[the revocation UI gap](../gaps/artifact-grant-revocation-ui.md).

Days are the stored and transported unit, `expiryDays`, and
`version.artifactViewer` reports both fields so an older client keeps its
hours slider and its gate. An `expiryHours` value, whether saved by an earlier
install or written by an older client, is converted by rounding up to whole
days: a two-hour lifetime becomes one day. Expiry shorter than a day is
therefore no longer expressible, which is the price of the unit people
actually reason about for a shared link. An older client that omits both
fields preserves the saved lifetime, and one that writes hours cannot exceed
its own 168-hour ceiling.

#### Grants survive restart

Grants outlive the server process. A link that says it expires in seven days
is usable for seven days, across restarts, upgrades and crashes, because the
lifetime a user was shown is the contract rather than an accident of process
lifetime.

State lives in `{dataDir}/artifacts/grants.json`, written atomically inside a
directory created mode 700. That file holds live bearer tokens, so its
protection is the directory's: anyone who can read it holds every unexpired
artifact URL. It never holds artifact content, and artifact files keep the
permissions their producer gave them.

Several artifact servers may share one state directory — every server built
from the same data directory does, and one process can hold more than one. A
write must therefore stage under a name unique to that write, not merely to
the process: a shared staging name lets one rename take the file another is
about to rename, failing the loser with `ENOENT` and leaving a live-token file
behind. The same rule governs the app-access generations file. A write that
cannot complete removes its staging file, is reported, and does not stop the
server from serving what it already holds.

Restoring drops grants that expired while the server was down, and applies the
same limits and validation as a fresh grant. Address or listener-port changes
revoke outstanding grants as before, and a revoked or expired grant is removed
from the file, not merely from memory. Unreadable or corrupt state is reported
and discarded rather than blocking startup: the cost is that outstanding links
stop working, which is the previous behaviour of every restart.

#### Owned artifacts are deleted when their link expires

A grant is created either **owning** its directory or **borrowing** it. A
borrowed grant never deletes anything: expiry only withdraws access, which is
what every grant did before this contract existed.

An owning grant freezes the fileset it was created over: the files present in
the granted directory at that moment, recorded relative to it. When the grant
expires or is revoked, exactly those files are removed, then the directories
they emptied, and the granted directory itself only if it is now empty. A file
written into that directory afterwards belongs to whoever put it there and is
never removed, and a directory still holding anything is left standing.
Ownership is refused, and the grant created as borrowing, when the directory
holds more files than an artifact bundle plausibly has.

Ownership is fixed when the grant is created and is never inferred later, and
it is never inherited from configuration. `POST /api/artifacts` grants
ownership only to a request that asks for it with `owned`; everything else
borrows. That asymmetry is deliberate: an interactive preview of a file the
user already had must not delete it when the viewer closes, and only the
caller that produced a directory can know it is disposable. YA's capture
command asks, because it wrote the directory it is publishing; a caller that
wants its capture to outlive the link passes `ownArtifact: false` and borrows
instead. No setting governs this: the request is the whole decision, so the
settings page states the resulting behaviour instead of offering a control
that could only contradict the caller.

A pending deletion is part of the persisted state, so a server that stops
between expiry and deletion still deletes on its next start. Deletion is
refused, and the grant is created as borrowing instead, when the directory is
a working tree's own root, a home directory, or a directory holding YA's data
directory, and — outside any working tree, where nothing else distinguishes a
bundle from ordinary content — when it sits under a home directory or under
YA's state. `~/Downloads` is the case that decides that rule. A working tree
counts as that distinguishing context only when its root lies strictly inside
the home directory or YA's state: a dotfiles repository at `~/.git` encloses
everything in the home directory and leaves `~/Downloads` protected.
These boundaries compare filesystem-resolved paths, including aliases such as
macOS `/tmp` and `/private/tmp`; a protected path that has not been created
yet is resolved through its nearest existing ancestor.

Inside a working tree, location is not the evidence: a capture written to
`<checkout>/.artifacts/` is still the caller's to clean up. There the frozen
fileset excludes Git's own metadata and every path Git tracks under the root,
staged-but-uncommitted included, so a capture beside a checkout's own files may
take itself away and leaves them. Tracked-ness is read once, when the grant is
created. A root whose files are all the working tree's own leaves nothing to
own, so it borrows; so does a root where Git will not answer. A deletion that
fails is recorded and dropped rather than retried forever.

The frame remains in the existing viewer owner while parked; no cooperative
suspension or CPU/memory containment is claimed. Dedicated HTML viewport,
drag/pinch inspection, and broader viewer-navigation work remain tracked in
[the HTML viewer gap](../gaps/html-document-viewer.md).

### Compatibility and verification

Optional permanent capability `artifact-viewer` (ID 59) gates grants. The
reviewed optional-feature corpus was v0.8.0 (2026-08-31) and v0.8.1
(2026-09-05); neither has this contract. Without the capability, clients keep
source/scriptless viewing and never POST or DELETE grants. New servers expose
`version.artifactViewer` configuration metadata even while disabled; its
presence independently gates PUT `/api/artifacts/config` and the settings UI.
The optional `version.artifactViewer.expiryHours` field additionally gates
the expiry slider and its write field. Earlier artifact-capable servers omit
it, so clients retain their existing settings UI and fixed 24-hour expiry.
`version.artifactViewer.expiryDays` gates the day-unit control and the
deletion setting; a client seeing only `expiryHours` keeps the hours control,
writes hours, and neither shows nor changes ownership.
The same v0.8.0/v0.8.1 corpus lacks artifact configuration entirely; the
maintainer approved this additive metadata gate on 2026-09-07. The existing
`artifact-viewer` capability is not broadened to imply configurable expiry.
Public shares never request private artifact grants. Existing capability
meanings and transport formats do not change.

Focused tests cover actual main-port hostname dispatch, original bytes,
revocation, ranges, traversal rejection, wildcard/opaque-origin exclusion,
older-server fallback, and failed reachability. The browser fixture in
`packages/server/test/fixtures/artifact` exercises fonts, media, modules,
mocked JSON, local state, controls, and linked documents with no source dev
server. Run `pnpm --filter @yep-anywhere/client exec playwright test --config
playwright.artifacts.config.ts`. Chromium was verified at desktop and phone
sizes; this host lacks WebKit's required system libraries. After the operator
restarted YA on 2026-09-07, a live public HTTPS tunnel served the demo with
working fonts, modules, mocked JSON, menu, and save interaction in Chromium.
The same grant also returned HTTP 200 through local same-port Host dispatch.
The complete hosted-client embedded flow, Safari/WebKit, macOS, and Windows
verification remain outstanding.
