# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `--install-service` / `--uninstall-service` / `--service-status` flags to run
  yepanywhere as a silent background auto-start service at login (Windows
  Scheduled Task, macOS launchd, or Linux systemd user service)

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
