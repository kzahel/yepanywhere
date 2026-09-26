# Website Changelog

All notable changes to the Yep Anywhere website and remote relay client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [site-v1.11.0] - 2026-09-26

### Added
- Add a standalone desktop downloads page with current Stable beta installers
  for macOS Apple Silicon, macOS Intel, and Windows. Desktop download actions
  lead to this page, and visitors can choose another platform or view all
  releases.

### Changed
- Remove obsolete Windows MSI guidance and direct manual desktop reinstalls
  to the downloads page.
- Publish the current hosted remote client, including file-viewer and artifact
  interaction improvements merged since the previous website release.

## [site-v1.10.0] - 2026-08-31

### Changed
- State directly that every Claude Code and Codex session appears in Yep
  Anywhere, including sessions started in their CLI, VS Code, and first-party
  desktop interfaces.
- Present Claude Gateway as the advanced route for compatible endpoints and
  Claude + Ollama as legacy compatibility rather than a current experimental
  integration.
- Classify Source Control as stable and complete its public description with
  working-tree and commit navigation, tracked-file search and blame,
  line-comment review bundles sent to agents, and the deliberately bounded
  remote, pull, and push actions.
- Give every green uppercase eyebrow label one platform-system sans rule with
  real 700 weight and restrained tracking, while leaving the mixed-case Inter
  headings unchanged.

## [site-v1.9.0] - 2026-08-01

### Fixed
- Keep ordered-list markers inside the documentation article measure instead
  of hanging into the outer gutter.
- Add the shipped experimental pi integration to the provider registry, FAQ,
  feature catalog, README, and provider guide, and validate that every runtime
  provider maps to a public registry entry.

### Added
- Add a typed public feature, provider, and distribution registry; a complete
  feature catalog; and public guides for installation, remote access,
  providers, workflows, security, and troubleshooting.
- Add build-time checks for catalog relationships, public internal links,
  canonical metadata, and the marketing analytics boundary.
- Add a homepage security-maintenance section covering the narrow runtime
  dependency surface, regular maintainer-led audits, and the two public core
  maintainers.

### Changed
- Make existing Claude and ChatGPT subscription-plan support a first-viewport
  benefit, with provider-owned billing caveats in the public guide.
- Replace the vague “Familiar by default” proof-strip fragment with the concrete
  fact that the official Claude Code and Codex tools run on the user's host.
- Name Claude Code and ChatGPT's first-party remote experiences in the Why
  section, then distinguish Yep Anywhere through complete access from any
  browser rather than only a phone.
- Clarify that the relay option is end-to-end encrypted so the proof strip does
  not imply that an unencrypted relay mode exists.
- Describe relay application traffic as end-to-end encrypted, keeping server
  authentication as a separate concept instead of calling the traffic itself
  authenticated.
- Rename the vague “Guarded source control” highlight to “Source control UI”
  and describe the repository workbench directly.
- Highlight the no-network-setup Remote Access path: install, set credentials,
  and connect from any browser without device pairing, a VPN, or port
  forwarding.
- Replace the generic pre-install FAQ heading with a direct first-party remote
  app comparison centered on one multi-provider browser workspace across hosts.
- Pair every future Android client mention with the later iOS plan: Android is
  in development, iOS follows, neither is published, and the complete mobile
  browser remains available today.
- Lead cross-device copy with “anything with a modern web browser” and use
  computers, tablets, and phones as examples instead of an exhaustive device
  list.
- Add a private vulnerability-disclosure email to the public security guide
  and reserve GitHub Issues for non-sensitive reports.
- Remove the arbitrary capability, provider, and connection counts from the
  feature-catalog hero.
- Reframe the homepage hero around full access to all supported agents from
  every device, and reduce the headline scale.
- Replace implementation-oriented persistence proof with a familiar-by-default
  workflow, optional product depth, and the application's six-language UI.
- Add a prominent “Why Yep Anywhere?” section covering the combined capability,
  privacy, and security advantages found in the project landscape survey.
- Highlight full transcript and tool-call visibility alongside the optional
  condensed conversation presentation.
