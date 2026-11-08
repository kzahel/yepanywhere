# UI design and mockup exports

> YA's design language is moving onto a small set of shared controls that are
> shown and captured in a dev-only design playground. UI proposals use real
> client components in isolated Vite fixtures, exported as relocatable HTML,
> CSS, JavaScript, fonts and linked captures.

Topic: ui-design

Read this topic before choosing fixtures or rendering/export commands for UI
appearance or interaction proposals, including prose discussions of UI ideas.
Respect explicit prose-only requests and the user's visual-verification
handoff. For a requested mockup, a source file or dev-server URL alone is not a
viewable handoff; use the capture and delivery workflow below.

## Design language and component owners

Start with the actual surface being proposed: `pages/ProjectsPage.tsx` and
`components/ProjectCard.tsx` for project browsing, `pages/SessionPage.tsx`
for a session, and `pages/settings/` for settings. These paths are relative to
`packages/client/src`. Check the current component API and its providers before
reusing it. [UI architecture](ui-architecture.md) owns rendering boundaries;
[CSS architecture](css-architecture.md) owns styles and their containment.

`src/styles/index.css` supplies the existing dark/light/verydark themes,
semantic colors, spacing, typography, and bundled font faces; component-owned
styles live beside their components in CSS Modules. Reuse those tokens and
component SVGs. The normal UI font is the system sans; the example explicitly
selects the existing **YA Inter** option to exercise bundled font loading.
This is fixture configuration, not a change to the application's default.
Keep related controls grouped, allow long content to scroll, and inspect the
real desktop and phone renders under [UI testing](ui-testing.md).

## Shared controls and the design playground

Status: direction selected 2026-11-08.
[Plan 182](../docs/tactical/182-design-playground-and-shared-controls.md)
sequences the work. The playground, its token page, the undefined-property
limit and the button and switch census have landed; no shared control has
yet. Until one exists, the owners above remain the reference.

**Layers.** The design language has four layers. Each lower layer may not
depend on a higher one:

