# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.1] - 2026-09-05

### Added
- Add native Codex goal commands with argument completion, live status notices,
  persistence across reloads and worker loss, and explicit clear, pause, and
  resume actions.
- Add a Codex plan-checklist provider setting, quick-hide actions for composer
  toolbar controls, and inline editing for queued prompt attachments.

### Changed
- Refresh the bundled Claude runtime to Claude Code 2.1.258 and Agent SDK
  0.3.258, including Fable 5.1 catalog metadata and its 1M-context capability.
- Refresh Codex compatibility through CLI 0.153.3, including current model
  defaults, app-server protocol fields, and provider-controlled plan tooling.
- Page large Codex histories directly from source offsets, stream oversized
  rollouts, and reconstruct reference-backed fork history.
- Extend in-session reverse search into older history and make Session Defaults
  guidance match the New Session controls.
- Render supported image and video links in live and newly frozen public session
  shares.

### Fixed
- Keep very large and incrementally updated Codex transcripts readable across
  restarts, UTF-8 boundaries, identity migrations, and nested forks.
- Keep managed viewers responsive in long sessions and prevent Markdown SVG
  previews, transcript selections, and themed hover feedback from doing stale
  or repeated work.
- Preserve selected model and effort state through idle cleanup or rejected live
  updates, and warn before attempting to compact an active Codex turn.
- Resolve runnable Claude shims correctly on Windows and reject shims that
  cannot spawn.
- Make queued attachment replacement recoverable and keep client snapshots
  within the generation that produced them.
- Patch audited URL and query dependencies and document the bounded sanitizer
  configurations used for the remaining upstream advisories.

## [0.8.0] - 2026-08-31

### Added
- Add a full Source Control workspace with working-tree diffs, commit and blame
  browsing, file and commit search, inline review comments, accumulated review
  drafts, and guarded Git actions.
- Add a richer project file workflow: link project paths from turns and command
  output, browse related files and revisions, inspect cumulative diffs, comment
  inline, and keep image and document previews in the managed viewer.
- Add live public file shares alongside read-only session sharing, with
  authenticated creation and bounded relay/storage behavior.
- Add a condensed conversation view, full-pane composer editing, persistent
  Follow and scroll-return state, and stable copy/select-all actions for
  rendered content.
- Show provider child and subagent sessions beneath their canonical parents,
  with bounded nesting and direct navigation from idle and active session lists.
- Add richer Codex surfaces for edit patches, goals, image views, status and
  usage commands, permission modes, reasoning summaries, and active-turn
  settings.
- Add provider-aware skill invocation, provider subscription-usage reporting,
  and an isolated opt-in Claude Gateway provider.
- Add project-write session sandboxing with authenticated controls and a
  public-network-only outbound boundary where the host supports it.
- Add an experimental multi-host relay monitor, provider process metrics, and
  consented remote browser diagnostics.
- Add authenticated glossary hints and project-path aliases across rendered
  Markdown, file content, and recent-project navigation.

### Changed
- Refresh provider compatibility through Codex CLI 0.151.0, Claude Code
  2.1.251 / Agent SDK 0.3.251, pi 0.84.2, and Grok Build 1.0.4.
- Keep eligible provider runtimes alive across server reloads, coordinate
  provider installation updates through leases, and bound detached or idle
  process lifetimes.
- Make long-session and cached-session navigation substantially faster through
  bounded transcript windows, retained compact DOM, source-versioned caches,
  and single-flight session inventory work.
- Improve rich-content rendering for sanitized embedded HTML, bracketed LaTeX,
  Codex code-mode output, images, rendered documents, and semantic copy.
- Make Source Control, file viewing, activity previews, and composer controls
  more responsive and usable across desktop and narrow mobile layouts.
- Move session and provider discovery toward durable summaries and generation
  vectors instead of repeated full transcript or project scans.

### Fixed
- Preserve active and detached sessions through reconnects, reloads, stale
  pagination cursors, provider reactivation, and mobile wake transitions.
- Prevent killed, archived, or stale provider processes from being resumed or
  from replaying completed work; verify shutdown before unregistering them.
- Repair Codex transcript identity, image rematerialization, live output,
  steering, effort and permission-mode updates, and Windows unread activity.
- Keep file viewers, revisions, selections, review drafts, and dirty diff state
  stable while live session and Source Control data refreshes.