- Rebuild the homepage around persistent mobile agent supervision, catalog-
  backed feature proof, local-data trust, and distinct installation paths.
- Make cross-device control explicit: any browser can supervise another
  computer, not only a phone, with Claude Code and Codex in one interface.
- Explain why the browser remains the supported mobile experience while the
  Android companion develops native notification and multi-server value.
- Clarify that public session sharing is opt-in because the current share path
  is readable by the relay operator, unlike authenticated Remote Access.
- Document the default npm/source and desktop data directories on macOS,
  Linux, and Windows.
- Classify Project Queue as a stable, optional capability with opt-in entry
  controls rather than an experimental feature.
- Describe source checkouts as suitable for forks and customization as well as
  contribution and following unreleased work.
- Expose beta macOS and Windows downloads from GitHub Releases while
  stating that Android is in development, iOS is planned later, and neither
  native app is published.
- Make Features and Docs first-class desktop and mobile navigation items, and
  correct website analytics and public-relay disclosures in the privacy page.

## [site-v1.8.3] - 2026-07-31

### Fixed
- Opt the Pages artifact uploader into hidden files so the checked deployment
  directory's `/.well-known/assetlinks.json` reaches production.

## [site-v1.8.2] - 2026-07-31

### Fixed
- Include hidden static directories such as `/.well-known` in the GitHub Pages
  deployment artifact.

## [site-v1.8.1] - 2026-07-31

### Added
- Associate the Yep Anywhere Android app with `yepanywhere.com` for compatible
  password-manager credential sharing and verified `/open` App Links.

## [site-v1.8.0] - 2026-07-25

### Added
- Add `!!` bang commands to the hosted composer: a draft starting with `!!`
  runs the rest as a local shell command on the connected server and renders
  inline as a transcript block with exit status, duration, streaming previews,
  and on-demand full output. Includes cancel, raw/rendered toggle, re-run,
  recall-to-composer, echo-to-session, delete, Tab completion (with a mobile
  Tab button), and a `/bang-commands` page listing runs across sessions. Hidden
  unless the connected server advertises the default-off capability, and never
  offered on public shares.
- Add hosted settings search: a substring filter whose matched rows stay
  operable in place, highlight matched tokens, and link to their named section,
  with a default-off value-matching toggle.
- Add a hosted composer recall drawer: Ctrl+Up opens prefix-matched prior user
  turns with per-row go-to-turn navigation, plus a default-hidden mobile open
  button.
- Add opt-in additional model controls so hosted model choosers surface a
  server-maintained catalog of extra and exact-ID models as a separate group,
  disabled by default and gated on the server capability.
- Add hosted controls for the battery-aware host-awake setting and server-owned
  per-host emoji identity markers, which appear beside headers and in
  browser-tab titles. Both stay hidden against servers that do not advertise
  them.
- Add server-backed browser settings backup with Save and Load controls that
  move an allowlisted set of browser-local preferences through one server-stored
  snapshot.
- Add a themed tooltip layer to the hosted client with a standard delay,
  pointer-rest timing, warm adjacency scanning, keyboard association, and
  secondary-click copy/enlarge. Browser-native tooltips remain the default.
- Show provider child sessions nested under their canonical parent in the hosted
  Agents page and session lists.
- Add a keyboard-open mobile composer action row with large delivery targets,
  inline Project Queue and Steer slots, and a More panel for the remaining
  toolbar controls.
- Add a hosted Project Queue new-session action behind its own default-off
  Toolbar setting, distinguished by a darker violet and a prominent `+` badge,
  and share Copy, Edit, Steer now, and Cancel across live queued rows.

### Changed
- Refresh hosted provider support for Claude Agent SDK 0.3.220 / Claude Code
  2.1.220 with Opus 5 on the stable family alias, Codex app-server 0.145.0, Pi
  0.81.1, and Grok ACP.
- Queue live effort changes until turn completion instead of restarting the
  provider process mid-turn.
- Serve hosted Inbox refresh from bounded session summaries rather than full
  transcript scans.
- Copy rendered Markdown and Σ previews as semantic HTML without presentation
  styles, retaining table structure and MathML, and keep text selections through
  Edit diff expansion.