1. **Tokens:** the theme custom properties in `src/styles/index.css`
   (color, spacing, radius, type, and the planned shadow and z-index scales).
   A token used in client CSS must be defined in every client theme. Reads of
   properties no client source defines are frozen by `pnpm css:check`
   ([CSS architecture](css-architecture.md#contract)).
2. **Controls:** prop-driven shared components in `src/components/ui/`, each
   with its own CSS Module. The planned set is `Button`, `IconButton`,
   `Switch`, `SegmentedControl`, `Checkbox`, `Field`, `Popover`, `Menu`,
   `Banner`, `Badge`, `Spinner` and `Tabs`, beside the existing `Modal` and
   `TooltipLayer`. A control renders from props alone: no server, router or
   app-level context. Needing a service makes it a pattern or a scene.
3. **Patterns:** reusable compositions of controls, such as a settings row,
   a confirm dialog or an icon toolbar group.
4. **Scenes:** real surfaces rendered with fixture data. Server-backed data
   reaches a scene through injected services (React context), never through
   bundler aliasing of production modules.

**Unification rules.**

- Each control's variants are chosen from a census page: every legacy
  variant rendered next to the proposed canonical set, reviewed by the
  maintainer before migration. The legacy-to-variant mapping lives in
  `packages/client/design/census/mapping.ts`, and migration follows it. Its
  rows are proposals until the maintainer confirms them there.
- Migration may change appearance slightly toward the canonical variant; it
  is not a pixel-identical refactor. Deliberate restyling (radius, shadow,
  density) happens afterwards in the shared controls and tokens, not per
  feature.
- Once a shared control exists, new code uses it rather than raw markup or a
  new feature-local class. A count-only ratchet will hold the legacy
  patterns (`toggle-switch` markup, `settings-button*`/`btn*` classes,
  `createPortal` outside `components/ui/`, hand-written outside-click
  listeners) so they can only decrease.

**Playground.** `packages/client/design.html` is a separate entry served by
the Vite dev server, so it opens at `/design.html` on the YA dev port (local
or Tailscale). No production build lists it as an input, and it is not
reachable on relay or hosted clients. Biome rejects any import of
`packages/client/design/`, a `*.specimen.tsx` file or the playground's data
module from production client code.

Example files are `*.specimen.tsx`: beside their component under `src/`, or
under `packages/client/design/` for playground-only pages. They use a
Storybook-compatible subset of Component Story Format: a default export
`{ title, component?, parameters }`, where `parameters.layer` is `token`,
`control`, `pattern`, `scene` or `census`, and one exported function per
state, optionally named with `storyName`. Decorators, args, loaders and play
functions are not supported. Ids follow Storybook's rules: `Census/Buttons`
is `census-buttons`, and its `LegacyByVariant` state is
`census-buttons--legacy-by-variant`. States keep source order.

| URL (after `/design.html`) | Shows |
| --- | --- |
| `#/` | Index, grouped by layer |
| `#/<specimen-id>` | Every state, one column per theme (verydark, dark, light) |
| `#/<state-id>` | One state across the themes |
| `…?theme=light` | One theme only |
| `…?phone` | Grid cells as 375 px frames, so media queries respond |
| `#/<state-id>?iso&theme=light` | The state alone on a bare page, for capture |

Every page except an isolated state has a sidebar listing the layers and
their specimens, with the current specimen's states expanded beneath it; its
links keep the chosen theme filter and width. Below 760 px wide the sidebar
becomes a drawer behind a **Pages** button, which closes on following a link,
Escape or a tap outside it, and the theme columns stack. Specimens with
`parameters.width: "fill"` (census and token pages) always stack their themes,
and their rows wrap details under the name rather than narrowing a column.
Each grid cell carries its own `data-theme`, so theme tokens resolve per cell.
An isolated page marks `[data-design-ready]` once fonts load; a state still
loading data marks an element `data-design-pending`, and capture waits for it
to go. A state that throws renders its error in place and logs a console
error.

```bash
pnpm -s design:index                       # JSON: every specimen, state and URL
pnpm -s design:shot census-buttons         # each state, dark theme, 1000 px
pnpm -s design:shot tokens--colors --theme all --phone
pnpm -s design:shot census-buttons--proposed --grid --theme all
pnpm -s design:shot census-buttons --url http://localhost:3400
```

`design:index` parses the example files statically, so it needs no browser or
server; check it before writing a new control. `design:shot` starts a
private dev server for the checkout on a free loopback port (with its own
optimizer cache) and closes it afterwards, unless `--url` names a running
one. It captures full-page PNGs in the system Chrome inside its sandbox and
writes them with the same `capture.json`, `links.md` and image commentary as
`artifact:capture`, under `.artifacts/design-shots/`. Page errors, console
errors, failed requests and HTTP errors fail it with exit 3; invalid
arguments exit 2. Inspect the images before claiming visual quality.

The playground's pages:

- **Tokens:** every theme color resolved in each theme, the spacing, radius
  and type scales, and the undefined properties with their recorded counts,
  how many reads lack a fallback, and their CSS sites.
- **Census/Buttons** and **Census/Switches and segmented controls:** the
  proposed canonical variants (census prototypes in `design/census/`, not
  shared controls), the mapped legacy styles grouped by the variant they
  would become, every unmapped global class, and every matching CSS Module
  class, each rendered standalone. Global class counts are static whole-token
  counts in production TypeScript, served by a dev-only Vite plugin and
  refreshed when sources change; classes built at runtime are not seen.

No visual-regression test of the playground runs in CI. Screenshots are
taken on demand.

**Mockup lifecycle.** A proposal mockup is temporary. Delete it in the change
that implements or abandons the proposal; git history keeps it. Do not leave
proposal fixtures checked in after the real UI ships. When the playground
lands, proposals become proposal scenes that declare their owning tactical
plan or gap, and a check fails once that owner is gone or marked done.
Reference scenes render only real components and are kept. The existing
`packages/client/mockups/` directories are scheduled for deletion once the
export tests below move to a playground export.

## Authoring and commands

This section describes the current export fixture. Plan 182 replaces it with
a static export of the playground, after which the `mockup:*` commands are
removed.

The retained example is `packages/client/mockups/projects/`: an HTML entry,
React source importing the actual `ProjectCard`, and a fixture-owned CSS
Module. Sixteen sample projects exercise attention/queue counts, long content,
responsive columns, code-name chips, captions, and the card's gear/trash/plus
controls; every third project omits its caption and code name so the sparse
card is covered too. Each card has four SVG controls: settings, removal, new
session, and the caption pencil, including when the caption is empty (64 SVGs
across the 16 cards). `I18nProvider` uses English, and `MemoryRouter` keeps
card/new-session navigation inside the fixture. The gear, trash, and inline
code-name/caption editors change local feedback or preview state only;
navigation displays its destination. No action contacts a provider, changes or
removes a project, or starts a session. The fixture's explanatory copy and sample data are fixed English.

From the checkout root:

```bash
# Author the fixture on an unused port; stop this server when done.
pnpm --filter @yep-anywhere/client mockup:dev --host 127.0.0.1 --port 4310 --strictPort

# Typecheck and build HTML/CSS/JS/assets plus the versioned manifest.
pnpm --filter @yep-anywhere/client mockup:build

# Build, compare source/export renders, capture, and check direct YA viewing.
pnpm --filter @yep-anywhere/client mockup:export

# Repeat capture/direct verification against an existing build.
pnpm --filter @yep-anywhere/client exec playwright test --config playwright.mockups.config.ts

# Independently build the fixture and check hosted-relay viewing.
pnpm --filter @yep-anywhere/client exec playwright test --config playwright.artifact-relay.config.ts
```

Playwright Chromium must be installed for export/capture. The relay test also
requires OpenSSL and the relay workspace's native dependencies; see the
[isolated relay recipe](media-rendering-and-routing.md#interactive-artifact-relay-verification)
for the temporary-home wrapper and browser cache setting. The source/dev and
viewer servers used by tests are fresh, use unused ports, and are closed
by the tests. No test restarts the operator's YA server.

Output is `.artifacts/mockups/projects/`. A build replaces that generated
directory; copy an export elsewhere before regenerating if it must be kept.
The source stays in Git. `mockup:build` does not produce screenshots;
`mockup:export` is complete only on exit 0 and adds four PNG captures plus
`review.html`, whose images link to their interactive document/state.
Source-comparison and direct/relay captures are retained separately under
`.artifacts/mockups/captures/projects/`.

To revise the example, change its fixture source/data and regenerate. To build
another surface, use an isolated HTML/React entry with its actual component
providers and explicit local service substitutes, then adapt the fixture root,
metadata, and behavior assertions. The current adapter is one example, not a
component catalogue or arbitrary source-to-HTML converter. Production client
entries do not import it.

## Portable artifact captures

For an already-built HTML entry or an existing HTTP(S) artifact URL, use the
committed command from the checkout root:

```bash
pnpm --filter @yep-anywhere/client exec playwright install chrome
pnpm -s artifact:capture path/to/index.html --json
pnpm -s artifact:capture path/to/index.html --out .artifacts/captures/review-1 --json
```

The first command is one-time browser setup after the normal `pnpm install`
or `pnpm setup:core`; skip it where Google Chrome is already installed. The
capture renders agent-authored pages, so it runs them in the system's Google
Chrome, which the OS keeps current with security fixes, rather than in
Playwright's pinned Chromium build, which lags them; and, like every Chromium
launch in this repository, inside Chrome's sandbox. `pnpm lint` rejects a
launch that omits `chromiumSandbox: true`. No private dotfiles, `~/agents` checkout, Python, relay
installation, running YA server, or configured artifact hostname is required.
The helper uses the existing Node/tsx, Playwright, shared capability code, and
server MIME table. It is development tooling and is not imported by the app.

The command captures exactly 1000×600 and 375×812 viewport PNGs in fresh browser
contexts. Local entries use a browser-only HTTP origin rooted at the HTML
directory; requests for sibling styles, modules, images, and fonts are served
from disk without a listening port. Canonical paths must stay in that directory,
including through symlinks. Requests outside the document origin fail unless
`--allow-network` is explicit. Service workers are blocked; no browser profile,
YA cookies, or existing tab is reused. This is a static-bundle renderer, not a
development server or backend API emulator.

Before the browser starts it also makes a color emoji font available to this
host, so YA's emoji-bearing UI photographs as itself rather than as fallback
boxes; [UI testing](ui-testing.md#emoji-need-a-font-on-the-capture-host) owns
that contract, including the one-download-per-machine cache and what a host
without fontconfig reports instead.

It waits for network idle and fonts, and accepts `--ready-selector <css>` for
an application-specific ready state. Load failures, console errors, missing
assets, and operation timeouts fail the command. Browser warnings remain visible
in the JSON `warnings` array and Markdown handoff; captures with warnings do not
certify a clean page. `--timeout-ms` defaults
to 30000 per browser/API operation.
Capturing succeeds only after both viewports and the output manifest are
written. A successful capture does not certify appearance or test interaction:
the agent must open and inspect both PNGs sequentially before handing them off.
Behavior checks belong to the caller's browser workflow or the interaction
module described below; capture alone makes no assertions about them.

Each invocation owns a new directory, defaulting to
`.artifacts/captures/<unique-id>/` in this checkout. `--out` selects another new
directory; an existing directory fails rather than overwriting prior captures.
The helper never edits Git excludes or the input bundle. Output files are
`desktop.png`, `phone.png`, `capture.json`, and `links.md`. JSON stdout is one
complete object by default (`--json` makes this explicit); `--text` emits the
same Markdown as `links.md`. Use `pnpm -s` to keep pnpm banners out of stdout.
JSON includes `_acli.commentary` by default: the Markdown handoff followed by
an ordinary two-column Markdown table containing image references for both
captures, labeled with their viewport dimensions. Expanding both previews
shows the sizes side by side; no custom image syntax is required.
`--no-commentary` omits that metadata while retaining all ordinary result
fields; `--text` has no structured metadata.
`--help` and the script header declare `acli: 1 +commentary`; ordinary
execution emits `# acli: 1 +commentary` on stderr before capture work.
`--acli-quiet` or nonempty `ACLI_QUIET` suppresses that banner and therefore
does not activate YA's current output-based commentary recognition.
Errors are structured JSON on stderr; exit 0 means complete, 2 means invalid
arguments, and 3 means a capture/delivery/filesystem failure. Partial PNGs may
remain after failure, but are not a successful handoff.

### Capturing a driven workflow

An explicit local interaction module can reach the desired state before each
capture:

```bash
pnpm -s artifact:capture path/to/index.html --interact path/to/workflow.mjs --ready-selector '[data-ready]' --json
```

The module default-exports an async function receiving `{ page, viewport }`:

```js
export default async ({ page, viewport }) => {
  await page.getByRole("textbox", { name: "Reply" }).fill("Show this result");
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Show this result", { exact: true }).waitFor();
};
```

The module is trusted caller-owned Node code, loaded from the supplied path
relative to the command's working directory; JavaScript and TypeScript are
supported by the existing tsx entry point. It is never loaded from artifact
content. It runs once in each fresh viewport after DOM-content navigation,
before `--ready-selector`, font readiness, and the screenshot. The ordinary
no-module path retains its network-idle wait. Playwright operations use the
configured timeout; the module owns any non-browser waits and assertions.
Keep its stdout clear for the command's JSON result. Callback errors fail the
capture, close the browser, and revoke any grant created by this invocation.
Network restrictions and YA-header separation remain unchanged. Reopening
the artifact starts the document normally; the interaction module is not
bundled into the document or replayed by the viewer.

For an existing Playwright workflow that already owns its browser, input
sequence, authentication, and screenshots, import `writeCapturePreview` and
`emitCapturePreview` from `packages/client/scripts/artifact-capture.ts`:

```ts
const preview = await writeCapturePreview({
  input: "Session question workflow",
  out: ".artifacts/provider-output-contract/20260908T070000Z-question-menu",
  screenshots: [
    { name: "desktop", width: 1000, height: 600, path: desktopPng },
    { name: "phone", width: 375, height: 812, path: phonePng },
  ],
  warnings: browserWarnings,
});
emitCapturePreview(preview);
```

This helper verifies nonempty screenshot files, canonicalizes their paths,
and writes the same `capture.json`, `links.md`, and image commentary used by
the CLI. It accepts one or more uniquely named states with positive viewport
dimensions. It never navigates, recaptures, copies images, closes the caller's
browser, or creates a delivery grant. The caller remains responsible for
assertions, browser errors, warning collection, and teardown. Optional `file`
and `delivery` describe an already-established interactive artifact; omit them
for screenshots of an ephemeral test server. Existing manifest or link files
are not overwritten; failure can leave partial output, never a success result.
`emitCapturePreview` writes the capability banner and JSON to the tool output
so supporting YA sessions present the image files beside that call. Agents
still inspect each image themselves before claiming visual quality.

### Optional interactive delivery

```bash
pnpm -s artifact:capture path/to/index.html --ya-url http://localhost:3400 --json
pnpm -s artifact:capture path/to/index.html --ya-url https://your-ya-host --audience public --ya-headers /private/ya-headers.json --json
```

`--ya-url` is an explicit YA server origin, not a relay or hosted-client URL.
For local HTML it defaults to the launcher's informational `AGENT_SERVER_URL`.
An explicit URL wins; `--local-only` disables YA requests even inside a YA
session. Without either URL source, capture stays local. The server must see
the same absolute HTML path. With a server selected and no announced origin,
the helper reads `/api/version` once and checks the
artifact capability, availability, and selected local/public origin. An absent
capability or disabled/unconfigured selected origin skips the grant request,
and still produces local captures and the file-viewer link.
It does not guess another audience, enable hosting, or change settings.

A session launched by YA already knows that answer:
`AGENT_ARTIFACT_VIEWER_ORIGIN` carries the isolated local origin when the
viewer is available, so the helper skips the capability query and requests the
grant directly. See
`topics/ya-env-vars.md` on child launch markers. The marker is only present for
a loopback session and the local audience; without it the helper asks the
server as above.

Enabled or not is the whole delivery decision, and the grant request is its
authority: a viewer that is off, or was disabled after a marker was published,
refuses the grant. Whether the origin *resolves* is never asked, because a
browser maps `*.localhost` to loopback itself under RFC 6761 with no hosts
file and no flag, which is what the default local origin relies on. Both PNGs
render the returned artifact URL, verifying that delivery path.
The success result retains that grant for the user and includes its expiration.
A failed capture revokes the grant it created. A non-isolated origin or a
refused grant skips delivery with that reason rather than failing the
run, so a misconfigured artifact service costs the
interactive link and never the captures. Explicit hosting failures for an
origin that did mint a grant are still reported rather than silently claimed as
working delivery; use `--local-only` when only local captures are needed.

Authentication is optional and explicit: `--ya-headers` reads a private JSON
object of string request headers, for example a supported session Cookie or
`X-Desktop-Token`. Keep this file outside the export directory. These headers
go only to the supplied YA origin, with
redirects rejected. They never enter artifact probes, browser contexts, logs,
or the output manifest. TLS verification remains enabled. Existing URL input
is captured directly, without querying YA or creating/renewing a grant; its
expiry is reported as unknown.

### Standard handoff

With [Tool commentary](acli-commentary.md) enabled and a supporting YA server,
the JSON-producing call itself fulfills the artifact handoff: YA presents the
following links and both image previews beside the tool output, including a
collapsed code-mode `Exec` row. Image expansion follows the existing inline
media preference and controls. No separate assistant message repeating these
links is needed. Inspect both PNGs before claiming visual quality; automatic
presentation precedes that judgment and is not a delivery/read receipt.

If that presentation is unavailable or disabled, present the returned Markdown
after inspection. The handoff uses this order:

1. **Open in YA** — the absolute HTML file-viewer link, when input was a file.
2. **Interactive** — the verified artifact URL and expiry, or an explicit
   reason interactive delivery was skipped.
3. **Captures** — the desktop and phone PNG file-viewer links.

Keep the local file-viewer link even when an artifact URL is available. A file
link can be opened weeks later while the file still exists and is authorized;
starting interactive preview creates a fresh grant with a new expiration.
An existing grant URL never renews merely because someone opens it, and a
server restart may invalidate it before its expiry. Captures remain the saved
pixels, while the file-viewer link opens the file's current contents.

The command and tests use portable Node filesystem/process APIs. Linux Chromium
is exercised; macOS and Windows execution remain unverified. The tests include
paths with spaces, Windows-formatted handoff destinations, disabled hosting,
credential separation, broken loads, traversal rejection, and CLI invocation
from a different working directory.

## Export contract

`ya-mockup.json` is version 1 of the `ya-ui-mockup` metadata format. It declares:

- `title`, relative HTML `entry`, and `presentation` (`scripted` here);
- selected `theme`, `locale`, and `font`;
- `states`: names and entry URLs (`default`, `selected`);
- `viewports`: named width/height pairs (1000×600 and 375×812);
- `files`: the complete finite set of exported relative file paths, including
  the manifest itself and, after capture, screenshots and the review page;
- `screenshots`: state, viewport name, image path, and linked document URL;
- `regenerate`: the command that recreates the bundle and captures.

The development manifest has empty file/capture lists because source serving
is not an export. The build manifest declares every output asset; screenshot
metadata is added by the capture command. This manifest is portable authoring
metadata, not a YA protocol capability, security allowlist, or installation
format. YA currently opens the HTML entry and does not interpret the manifest.

Vite builds with `base: "./"`, no public-directory copying, and file-based
assets. Keep all required resources below the HTML entry's directory. Import
assets through the builder; root-relative resources, parent-directory assets,
external services, and history-router fallback are not supplied by this
adapter. Viewing the export needs no source server, package install, or build.
Transfer the whole directory; an optional ZIP must be extracted before viewing.
Local state is illustrative and resets on document reload unless the fixture
deliberately implements persistence.

## Delivery and verification

When presenting a proposal, give a clickable absolute local path to the
exported HTML, such as `[Open mockup](/absolute/checkout/.artifacts/mockups/projects/index.html)`,
and a path to `review.html` or an inspected PNG as the fallback. Resolve the
actual checkout path; do not give only a source-code path or a dev URL. Explain
the interactive-preview setting below when it is required. The file-viewer
link opens the document; it is not a publicly shareable artifact grant.

When interactive delivery is configured, also create a grant through the
existing `POST /api/artifacts` route for the exported HTML and present its
returned `url` on the configured artifact domain, with its expiry. Select
the local/public audience appropriate to the user's connection. Verify that
URL in a browser, including its assets and an interaction, before calling it
usable. Ordinary taps on configured artifact links inside an authenticated
session open its [managed viewer](parked-file-viewer.md#interactive-artifact-links),
keeping the session and composer mounted on mobile as well as desktop. Prefer
that interaction for review; deliberate browser new-tab gestures remain
available. A parent policy that blocks embedding requires a frontend restart
and then a page reload. Keep the grant's directory limited to the
export, and never substitute a URL on YA's authenticated application origin.
The URL grants access until expiry or revocation; do not commit it into docs.

Open `index.html` in YA's file viewer and click the top-row source/preview
toggle once. It starts interactive HTML directly; switching back to source
stops it. Interactive HTML artifacts must be enabled in Local Access, with
a reachable separate artifact origin. Local access can use
`artifacts.localhost` on the forwarded YA port; hosted clients need a configured
public HTTPS artifact address. The exact configuration, grant, expiry, and
security contract lives in [active content security](active-content-security.md#interactive-html-artifacts).
Any required restart of a live YA server belongs to the operator.

Source/scriptless viewing remains available when interactive delivery is
disabled or unsupported; it cannot run the React fixture. Link directly to the
PNGs as the fallback. The gallery also needs interactive asset delivery to
show its linked images inside YA's viewer. An on-disk bundle or localhost dev URL alone
does not prove remote reachability. Check the user's actual configured path
before promising access through a particular hosted installation.

If **Run interactive preview** produces the browser's blocked-content page,
check the parent YA document's CSP as well as the artifact response. A stale
Vite process may still serve `default-src 'self'` without the current
`frame-src 'self' blob: http: https:` directive from `vite-plugin-csp.ts`.
That policy blocks the separate artifact host even when its grant works. It requires an operator-owned frontend restart and a page reload;
ordinary module hot reload does not establish that the HTML policy is current.
The viewer now replaces an enforced frame-policy failure with an explanation
and a link to open the granted document in a separate tab. That link remains
owned by the viewer and is revoked when it is stopped or closed.

The automated export check compares source and relocated production output
pixel-for-pixel at equal fonts, theme, state, and viewport, after waiting for
fonts. It verifies every declared file's served bytes, rejects undeclared or
external runtime requests, and checks font loading, SVG icons, scrolling,
overflow, and the card's settings control. The source server is closed before
the export is viewed. The direct test embeds it through the existing same-port
artifact-host route; the relay test uses real encrypted authentication/grants
and a separate disposable HTTPS gateway, exercises the card controls and
navigation at desktop and phone sizes, checks credential separation, and
revokes the grant.

Chromium on Linux is verified. The tests use portable Node filesystem/server
APIs; macOS, Windows, and WebKit remain unverified. The relay gateway explicitly
skips when OpenSSL is unavailable. These local-service tests do not attest to
a particular public tunnel or published hosted-client build. Broader HTML
inspection controls remain owned by [the HTML viewer gap](../gaps/html-document-viewer.md).

## Design decisions

- **A dedicated Vite entry with real components**, versus a new renderer or
  Storybook catalogue: uses the existing builder without runtime dependencies
  or a second UI implementation. A project with established stories can use
  its static exporter, but must prove the same completeness and viewing path.
- **A self-built playground**, versus Storybook, Ladle or React Cosmos
  (re-evaluated 2026-11-08): Storybook 10.3+ adds an agent-oriented MCP
  addon, but its dev-dependency and configuration surface means continual
  security upkeep for capability the Vite entry and `artifact:capture`
  already provide. Example files keep a Storybook-compatible subset so that
  choice stays reversible. The machine-readable index follows React Cosmos's
  fixture list.
- **Injected services for scenes**, versus bundler aliases or a faked network
  layer: aliases silently break when module paths move, and a network fake
  would duplicate the server contract. Context injection matches the ongoing
  client refactor.
- **A directory plus ordinary HTML metadata**, versus mandatory single-file
  inlining or browser-specific bundle navigation: preserves modules and fonts
  and works with the existing artifact grant. The current export includes the
  full shared stylesheet/font inventory and locale chunks; it favors fidelity
  over a minimal download. It does not install applications or launch servers.
- **Reuse the existing artifact isolation**, versus new hosting machinery:
  source authoring and document delivery remain separate concerns. The broader
  [Interactives](interactives.md) proposal is not required for mockup review.