- Restore relay login and cached-page behavior across disconnects, and harden
  public-share transport and storage boundaries.
- Fix mobile IME delivery, adjusted touch targets, gallery navigation, sidebar
  actions, horizontal scrolling, and notification-permission recovery.
- Stabilize provider discovery, worktree watchers, path handling, shell quoting,
  and test behavior across Linux, macOS, and Windows.
- Bound background polling, watchers, cached transcript work, and diagnostic
  collection so idle sessions and closed tabs release server resources.

## [0.7.0] - 2026-07-25

### Added
- Add `!!` bang commands: a composer draft starting with `!!` runs the rest as a
  local shell command in the session's project directory and persists inline as
  a transcript block with exit status, duration, bounded streaming previews, and
  on-demand full output. Includes cancel, raw/rendered toggle, re-run,
  recall-to-composer with shell-style history, echo-to-session, and delete, plus
  Tab completion over PATH, project-relative paths, and global `!!` history. A
  `/bang-commands` page lists runs across sessions with per-entry edit, new, and
  jump actions. Server-enforced, capability-gated, default-off, and excluded
  from public shares.
- Add settings search: a substring filter whose matched rows stay operable in
  place, highlight matched tokens, and link to their named section. Value
  matching ships as an adjacent default-off toggle.
- Add a composer recall drawer: Ctrl+Up opens prefix-matched prior user turns
  with per-row go-to-turn navigation, plus a default-hidden mobile open button.
- Add an opt-in additional model catalog: a server-owned registry of maintained
  and exact-ID model selections, projected into new-session and live-switch
  choosers as a separate group and disabled by default.
- Add a battery-aware host-awake control so a remote host stays reachable
  through macOS `caffeinate` or Windows power requests down to a configured
  battery reserve. Default off; Linux remains unsupported.
- Add server-owned per-host identity markers: an opt-in emoji shown beside
  headers and in browser-tab titles so remote tabs identify their server.
- Add server-backed browser settings backup with Save and Load controls that
  move an allowlisted set of browser-local preferences through one server-stored
  snapshot, omitting credentials, identity, drafts, and cache contents.
- Add a themed tooltip layer with a standard delay, pointer-rest timing, warm
  adjacency scanning, keyboard association, and secondary-click copy/enlarge.
  Browser-native tooltips remain the default and stay selectable.
- Show provider child sessions nested under their canonical parent in the Agents
  page and session lists, covering Claude parent-scoped child transcripts and
  Codex `spawn_agent` child rollouts.
- Add a keyboard-open mobile composer action row with large delivery targets,
  inline Project Queue and Steer slots, and a More panel for the remaining
  toolbar controls.
- Add a Project Queue new-session action behind its own default-off Toolbar
  setting, distinguished from the current-session action by a darker violet and
  a prominent `+` badge, and share Copy, Edit, Steer now, and Cancel across live
  queued rows.

### Changed
- Refresh provider compatibility: Claude Agent SDK 0.3.220 with the Claude Code
  marker at 2.1.220 and Opus 5 on the stable family alias, Codex app-server
  0.145.0, Pi 0.81.1 `agent_settled` turn boundaries (version-gated so 0.79.9
  through 0.80.3 retain `agent_end`), and Grok ACP model discovery with
  question and plan-exit bridging.
- Queue live effort changes until turn completion instead of restarting the
  provider process mid-turn.
- Serve Inbox refresh, resolver-only routes, and heartbeat discovery from
  bounded session summaries rather than full transcript scans.
- Copy rendered Markdown and Σ previews as semantic HTML without presentation
  styles, retaining table structure and MathML, and keep text selections through
  Edit diff expansion.
- Render uniform JSONL and TOON command output as real tables instead of fenced
  JSON blobs.
- Recognize bracketed `\( \)` and `\[ \]` LaTeX delimiters in Σ rendering.
- Refactor transcript projection into a browser-free portable transcript
  compiler with separate cache, semantic-folding, and web-adapter layers, with
  no change to projection output or diagnostics.
- Raise the declared Node runtime floor to 20.12.

### Fixed
- Verify provider shutdown before unregistering a killed agent, escalate Codex
  process groups through SIGKILL, and exempt explicitly killed and archived
  sessions from heartbeat auto-resume so they cannot be resurrected.