- Render uniform JSONL and TOON command output as real tables instead of fenced
  JSON blobs.
- Recognize bracketed `\( \)` and `\[ \]` LaTeX delimiters in Σ rendering.
- Rebuild hosted transcript rendering on the browser-free portable transcript
  compiler with separate cache, semantic-folding, and web-adapter layers, with
  no change to rendered output.

### Fixed
- Stop relay login from redirecting to an offline host after signing in to a
  different one, and keep cached pages readable after a remote disconnect
  instead of replacing them with a non-dismissible error.
- Keep accepted steer messages visible through reconnect.
- Merge provisional session IDs on canonical remap so a just-created session
  cannot appear twice in hosted session lists.
- Title Claude slash-command session openers from the first non-meta user turn
  instead of the provider's local-command caveat.
- Keep touch taps from opening or stranding hover-only tooltips and session
  previews.

## [site-v1.7.4] - 2026-07-11

### Added
- Add bounded active transcript-window trimming in the hosted remote client to
  reduce long-session memory and rendering cost while preserving search,
  navigation, and hidden-content awareness.
- Render Codex `web.run` browsing and compound exploration output as structured
  hosted transcript tool rows.
- Add Codex user-turn provenance handling so hosted streamed and persisted
  transcripts resolve user turns consistently.

### Changed
- Normalize Codex code-mode shell/run/wait rows, retries, failures, exit/runtime
  metadata, output previews, and shell auto-expand behavior.
- Improve session freshness, transcript context identity stability, and summary
  cache rebuild behavior to reduce avoidable hosted-client churn.
- Choose the newest available Codex CLI during autodetection and enumerate all
  Unix PATH candidates.

### Fixed
- Surface terminal provider turn failures and handle Codex retry/process-failure
  payloads.
- Link shell polls to their command, fold waits into a single row, and hide
  info-free empty polls.
- Fix session info modal scrolling and hide unavailable Codex browser-skill UI.

## [site-v1.7.3] - 2026-07-10

### Added
- Render Codex code-mode command/tool rows in hosted remote transcripts.
- Add hosted file-link actions for starting new sessions from referenced files.
- Add an Agents-page kill action for live provider cards.

### Changed
- Refresh hosted remote compatibility for the npm `0.6.1` server, Codex
  CLI/app-server compatibility through 0.144.1, and Claude Agent SDK 0.3.205.
- Disable off-screen transcript rendering by default while keeping it
  configurable, and tighten compact-history turn tail loading.
- Improve long-transcript rendering cost, thinking outline streaming, search
  preview stability, and sidebar/session feed rendering.

### Fixed
- Fix Codex titles polluted by injected plugin context and hide
  plugin-prefixed startup instructions from visible transcripts.
- Cancel unacted steering sends and clear interrupted pending approvals.
- Unlock notification-type toggles without a reload and scope them under push
  notification settings.
- Skip unconfigured remote-client deploy uploads.

## [site-v1.7.2] - 2026-07-07

### Fixed
- Canonicalize relay login return targets so a direct hosted URL such as
  `/remote/projects` does not keep redirecting back to `/remote/projects` after
  login.

## [site-v1.7.1] - 2026-07-07

### Fixed
- Redirect connected relay sessions from direct hosted routes such as
  `/remote/projects` to the relay-scoped project route before source-runtime
  data fetches start.

## [site-v1.7.0] - 2026-07-06

### Added
- "What Shipped This Spring and Early Summer" recap post (`/spring-2026`)
  covering first-class Codex support, Project Queue, public session sharing,
  server-routed voice input, source-control actions, six-language localization,
  session search, and the secure-by-default file viewer, with a linked entry at
  the top of the News page and homepage announcement banner.
- Hosted remote Project Queue UI for compatible servers, including Projects-page
  management, inline target-session queue rows, sidebar and inbox badges,
  recovered queue visibility, force-start/pause controls, move-to-top, and a
  hidden-by-default composer affordance.
- Hosted remote Source Control actions for manual remote checks, safe
  fast-forward pulls, branch push/publish, diverged-branch guidance, recent
  commits, and wide-screen split diff preview.
