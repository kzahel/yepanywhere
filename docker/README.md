# Sandboxed Yep-Anywhere

Run yep-anywhere + Claude in a container for filesystem/privilege isolation.

## Quick Start

```bash
# Build the image
docker compose -f docker/docker-compose.yml build

# First time: install dependencies
docker compose -f docker/docker-compose.yml run --rm yep-sandbox pnpm install

# Run (sandboxed, full network)
docker compose -f docker/docker-compose.yml up
```

Access at http://localhost:3600

## Profiles

### Sandboxed (default)
Full network access, restricted filesystem/privileges:
```bash
docker compose -f docker/docker-compose.yml up
```

### Isolated
Localhost-only network - can serve the web UI but cannot reach the internet:
```bash
docker compose -f docker/docker-compose.yml --profile isolated up yep-isolated
```

The isolated profile uses Docker's `internal: true` network which blocks all outbound traffic. The container can still accept inbound connections on the forwarded ports, so the web UI works normally.

Note: In isolated mode, Claude cannot fetch URLs, clone repos, or install packages from the internet. Use sandboxed mode for initial setup, then switch to isolated for paranoid sessions.

## What's Mounted

| Host Path | Container Path | Mode |
|-----------|----------------|------|
| `~/code` (or `$CODE_DIR`) | `/home/sandbox/code` | read-write |
| `~/.claude` | `/home/sandbox/.claude` | read-write |
| `~/.yep-anywhere` | `/home/sandbox/.yep-anywhere` | read-write |
| `~/.gitconfig` | `/home/sandbox/.gitconfig` | read-only |
| `~/.ssh` | `/home/sandbox/.ssh` | read-only |

## Security Restrictions

- Runs as non-root user (your UID/GID)
- `--cap-drop=ALL` - No special Linux capabilities
- `no-new-privileges` - Can't escalate privileges
- Can only write to explicitly mounted paths
- No access to Docker socket, host system dirs, etc.

## Customization

Override defaults with environment variables:

```bash
# Use different UID/GID
USER_UID=1001 USER_GID=1001 docker compose -f docker/docker-compose.yml up

# Different code directory
CODE_DIR=/path/to/projects docker compose -f docker/docker-compose.yml up

# Different port
PORT=4000 docker compose -f docker/docker-compose.yml up
```

## Development

To get a shell instead of starting the server:
```bash
docker compose -f docker/docker-compose.yml run --rm yep-sandbox bash
```

To rebuild after Dockerfile changes:
```bash
docker compose -f docker/docker-compose.yml build --no-cache
```