- Reset provider retries when switching models so a held retry on the old model
  no longer blocks sends on the replacement.
- Merge provisional session IDs on canonical remap so a just-created session
  cannot appear twice.
- Keep accepted steer messages visible through reconnect, and preserve Codex
  patient queue entries across a server restart.
- Stop relay login from redirecting to an offline host after signing in to a
  different one, and keep cached pages readable after a remote disconnect
  instead of replacing them with a non-dismissible error.
- Title Claude slash-command session openers from the first non-meta user turn
  instead of the provider's local-command caveat.
- Keep touch taps from opening or stranding hover-only tooltips and session
  previews.

## [0.6.2] - 2026-07-11

### Added
- Add bounded active transcript-window trimming to reduce long-session memory
  and rendering cost while preserving search, navigation, and hidden-content
  awareness.
- Render Codex `web.run` browsing and compound exploration output as structured
  transcript tool rows.
- Add Codex user-turn provenance tracking and audit tooling so streamed and
  persisted transcripts resolve user turns consistently.

### Changed
- Normalize Codex code-mode shell/run/wait rows, retries, failures, exit/runtime
  metadata, output previews, and shell auto-expand behavior.
- Improve session freshness, transcript context identity stability, and summary
  cache rebuild behavior to reduce avoidable client churn.
- Choose the newest available Codex CLI during autodetection and enumerate all
  Unix PATH candidates.

### Fixed
- Surface terminal provider turn failures and handle Codex retry/process-failure
  payloads.
- Link shell polls to their command, fold waits into a single row, and hide
  info-free empty polls.
- Fix session info modal scrolling and hide unavailable Codex browser-skill UI.

## [0.6.1] - 2026-07-10

### Added
- Render Codex code-mode command/tool rows through the shared display-action
  pipeline, including compact command details for persisted and streamed
  transcripts.
- Add file-link actions for starting new sessions from referenced files.
- Add an Agents-page kill action for live provider cards.

### Changed
- Refresh Codex CLI/app-server compatibility through 0.144.1, prefer
  GPT-5.6 Sol by default, and add compact Sol/Terra/Luna model glyphs. Upgrade
  claude-agent-sdk and Claude Code compatibility through 0.3.205 / 2.1.205.
- Disable off-screen transcript rendering by default while keeping it
  configurable, and keep compact-history turn tails inside the requested scope.
- Stream thinking outlines incrementally and render Claude local-command rows.
- Improve long-transcript rendering cost, search-preview hover stability, and
  sidebar/session feed rendering by reducing avoidable client updates.

### Fixed
- Fix Codex titles polluted by injected plugin context and hide
  plugin-prefixed startup instructions from visible transcripts.
- Cancel unacted steering sends and clear interrupted pending approvals.
- Unlock notification-type toggles without a reload and scope them under push
  notification settings.
- Keep filtered bulk action selection limited to the filtered session set.
- Skip unconfigured remote-client deploy uploads.

## [0.6.0] - 2026-07-06

### Added
- Project Queue: durable, server-owned project queues for follow-up work that
  should wait until every session in a project is idle. The release includes
  Projects-page management, edit/cancel/retry/move-to-top actions, recovered
  queue visibility, sidebar and inbox badges, optional composer and new-session
  entry points, and Project Queue delivery settings.
- Source Control actions for manual remote checks, safe fast-forward pulls,
  branch pushes/publishing, diverged-branch guidance, recent commits, and a
  wide-screen split diff preview.
- Durable and configurable session recaps, generated session titles,
  fork-after-summary flows, and session hover cards with recent agent context.
- Speech input additions for dedicated relay streaming, browser microphone
  selection, direct xAI batch/streaming STT, local Whisper/Parakeet/NeMo
  backends, warm-mic handoff, Smart Turn controls, and inline cancellable
  transcription chips.
- OpenCode 1.17.9 support for direct database transcript reads, resumable
  `ses_*` sessions, durable thinking/tool rendering, image input, permission
  prompts, graceful interrupts, and reasoning-effort model variants.
- Codex `spawn_agent` subagent rendering, native compaction controls, stopped
  session slash commands, Windows Desktop CLI detection, and richer Codex
  summary/index handling.
