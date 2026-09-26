# Website Product Communication

> The public website explains shipped Yep Anywhere behavior honestly: the
> homepage tells the product story, the feature catalog owns capability claims,
> and public docs teach supported user journeys.

Topic: website-product-communication

Related:

- [`docs/tactical/077-website-feature-catalog-and-public-docs.md`](../docs/tactical/077-website-feature-catalog-and-public-docs.md)
- [`site/src/data/features.ts`](../site/src/data/features.ts)
- [`site/src/data/providers.ts`](../site/src/data/providers.ts)
- [`site/src/data/distributions.ts`](../site/src/data/distributions.ts)

## Public surface ownership

- The homepage is selective. It states the primary outcome, local execution
  boundary, trust model, and next steps, then renders a small set of registry-
  selected feature highlights.
- The homepage's primary promise is full access to supported agents and
  workflows from every device through the browser. Server-owned persistence is
  supporting proof, not the headline outcome, and the remote experience must
  not be framed as a cut-down phone companion.
- The first viewport identifies subscription-plan support as a primary benefit.
  Yep Anywhere launches the official Claude Code or Codex process and uses its
  active provider-managed authentication. Public copy must not imply that Yep
  Anywhere grants plan eligibility, bypasses provider limits, or prevents an
  API-key or pay-as-you-go configuration from incurring provider charges.
- The default workflow should feel familiar to people who already use Claude
  Code or Codex in a CLI or desktop app. Advanced coordination, review,
  sharing, voice, and device-control capabilities are product depth, not new
  concepts a first-time user must learn before starting.
- The application interface is available in English, Chinese, Spanish, French,
  German, and Japanese. The public website remains English-only until its
  dedicated localization roadmap includes translated routes, navigation,
  metadata, and an accessible language switcher; do not imply that the website
  is already localized.
- A prominent “Why Yep Anywhere?” section explains the combination that sets
  the product apart: multi-agent workflow breadth, a full browser client on
  every device, complete session and tool-call visibility with an optional
  condensed conversation view, local data ownership, direct and self-hosted
  access, and an end-to-end encrypted relay. Phrase landscape
  claims as what the project survey found, not as an unprovable guarantee that
  no competitor can ever match an individual feature.
- `/features` is the canonical public catalog of shipped capabilities. A
  capability is included once and rendered from the feature registry.
- `/docs` is the canonical user guide. Internal topics, architecture notes,
  tactical plans, and historical proposals are evidence for authors but are
  not published as customer documentation.
- News posts remain dated history. Current calls to action should point at the
  canonical catalog or docs when a dated article's product state has moved on.
- The README stays concise and links to the public catalog/docs rather than
  maintaining another exhaustive inventory.

Green uppercase eyebrow labels use the platform system sans at real 700 weight
with one shared restrained-tracking rule. Individual pages may own their local
spacing around the label but do not redefine its face, size, weight, tracking,
case, or color. Mixed-case display headings remain in the site's Inter face.

## Registry contract

The site has three editorial registries with distinct meanings:

- **Features** describe shipped user capabilities. `stable` means the public
  workflow is supported for its stated availability; `experimental` means it
  is shipped but may have rough edges or narrower maturity. Optional or opt-in
  exposure is an availability note, not an experimental status. Project Queue,
  for example, is stable and optional.
- **Providers** describe the integration maturity of agent backends. A stable
  provider is expected to support the primary session, streaming, approval,
  and diff workflow. Experimental provider capabilities vary and must not
  inherit blanket parity claims.
- **Distributions** describe ways to install or access Yep Anywhere. Their
  states are `available`, `beta`, and `development`.

These registries are editorial release claims, not runtime negotiation. They
must not replace server capability gates, provider adapter contracts, or
hosted-client compatibility checks.

