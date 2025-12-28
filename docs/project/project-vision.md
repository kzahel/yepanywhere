# claude-anywhere

## Overview

A mobile-first web interface for supervising Claude Code sessions remotely. Designed to run as a service on a development machine (e.g., Mac Mini) and be accessed from any device, primarily phones.

## Problem Statement

The VS Code Claude extension works well locally but has limitations for remote/mobile workflows:

- Tunnel reconnects break the webview state
- No file upload capability through tunnels
- Session state is tied to the VS Code client, not the server
- No way to queue messages while Claude is working
- No native notifications for approval requests

The official Claude Code CLI is single-session, single-terminal. Multiplexing requires external tools (tmux, multiple terminals).

## Solution

A lightweight web server that:

1. **Owns the agent loop server-side** — Client disconnects don't interrupt Claude's work
2. **Manages multiple projects/sessions** — One interface for all your CWDs
3. **Streams responses in real-time** — Via SSE, not file-watching
4. **Supports message queuing** — Type your next instruction while Claude is still working
5. **Enables mobile supervision** — Approve tool requests from your phone via push notifications

## Core Terminology

| Term | Definition |
|------|------------|
| **Project** | A working directory containing Claude sessions |
| **Session** | A conversation thread (corresponds to a jsonl file) |
| **Process** | A running Claude CLI instance, owned by the supervisor |
| **Supervisor** | The singleton service managing process lifecycles |

## Key Architectural Decisions

### Process Lifecycle

- Processes are spawned on-demand when a session becomes active
- Idle timeout kills processes after N minutes of inactivity
- On next message, process respawns with `--resume sessionId`
- State is in-memory; server restart halts all processes (acceptable)

### Data Flow

```
SDK async iterator ──► SSE ──► Client (real-time)
        │
        └──► jsonl (persistence, handled by SDK)
```

Live sessions stream SDK messages directly to clients. Historical sessions read from jsonl. No file-watcher-as-event-bus pattern.

### Message Queue

- Users can queue messages while Claude is working
- Single in-memory queue per process
- Messages rendered optimistically in UI
- Generator yields from queue when Claude is ready for next turn

### Session Ownership

Sessions have three states:

- **owned** — We spawned this process, full control
- **external** — jsonl is being written by another process (CLI, VS Code), view-only
- **idle** — No active process, safe to resume

UI clearly indicates ownership state to avoid confusion.

### Client Connection

- SSE for server→client streaming (with Last-Event-ID for resume)
- REST for client→server actions (send message, approve, abort)
- Designed for flaky mobile connections with frequent reconnects

## Technology Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Hono (or similar lightweight framework)
- **Client**: React (Vite)
- **Streaming**: SSE with reconnect/resume
- **Claude Integration**: @anthropic-ai/claude-code SDK
- **Testing**: Vitest with deterministic replay mocks

## Non-Goals (for now)

- Multi-machine federation
- Persistent process recovery after server restart
- Custom model selection / slash commands
- Fancy queue management UI (cancel, reorder)

## Success Criteria

From your phone, you can:

1. See all projects and their sessions
2. Start or resume a session
3. Watch Claude work in real-time
4. Queue up follow-on messages
5. Receive push notification when approval needed
6. Approve/deny from the notification or UI
7. Upload files (images, documents) to include in messages
8. Disconnect and reconnect without losing state
