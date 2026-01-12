# Relay Server Implementation Plan

## Overview

A relay server that enables phone clients to connect to yepanywhere servers behind NAT. The relay is a "dumb pipe" that matches clients to servers and forwards encrypted messages without inspection.

## Architecture

```
Yepanywhere Server                     Relay                          Phone
      |                                  |                               |
      |-- WS (waiting) ---------------->| <- stored in waiting map      |
      |                                  |                               |
      |   [phone connects, claims it]    |                               |
      |                                  |<------------------------------ |
      |-- WS (pipe to phone 1) -------->|<=============================>|
      |-- WS (waiting) ---------------->| <- new waiting (auto-opened)  |
      |                                  |                               |
      |   [another phone connects]       |                               |
      |                                  |                         Phone 2
      |-- WS (pipe to phone 1) -------->|<============================> Phone 1
      |-- WS (pipe to phone 2) -------->|<============================> Phone 2
      |-- WS (waiting) ---------------->| <- always one waiting         |
```

- Each phone gets a dedicated server connection (no multiplexing)
- When a waiting connection is claimed, yepanywhere immediately opens a new one
- Relay maintains exactly one waiting connection per username
- Relay is a dumb pipe - E2E encryption happens between phone and yepanywhere

## Protocol

```typescript
// Server -> Relay (on connect)
{ type: "server_register", username: string, installId: string }

// Relay -> Server
{ type: "server_registered" }
{ type: "server_rejected", reason: "username_taken" | "invalid_username" }

// Phone -> Relay (on connect)
{ type: "client_connect", username: string }

// Relay -> Phone
{ type: "client_connected" }
{ type: "client_error", reason: "server_offline" | "unknown_username" }

// After pairing: pure passthrough (relay doesn't inspect messages)
// Server detects claim implicitly when first message arrives (SRP init from phone)
```

## Implementation Phases

### Phase 1: Shared Types

**File: `packages/shared/src/relay-protocol.ts`** (new)

```typescript
// Server registration
export interface RelayServerRegister {
  type: "server_register";
  username: string;
  installId: string;
}

export interface RelayServerRegistered {
  type: "server_registered";
}

export interface RelayServerRejected {
  type: "server_rejected";
  reason: "username_taken" | "invalid_username";
}

// Client connection
export interface RelayClientConnect {
  type: "client_connect";
  username: string;
}

export interface RelayClientConnected {
  type: "client_connected";
}

export interface RelayClientError {
  type: "client_error";
  reason: "server_offline" | "unknown_username";
}

// Union types
export type RelayServerMessage = RelayServerRegister;
export type RelayServerResponse = RelayServerRegistered | RelayServerRejected;
export type RelayClientMessage = RelayClientConnect;
export type RelayClientResponse = RelayClientConnected | RelayClientError;

// Type guards
export function isServerRegister(msg: unknown): msg is RelayServerRegister { ... }
export function isClientConnect(msg: unknown): msg is RelayClientConnect { ... }

// Username validation
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}
```

**File: `packages/shared/src/index.ts`** - Export new types

**Tests:** `packages/shared/test/relay-protocol.test.ts`
- Type guard correctness
- Username validation (valid cases, edge cases, invalid cases)

---

### Phase 2: Relay Package

**Directory: `packages/relay/`**

```
packages/relay/
├── package.json          # depends on hono, better-sqlite3, @yep-anywhere/shared
├── tsconfig.json
├── src/
│   ├── index.ts          # Hono server entry
│   ├── config.ts         # Environment config (PORT, DATA_DIR)
│   ├── db.ts             # SQLite database setup
│   ├── registry.ts       # UsernameRegistry - SQLite persistence
│   ├── connections.ts    # ConnectionManager - matching & forwarding
│   └── ws-handler.ts     # WebSocket route handler
└── test/
    ├── registry.test.ts
    └── connections.test.ts
```