Source Control is a stable feature. Its entry and guide present an inspection
and agent-direction workbench: working-tree and commit diffs, tracked-file
search and blame, and persistent line comments submitted as coherent
agent-session reviews. Its only direct repository mutations are explicit
fast-forward Pull and Push; Check remote updates observation without modifying
the working tree. Do not imply a general-purpose Git client with staging,
commit, branch surgery, integration, conflict resolution, discard, or recovery
controls.

Every registry entry has a stable id, concise public copy, an owning docs path,
and repository source references for review. A build fails on duplicate ids,
unknown relationships, missing docs destinations, nonexistent repository
source references, or an invalid status. A development-only distribution must
not have a download URL.

Repository source references are checked by a dedicated source-time validation
step before Astro bundles and prerenders the catalog. Rendered catalog modules
must not derive repository paths from their output location; bundling may move
them under `dist/`, while the validation script retains a stable repository
anchor.

Every server runtime provider id must map to one public provider entry, including
runtime aliases grouped under a single public integration. This build-time
coverage check prevents a shipped provider from disappearing from the website;
it is an editorial completeness check, not runtime capability negotiation.

Claude Gateway is an advanced opt-in route within the public Claude integration
and must be distinguished from ordinary first-party Claude routing. The legacy
Claude + Ollama provider remains visible publicly only as deprecation guidance
for previously configured installations and existing sessions; do not promote
it as a current experimental choice for new setups.

Pi is a shipped experimental provider. Public copy names its headless RPC
sessions, durable history, tools, models, thinking, compaction, and fork support
while stating that its tools currently run without a Yep Anywhere approval
bridge.

Subscription-plan access is a stable Claude Code and Codex capability. The
feature registry and provider guide state that the official provider process
owns authentication and billing. Yep Anywhere may show normalized usage windows
when the provider exposes them, but missing usage data does not mean the plan is
unsupported and displayed limits are never presented as Yep Anywhere quotas.

Planned features are excluded from the feature catalog. A development-only
distribution may appear in an explicit platform-availability comparison so a
visitor is not misled, but it receives no download action or installation
instructions.

## Current distribution statements

- The npm/server install and browser client are available.
- Signed macOS and Windows desktop installers are published through GitHub
  Releases and are publicly labeled **Beta** while release-readiness work
  continues.
- /download is the canonical destination for desktop download actions. It
  offers the current Stable macOS Apple Silicon, macOS Intel, and Windows
  installers through update-server redirects to GitHub assets; it never offers
  nightly Latest builds. A visitor's platform chooses the prominent installer,
  while every supported installer and the GitHub Releases fallback remain
  reachable. With JavaScript disabled, all installer links remain visible.
- The Android app is in development and iOS is planned afterward. Neither is
  published. The normal phone experience is the browser client. The website
  must not expose an Android or iOS download, store badge, or installation
  procedure.
- Remote Android device control is a separate capability and must not be
  described as either native mobile client app.

## Local data path statements

