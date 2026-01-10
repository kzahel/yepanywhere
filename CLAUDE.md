# Yep Anywhere

A mobile-first supervisor for Claude Code agents. Like the VS Code Claude extension, but designed for phones and multi-session workflows.

**Key ideas:**
- **Server-owned processes** — Claude runs on your dev machine; client disconnects don't interrupt work
- **Multi-session dashboard** — See all projects at a glance, no window cycling
- **Mobile supervision** — Push notifications for approvals, respond from your lock screen
- **Zero external dependencies** — No Firebase, no accounts, just Tailscale for network access

**Architecture:** Hono server manages Claude SDK processes. React client connects via SSE for real-time streaming. Sessions persist to jsonl files (handled by SDK).

For detailed overview, see `docs/project/`. Historical vision docs in `docs/archive/`.

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

### Running Multiple Instances

Use profiles to run dev and production instances simultaneously (like Chrome profiles):

```bash
# Production (default profile, port 3400)
PORT=3400 pnpm start

# Development (dev profile, port 4000)
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

This creates separate data directories:
- Production: `~/.yep-anywhere/`
- Development: `~/.yep-anywhere-dev/`

Environment variables:
- `YEP_ANYWHERE_PROFILE` - Profile name suffix (creates `~/.yep-anywhere-{profile}/`)
- `YEP_ANYWHERE_DATA_DIR` - Full path override for data directory

Note: Both instances share `~/.claude/projects/` (SDK-managed sessions).

## After Editing Code

After editing TypeScript or other source files, verify your changes compile and pass checks:

```bash
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript type checking (fast, no emit)
pnpm test       # Unit tests
pnpm test:e2e   # E2E tests (if UI changes)
```

Fix any errors before considering the task complete.

## Git Commits

Never mention Claude, AI, or any AI assistant in commit messages. Write commit messages as if a human developer wrote them.

## Releasing to npm

The package is published to npm as `yepanywhere` using GitHub Actions with OIDC trusted publishing (no npm tokens stored in secrets). Pushing a version tag triggers the release.

```bash
git tag v0.1.10
git push origin v0.1.10
```

The workflow (`.github/workflows/publish.yml`) runs lint, typecheck, and tests, then builds with `pnpm build:bundle` and publishes with `--provenance` for supply chain attestation. It also creates a GitHub Release with auto-generated notes.

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
- `LOG_TO_FILE` - Set to "false" to disable file logging
- `LOG_TO_CONSOLE` - Set to "false" to disable console logging

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

The SDK provides structured `tool_use_result` objects alongside tool results. These are logged to `~/.yep-anywhere/logs/sdk-raw.jsonl` when `LOG_SDK_MESSAGES=true` (default). Run this script after adding new tool schemas or when debugging tool result parsing.

## Type System

Types are defined in `packages/shared/src/claude-sdk-schema/` (Zod schemas as source of truth).

Key patterns:
- **Message identification**: Use `getMessageId(m)` helper which returns `uuid ?? id`
- **Content access**: Prefer `message.content` over top-level `content`
- **Type discrimination**: Use `type` field (user/assistant/system/summary)

## Task Tracking with Beads (bd)

This project uses [Beads](https://github.com/steveyegge/beads) for cross-session task tracking. Beads is a git-backed issue tracker designed for AI agents, solving the "50 First Dates" problem of session continuity.

**When to use beads:**
- Track bugs, features, and tasks that span multiple sessions
- Create dependency trees for complex work
- File issues discovered during implementation for later follow-up

**Essential commands:**

```bash
bd ready              # Show tasks with no blockers (what to work on next)
bd list               # List all open issues
bd create "Title"     # Create a new issue
bd show <id>          # View issue details
bd close <id>         # Close a completed issue
bd dep add <a> <b>    # Make issue <a> depend on <b>
bd sync               # Sync database to JSONL (run before commits)
```

**Workflow:**
1. At session start: Run `bd ready` to see available tasks
2. During work: Use `bd create` to file discovered issues
3. Before committing: Run `bd sync` to persist changes
4. At session end: Follow the "landing the plane" workflow in AGENTS.md

Issues are stored in `.beads/` and version-controlled with git. IDs look like `yepanywhere-a3f2` (project prefix + hash).
