# Local development

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Setup

Use Node.js `^22.16 || ^23.11 || >=24.10` (a maintained LTS is recommended).
See [server runtimes](../../topics/server-runtime.md) for Bun and remote upgrade guidance.

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm dev
```

Open http://localhost:3400 in your browser.

For everyday use of a source checkout with fewer browser requests, run
`pnpm dev --built-client`. It builds the client once at startup and again on
manual reload, serves cached production chunks, and keeps the source backend
and provider-host reload support. Client edits wait for a successful reload
and browser refresh. Plain `pnpm dev` keeps HMR. See
[built-client lifecycle](../../topics/reload-safe-provider-runtimes.md#built-client-for-everyday-source-checkout-use)
for build failure and asset retention behavior.

For the unpacked Chrome extension, run `pnpm dev --extension` (also works
with `--built-client`), then load `packages/browser-extension/dist-dev` once
from Chrome's **Load unpacked**. The opt-in watcher rebuilds the panel, app,
background worker and manifest together after source changes. It leaves the
release `dist` alone. To watch without a dev server, run
`pnpm --filter @yep-anywhere/browser-extension dev`.

The **Yep Anywhere (Dev)** side panel has a build indicator and update button
at the bottom right. UI-only updates refresh the panel in place; worker or
manifest changes highlight **Reload extension**. That button is also always
available for a manual full reload, even when build detection fails or no
update is detected. Full reload saves and restores the open extension tabs,
their session URLs and window placement. Chrome may close the panel during a full extension reload
and reject automatic reopening without a fresh user
gesture; click the toolbar icon to reopen it. Updates are never applied
automatically. Failed builds retain the last successful output. One watcher
owns each output directory, so use one owner across dev profiles. See the
[development build contract](../../topics/trusted-client-packaging.md#chrome-extension-development-build).

If you only want the main app and do not want to install the relay workspace, use:

```bash
pnpm setup:core
pnpm dev
```

## Commands

```bash
pnpm setup:core       # Install root + client + server + shared, skipping relay
pnpm dev              # Start dev server
pnpm lint             # Biome lint, CSS lint (ESLint), CSS containment checks
pnpm format:check     # Biome formatter verification (does not write)
pnpm format           # Intentionally format all tracked supported files
pnpm typecheck        # TypeScript type checking
pnpm test             # Unit tests for non-Android workspaces
pnpm --filter @yep-anywhere/android test # Android unit tests
pnpm test:e2e         # E2E tests
pnpm references:sync  # Clone/sync upstream source to pinned provider versions
pnpm references:check # Verify local references match pinned provider versions
```

## Port Configuration

All ports are derived from a single `PORT` environment variable (default: 3400):

| Port | Purpose |
|------|---------|
| PORT + 0 | Main server (default: 3400) |
| PORT + 1 | Maintenance server (3401 by convention; only runs when `MAINTENANCE_PORT` is set) |
| PORT + 2 | Vite dev server (default: 3402) |

To run on different ports:
```bash
PORT=4000 pnpm dev  # Uses 4000, 4001, 4002
```

Individual overrides (rarely needed):
- `MAINTENANCE_PORT` - Port for the maintenance server; unset or 0 means it does not run
- `VITE_PORT` - Override vite dev port

## Data Directory

Server state is stored in a data directory (default: `~/.yep-anywhere/`). This includes:
- `logs/` - Server logs
- `indexes/` - Session index cache
- `uploads/` - Uploaded files
- `discovery.sqlite` - Session metadata (custom titles, archive/starred status) and other durable SQLite state
- `notifications.json` - Last-seen timestamps
- `push-subscriptions.json` - Web push subscriptions
- `vapid.json` - VAPID keys for push
- `auth.json` - Authentication state (password hash, sessions)

Follow [Project Directory Storage](../../topics/project-directory-storage.md)
for the app-data default and explicit global opt-in for project-local storage.

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

Server Connections is available without environment configuration. Pair devices
in Settings → Server Connections; no separate enable step is needed. Use
`YEP_PEER_API_ENABLED=false` only to disable all peer routing/pairing (retaining
saved devices); explicit `true` forces it on. Empty or unrecognized supplied
values leave it disabled. The existing owner API's saved
disable setting is respected when the variable is unset. The owner-only
`/api/peers` API requires actual owner proof even when ordinary localhost/UI
authentication is open. Agent use of paired devices defaults on, subject to
existing Agent API launch settings and target grants. See
[peer access](../../topics/peer-access.md) for ceremony, private state,
direct/relay routes and revocation. No relay URL/name is inferred or changed.

The optional provider host keeps supported agent turns and pending approvals
alive across web-server reloads on Linux and macOS Node source checkouts. On
Linux it also preserves project apps and Live preview, including HMR, with
the same process and URL. Apps keep their own enforced project sandbox;
macOS provider hosting does not enable Linux-only process apps. See the
[user guide](../../site/src/content/docs/updating.md#keep-work-running-during-server-reloads)
for benefits and restart boundaries.

Restrict which agent providers and features are available:

```bash
# Only show Claude Code (hide Codex, Gemini, etc.)
ENABLED_PROVIDERS=claude pnpm dev

# Disable voice input (microphone button)
VOICE_INPUT=false pnpm dev

# Opt into reload-safe provider hosting on macOS
YEP_PROVIDER_HOST_ENABLED=true pnpm dev

# Keep provider sessions inside the backend process on any platform
YEP_PROVIDER_HOST_ENABLED=false pnpm dev

# Combined example: Claude-only, no voice, dev profile
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_PROFILE=dev pnpm dev
```

Environment variables:
- `ENABLED_PROVIDERS` - Comma-separated list of provider names to expose (default: all). Valid names: `claude`, `claude-gateway`, `claude-ollama`, `codex`, `codex-oss`, `gemini`, `gemini-acp`, `opencode`, `grok`
- `VOICE_INPUT` - Set to `false` to disable the voice input button server-side (default: `true`)
- `YEP_PROVIDER_HOST_ENABLED` - Set to `true` or `false` to control shared
  provider hosting. It defaults to `false` on macOS and `true` on Linux.
  macOS remains opt-in while the
  [active-turn interruption issue](../../gaps/macos-provider-host-turn-interruptions.md)
  is investigated.
  Disabled sessions use ordinary in-backend provider ownership and are not
  reported as a degraded host. The setting takes effect on the next full dev
  wrapper restart and does not change the default manual-only backend reload
  behavior of `pnpm dev`.