- Pi provider live RPC subprocess support and canonical tool rendering.
- Environment settings for startup variables and active listen-address display.
- File access controls (Settings → File access) to scope which local folders
  the HTTP file viewer may read: project folders, uploads, temp, home, and a
  custom list. The same allow-set is now enforced by both the media routes and
  the project-files route. `ALLOWED_FILE_PATHS` (alias for `ALLOWED_IMAGE_PATHS`)
  pins it from the environment.
- Approval audit log settings and audit log rotation.
- Inactivity push notifications for sessions and project queues that need
  attention.

### Changed
- Upgrade claude-agent-sdk to 0.3.199 and refresh Claude Code compatibility
  through 2.1.199.
- Refresh Codex CLI/app-server compatibility through 0.142.4 and report
  `yep-anywhere` as the Codex originator.
- Canonicalize startup environment variables to `YEP_*` names with legacy
  migration for existing settings.
- Move session collection/detail state, inbox/sidebar/project feeds, and remote
  activity streams onto retained/source-runtime-backed stores for faster
  restores and fewer redundant requests.
- Isolate summary parsing in worker threads, stream Claude/Codex summaries, and
  reduce Codex scanner/index memory churn.
- Compress API and public-share API responses with gzip/deflate.
- Capability-gate Project Queue, enhanced Source Control, and hosted remote
  compatibility surfaces so newer hosted clients degrade cleanly against older
  servers.
- Refine toolbar visibility/priority controls, Message Delivery settings,
  immediate settings undo, transcript selection controls, and mobile/narrow
  layouts.
- **Breaking (secure-by-default):** the project-files HTTP route no longer serves
  arbitrary absolute/`~` paths. Relative in-project paths are unchanged, but
  absolute paths outside projects/uploads/temp are denied until the folder is
  added under Settings → File access (or via `ALLOWED_FILE_PATHS`). Enable "Home
  folder" to restore reading under your home directory.
- Windows default temp allow-list now resolves through `os.tmpdir()`
  (`%LOCALAPPDATA%\Temp`) instead of a hardcoded `C:\tmp`.

### Fixed
- Preserve and recover session delivery queues across safe restart, server
  restart, and browser reconnect; avoid bursting queued messages into one
  joined turn; include late-delivered Claude queue entries during incremental
  fetch.
- Stabilize secure reconnect/auth recovery, relay login state, hosted remote
  update notices, reload banner dismissal/restart actions, and safe-reload
  confirmations.
- Fix Codex durable/stream identity alignment, transcript-cache duplicates,
  zstd rollout handling, Windows read normalization, Bash exit-code replay, and
  targeted session-index invalidation.
- Improve Windows project/path identity, URL-style Windows file paths, file
  access bridge tests, and portable server tests.
- Stabilize session scroll restoration, cached return-to-session behavior,
  transcript selection, toolbar overflow, rendered markdown DOM identity, and
  long-session restore/loading progress.
- Fix file viewer/share warnings, image preview behavior, public share status
  retention, uploaded filename normalization, source-control project context,
  and no-output tool rows.
- Close parser workers on server reload and harden disk-full stream handling.

### Security
- File viewer and project-file reads are now scoped by the user-controlled
  allow-list described above.
- Add approval audit log configuration and rotation.
- Serialize secure reconnect recovery to avoid overlapping recovery attempts.
- Keep STT-specific xAI credentials scoped to speech and scrub general
  `XAI_API_KEY` from child agent environments unless explicitly opted in for
  Grok Build.

## [0.5.2] - 2026-06-05

### Added
- Shared file viewer and Markdown media handling across session, public share,
  and remote file links, including line-range views.
- Output appearance controls for fixed-width rendering, typography, and Grep
  preview line counts.
- Session search, explicit thinking controls, and broader localized client UI
  coverage for German, Spanish, French, Japanese, and Chinese.
- OpenCode session recovery from CLI exports and vLLM response rendering.

### Changed
- Move speech options into the microphone menu and share thinking effort controls
  across composer surfaces.
- Tighten transcript, tool-row, sidebar, settings, and mobile spacing and
  typography.
- Default heartbeat turns to continue and bind queued "when done" prompts to
  Ctrl+Enter.
- Document relay protocol grace policy and local CI gating expectations.

### Fixed
- Clear stale relay resume sessions before login.
- Reap idle Claude sessions so closed tabs do not leave provider sessions alive
  indefinitely.
