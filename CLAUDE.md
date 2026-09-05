# Yep Anywhere

For cross-project context (how this project relates to other Kyle projects), see `~/code/dotfiles/projects/README.md`.

For dev/contributor guidance (setup, commands, style, contribution ethos), see [DEVELOPMENT.md](DEVELOPMENT.md).

For current product priorities and initiative blockers, start at the
[Roadmap](docs/roadmap/README.md). It is the canonical priority overview;
implementation plans and behavior contracts remain in their linked documents.

A mobile-first supervisor for Claude Code agents. Like the VS Code Claude extension, but designed for phones and multi-session workflows.

**Key ideas:**
- **Server-owned processes** — Claude runs on your dev machine; client disconnects don't interrupt work
- **Multi-session dashboard** — See all projects at a glance, no window cycling
- **Mobile supervision** — Push notifications for approvals, respond from your lock screen
- **Self-contained core** — The server/web app needs no hosted account or
  Firebase dependency; the optional published native app uses its separate
  hosted push broker for platform notifications

**Architecture:** Hono server manages Claude SDK processes. React client connects via WebSocket for real-time streaming. Sessions persist to jsonl files (handled by SDK).

For UI rendering-boundary and shared-view decisions, see
[`topics/ui-architecture.md`](topics/ui-architecture.md).

**Remote access:** Two connection modes:
- **Direct (Tailscale/LAN)** — Client connects to server WebSocket directly
- **Relay** — Client connects through a relay server (`packages/relay/`). SRP (Secure Remote Password) authenticates without exposing the password to the relay. All messages are end-to-end encrypted with NaCl (XSalsa20-Poly1305) so the relay sees only opaque ciphertext.

For detailed overview, see `docs/project/`. Historical vision docs in `docs/archive/`.

## Client/Server Backwards Compatibility

Before making the client depend on a server route, response field, event, or
changed semantic that a supported stable release lacks, read
[`topics/server-capabilities.md`](topics/server-capabilities.md) and
[`topics/remote-hosted-compatibility.md`](topics/remote-hosted-compatibility.md).
Inspect at least the latest two stable releases plus every stable release from
the preceding 14 days for an optional feature or 60 days for core
functionality.

Before implementation, present the maintainer with the release corpus, new
contract, capability/protocol gate, exact missing-gate fallback, and any change
to an existing capability meaning or older capable behavior. Wait for approval
unless the originating request already approved all of those decisions. Never
retroactively broaden an advertised capability, and never call a new endpoint
before its gate is known present. A support horizon expiring permits review; it
does not automatically remove compatibility.

Use this prompt shape:

> Compatibility review for `<feature>`: releases `<corpus>` lack
> `<routes/fields/events>`. I propose `<capability/protocol>`; without it the
> client `<fallback>` and makes no unsupported requests. Existing capability
> meanings and older capable behavior remain unchanged. Approve?

## Port Configuration

All ports are derived from a single `PORT` environment variable (default: 3400):

| Port | Purpose |
|------|---------|
| PORT + 0 | Main server (default: 3400) |
| PORT + 1 | Maintenance server (default: 3401) |
| PORT + 2 | Vite dev server (default: 3402) |

To run on different ports:
```bash
PORT=4000 pnpm dev  # Uses 4000, 4001, 4002
```

Individual overrides (rarely needed):
- `MAINTENANCE_PORT` - Override maintenance port (set to 0 to disable)
- `VITE_PORT` - Override vite dev port

## Data Directory & Profiles

Server state is stored in a data directory (default: `~/.yep-anywhere/`). This includes:
- `logs/` - Server logs
- `indexes/` - Session index cache
- `uploads/` - Uploaded files
- `session-metadata.json` - Custom titles, archive/starred status
- `notifications.json` - Last-seen timestamps
- `push-subscriptions.json` - Web push subscriptions
- `vapid.json` - VAPID keys for push
- `auth.json` - Authentication state (password hash, sessions)

YA-managed state belongs in this data directory by default. Project-local
storage is an explicit global opt-in; merely opening, rendering, indexing, or
replaying a project must not create hidden files or change its Git metadata.
See [`topics/project-directory-storage.md`](topics/project-directory-storage.md).

### Running Multiple Instances

Use profiles to run dev and production instances simultaneously (like Chrome profiles):

```bash
# Production (default profile, port 3400)
PORT=3400 pnpm start

# Development (dev profile, port 4000)
PORT=4000 YEP_PROFILE=dev pnpm dev
```

This creates separate data directories:
- Production: `~/.yep-anywhere/`
- Development: `~/.yep-anywhere-dev/`