- npm and source installs default to `~/.yep-anywhere/` on macOS and Linux and
  `%USERPROFILE%\.yep-anywhere\` on Windows.
- Desktop installs use the separate `~/.yep-anywhere-desktop/` directory on
  macOS and `%USERPROFILE%\.yep-anywhere-desktop\` on Windows.
- `YEP_DATA_DIR` overrides the npm/source location. A named `YEP_PROFILE`
  creates a suffixed directory under the user's home directory.

## Cross-device and first-party positioning

- Yep Anywhere is not a phone-only companion. Anything with a modern web
  browser can supervise an agent host; examples such as another computer, a
  tablet, or a phone are illustrative rather than an exhaustive device list.
- The easiest public-relay path requires no manual device pairing, VPN, or port
  forwarding. Public copy describes the actual setup rather than claiming that
  nothing must be configured: install Yep Anywhere, choose Remote Access
  credentials, enable the relay, then sign in from any browser.
- The durable comparison with Claude Remote Control and Codex Remote Control is
  that Yep Anywhere is a provider-neutral, browser-first supervisor across the
  machines the user controls. It must not depend on a native controller app or
  a particular controller operating system.
- The homepage Why section acknowledges Claude Code and ChatGPT's useful
  first-party remote experiences by name, then states Yep Anywhere's positive
  distinction: the complete multi-provider workspace works in any browser
  across the user's connected hosts, not only on a phone.
- The homepage FAQ asks directly why a visitor would choose Yep Anywhere over
  the first-party remote apps. Its answer acknowledges those products
  positively, then names the durable difference: Claude Code and Codex share
  one complete browser workspace across hosts, without limiting the controller
  to one provider or a phone app.
- Do not claim that every current first-party Remote Control experience is
  universally phone-only. Provider device support and rollouts can change; use
  the positive browser, host, provider, session-management, and self-hosting
  distinctions that Yep Anywhere owns.
- The native Android and iOS apps should be described as companions that must
  add dependable native value—background notifications, deep links, trusted
  packaging, and multi-server triage—not as prerequisites for mobile use.
  Android is in development first; iOS is planned later.

## Navigation and fallback behavior

The primary public navigation exposes Features, Docs, News, GitHub, Log In, and
Get started at desktop and phone widths. Get started routes to
`/docs/getting-started`; Log In routes existing installations to `/remote/`.

A feature with no dedicated guide links to the nearest useful public docs
section. It never links to a missing route or uses an internal design document
as the sole user guide. Public pages must remain navigable without JavaScript.

## Analytics and privacy boundary

Cloudflare Web Analytics runs on the Astro marketing, news, and docs pages via
the shared base layout. It collects aggregate page/performance measurements.
The privacy page discloses that behavior.

The hosted `/remote/` application does not include the marketing analytics
beacon. Product sessions, prompts, files, approvals, and application actions
are not marketing events. Changing that boundary requires a separate explicit
privacy and product decision.

Important journeys use distinct page paths, including `/features`, `/docs`,
and `/docs/getting-started`, so aggregate path traffic can answer navigation
questions without custom event tracking. Page views are not proof that an
installation or workflow succeeded.

## Security and maintainer statements

- Public security copy distinguishes architectural controls from maintenance
  practice. It may state that the runtime dependency surface is deliberately
  narrow and that maintainers regularly audit security-sensitive surfaces, but
  must call those reviews maintainer-led rather than implying independent
  certification.
- The public core maintainer set is Jonathan Graehl (`@graehl`) and Kyle Graehl
  (`@kzahel`). Link identities to their public GitHub profiles. Link additional
  professional profiles only when the exact URL has been verified.
- The homepage points readers to the public security guide and `SECURITY.md`
  remains the operator-facing vulnerability-reporting source of truth.
- The public security guide provides `graehlarts@gmail.com` as the private
  vulnerability-disclosure address and directs non-sensitive reports to GitHub
  Issues. It must warn against publishing exploit details, credentials, or
  other sensitive evidence in a public issue.

## Public-share privacy boundary

Public session sharing is opt-in because the current relay transport for shares
is not private from the relay operator. No public share exists until the owner
deliberately creates one. Anyone holding the secret link can read the shared
content while the share remains active, and a relay operator who inspects or
modifies the relay can see the request path, bearer secret, and response
contents.

Public copy must distinguish this path from end-to-end encrypted Remote Access,
whose application messages are end-to-end encrypted. Do not use blanket
statements such as “all relay traffic is private” or “the relay cannot read your
data.” Tell users to review content before enabling a share and revoke the share
when it is no longer needed.

## Verification contract

Before a website communication change is complete:

- `pnpm site:build` succeeds without warnings;
- the built-site validator checks catalog relationships, public internal links,
  canonical metadata, and the analytics inclusion boundary;
- homepage, feature catalog, docs, navigation, and privacy are inspected at
  1920 x 1080 and 375 x 812 in a real browser;
- light and dark themes remain readable;
- ordered and unordered docs lists keep their markers inside the article
  measure with a readable text inset;
- keyboard focus, mobile touch targets, code overflow, and long-doc navigation
  remain operable; and
- the site changelog describes externally visible changes.
