# Desktop downloads page and stable installer links

Status: implementation verified locally, update-server routes deployed,
website release pending, 2026-09-26. The server change is in
`simple-app-update-server` commit `a6b5240`; this repository configures it in
commit `2ed359595`.
Contributing-model: opus-5.5.

## Problem

The website offers the desktop apps by linking to
<https://github.com/kzahel/yepanywhere/releases>
(`site/src/data/distributions.ts`, `site/src/content/docs/desktop-apps.md`,
the footer and `updating.md`). That page mixes npm (`v*`), device bridge
(`bridge-v*`), stable desktop (`desktop-v*`) and a nightly Latest build
(`desktop-latest-v*`) almost every day, so a visitor has to scroll and then
pick the right file among DMGs, updater archives and `.sig` files. The
Desktop apps guide also still describes a `.msi` that 0.2.1 stopped
publishing.

The goal is one shareable `/download` page with an obvious button for the
visitor's platform that always downloads the current stable installer, with
the other supported platforms one tap away. Website calls to action for
desktop downloads lead to that page. Nightly Latest builds are never offered
on the website.

## Decision

Resolve "the current stable desktop installer for platform X" in the shared
update server. The website links to its own `/download` page; installer buttons
on that page link to stable update-server redirect URLs.

`simple-app-update-server` already pages through every GitHub release
(`per_page=100` with pagination in `src/github.ts`), selects the newest
release per product and channel with the tag-prefix rules in
`update-server/yepanywhere.json`, and caches the result. It is the one place
that already knows which release is stable desktop, so it gains download
redirects. A redirect returns `302` and a `Location` header containing the
selected GitHub release asset's `browser_download_url`. The browser follows
that URL and GitHub serves the binary with its download filename; the update
server does not proxy the bytes or set `Content-Disposition`. The site renders
plain installer links and uses a short inline script only to choose which is
primary.

Rejected alternatives:

- **Browser-side GitHub API**, as the JSTorrent site's `Downloads.tsx` does.
  With npm, bridge, stable desktop and nightly releases in one repository, the
  current stable desktop release falls off the first 100 releases within a few
  months without a new stable release. Unauthenticated calls are limited to 60
  per hour per visitor IP. GitHub's `releases/latest` is repository-wide and
  currently resolves to the npm release, so it cannot select desktop.
- **Hard-coding the version at site build time.** The site deploys only on a
  `site-v*` tag, so every desktop release would need a site release, and a
  forgotten one leaves stale links.

## Constraints

- [Website product communication](../../topics/website-product-communication.md)
  owns the public distribution statements. Registries stay editorial release
  claims, desktop stays labeled **Beta**, and the site must not offer Android
  or iOS downloads. Its verification contract applies to the site steps.
- Its analytics and privacy boundary says changing that boundary needs an
  explicit privacy and product decision. Counting downloads is such a change,
  so this plan does not add it.
- [Desktop V0](../../topics/desktop-v0.md) owns the Stable and Latest update
  channels. The new routes serve Stable only and must not change the Tauri
  updater routes or their responses.

## Update server

These steps are in the `kzahel/simple-app-update-server` repository
(`~/code/simple-app-update-server`), which serves JSTorrent and the other
products too, so the feature is generic and off unless a product configures
it.

### 1 — keep installer assets in the release cache

For Tauri products the cache holds only `latest.json`, whose `platforms`
entries point at updater archives (`YepAnywhere_aarch64.app.tar.gz`), not at
installers. When a cache refresh selects the newest release for a channel it
already has the release's `assets`; keep `name` and `browser_download_url` for
each asset alongside the cached `latest.json` and tag. Do not add GitHub
requests to do this. Existing disk caches lack these fields. An updater may
still use that old cache as fallback, but a download route must return `503`
until it has asset metadata from a successfully validated Stable refresh.

### 2 — add download routes

Add an optional product field, validated at startup like the existing
fields:

```json
"downloads": {
  "macos-arm64": { "asset": "YepAnywhere_*_aarch64.dmg" },
  "macos-x64": { "asset": "YepAnywhere_*_x64.dmg" },
  "windows-x64": { "asset": "YepAnywhere_*_x64-setup.exe" }
}
```

Keys are opaque platform ids chosen by the product. `asset` is a glob over
the release's asset names. The patterns above match the `desktop-v0.2.2`
assets and must not match the `.sig`, `.app.tar.gz` or `latest.json` assets.

Routes under the product's `pathPrefix` (`/desktop` for Yep Anywhere
Desktop):

- `GET` and `HEAD /download/:platform` redirect with `302` to the matching
  asset's `browser_download_url` in the newest release of the product's
  stable channel, with a short public cache lifetime (about five minutes).
  An unknown platform id, or a release with no matching asset, returns `404`
  with a JSON error. A glob that matches more than one asset is a
  configuration error: log it and return `404` rather than guess. If there
  is no asset-bearing Stable cache yet, return `503` instead of claiming that
  an installer is absent. The `/download` page retains an "All releases"
  fallback; do not probe redirects from the browser.
- The redirect route records no download analytics and needs no CORS. It
  serves only the stable channel, whatever the query string says. Add `HEAD`
  support to the server's current top-level `GET`-only method guard without
  changing the established update routes' behavior.

Tests: pattern selection, a zero-match and a multi-match release, a stable
release that is not on the first page of releases, a newer prerelease that
must be ignored, redirect, `404` and old-cache `503` responses, `HEAD`, and
unchanged `/tauri`, `/version` and `/channels` responses.

### 3 — configure Yep Anywhere desktop downloads

