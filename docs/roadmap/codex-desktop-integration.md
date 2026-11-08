# Codex Desktop Deep Integration

Roadmap for improving Codex integration by leveraging the app-server API more fully and optionally connecting directly to Codex Desktop.

## Motivation

We currently use the Codex app-server in a limited way:
- Spawn ephemeral `codex app-server --listen stdio://` subprocesses for model listing (1hr cache)
- Spawn per-session subprocesses for turns
- Scan `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files to discover sessions
- Kill processes to cancel turns

The app-server exposes a much richer API that we're not using. And Codex Desktop runs its own app-server internally — connecting to it directly would give users 2x token usage and eliminate the CLI requirement.

Reference implementations: [Farfield](https://github.com/achimala/farfield) connects to Desktop's IPC socket + app-server. [Codex Pocket](https://github.com/ddevalco/codex-pocket) wraps the CLI app-server with a relay architecture.

## Phase 1: Persistent App-Server Connection

**Goal:** Stop spawning ephemeral processes. One long-lived app-server per Codex provider instance.

Currently we spawn a new `codex app-server` subprocess for:
- Model list queries (`requestAppServerModelList` — spawn, initialize, query, kill)
- Each session's turns (`CodexAppServerClient` — one subprocess per active session)

**Changes:**
- Single persistent app-server subprocess shared across model queries and sessions
- Reconnect on crash with backoff
- Use the existing JSON-RPC protocol, just longer-lived

**Benefit:** Faster model queries, lower overhead, foundation for phases 2-3.

## Phase 2: App-Server APIs for Session Management

**Goal:** Replace filesystem scanning with `thread/list` and use proper thread management APIs.

### `thread/list` for session discovery

Replace `CodexSessionScanner` (recursive JSONL file scanning, reading first line of each file) with a single `thread/list` call.

Status, 2026-11-08: change detection already reads Codex's `state_5.sqlite`
thread index directly, without spawning Codex
([thread-index change hints](../../topics/codex-metadata-scanner.md#thread-index-change-hints));
listing from it is evaluated in
[Codex's native thread index](../research/codex-native-thread-index.md).

API: `thread/list { limit, cursor, archived }` → paginated threads with metadata (id, cwd, title, timestamps, archived status).

**Benefits:**
- No filesystem scanning (currently reads N files per refresh)
- Titles from Desktop included (no separate title generation)
- Archive status synced with Desktop
- Cursor-based pagination

### `thread/archive` / `thread/unarchive`

Sync archive state bidirectionally with Desktop instead of maintaining separate metadata in `session-metadata.json`.

### `turn/interrupt` for clean cancellation

Replace killing the app-server subprocess with `turn/interrupt`. Preserves session state and allows the turn to complete gracefully.

### `thread/fork` for conversation branching

We already have fork for Claude sessions. The app-server exposes `thread/fork` — could light up forking for Codex sessions too.

### Other APIs to evaluate

| Method | Potential use |
|--------|--------------|
| `turn/steer` | Add input to active turns (mid-generation steering) |
| `command/exec` | Terminal/sandbox commands from UI |
| `skills/list` | Surface available Codex skills |
| `review/start` | Code review workflow |

## Phase 3: Codex Desktop Direct Connection

**Goal:** If Codex Desktop is running, connect to it directly instead of spawning our own app-server. Users get 2x token usage and no CLI install required.

### Desktop detection

Farfield discovers Codex Desktop via an IPC socket:
- macOS/Linux: `/tmp/codex-ipc/ipc-{uid}.sock`
- Windows: `\\.\pipe\codex-ipc`
- Override: `CODEX_IPC_SOCKET` env var

If the socket exists → Desktop is running.

Desktop also bundles the codex binary at `/Applications/Codex.app/Contents/Resources/codex`, so no separate CLI install is needed even for fallback.

### Dual-channel architecture (Farfield's approach)

Farfield uses two channels because they serve different purposes:

1. **IPC socket** — live thread streaming and control
   - Binary framing: 4-byte LE length prefix + JSON payload
   - Frame types: request, response, broadcast
   - Used for: `thread-follower-start-turn`, `interrupt-turn`, state change broadcasts (JSON patches)
   - Initialize handshake with `clientType` identifier

2. **App-server subprocess** — metadata queries
   - JSON-RPC over stdio (same as our current approach)
   - Used for: `thread/list`, `thread/read`, `model/list`
   - Spawns Desktop's bundled binary: `/Applications/Codex.app/Contents/Resources/codex app-server`

### Connection priority

```
1. Codex Desktop IPC socket exists? → Connect directly (2x tokens)
2. Codex CLI installed? → Spawn app-server subprocess (current behavior)
3. Neither? → Codex provider unavailable
```

### Transport abstraction

The `CodexAppServerClient` already abstracts JSON-RPC messaging. We'd need:
- New transport for IPC socket (length-prefixed binary framing vs newline-delimited JSON)
- Transport interface: `send(message)`, `onMessage(handler)`, `close()`
- Swap implementation based on detection result

### 2x token benefit

Sessions routed through Codex Desktop use Desktop's auth context, which gets 2x token limits compared to CLI. This is the primary user-facing motivation — the integration is worth it for the token doubling alone.

## Open Questions

- Does Desktop's app-server accept connections from external clients, or only its own Electron UI? (Farfield proves it works, but is it officially supported?)
- Is the IPC socket protocol stable or internal/undocumented?
- Can we use a single channel (IPC socket) for everything, or is the dual-channel split necessary?
- Auth — does the IPC socket require any token/handshake beyond `initialize`?
- How does Desktop handle multiple external clients connecting simultaneously?

## References

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — official API docs
- [Farfield source](https://github.com/achimala/farfield) — `packages/api/src/` has IPC + app-server client implementations
- [Codex Pocket source](https://github.com/ddevalco/codex-pocket) — `services/anchor/src/` has app-server subprocess management
- Local clones: `~/code/reference/codex-community/{farfield,codex-pocket}`
- Current provider: `packages/server/src/sdk/providers/codex.ts`
- Current scanner: `packages/server/src/projects/codex-scanner.ts`