- Fix public share copy, edit previews, file media, and Read links.
- Stabilize thinking transcript rendering and Grep summary previews.
- Improve OpenCode provider session recovery, provider resolution, and session
  reading.

### Security
- Add relay SRP v2-to-v3 grace handling and hosted-client compatibility
  warnings for stronger resume verification.

## [0.5.1] - 2026-06-03

### Added
- Stable tool preview rendering controls, enabled by default for a steadier
  transcript layout.
- Inline media display controls for generated and local media previews.
- Shared local-resource link handling for project-root files and remote/relay
  sessions.

### Changed
- Gate Codex live deltas on active subscriber demand and respect the streaming
  preference for Codex delta rendering.
- Stop persisting per-session permission mode locally.
- Apply collapsed-by-default inline media behavior to images and videos.

### Fixed
- Fix file preview modal scrolling and project-root local file opening.
- Preserve hosted relay paths when opening local-resource links in a new tab.
- Fix relay agent session links and remote project redirect routing.
- Stabilize transcript rendering while appending streamed content.
- Stabilize Codex update prompt checks in CI.
- Use the root package version when locally building npm bundles without CI tag
  metadata.

## [0.5.0] - 2026-06-01

### Added
- Public read-only session sharing with share controls, viewer counts, relay URL
  handling, and origin-aware share gating.
- Server-routed speech input backends, including browser-native, Deepgram,
  local Whisper, and xAI STT options with per-session controls.
- Grok Build ACP provider support, prompt suggestions, session recaps, heartbeat
  turns, Codex `/btw` asides, and provider effort controls.
- Attachment previews, image sizing hints, local media/file previews, generated
  media rendering, and project-local attachment storage.
- Rich transcript rendering for KaTeX math, ANSI SGR output, expandable tool
  rows, transcript follow controls, reverse search, and markdown copy.
- Session UI customization for toolbar buttons, tab title activity, content
  width, sidebar sections, floating session actions, and provider/model labels.
- Remote compatibility notices and Codex CLI update checks in provider settings.

### Changed
- Upgrade claude-agent-sdk to 0.3.158.
- Refresh Codex protocol compatibility through the 0.135.0 CLI target.
- Move the client session lifecycle, replay, and catch-up paths onto more
  explicit stores to reduce stale sidebar and transcript state.
- Reduce streaming, replay, upload, and long-session render churn.
- Update the Biome toolchain and GitHub Actions workflows for current Node
  runtimes.

### Fixed
- Stabilize Codex steering, interrupts, queued messages, reconnect merging,
  session discovery, and long-session refresh behavior.
- Improve mixed-provider session resolution, handoff, cloning, project scoping,
  and provider catalog cache behavior.
- Fix Windows path handling, temp path media links, spawn/reload behavior, and
  local secret ACL checks.
- Fix mobile and narrow-layout issues across the composer, session toolbar,
  sidebar, filters, slash menu, and model selection UI.
- Fix notification, lifecycle, webhook, settings save, and public share status
  edge cases.

### Security
- Harden local file, local image, upload, static asset, and public share path
  containment.
- Add relay origin allowlist enforcement, safer relay admission checks, approval
  audit logging, and unsafe Unicode visibility in approval prompts.

## [0.4.28] - 2026-04-16

### Changed
- Upgrade claude-agent-sdk to 0.2.111 (adds Opus 4.7 support)

## [0.4.27] - 2026-04-16

### Fixed
- Preserve provider on session restarts

## [0.4.26] - 2026-04-13

### Fixed
- Prefer persisted provider for session resume and agents

## [0.4.25] - 2026-04-13

### Added
- Core workspace setup script

### Fixed
- Fix clearing empty server settings
- Keep idle Claude sessions owned while alive
- Fix Codex sessions not appearing in All Sessions on Windows
- Fix Windows spawn ENOENT and EINVAL in scripts
- Fix notification read-state persistence on restart
- Fix Windows project path deduplication

## [0.4.24] - 2026-04-05

### Added
- Lifecycle webhook support
- ToolSearch schema validation
- Claude metadata session entry handling
- Relay host upsert on auto-resume for reliable reconnect

