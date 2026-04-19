# Development

## Setup

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm dev
```

Open http://localhost:3400 in your browser.

If you only want the main app and do not want to install the relay workspace, use:

```bash
pnpm setup:core
pnpm dev
```

If this repo lives on an `exFAT` volume, the default pnpm workspace linker will
break because `exFAT` does not support the junction/reparse-point layout pnpm
expects. In that case, use the repo-local recovery/bootstrap command instead:

```bash
pnpm setup:exfat
```

That command:

- backs up the current `node_modules` tree to a sibling `_install-backups` folder
- installs dependencies with an `exFAT`-compatible pnpm layout
- materializes local `workspace:*` packages into each package's `node_modules`
- rebuilds the core workspaces (`shared`, `client`, `server`, `relay`)

## Commands

```bash
pnpm setup:core # Install root + client + server + shared, skipping relay
pnpm setup:exfat # Recover/install on exFAT and rebuild core workspaces
pnpm dev        # Start dev server
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript type checking
pnpm test       # Unit tests
pnpm test:e2e   # E2E tests
```

## Port Configuration

Ports are derived from a single `PORT` variable (default: 3400):

| Port | Purpose |
|------|---------|
| PORT + 0 | Main server |
| PORT + 1 | Maintenance server |
| PORT + 2 | Vite dev server |

```bash
PORT=4000 pnpm dev  # Uses 4000, 4001, 4002
```

## Data Directory

Server state is stored in `~/.yep-anywhere/` by default:

- `logs/` — Server logs
- `indexes/` — Session index cache
- `uploads/` — Uploaded files
- `session-metadata.json` — Custom titles, archive/starred status

### Running Multiple Instances

Use profiles to run dev and production instances simultaneously:

```bash
# Production (default profile, port 3400)
PORT=3400 pnpm start

# Development (dev profile, port 4000)
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

Environment variables:
- `YEP_ANYWHERE_PROFILE` — Profile name suffix (creates `~/.yep-anywhere-{profile}/`)
- `YEP_ANYWHERE_DATA_DIR` — Full path override for data directory

## Server Logs

Logs are written to `{dataDir}/logs/server.log`. View in real-time:

```bash
tail -f ~/.yep-anywhere/logs/server.log
```

Environment variables:
- `LOG_LEVEL` — Minimum level: fatal, error, warn, info, debug, trace (default: info)
- `LOG_TO_FILE` — Set to "true" to enable file logging (default: off)
- `LOG_PRETTY` — Set to "false" to disable pretty console logs (default: on)

## Maintenance Server

A lightweight HTTP server runs on PORT + 1 for diagnostics when the main server is unresponsive:

```bash
curl http://localhost:3401/status          # Server status
curl -X POST http://localhost:3401/reload  # Restart server
```