- Hosted remote session orientation improvements, including durable recaps,
  generated titles, fork-after-summary flows, session hover cards, retained
  routes, and faster cached session restores.

### Changed
- Gate Project Queue, enhanced Source Control, and hosted remote compatibility
  surfaces on server capabilities so newer hosted clients degrade cleanly
  against older servers.
- Refresh hosted remote client compatibility for the npm `0.6.0` server, Codex
  CLI/app-server compatibility through 0.142.4, and Claude Agent SDK 0.3.199.
- Move session feeds, activity streams, summary state, and session detail
  restore paths toward retained/source-runtime-backed data so the hosted remote
  client does less redundant fetching.
- Improve toolbar visibility/priority settings, reload banners, transcript
  selection, file/image previews, mobile settings layout, and session list
  orientation.

### Fixed
- Stabilize secure reconnect/auth recovery, relay login state, hosted update
  notices, safe restart/reload flows, and Project Queue recovery after restart.
- Improve Codex summary parsing, session index invalidation, subagent rendering,
  Windows path handling, Bash replay details, and stale queue/session display.
- Harden file viewer and public-share warnings, uploaded filename handling,
  disk-full stream behavior, and parser-worker cleanup on server reload.

## [site-v1.6.4] - 2026-06-07

### Fixed
- Keep the relay-only Switch Host item icon-only in the collapsed hosted
  sidebar.

## [site-v1.6.3] - 2026-06-07

### Fixed
- Hide the remote Switch Host label in the collapsed hosted sidebar.

## [site-v1.6.2] - 2026-06-05

### Added
- Session search, fixed-font and output appearance controls, explicit thinking
  controls, and Grep preview line settings for hosted remote sessions.
- Localized remote UI coverage for German, Spanish, French, Japanese, and
  Chinese.
- Shared Markdown media and file viewer support for remote and public share file
  links.

### Changed
- Move speech controls into the microphone menu, hide the composer model chip by
  default, and polish transcript, tool-row, sidebar, and settings typography.
- Show daily-snoozed remote compatibility notices and ignore `site-v*` tags in
  YA server version displays.
- Keep relay SRP v2 resume available during the v3 grace window with visible
  compatibility guidance.

### Fixed
- Clear stale relay resume sessions before login.
- Fix public share file media and Read links.
- Stabilize thinking transcript and Grep preview rendering.
- Improve mobile sidebar tap targets and mid-width settings layout.

## [site-v1.6.1] - 2026-06-03

### Added
- Stable tool preview rendering controls for the hosted remote client.
- Inline media display controls for generated and local media previews.
- Local-resource link handling for project-root files in remote/relay sessions.

### Changed
- Gate Codex live deltas on active subscriber demand and respect the streaming
  preference for Codex delta rendering.
- Apply collapsed-by-default inline media behavior to images and videos.

### Fixed
- Fix file preview modal scrolling and project-root local file opening.
- Preserve hosted relay paths when opening local-resource links in a new tab.
- Fix relay agent session links and remote project redirect routing.
- Stabilize transcript rendering while appending streamed content.

## [site-v1.6.0] - 2026-06-01

### Added
- Remote compatibility notices in About settings for hosted-client guidance

### Changed
- Update the Astro site configuration for the current Pages build
- Refine remote notice presentation and update guidance

### Fixed
- Reuse session message history on hot reload instead of re-downloading it
- Keep reconnect/catch-up behavior on incremental deltas rather than full replay
- Avoid eager image attachment fetches on session replay
- Strip inline image blobs from Codex replay payloads before serialization

## [site-v1.5.31] - 2026-04-13

### Fixed
- Prefer persisted provider for session resume and agents

## [site-v1.5.30] - 2026-04-13

### Fixed
- Fix clearing empty server settings

## [site-v1.5.29] - 2026-04-05

### Added
- Lifecycle webhook support
- ToolSearch schema validation
- Relay host upsert on auto-resume for reliable reconnect

### Changed
- Update Claude model selection options
- Move persist-remote-sessions toggle to Remote Access settings

### Fixed
- Avoid new-session remounts on project refresh
- Fix relay host ID race condition during session refresh
- Fix modal title overflow on long names