Environment variables:
- `YEP_PROFILE` - Profile name suffix (creates `~/.yep-anywhere-{profile}/`)
- `YEP_DATA_DIR` - Full path override for data directory
- `CLAUDE_CONFIG_DIR` - Claude Code config directory (default: `~/.claude`). Use this to point at a Claude Code profile (e.g., `~/.claude-work`). Sessions are scanned from `{CLAUDE_CONFIG_DIR}/projects/`.

Note: By default, all instances share `~/.claude/projects/` (SDK-managed sessions). Set `CLAUDE_CONFIG_DIR` to use a different Claude Code profile per instance.

## Provider & Feature Configuration

Restrict which agent providers and features are available:

```bash
# Only show Claude Code (hide Codex, Gemini, etc.)
ENABLED_PROVIDERS=claude pnpm dev

# Disable voice input (microphone button)
VOICE_INPUT=false pnpm dev

# Combined example: Claude-only, no voice, dev profile
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_PROFILE=dev pnpm dev
```

Environment variables:
- `ENABLED_PROVIDERS` - Comma-separated list of provider names to expose (default: all). Valid names: `claude`, `claude-gateway`, `claude-ollama`, `codex`, `codex-oss`, `gemini`, `gemini-acp`, `opencode`, `grok`
- `VOICE_INPUT` - Set to `false` to disable the voice input button server-side (default: `true`)

## Device Control Testing

Use the Android emulator only when testing the device-control/device-bridge feature. Check with `source ~/.profile && adb devices` and deploy/test on the emulator for changes that touch device streaming, `/api/devices`, `deviceBridge`, or `packages/device-bridge`. For general client, server, web UI, provider, relay, or rendering changes, do not require emulator testing.

## Browser Control (UI Testing)

Use an available browser-control capability for interactive web UI testing. If
browser setup or discovery reports that no browser is available, or the browser
inventory is empty, do not stop or keep retrying a desktop-only backend.
Immediately fall back to YA's installed Playwright dependency.

For a one-shot screenshot of the live local server:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ARTIFACT_DIR="$REPO_ROOT/.artifacts/ui-testing"
mkdir -p "$ARTIFACT_DIR"
pnpm --filter @yep-anywhere/client exec playwright screenshot \
  --ignore-https-errors \
  --block-service-workers \
  --wait-for-timeout 500 \
  --viewport-size "1000,600" \
  https://localhost:3400/ \
  "$ARTIFACT_DIR/ya-desktop.png"
```

Use `--viewport-size "375,812"` for a mobile-width capture. For multi-step
interaction testing, add or run a focused `@playwright/test` case under
`packages/client/e2e/`. A missing in-app browser backend is not a blocker while
the repository Playwright command is available. Default capture-confirmation
requirements for UI tweak requests (final result at 1000×600 + phone width,
inspected sequentially one image at a time before claiming completion), including
visual-review exception, are in `topics/ui-testing.md`.

## ChromeOS Debugging

For Chromebook testing and debugging (screenshots, input, diagnostics), use the chromeos-testbed CLI — NOT the browser control skill (which is for local headless Chromium).

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # saves screenshot, prints path
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # saves to output.png
~/code/chromeos-testbed/bin/chromeos help                    # full command list
```

Requires SSH access to `chromeroot`. See `~/code/chromeos-testbed/CLAUDE.md` for details.

## After Editing Code

After editing TypeScript or other source files, verify your changes compile and pass checks:

```bash
pnpm lint          # Biome linter
pnpm format:check  # Biome formatter verification (does not write)
pnpm typecheck     # TypeScript type checking (fast, no emit)
pnpm test          # Unit tests for non-Android workspaces
pnpm test:e2e      # E2E tests (if UI changes)
```

For site changes (marketing pages in `site/`):
```bash
cd site && npm run build   # Astro check + build (or: pnpm site:build from root)
```

Fix any errors before considering the task complete.

## Dependency Security Maintenance

CI runs `pnpm audit --prod` on every push (the `audit` job in `ci.yml`) and it
must exit 0. Pay special attention to the `web-push -> asn1.js -> bn.js` chain.
Keep `bn.js` patched (currently via pnpm override) until `web-push` ships an
upstream fix.

When a transitive dep has no direct upgrade path, prefer a pnpm override. Pin it
exactly if a newer major would escape the parent's declared range — `fast-uri`
is pinned to `3.1.6` rather than `^3.1.6` because 4.x is published and `ajv`
declares `^3.0.1`. When the parent's declared range already contains the patched
version, no override is needed: refresh the lockfile with
`pnpm -r update <pkg> --depth=Infinity` (plain `pnpm update` skips transitive
deps).