**Database** (`db.ts`):
```typescript
import Database from "better-sqlite3";

// Schema
// CREATE TABLE usernames (
//   username TEXT PRIMARY KEY,
//   install_id TEXT NOT NULL,
//   registered_at TEXT NOT NULL,
//   last_seen_at TEXT NOT NULL
// );

export function createDb(dataDir: string): Database.Database { ... }
```

**UsernameRegistry** (`registry.ts`):
- `canRegister(username, installId)` - returns true if available or owned by this installId
- `register(username, installId)` - claim username, update last_seen_at
- `updateLastSeen(username)` - touch timestamp on activity
- `reclaimInactive(days: number)` - delete rows where last_seen_at > N days ago

**ConnectionManager** (`connections.ts`):
```typescript
class ConnectionManager {
  private waiting = new Map<string, WebSocket>();  // username -> waiting connection
  private pairs = new Set<{ server: WebSocket; client: WebSocket }>();

  registerServer(ws: WebSocket, username: string, installId: string):
    "registered" | "username_taken" | "invalid_username";

  connectClient(ws: WebSocket, username: string):
    "connected" | "server_offline" | "unknown_username";

  forward(ws: WebSocket, data: Buffer | string): void;

  handleClose(ws: WebSocket): void;
}
```

- `registerServer`: validates username format, checks registry, replaces existing waiting connection if same installId
- `connectClient`: finds waiting connection, removes from waiting map, creates pair, returns result
- `forward`: looks up paired socket, sends data
- `handleClose`: removes from waiting map or pairs set, closes other end if paired