## [site-v1.5.28] - 2026-04-02

### Added
- Local media preview modal for file paths in markdown
- Prefer recent project for new sessions

## [site-v1.5.27] - 2026-03-29

### Added
- Centralized cross-provider session listing
- Session summary caching for Gemini and Codex providers

### Fixed
- Fix streaming edit patch filenames
- Improve PTY and Codex PTY tool rendering
- Fix mixed-provider session resolution and titles
- Preserve Claude sibling ordering on reload
- Stabilize session replay and queued prompt rendering
- Detect Codex CLI from desktop app sandbox-bin location

## [site-v1.5.26] - 2026-03-27

### Added
- New session defaults: save preferred provider, model, and permission mode
- Local image viewing for Codex imageView events

### Fixed
- Resolve allowed image paths for macOS /tmp symlink
- Deduplicate sessions on Windows caused by mixed-slash cwds

## [site-v1.5.25] - 2026-03-22

### Fixed
- Widen tool_result content type for broader SDK compatibility
- Stabilize Claude persisted session rendering
- Guard localStorage calls in i18n module
- Prevent false unread notifications from late JSONL writes
- Exclude progress messages from DAG to prevent dead branches

## [site-v1.5.24] - 2026-03-21

### Added
- Client-side i18n with lazy-loaded locale bundles (English, Chinese, Spanish, French, German, Japanese)
- Language selector in Appearance settings

## [site-v1.5.23] - 2026-03-15

### Changed
- Update Claude Agent SDK to 0.2.76 with runtime context window detection
- Support SDK 0.2.76+ Agent tool format and subagents directory

## [site-v1.5.22] - 2026-03-15

### Changed
- Update remote device control post to cover iOS Simulator support alongside Android
- Replace device list screenshot to show iOS Simulators section
- Add iOS Simulator stream screenshot

## [site-v1.5.21] - 2026-03-13

### Added
- iOS simulator HID input support in remote client
- `/model` slash command for mid-session model switching
- PDF file previews in Read tool renderer

### Fixed
- Fix inbox race condition
- Prevent Enter key from triggering send during IME composition
- Improve Codex replay deduplication and session reconnect merging
- Fix Codex session cloning in mixed projects
- Keep pending Codex Bash rows collapsed

### Changed
- Reduce routine update checks

## [site-v1.5.20] - 2026-03-03

### Changed
- Remote device control post: clarify zero-dependency architecture (pre-built binaries, downloaded on demand)

## [site-v1.5.19] - 2026-03-03

### Added
- Per-article Open Graph image support in ArticleLayout
- Custom OG image for remote device control blog post

## [site-v1.5.18] - 2026-03-03

### Added
- Blog post: Android Dev Without a Desktop — Remote Device Control
- Device control feature card on homepage
- Device stream screenshot in homepage and README galleries
- Screenshots: device sidebar, device list, device stream, device settings

### Changed
- Homepage announcement banner now promotes remote device control

## [site-v1.5.17] - 2026-02-27

### Added
- New article: "What I Learned from the OpenClaw Guy's AI Coding Workflow"
- All news items now expanded by default on news page

## [site-v1.5.16] - 2026-02-25

### Fixed
- Fix spectrum diagram rendering: use ASCII arrows instead of variable-width em dashes
- Add proper pre/code block styling so text aligns with clean right edge

## [site-v1.5.15] - 2026-02-25

### Fixed
- Fix .html URLs serving blank page (remote SPA 404 fallback instead of actual page)
- Switch Astro to `build.format: "file"` so pages output as .html files directly
- Remove obsolete meta-refresh redirect stubs from public/

## [site-v1.5.14] - 2026-02-25

### Fixed
- Hide Screenshots, Features, and FAQ nav links on mobile to prevent header overflow

## [site-v1.5.13] - 2026-02-25

### Added
- Light/dark mode toggle in header with system theme default
- Light theme CSS variables with proper contrast
- Theme preference persisted to localStorage across page loads

### Fixed
- Hardcoded hex colors in announcement gradient and comparison table now use CSS variables

## [site-v1.5.12] - 2026-02-25