### Install-script allowlist

Dependency install scripts (preinstall/install/postinstall) are blocked by
default via `onlyBuiltDependencies` in `pnpm-workspace.yaml`; only
`bcrypt` and `better-sqlite3` (native node-gyp/prebuild builds) may run
theirs. This neutralizes the `"preinstall": "node setup.mjs"` vector used
by npm supply-chain attacks. If a newly added dep needs its build script,
`pnpm install` warns `build scripts that were ignored: <pkg>` and the
package will be missing its native binary at runtime — vet the script,
then add the package name to the allowlist. Blocked today, each verified
a no-op with no performance fallback: `esbuild` (native binary ships via
`@esbuild/*` optional deps; the postinstall only swaps the bin shim, and
there is no silent WASM fallback), `@firebase/util` (bakes
`FIREBASE_WEBAPP_CONFIG` into web-SDK defaults; unset here), `protobufjs`
(prints a version-scheme warning).

### Known-unreachable advisories

Advisories triaged as unreachable are suppressed via
`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`; that list and this
table must stay in sync — every ignored GHSA needs a row here, and removing a
row means removing the ignore. As of 2026-09-02 four advisories are triaged as
unreachable with no fix compatible with YA's current dependency and runtime
constraints. Re-check when the listed trigger fires rather than re-deriving the
analysis:

| Advisory | Why unreachable | Revisit when |
|---|---|---|
| `react-router` RSC-mode CSRF (GHSA-qwww-vcr4-c8h2) | Client is SPA-only — `BrowserRouter`/`Routes`, no `createBrowserRouter`, RSC, or server actions | Migrating to react-router v8. The fix lands in 8.3.0 and `react-router-dom` never reaches it (v8 consolidated into `react-router`) |
| `@hono/node-server` serve-static traversal (GHSA-frvp-7c67-39w9) | `serveStatic` is never imported; only `serve`, `getRequestListener`, `HttpBindings`, `RESPONSE_ALREADY_SENT` | `@hono/node-ws` supports node-server 2.x — its peer is currently `^1.19.11`, so 2.x breaks the WebSocket path |
| `uuid` buffer bounds (GHSA-w5hq-g745-h8pq) | Only path is `firebase-admin -> @google-cloud/storage -> gaxios@6`, which calls `uuid.v4()` with no arguments; the defect needs v3/v5/v6 with a caller-supplied `buf`. Patched only in `>=11.1.1`, outside gaxios 6's `^9` range | `firebase-admin`/`gaxios` declare uuid `>=11`, or a 9.x patch release appears |
| `sanitize-html` SVG SMIL URL-list XSS (GHSA-g8qq-57p8-ggw5) | The exploit needs allowed SVG `animate`/`set` markup targeting a link; YA allows neither those tags nor their attributes, and escapes disallowed embedded HTML | YA supports Node `>=22.12` and can take `sanitize-html` 2.17.7, a Node 20-compatible patch appears, or YA begins allowing SVG animation markup |

Anything not on this list is untriaged — treat a new advisory as actionable.

## Git Commits

Never mention Claude, AI, or any AI assistant in commit messages. Write commit messages as if a human developer wrote them.

## Releasing to npm

The package is published to npm as `yepanywhere` using GitHub Actions with OIDC trusted publishing (no npm tokens stored in secrets).

**Before releasing:**

1. Update `CHANGELOG.md` with a new version section:
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. Commit the changelog update

3. Tag and push:
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

The CI workflow verifies the changelog contains an entry for the version being released. If missing, the release will fail with instructions to update the changelog.

The workflow runs lint, typecheck, and tests, then builds with `pnpm build:bundle` and publishes with `--provenance` for supply chain attestation. It also creates a GitHub Release with auto-generated notes.

## Releasing the Website

The website (landing pages + remote relay client at `/remote`) is deployed to GitHub Pages separately from npm. **Pushing to main does NOT deploy the site** — it only runs CI (lint, typecheck, tests). The site only deploys when a `site-v*` tag is pushed (or via manual workflow_dispatch).

See `site/RELEASING.md` for the full process.

Quick reference:
```bash
# Update site/CHANGELOG.md first, then:
scripts/release-website.sh 1.5.3
```

## Deploying to Staging

The staging deploy runbook is host-specific and intentionally kept out of this public
repo. It lives in the private dotfiles repo: `~/code/dotfiles/machines/pi/README.md`. If
asked to deploy to staging, read the steps there.

## Server Logs

Server logs are written to `{dataDir}/logs/` (default: `~/.yep-anywhere/logs/`):