Add the `downloads` field above to the `yepanywhere-desktop` product in this
repository's `update-server/yepanywhere.json`. Keep the field absent from other
products.
The Pi's `products.d` symlinks this file from its checkout of this
repository, so it takes effect after that checkout is updated and the service
restarts. The server must reject the config if the product field is invalid,
so land the server change (step 2) first.

### 4 — deploy and check the live routes

Deploy per the private Pi runbook (`~/code/dotfiles/machines/pi/README.md`,
"Simple App Update Server"): update `~/code/simple-app-update-server` and the
Pi's `~/code/yepanywhere` checkout, run `npm run build` in the update-server
checkout as its `AGENTS.md` requires, restart `simple-app-update-server`, then
check:

```bash
curl -sI https://updates.yepanywhere.com/desktop/download/macos-arm64   # 302 to desktop-v…/YepAnywhere_…_aarch64.dmg
curl -sI https://updates.yepanywhere.com/desktop/download/windows-x64   # 302 to …_x64-setup.exe
curl -s  https://updates.yepanywhere.com/desktop/download/linux-x64 -o /dev/null -w '%{http_code}\n'  # 404
curl -s -o /dev/null -w '%{http_code}\n' https://updates.yepanywhere.com/desktop/tauri/darwin/aarch64/0.2.1   # still 200, unchanged
```

The site steps must not be released until these pass.

## Website

These steps are in this repository. The site has no UI framework; use an
Astro component with an inline script, as `Header.astro` and the layouts
already do.

### 5 — standalone desktop downloads page

Add `/download` as the canonical, shareable destination for desktop installer
choices. Keep the detailed installation and recovery guidance on
`/docs/desktop-apps`; link to it from the download page. Homepage and Features
desktop download calls to action, and manual-reinstall links in the guides,
lead to `/download` rather than duplicating the installer chooser on each
page. Keep the footer's generic "Releases" link pointed at all GitHub releases.

- Server-render one link per supported installer, pointing at the step 2
  redirects: macOS Apple Silicon, macOS Intel, Windows x64. With JavaScript
  off, every link is visible and works. Show a secondary "All releases" link
  to the GitHub Releases page, and keep the Beta label.
- The inline script chooses the primary button:
  - Windows: the x64 installer. On ARM64 Windows, note that the x64 installer
    works because it bundles a native ARM64 runtime (desktop 0.2.0).
  - macOS: Apple Silicon primary with Intel beside it. Only Chromium exposes
    the CPU (`navigator.userAgentData.getHighEntropyValues(["architecture"])`);
    when it reports `x86`, make Intel primary. Safari and Firefox always
    report "Intel Mac OS X", so do not trust that string.
  - iPadOS in desktop mode reports a Mac user agent; treat a "Macintosh"
    user agent with `navigator.maxTouchPoints > 1` as iPad.
  - iPhone, iPad, Android, Linux and ChromeOS: no desktop build. State that
    the desktop app is for macOS and Windows and offer the npm install and
    phone-browser paths instead.
  - An "Other platforms" control reveals every installer so a visitor can
    override the guess.
- If a redirect returns `404` (a release without that installer), the visitor
  lands on the update server's error; the "All releases" link remains the
  fallback. Do not add client-side probing of the redirects.
- Point the desktop entries' `downloadUrl` in
  `site/src/data/distributions.ts` at `/download`, and update desktop-specific
  links in `desktop-apps.md` and `updating.md` that currently send visitors to
  the raw Releases page. Distinguish "Download desktop app" actions from
  "Read the installation guide" actions.

### 6 — correct the Desktop apps guide

`site/src/content/docs/desktop-apps.md` still says a signed `.msi` is
published for managed deployment. Since desktop 0.2.1 only the per-user NSIS
`x64-setup.exe` is published (see `packages/desktop/CHANGELOG.md`). Remove
the MSI guidance. This step is independent and can land first.

### 7 — record the contract

In [website product communication](../../topics/website-product-communication.md),
"Current distribution statements": the site offers the current stable
desktop installers from `/download` through the update server's stable
redirects, chooses a primary installer from the visitor's platform while
keeping every supported installer reachable, never offers Latest (nightly)
builds, and falls back to the GitHub Releases page. Record the update-server
route's behavior where the server documents its endpoints (its README), not in
this repository. Add a `site/CHANGELOG.md` entry.

### 8 — verify and release the site

- `pnpm site:build` succeeds without warnings, including the catalog,
  internal-link and analytics-boundary validation.
- Per the topic's verification contract, inspect the homepage, Features,
  `/download`, Desktop apps guide and privacy page at 1920 x 1080 and
  375 x 812, in light and dark themes, with keyboard focus and touch targets
  checked.
- Capture `/download` with spoofed user agents for macOS (Safari and
  Chrome), Windows, iPhone and Android, and with JavaScript disabled, through
  the repository's artifact capture facility (see
  [UI testing](../../topics/ui-testing.md)).
- Click through each installer link once against the live update server.
- Release with `scripts/release-website.sh` per `site/RELEASING.md`.

## Open decisions

- **Download counting.** The update server could count redirects per
  platform. That changes the analytics boundary, so it stays out unless Kyle
  decides to add it, together with a privacy-page disclosure.

## Follow-ups outside this plan

- JSTorrent's site could replace its browser-side GitHub fetch with the same
  routes.
- A Linux desktop installer would need its own scope (roadmap item 1 notes
  this); `/download` would then gain a Linux option.
- Version and size labels could use an update-server metadata endpoint later.
  They would require a cross-origin request from each visitor to `/download`,
  a privacy-page disclosure, and a decision about labels going stale while a
  stable redirect advances to a newer release.