### Fixed
- Thinking mode toggle now persists correctly in localStorage
- Stream reconnects automatically after thinking-mode process restart
- "On" thinking mode uses adaptive + effort (avoids CLI crash on Opus 4.6)

## [site-v1.5.11] - 2026-02-25

### Added
- Blog post: Five Ways to Access AI Subscriptions Programmatically
- News page entry for subscription access approaches article

## [site-v1.5.9] - 2026-02-25

### Changed
- Migrate website from plain HTML to Astro

### Added
- Subscription access approaches page

## [site-v1.5.8] - 2026-02-25

### Changed
- Improve homepage comparison section heading

## [site-v1.5.7] - 2026-02-25

### Added
- Homepage: Remote Control comparison section and updated announcement banner

## [site-v1.5.6] - 2026-02-25

### Changed
- Update connectivity comparison: hosted relay parity, telemetry privacy, no extra install

## [site-v1.5.5] - 2026-02-25

### Added
- Feature comparison table and TLDR summary on Remote Control blog post

## [site-v1.5.4] - 2026-02-24

### Added
- Blog post: Claude Code Remote Control vs Yep Anywhere

## [site-v1.5.3] - 2026-02-23

### Added
- Blog post: Google banning subscribers for using OpenClaw

## [site-v1.5.2] - 2026-02-22

### Added
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

## [site-v1.5.1] - 2026-02-22

### Fixed
- Fix send racing ahead of in-flight file uploads
- Improve pending tool render and tighten settings copy

## [site-v1.5.0] - 2026-02-22

### Security
- Harden auth enable flow and add secure recovery path
- Harden relay replay protection for SRP sessions
- Harden session resume replay defenses for untrusted relays
- Patch vulnerable dependencies (bn.js)

### Added
- Legacy relay protocol compatibility for old servers
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Safe area insets for Tauri mobile edge-to-edge mode

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise

### Changed
- Default remote sessions to memory with dev persistence toggle
- Warn relay users about resume protocol mismatch
- Improve server update modal copy and layout

## [site-v1.4.2] - 2026-02-19

### Changed
- Polish value prop copy (disconnect card, approval urgency, encryption claim)
- Brighten feature card link color for better contrast on dark backgrounds

## [site-v1.4.1] - 2026-02-19

### Changed
- Rewrite relay value prop and feature card to highlight free relay access (no Tailscale/VPN needed)
- Restore "Log In to Your Server" as secondary CTA in hero
- Update hero screenshot caption to "Fix issues from anywhere"

### Added
- Desktop remote access settings screenshot

## [site-v1.4.0] - 2026-02-19

### Changed
- Rewrite hero headline and subhead to be outcome-driven ("Walk away. Your agents keep shipping.")
- Make "Get Started" the primary CTA, move "Log In" to nav only
- Rewrite value prop cards to match marketing pillars: seamless handoff, survive disconnects, lock-screen approvals, dashboard, self-hosted encryption
- Tighten all value prop copy

### Added
- Hero showcase with two phone screenshots (approve edit, completed session)
- TOS compliance feature card with link to SDK docs
- README TOS compliance section

## [site-v1.3.2] - 2026-02-19

### Added
- Blog post: The Agent SDK Auth Scare (and Why You're Fine)

### Changed
- Update Jan 11 compliance post to reflect that we don't handle auth at all

## [site-v1.3.1] - 2026-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [site-v1.3.0] - 2026-02-18

### Changed
- Highlight Codex CLI as fully supported alongside Claude Code
- Update hero, announcement banner, features, and FAQ for multi-provider messaging
- Update page title and meta description to mention Codex

## [site-v1.2.0] - 2026-02-16

### Added
- Blog post: OpenClaw and Yep Anywhere — Two Paths to the Same Future
- News entry linking to the blog post

### Fixed
- Link color in news item metadata now uses green accent

## [site-v1.1.0] - 2025-02-13

### Fixed
- Remove relay login redirect routes that dropped query params and hash fragments

## [site-v1.0.0] - 2025-02-01

### Added
- Initial tagged release
- Landing page, privacy policy, ToS compliance docs
- Remote relay client at /remote
- Public relay documentation