### Changed
- Update claude-agent-sdk to 0.2.90
- Update Claude model selection options
- Move persist-remote-sessions toggle to Remote Access settings
- Align Codex session schema with upstream types

### Fixed
- Avoid new-session remounts on project refresh
- Allow local image access to managed uploads
- Fix relay host ID race condition during session refresh
- Fix modal title overflow on long names

## [0.4.20] - 2026-04-02

### Added
- Local media preview modal for file paths in markdown
- Prefer recent project for new sessions

## [0.4.19] - 2026-03-29

### Added
- Centralized cross-provider session listing
- Session summary caching for Gemini and Codex providers
- Safe HOME guards for dev and test entrypoints

### Fixed
- Fix streaming edit patch filenames
- Improve PTY and Codex PTY tool rendering
- Fix mixed-provider session resolution and titles
- Preserve Claude sibling ordering on reload
- Stabilize session replay and queued prompt rendering
- Detect Codex CLI from desktop app sandbox-bin location

## [0.4.18] - 2026-03-27

### Added
- New session defaults: save preferred provider, model, and permission mode
- Local image viewing for Codex imageView events
- Scoped session indexing for shared providers

### Fixed
- Resolve allowed image paths for macOS /tmp symlink
- Deduplicate sessions on Windows caused by mixed-slash cwds
- Improve provider process handling

## [0.4.17] - 2026-03-22

### Fixed
- Widen tool_result content type for broader SDK compatibility
- Stabilize Claude persisted session rendering
- Guard localStorage calls in i18n module
- Prevent false unread notifications from late JSONL writes
- Exclude progress messages from DAG to prevent dead branches

## [0.4.16] - 2026-03-21

### Added
- Client-side i18n with lazy-loaded locale bundles (English, Chinese, Spanish, French, German, Japanese)
- Language selector in Appearance settings

## [0.4.15] - 2026-03-19

### Fixed
- Pin @biomejs/biome to 1.9.4 to fix CI (pnpm resolved ^1.9.4 to breaking 2.x)

## [0.4.14] - 2026-03-19

### Added
- Provider filtering and voice input toggle via environment variables
- Dynamic model list and Claude profile support
- Age filter and bulk archive for filtered sessions
- Approval panel truncation with view-details modal for large tool calls

### Changed
- Update Claude Agent SDK to 0.2.77