**Keepalives** (in `ws-handler.ts`):
- Ping waiting connections every 60s
- Drop connection if no pong within 30s
- Paired connections: no keepalive (not relay's responsibility)

**Reclamation:**
- Run `registry.reclaimInactive(90)` on startup
- Optionally add hourly interval (can defer to v2)

**Tests:** `packages/relay/test/`
- `registry.test.ts`: username claiming, same installId replacement, different installId rejection, reclamation
- `connections.test.ts`: server registration, client pairing, forwarding, cleanup on close

---

### Phase 3: InstallService (Yepanywhere)

**File: `packages/server/src/services/InstallService.ts`** (new)

```typescript
interface InstallState {
  version: number;
  installId: string;    // crypto.randomUUID()
  createdAt: string;
}

class InstallService {
  private state: InstallState;
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "install.json");
    this.state = this.load();
  }

  private load(): InstallState {
    // If file exists and valid, return it
    // Otherwise generate new installId, persist, return
  }

  getInstallId(): string {
    return this.state.installId;
  }
}
```

**File: `packages/server/src/index.ts`** - Initialize InstallService early in startup

**Tests:** `packages/server/test/services/InstallService.test.ts`
- Generates new ID on first run
- Persists and reloads same ID
- Handles corrupted file (regenerate)

---

### Phase 4: RelayClientService (Yepanywhere)

**File: `packages/server/src/services/RelayClientService.ts`** (new)

```typescript
class RelayClientService {
  private waitingWs: WebSocket | null = null;
  private backoff: ExponentialBackoff;
  private relayUrl: string;
  private username: string;
  private installId: string;

  constructor(config: {
    relayUrl: string;
    username: string;
    installId: string;
    onRelayConnection: (ws: WebSocket, firstMessage: string) => void;
  }) {
    this.backoff = new ExponentialBackoff({
      initialDelay: 1000,
      maxDelay: 60_000,
      multiplier: 2
    });
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "server_register",
        username: this.username,
        installId: this.installId
      }));
    };

    ws.onmessage = (event) => this.handleMessage(ws, event);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => this.handleClose();
  }

  private handleMessage(ws: WebSocket, event: MessageEvent): void {
    const data = JSON.parse(event.data);

    if (data.type === "server_registered") {
      this.waitingWs = ws;
      this.backoff.reset();
      return;
    }

    if (data.type === "server_rejected") {
      // Log error, maybe emit event for UI
      // Don't reconnect for username_taken (permanent error)
      if (data.reason !== "username_taken") {
        this.scheduleReconnect();
      }
      return;
    }

    // Any other message = claimed by remote client (first message is SRP init)
    this.waitingWs = null;
    this.onRelayConnection(ws, event.data);
    this.connect();  // Open new waiting connection immediately
  }

  private handleClose(): void {
    if (this.waitingWs) {
      this.waitingWs = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = this.backoff.next();
    setTimeout(() => this.connect(), delay);
  }

  disconnect(): void {
    this.waitingWs?.close();
    this.waitingWs = null;
  }
}
```

**Integration with ws-relay.ts:**

Add to `packages/server/src/routes/ws-relay.ts`:

```typescript
// Existing: handles direct WebSocket connections
app.get("/ws-relay", upgradeWebSocket((c) => { ... }));

// New: accept already-connected WebSocket from relay
export function acceptRelayConnection(ws: WebSocket, firstMessage: string): void {
  // Create the same handler state as direct connections
  const handler = createWsRelayHandler();

  // Wire up the WebSocket events
  ws.onmessage = (event) => handler.onMessage(event.data);
  ws.onclose = () => handler.onClose();
  ws.onerror = () => handler.onClose();

  // Process the first message (SRP init from phone)
  handler.onMessage(firstMessage);
}
```

The key insight: the WebSocket is already connected (upgrade happened at relay), so we skip Hono's upgradeWebSocket and wire events directly. The SRP/encryption flow is identical.

**Tests:** `packages/server/test/services/RelayClientService.test.ts`
- Connects and registers successfully
- Handles rejection (username_taken)
- Detects claim on first message, hands off, reconnects
- Exponential backoff on disconnect
- Max backoff capped at 60s

---

### Phase 5: Settings UI

**File: `packages/server/src/remote-access/RemoteAccessService.ts`**
- Add `relayUrl?: string` to state
- Add `relayUsername?: string` to state (separate from local password username)
- Add `getRelayConfig()` / `setRelayConfig()` methods
- Bump schema version, add migration

**File: `packages/server/src/remote-access/routes.ts`**
- `GET /api/remote-access/relay` - get relay config
- `PUT /api/remote-access/relay` - set relay URL and username
- `DELETE /api/remote-access/relay` - disable relay

**File: `packages/client/src/pages/SettingsPage.tsx`**
- Add relay section when remote access is enabled
- Input for relay URL (default placeholder: `wss://relay.yepanywhere.com/ws`)
- Input for relay username
- Status indicator (connected/disconnected/error)

**File: `packages/client/src/hooks/useRemoteAccess.ts`**
- Add `relayConfig` to state type
- Add `updateRelayConfig()` / `clearRelayConfig()` methods

**Tests:** Defer detailed UI tests to after core functionality works. Basic E2E coverage in Phase 6.

---

### Phase 6: Integration Testing

**E2E tests:** `packages/relay/test/e2e/relay.e2e.test.ts`

Spin up relay + yepanywhere + simulated phone client:

1. **Server registration flow**
   - Server connects, registers username
   - Receives server_registered
   - Connection stays open (waiting)

2. **Client connection flow**
   - Phone connects with registered username
   - Receives client_connected
   - Server receives first message (SRP init)

3. **Message forwarding**
   - Phone sends message → server receives it
   - Server sends message → phone receives it
   - Binary data works correctly

4. **Server offline**
   - Phone connects to unregistered username
   - Receives client_error: server_offline

5. **Username taken**
   - Server A registers "alice"
   - Server B (different installId) tries to register "alice"
   - Server B receives server_rejected: username_taken

6. **Same installId replacement**
   - Server registers "alice"
   - Server reconnects (same installId)
   - New connection replaces old waiting connection

7. **Reconnection after disconnect**
   - Server registers, connection drops
   - Server reconnects with backoff
   - Successfully re-registers

8. **Full relay flow**
   - Yepanywhere connects to relay
   - Phone connects through relay
   - SRP auth completes through relay
   - Encrypted app traffic works

---

### Phase 7: Server Wiring ✅

Wire up RelayClientService to actually run on the yepanywhere server.

**Status: Complete**

Implementation notes:
- `RelayClientService` instantiated in `index.ts` before `createApp`
- `relayConfigCallbackHolder` pattern used to pass callback to routes (avoids circular dependency)
- `createAcceptRelayConnection` creates handler after app is created
- `updateRelayConnection()` called on startup and wired to API routes via callback holder
- Status endpoint at `GET /api/remote-access/relay/status` returns `{ status, error, reconnectAttempts }`

**File: `packages/server/src/index.ts`**

```typescript
import { RelayClientService } from "./services/RelayClientService";

// After InstallService initialization...
const installService = new InstallService(config.dataDir);
await installService.initialize();

// Create relay client service
const relayClientService = new RelayClientService();

// Create the relay connection handler
const acceptRelayConnection = createAcceptRelayConnection({
  app,
  baseUrl,
  supervisor,
  eventBus,
  uploadManager,
  remoteAccessService,
  remoteSessionService,
});

// Function to start/restart relay client with current config
async function updateRelayConnection() {
  const relayConfig = remoteAccessService.getRelayConfig();
  if (relayConfig?.url && relayConfig?.username) {
    await relayClientService.start({
      relayUrl: relayConfig.url,
      username: relayConfig.username,
      installId: installService.getInstallId(),
      onRelayConnection: acceptRelayConnection,
    });
  } else {
    relayClientService.stop();
  }
}

// Start relay on boot if configured
await updateRelayConnection();

// Re-wire when config changes (called from PUT /api/remote-access/relay)
// Add to routes or use an event emitter pattern
```

**File: `packages/server/src/remote-access/routes.ts`**

Add callback or event when relay config changes:

```typescript
app.put("/api/remote-access/relay", async (c) => {
  // ... existing validation and save ...

  // Notify server to reconnect with new config
  await onRelayConfigChanged?.();

  return c.json({ success: true });
});
```

**File: `packages/server/src/remote-access/routes.ts`** - Add status endpoint

```typescript
app.get("/api/remote-access/relay/status", (c) => {
  return c.json({
    status: relayClientService.getStatus(), // "disconnected" | "connecting" | "registering" | "waiting" | "rejected"
    error: relayClientService.getLastError(), // null | "username_taken" | "invalid_username" | "connection_failed"
  });
});
```

**File: `packages/client/src/pages/SettingsPage.tsx`**

Update UI to show live status:
- Poll `/api/remote-access/relay/status` or use SSE
- Show "Connected" (green) when status is "waiting"
- Show "Connecting..." when status is "connecting" or "registering"
- Show error message when status is "rejected"

**Tests:** `packages/server/test/integration/relay-wiring.test.ts`
- Server connects to relay on startup when configured
- Server reconnects when config changes
- Server disconnects when relay config cleared
- Status endpoint returns correct state

---

### Phase 8: Remote Client Relay Support ✅

Add relay connection mode to the remote client while keeping direct connection.

**Status: Complete**

Implementation notes:
- `SecureConnection.connectWithExistingSocket()` accepts pre-connected WebSocket from relay
- `RemoteLoginModePage` provides mode selection (relay vs direct)
- `DirectLoginPage` renamed from RemoteLoginPage, handles direct WebSocket connection
- `RelayLoginPage` handles relay connection flow with status feedback
- `RemoteConnectionContext.connectViaRelay()` manages the relay handshake and SRP auth
- Login routes (`/login`, `/direct`, `/relay`) added to `remote-main.tsx`
- `RemoteApp` `ConnectionGate` updated for route-based auth flow

**Connection Modes:**

1. **Direct mode** (existing): Enter devserver WebSocket URL + SRP credentials
   - For LAN, Tailscale, future Android WebView
   - URL like `wss://192.168.1.10:3400/ws-relay`

2. **Relay mode** (new): Enter relay username + SRP credentials
   - For NAT traversal, public internet access
   - Default relay: `wss://remote.yepanywhere.com/ws`

**File: `packages/client/src/remote-main.tsx`**

Add routes for both modes:

```typescript
<Routes>
  <Route path="/" element={<RemoteLoginPage />} />
  <Route path="/direct" element={<DirectLoginPage />} />
  <Route path="/relay" element={<RelayLoginPage />} />
  {/* ... rest of app routes wrapped in RemoteApp ... */}
</Routes>
```

**File: `packages/client/src/pages/RemoteLoginPage.tsx`** (new)

Landing page with two options:
- "Connect via Relay" → navigates to `/relay`
- "Direct Connection" → navigates to `/direct`

**File: `packages/client/src/pages/DirectLoginPage.tsx`** (rename from current login)

Existing direct connection flow:
- WebSocket URL input
- Username input
- Password input
- Connect button → `SecureConnection.connect(wsUrl, username, password)`

**File: `packages/client/src/pages/RelayLoginPage.tsx`** (new)

Relay connection flow:
- Relay username input (e.g., "crostini")
- SRP username input
- SRP password input
- Optional: relay URL override (default: `wss://remote.yepanywhere.com/ws`)

```typescript
async function connectViaRelay(relayUsername: string, srpUsername: string, srpPassword: string) {
  const relayUrl = customRelayUrl || "wss://remote.yepanywhere.com/ws";

  // 1. Connect to relay
  const ws = new WebSocket(relayUrl);

  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      // 2. Send client_connect
      ws.send(JSON.stringify({ type: "client_connect", username: relayUsername }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "client_connected") {
        resolve(ws);
      } else if (msg.type === "client_error") {
        reject(new Error(msg.reason)); // "server_offline" | "unknown_username"
      }
    };

    ws.onerror = () => reject(new Error("connection_failed"));
  });

  // 3. Hand off to SecureConnection for SRP auth
  // WebSocket is now a direct pipe to yepanywhere server
  await secureConnection.connectWithExistingSocket(ws, srpUsername, srpPassword);
}
```

**File: `packages/client/src/lib/SecureConnection.ts`**

Add method to accept pre-connected WebSocket:

```typescript
async connectWithExistingSocket(ws: WebSocket, username: string, password: string): Promise<void> {
  // Same SRP flow as connect(), but skip WebSocket creation
  this.ws = ws;
  this.setupMessageHandler();
  await this.performSrpAuth(username, password);
}
```

**UI States for Relay Login:**
- Initial: form with inputs
- Connecting: "Connecting to relay..."
- Waiting: "Waiting for server..." (after client_connect sent)
- Error: Show error message (server_offline, connection_failed, etc.)
- Success: Redirect to app

**Tests:** `packages/client/test/relay-login.test.ts`
- Relay connection flow succeeds
- Handles server_offline error
- Handles connection_failed error
- Falls back gracefully on relay issues

---

## Critical Files

| File | Action | Phase |
|------|--------|-------|
| `packages/shared/src/relay-protocol.ts` | Create - protocol types | 1 |
| `packages/relay/` | Create - new package | 2 |
| `packages/relay/src/db.ts` | Create - SQLite setup | 2 |
| `packages/relay/src/registry.ts` | Create - username registry | 2 |
| `packages/relay/src/connections.ts` | Create - connection manager | 2 |
| `packages/server/src/services/InstallService.ts` | Create - install ID | 3 |
| `packages/server/src/services/RelayClientService.ts` | Create - relay client | 4 |
| `packages/server/src/remote-access/RemoteAccessService.ts` | Modify - add relay config | 5 |
| `packages/server/src/remote-access/routes.ts` | Modify - relay endpoints | 5 |
| `packages/server/src/routes/ws-relay.ts` | Modify - accept relay connections | 5 |
| `packages/client/src/pages/SettingsPage.tsx` | Modify - relay settings | 5 |
| `packages/client/src/hooks/useRemoteAccess.ts` | Modify - relay config hook | 5 |
| `packages/server/src/index.ts` | Modify - wire up RelayClientService | 7 |
| `packages/server/src/remote-access/routes.ts` | Modify - relay status endpoint | 7 |
| `packages/client/src/pages/RemoteLoginPage.tsx` | Create - mode selection landing | 8 |
| `packages/client/src/pages/DirectLoginPage.tsx` | Rename - existing login page | 8 |
| `packages/client/src/pages/RelayLoginPage.tsx` | Create - relay login flow | 8 |
| `packages/client/src/lib/SecureConnection.ts` | Modify - accept existing WebSocket | 8 |
| `packages/client/src/remote-main.tsx` | Modify - add login routes | 8 |

## Configuration

**Relay server:**
- `RELAY_PORT` (default: 3500)
- `RELAY_DATA_DIR` (default: `~/.yep-relay/`)
- `RELAY_LOG_LEVEL` (default: info)

**Yepanywhere server:**
- Relay config stored in `remote-access.json`
- Install ID stored in `install.json`

## Design Decisions

- **SQLite for registry** - better-sqlite3 for atomic operations and easy querying
- **Self-hosted relay** in monorepo as `packages/relay`
- **Consistent stack** - Hono + Node.js (same as yepanywhere)
- **No complex auth** - installId is weak secret for username claiming
- **First-come-first-served** usernames with 90-day reclamation
- **Username format** - `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` (3-32 chars)
- **Offline detection** - Relay returns `server_offline` immediately if no waiting connection
- **Custom relay URL** - Users can point to their own relay in settings
- **Dumb pipe** - Relay never inspects message content; E2E encryption is phone↔yepanywhere
- **Implicit claim detection** - Server knows it's claimed when first message arrives
- **Exponential backoff** - Prevents thundering herd on relay/server restart (max 60s)
- **Keepalives** - Relay pings waiting connections every 60s, drops after 30s no pong

## Future: Multi-Relay Scaling

When needed, add a front-door service:
1. Yepanywhere connects to front-door, gets assigned to relay N
2. Phone queries front-door for username location, connects to relay N
3. Database tracks username -> relay mapping (sticky for efficiency)

This can be added later without changing the core relay protocol.

## Verification

### Local Testing (with local relay)

1. Start relay: `cd packages/relay && pnpm dev` (runs on port 3500)
2. Start yepanywhere: `pnpm dev` (runs on port 3400)
3. Configure relay in yepanywhere: Settings > Remote Access > Relay URL = `ws://localhost:3500/ws`
4. Set relay username (e.g., "testuser")
5. Enable remote access with SRP username/password
6. Verify Settings shows relay status as "Connected" (green)
7. Start remote client: `pnpm dev:remote` (runs on port 3402)
8. Navigate to relay login, enter relay username + SRP credentials
9. Verify SRP auth completes and app works through relay

### Production Testing (with remote.yepanywhere.com)

1. Start yepanywhere: `pnpm start`
2. Configure relay: Settings > Remote Access > Relay URL = `wss://remote.yepanywhere.com/ws`
3. Set relay username
4. Enable remote access with SRP username/password
5. Verify relay status shows "Connected"
6. Open `https://remote.yepanywhere.com` on phone
7. Use relay login with same relay username + SRP credentials
8. Verify connection works through public relay

### Run tests:
```bash
pnpm --filter @yep-anywhere/relay test
pnpm --filter @yep-anywhere/server test
pnpm test:e2e
```