- `server.log` - Main server log (dev mode with `pnpm dev`)
- `e2e-server.log` - Server log during E2E tests

To view logs in real-time: `tail -f ~/.yep-anywhere/logs/server.log`

All `console.log/error/warn` output is captured. Logs are JSON format in the file but pretty-printed to console.

Environment variables:
- `LOG_DIR` - Custom log directory
- `LOG_FILE` - Custom log filename (default: server.log)
- `LOG_LEVEL` - Minimum level: fatal, error, warn, info, debug, trace (default: info)
- `LOG_FILE_LEVEL` - Separate level for file logging (default: same as LOG_LEVEL)
- `LOG_TO_FILE` - Set to "true" to enable file logging (default: off)
- `LOG_PRETTY` - Set to "false" to disable pretty console logs (default: on)

## Client Console Logs

Remote collection of browser `console.log/warn/error` from mobile clients. Useful for debugging connection issues on devices where you can't open DevTools.

**Enable:** Developer Mode settings → "Remote Log Collection" toggle.

**Storage:** `{dataDir}/logs/client-logs/` (default: `~/.yep-anywhere/logs/client-logs/`). One JSONL file per device per day, named `client-{YYYY-MM-DD}-{deviceId}.jsonl`. The device UUID is persisted in the client's `localStorage`.

Each line is a single log event:
```json
{"timestamp":1770790157738,"level":"log","prefix":"[SecureConnection]","message":"[SecureConnection] Closed: 1006","_receivedAt":1770790161477}
```

A `[ClientInfo]` entry is written on each session start with user agent, screen size, DPR, and language.

```bash
# List device log files
ls ~/.yep-anywhere/logs/client-logs/

# View today's logs for a device
cat ~/.yep-anywhere/logs/client-logs/client-$(date +%Y-%m-%d)-<deviceId>.jsonl

# Follow incoming logs
tail -f ~/.yep-anywhere/logs/client-logs/*.jsonl
```

**Implementation:** `packages/client/src/lib/diagnostics/ClientLogCollector.ts` (client), `packages/server/src/routes/client-logs.ts` (server `POST /api/client-logs`).

## Maintenance Server

A separate lightweight HTTP server runs on PORT + 1 (default 3401) for out-of-band diagnostics. Useful when the main server is unresponsive.

```bash
# Check server status
curl http://localhost:3401/status

# Enable proxy debug logging at runtime
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'

# Change log levels at runtime
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'

# Enable Chrome DevTools inspector
curl -X POST http://localhost:3401/inspector/open
# Then open chrome://inspect in Chrome

# Trigger server restart
curl -X POST http://localhost:3401/reload
```

Available endpoints:
- `GET /health` - Health check
- `GET /status` - Memory, uptime, connections
- `GET|PUT /log/level` - Get/set log levels
- `GET|PUT /proxy/debug` - Get/set proxy debug logging
- `GET /inspector` - Inspector status
- `POST /inspector/open` - Enable Chrome DevTools
- `POST /inspector/close` - Disable Chrome DevTools
- `POST /reload` - Restart server

Environment variables:
- `MAINTENANCE_PORT` - Port for maintenance server (default: PORT + 1, set to 0 to disable)
- `PROXY_DEBUG` - Enable proxy debug logging at startup (default: false)

## Validating Session Data

Validate JSONL session files against Zod schemas:

```bash
# Validate all sessions in ~/.claude/projects
npx tsx scripts/validate-jsonl.ts

# Validate a specific file or directory
npx tsx scripts/validate-jsonl.ts /path/to/session.jsonl
```

Run this after schema changes to verify compatibility with existing session data.

## Validating Tool Results

Validate `tool_use_result` fields from SDK raw logs against ToolResultSchemas:

```bash
# Validate sdk-raw.jsonl (default location)
npx tsx scripts/validate-tool-results.ts

# Summary only (no error details)
npx tsx scripts/validate-tool-results.ts --summary

# Filter by tool name
npx tsx scripts/validate-tool-results.ts --tool=Edit
```

The SDK provides structured `tool_use_result` objects alongside tool results. These are logged to `~/.yep-anywhere/logs/sdk-raw.jsonl` when `LOG_SDK_MESSAGES=true` is set. Run this script after adding new tool schemas or when debugging tool result parsing.

## Type System

Types are defined in `packages/shared/src/claude-sdk-schema/` (Zod schemas as source of truth).

Key patterns:
- **Message identification**: Use `getMessageId(m)` helper which returns `uuid ?? id`
- **Content access**: Prefer `message.content` over top-level `content`
- **Type discrimination**: Use `type` field (user/assistant/system/summary)