### Fixed
- Prevent NODE_ENV=production from leaking into Claude Code child processes (#41)

## [0.4.13] - 2026-03-15

### Changed
- Update Claude Agent SDK to 0.2.76 with runtime context window detection
- Support SDK 0.2.76+ Agent tool format and subagents directory
- Version-aware device bridge updates
- Restore iOS simulator home button

## [0.4.12] - 2026-03-13

### Added
- iOS simulator device bridge support with HID input
- Improved iOS simulator bridge preflight error messages

### Changed
- Reduce routine update checks

## [0.4.11] - 2026-03-12

### Added
- Relay telemetry and stats dashboard
- Relay server compatibility reporting
- Fetch version and bridge version from update server instead of npm registry/hardcoding

### Fixed
- Fix inbox race condition
- Prevent Enter key from triggering send during IME composition
- Relax relay resume proof skew tolerance

## [0.4.10] - 2026-03-10

### Added
- `/model` slash command for mid-session model switching
- Codex correlation debug logging

### Codex
- Improve replay deduplication
- Preserve timestamps on stream messages
- Improve session reconnect merging

### Fixed
- Fix Codex session titles on agents page
- Fix Codex session cloning in mixed projects
- Fix Codex session clone visibility
- Fix Codex session discovery defaults
- Reduce Codex debug logging overhead

## [0.4.9] - 2026-03-06

### Added
- ModelInfoService for accurate context window lookups
- PDF file previews in Read tool renderer
- Server timestamps to streamed SDK messages for replay dedup
- Stream vs persisted render parity harness
- Slash commands attached to session REST response

### Codex
- Keep pending Bash rows collapsed
- Improve image previews and Bash row summaries
- Normalize tool rendering (heredoc writes, bash, edit patches) across stream and JSONL
- Surface rate limit exhaustion as error messages
- Treat rate-limit updates as telemetry only
- Log Codex messages to sdk-raw

### Fixed
- Filter replayed stream messages using persisted timestamp watermark
- Fix getResultSummary crash for PDF Read results
- Fix live Codex edit patch previews for file changes
- Persist provider to session metadata for correct resume
- Detect claude-ollama sessions from model name in JSONL
- Skip Ollama detection ping when URL is explicitly configured

## [0.4.8] - 2026-03-03

### Added
- Android device bridge with WebRTC streaming and MediaCodec capture
- ChromeOS device transport and streaming with host aliases
- Ollama local model provider with customizable system prompt
- Adaptive bitrate and quality controls for device streaming
- Immersive keyboard mode for Android device input
- On-demand download for device bridge sidecar binary
- CI pipeline for device bridge sidecar binaries
- Emulator streaming E2E tests and validation scripts

### Fixed
- Fix Windows session spawning across all providers
- Fix session resume losing provider for non-Claude models
- Fix crash when tool result content is an array instead of string
- Stabilize Android stream startup and soak reliability
- Fix keyboard input mapping for emulator and Android streams
- Fix WebRTC video stream stalling after a few seconds
- Fix sidecar crash on WebSocket disconnect
- Fix emulator bridge cascading restart loop

### Changed
- Rename Emulator to Devices in sidebar and routes
- Refactor bridge to unified device interface with Android and ChromeOS transports

## [0.4.7] - 2026-03-01

### Added
- Draft badge in session sidebar, list, and inbox

### Fixed
- Fix Codex sessions not appearing due to truncated first-line read (#23)
- Fix duplicate message display when queuing deferred messages
- Fix stale detection killing busy processes and orphaning CLI sessions

## [0.4.6] - 2026-02-27

### Added
- Configurable tab size setting for code and diff display
- Codex scanner diagnostics for troubleshooting session discovery

### Fixed
- Fix Windows session discovery
- Fix Gemini session discovery for newer CLI versions
- Fix Codex/Gemini session discovery when ~/.claude/projects is missing

### Changed
- Update Gemini model list for v0.30.0 CLI
- Optimize Gemini session loading with generalized session index
- Extract shared JSONL/BOM utilities to reduce duplication

## [0.4.5] - 2026-02-25

### Added
- Session cloning support for Codex sessions
- Show session creation date in Session Info panel

### Fixed
- Fix Codex sessions failing with 'minimal' reasoning effort
- Fix broken image paths in README

## [0.4.4] - 2026-02-25

### Added
- 3-way thinking toggle: off / auto / on (model decides when to think in auto mode)

### Fixed
- Fix thinking "on" mode for Opus 4.6+ and wait for CLI exit on abort
- Reconnect session stream after thinking-mode process restart
- Fix context usage percentage being too low after compaction
- Fix DAG not bridging across compaction boundaries with broken logicalParentUuid
- Fix source control page issues

## [0.4.3] - 2026-02-23

### Added
- Source Control page with git working tree status
- File diff viewer: click any file to see syntax-highlighted diff with full context toggle and markdown preview
- Session sharing via Cloudflare Worker + R2

### Fixed
- Fix denied subagent showing spinner instead of error state
- Fix remote client redirect loop on git-status page
- Fix DAG selecting stale pre-compaction branch over post-compaction one

## [0.4.2] - 2026-02-22

### Added
- HTTPS self-signed cert support (`--https-self-signed` flag and `HTTPS_SELF_SIGNED` env var)
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

### Changed
- File logging and SDK message logging default to off (opt-in)
- Replace `LOG_TO_CONSOLE` with `LOG_PRETTY` for clearer semantics

## [0.4.1] - 2026-02-22

### Added
- Session cache with phased optimizations: cached scanner results, batched stats, cached stats endpoint with invalidation
- Cross-process locking and atomic writes for session index files
- Improved pending tool render and settings copy

### Fixed
- Fix localhost websocket auth policy when remote access is enabled
- Fix send racing ahead of in-flight file uploads

## [0.4.0] - 2026-02-22

### Security
- Harden markdown rendering against XSS
- Harden SSH host handling for remote executors
- Harden auth enable flow and add secure recovery path
- Patch vulnerable dependencies (bn.js)
- Enforce 0600 permissions on sensitive data files
- Add SRP handshake rate limiting and timeout guards
- Harden session resume replay defenses for untrusted relays
- Harden relay replay protection for SRP sessions

### Added
- Tauri 2 desktop app scaffold with setup wizard
- Tauri 2 mobile app scaffold with Android support
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Legacy relay protocol compatibility for old servers

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise
- Fix localhost cookie-auth websocket regression
- Fix WebSocket SRP auth-state coupling and regressions
- Fix server crash when spawning sessions with foreign project paths
- Fix streamed Codex Edit patch augmentation parity
- Fix Linux AppImage builds (patchelf corruption, native deps, signing)

### Changed
- Default remote sessions to memory with dev persistence toggle
- Refactor websocket transport into auth, routing, and handler modules
- Improve server update modal copy and layout
- Remove browser control module

## [0.3.2] - 2025-02-18

### Changed
- Update README with current Codex support status (full diffs, approvals, streaming)

## [0.3.1] - 2025-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [0.3.0] - 2025-02-18

### Added
- Codex CLI integration with app-server approvals and protocol workflow
- Codex session launch metadata, originator override, and steering improvements
- Focused session-watch subscriptions for session pages
- Server-side highlighted diff HTML for parsed raw patches
- Browser control module for headless browser automation

### Fixed
- Relay navigation dropping machine name from URL
- Codex Bash error inference for exit code output
- Codex persisted apply_patch diff rendering
- Codex session context and stream reliability

### Changed
- Collapse injected session setup prompts in transcript
- Normalize update_plan and write_stdin tool events
- Improve Codex persisted session rendering parity
- Show Codex provider errors in session UI

## [0.2.9] - 2025-02-15

### Fixed
- `--open` flag now opens the Windows browser when running under WSL

## [0.2.8] - 2025-02-15

### Added
- `--open` CLI flag to open the dashboard in the default browser on startup

## [0.2.7] - 2025-02-13

### Fixed
- Fix relay connect URL dropping username query parameter during redirect

## [0.2.6] - 2025-02-09

### Fixed
- Fix page crash on LAN IPs due to eager tssrp6a loading
- Fall back to any project for new sessions; replace postinstall symlink with import rewriting

## [0.2.5] - 2025-02-09

### Fixed
- Windows support: fix project directory detection for Windows drive-letter encoded paths (e.g. `c--Users-kaa-project`)
- Windows support: fix session index path encoding for backslash separators

## [0.2.4] - 2025-02-09

### Fixed
- Windows support: replace Unix `which` with `where` for CLI detection
- Windows support: accept Windows absolute paths (e.g. `C:\Users\...`) in project validation
- Windows support: fix path traversal guard and project directory encoding for backslash paths
- Windows support: use `os.homedir()` instead of `process.env.HOME` for tilde expansion
- Windows support: fix path separator handling in codex/gemini directory resolution
- Windows support: show PowerShell install command instead of curl/bash

## [0.2.2] - 2025-02-03

### Added
- Relay connection status bar
- Website release process with tag-based deployment

### Fixed
- Sibling tool branches in conversation tree

### Changed
- Simplify Claude, Codex, and Gemini auth to CLI detection only
- Update claude-agent-sdk to 0.2.29

## [0.2.1] - 2025-01-31

### Added
- CLI setup commands for headless auth configuration
- Relay `/online/:username` endpoint for status checks
- Multi-host support for remote access
- Switch host button to sidebar
- WebSocket keepalive ping/pong to RelayClientService
- Host offline modal and tool approval click protection
- Error boundary for graceful error handling
- Terminate option to session menu

### Fixed
- Host picker navigation and relay routes session resumption
- Relay login to set currentHostId before connecting
- DAG branch selection to prefer conversation over progress messages
- Session status event field name and auto-retry on dead process
- Sidebar overlay auto-close logic
- SRP auth hanging on unexpected messages
- Relay reconnection error messages for unreachable server
- Mobile reconnection showing stale session status
- Dual sidebar rendering on viewport resize
- Skip API calls on login page to prevent 401 popups
- Various relay host routing and disconnect handling fixes

### Changed
- Update claude-agent-sdk to 0.2.19
- Rename session status to ownership and clarify agent activity

## [0.1.10] - 2025-01-23

### Fixed
- Handle 401 auth errors in SSE connections
- Fix session stream reconnection on mobile wake
- Fix relay reconnection to actually reconnect WebSocket

### Added
- Connection diagnostics and detailed reconnect logging
- Show event stream connection status in session info modal
