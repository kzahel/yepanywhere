# Relay System Design

**Status:** Draft
**Author:** Design discussion 2026-01-10

## Overview

A relay service that enables phone clients to connect to yepanywhere servers behind NAT without requiring Tailscale, Cloudflare tunnels, or port forwarding.

### Goals

1. **Zero-config remote access** - User sets username/password, connects from any browser
2. **E2E encryption** - Relay cannot read user traffic (SRP + NaCl)
3. **Simple pairing** - No QR codes required (optional optimization)
4. **Scalable** - Config-based relay discovery allows future migration from self-hosted to managed service

### Non-Goals (Initially)

- Mobile app (web-only for now)
- UPnP hole punching (future optimization)
- Multiple relay regions (start with one)

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Phone/Browser  │────▶│     Relay       │◀────│   Yepanywhere   │
│                 │     │                 │     │                 │
│  - SRP auth     │     │  - Routes msgs  │     │  - Holds SRP    │
│  - Encrypts     │     │  - Cannot read  │     │    verifier     │
│    traffic      │     │    traffic      │     │  - Decrypts     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌─────────────────┐
                        │ Config Endpoint │
                        │ (yepanywhere.com│
                        │  /api/config)   │
                        └─────────────────┘
```

## Components

### 1. Config Endpoint (yepanywhere.com)

Returns relay URLs and version requirements. Allows migration without client updates.

```json
{
  "relay": {
    "servers": [
      { "url": "wss://relay.yepanywhere.com", "region": "us" }
    ],
    "minVersion": "0.3.0",
    "maxVersion": null
  }
}
```

Yepanywhere server fetches this on startup (already fetches version info).

### 2. Relay

Lightweight WebSocket router. Responsibilities:
- Accept yepanywhere server connections (authenticated via secret)
- Accept phone connections (SRP handshake, then encrypted traffic)
- Route encrypted messages between phone and yepanywhere server
- Track which yepanywhere server is connected to which relay (for multi-relay scaling)

**Does NOT:**
- Read message contents (E2E encrypted)
- Store user data
- Handle SRP verification (user's yepanywhere server does this)

### 3. Yepanywhere Server Changes

- **Relay client** - Persistent WebSocket connection to relay
- **SRP verifier storage** - Store username, salt, verifier in data dir
- **Settings UI** - Enable remote access, set username/password
- **Connection handler** - Handle relay protocol messages, decrypt, route to existing handlers

### 4. Client (Phone/Browser) Changes

- **Connection abstraction** - Interface for Direct vs Relay modes
- **SRP client** - Authenticate to yepanywhere server via relay
- **Encryption layer** - Encrypt/decrypt all traffic
- **Relay protocol** - Multiplex HTTP requests, SSE events, uploads over single WebSocket

## User Flow

### Setup (one-time)

1. User opens yepanywhere settings
2. Enables "Remote Access"
3. Enters username (e.g., `kgraehl`) - checked for availability
4. Enters password
5. Yepanywhere server stores SRP verifier (never the password)
6. Yepanywhere server connects to relay, registers username

### Connecting from Phone

1. User visits `yepanywhere.com/c/kgraehl`
2. Enters password
3. SRP handshake via relay (proves both sides know password)
4. Session key established
5. All traffic encrypted with session key
6. Phone stores derived key for future sessions (auto-reconnect)

## Protocol Details

### SRP Authentication

Using SRP-6a with the RFC 5054 2048-bit group and SHA-512. Yepanywhere server
stores the verifier, never the password.

```
Phone                      Relay                      Yepanywhere
  │                          │                          │
  │ ── SRP hello (A) ──────▶ │ ── forward ───────────▶ │
  │                          │                          │
  │ ◀── SRP challenge (B) ── │ ◀── forward ─────────── │
  │                          │                          │
  │ ── SRP proof (M1) ─────▶ │ ── forward ───────────▶ │
  │                          │                          │
  │ ◀── SRP verify (M2) ──── │ ◀── forward ─────────── │
  │                          │                          │
  │    (session key K established, relay cannot derive K)
  │                          │                          │
  │ ══ encrypted traffic ══▶ │ ══ passthrough ═══════▶ │
```

### Message Encryption

Using NaCl secretbox (XSalsa20-Poly1305):
- 24-byte random nonce per message
- Session key from SRP
- Authenticated encryption (tamper-evident)

### Relay Protocol (Encrypted Payload)

All messages inside encrypted envelope:

```typescript
// HTTP-like request/response
{ type: "request", id: "uuid", method: "GET", path: "/api/sessions", body?: any }
{ type: "response", id: "uuid", status: 200, body: any }

// Event streaming (replaces SSE)
{ type: "subscribe", sessionId: "..." }
{ type: "event", sessionId: "...", eventType: "message", data: any }

// File uploads
{ type: "upload_start", uploadId: "...", filename: "...", size: 1234 }
{ type: "upload_chunk", uploadId: "...", offset: 0, data: "base64..." }
{ type: "upload_complete", uploadId: "...", file: {...} }
```

### Connection Abstraction (Client)

```typescript
interface Connection {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  subscribe(sessionId: string): AsyncIterable<SessionEvent>;
  upload(file: File, onProgress: (n: number) => void): Promise<UploadedFile>;
}

// Plain mode - normal fetch, WebSocket, SSE (localhost dev, easy debugging)
class DirectConnection implements Connection { ... }

// Secure mode - SRP + encrypted WebSocket (reusable base)
class SecureConnection implements Connection {
  constructor(wsUrl: string, username: string) { ... }
  async connect(password: string) { /* SRP handshake, derive sessionKey */ }
  // All methods encrypt/decrypt using sessionKey
}

// Direct secure - WS straight to yepanywhere (LAN testing)
new SecureConnection('wss://192.168.1.50:3400/ws', 'kgraehl')

// Via relay - WS to relay (production remote access)
new SecureConnection('wss://relay.yepanywhere.com/ws', 'kgraehl')
```

**Connection modes:**

| Mode | Transport | Auth | Use Case |
|------|-----------|------|----------|
| DirectConnection | fetch/WS/SSE | Cookie session | Default for localhost, network tab debugging |
| WebSocketConnection | WS to yepanywhere | Cookie session | Dev setting to test WS protocol without encryption |
| SecureConnection (direct) | WS to yepanywhere | SRP + encryption | LAN, test secure protocol without relay |
| SecureConnection (relay) | WS to relay | SRP + encryption | Production remote access |

**Mode selection:**
- DirectConnection is the **default** for localhost/LAN access (normal fetch/XHR/SSE)
- WebSocketConnection can be enabled via **developer settings** toggle for testing
- SecureConnection is used automatically when connecting via relay URL

SecureConnection extends WebSocketConnection, adding SRP handshake and encryption. Same WS protocol, same message routing - just with an encryption layer on top.

## Multi-Relay Scaling

> Superseded 2026-11-27 by the [relay fleet proposal](../../topics/relay-fleet.md).
> The sketch below is the original January 2026 idea, kept for history.

For load balancing across multiple relays:

1. **Registration** - Yepanywhere server registers with central DB (Redis/Postgres)
2. **Discovery** - Phone asks "where is kgraehl?" → gets assigned relay URL
3. **Routing** - Phone connects to correct relay

```
Phone ──▶ /api/relay/locate/kgraehl ──▶ { "relay": "wss://relay2.yepanywhere.com" }
      │
      └──▶ connect to relay2
```

This allows rebalancing by telling yepanywhere servers to reconnect to different relays.

## Security Considerations

### What relay CAN see
- Username being connected to
- Connection timing/duration
- Encrypted blob sizes (traffic analysis)

### What relay CANNOT see
- Password (SRP zero-knowledge)
- Session keys (derived from password, never transmitted)
- Message contents (encrypted)
- Files being uploaded (encrypted)

### Compression Before Encryption (reviewed 2026-02-21)
- Relay payloads may be gzip-compressed before encryption for bandwidth/latency wins on large responses.
- This pattern can theoretically enable CRIME/BREACH-style length-oracle attacks when attacker-controlled input and secrets share the same compressed payload and an attacker can repeatedly observe ciphertext lengths.
- Current risk is accepted as low for this architecture: authenticated E2E relay traffic, per-message gzip streams (no shared cross-message compression context), and no known high-risk secret-reflection response classes in relay payloads.
- If this threat model changes, keep compression and add ciphertext length bucketing/padding for sensitive message classes rather than disabling compression globally.

### Abuse Prevention
- Rate limit registration (3 per IP per hour)
- Rate limit SRP attempts (prevent brute force)
- Username blocklist (offensive terms)
- Inactive username reclamation (90 days?)

## Push Notifications

Separate concern from relay. Two options:

**Option A: Generic notifications**
```json
{ "title": "kgraehl", "body": "Action needed" }
```
User taps, app fetches details over encrypted relay.

**Option B: User choice**
Setting to show full details (less private) or generic (more private).

## Implementation Phases

### Phase 1: Protocol Types

Define all message types in `packages/shared/src/relay.ts`:

**Request/Response (HTTP-like)**
```typescript
type RelayRequest = {
  type: "request";
  id: string;              // UUID for matching response
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;            // e.g., "/api/sessions"
  headers?: Record<string, string>;
  body?: unknown;
};

type RelayResponse = {
  type: "response";
  id: string;              // matches request.id
  status: number;          // HTTP status code
  headers?: Record<string, string>;
  body?: unknown;
};
```

**Event Subscriptions (SSE replacement)**
```typescript
type RelaySubscribe = {
  type: "subscribe";
  subscriptionId: string;  // client-generated, for unsubscribe
  channel: "session" | "activity";
  sessionId?: string;      // required for channel: "session"
  lastEventId?: string;    // for resumption
};

type RelayUnsubscribe = {
  type: "unsubscribe";
  subscriptionId: string;
};

type RelayEvent = {
  type: "event";
  subscriptionId: string;
  eventType: string;       // "message", "status", "stream_event", etc.
  eventId?: string;        // for resumption
  data: unknown;
};
```

**File Upload**
```typescript
type RelayUploadStart = {
  type: "upload_start";
  uploadId: string;
  projectId: string;
  sessionId: string;
  filename: string;
  size: number;
  mimeType: string;
};

type RelayUploadChunk = {
  type: "upload_chunk";
  uploadId: string;
  offset: number;
  data: string;            // base64 encoded
};

type RelayUploadEnd = {
  type: "upload_end";
  uploadId: string;
};

type RelayUploadProgress = {
  type: "upload_progress";
  uploadId: string;
  bytesReceived: number;
};

type RelayUploadComplete = {
  type: "upload_complete";
  uploadId: string;
  file: UploadedFile;
};

type RelayUploadError = {
  type: "upload_error";
  uploadId: string;
  error: string;
};
```

**Union types**
```typescript
// Messages from phone/browser → yepanywhere
type RemoteClientMessage = RelayRequest | RelaySubscribe | RelayUnsubscribe
                         | RelayUploadStart | RelayUploadChunk | RelayUploadEnd;

// Messages from yepanywhere → phone/browser
type YepMessage = RelayResponse | RelayEvent
                | RelayUploadProgress | RelayUploadComplete | RelayUploadError;
```

Tasks:
- [x] Define all types above in shared package
- [x] Export from shared/index.ts

### Phase 2a: Connection Interface + DirectConnection
- [x] Define Connection interface
- [x] DirectConnection wraps existing fetch (trivial)
- [x] useConnection hook returns DirectConnection
- [x] App works unchanged (just routed through interface)

### Phase 2b: WebSocket Endpoint + Request/Response
- [x] `/ws` endpoint on yepanywhere server
- [x] Basic message routing: receive request, call Hono handler, send response
- [x] WebSocketConnection class implementing Connection interface
- [x] WebSocketConnection.fetch() - send request, match response by ID
- [x] Developer settings toggle: "Use WebSocket transport" (default: off)
- [x] useConnection hook checks dev setting, returns WebSocketConnection or DirectConnection
- [x] "Test" button in settings to verify WebSocket connection before enabling
- [x] Wire up `fetchJSON` in `api/client.ts` to check setting and use WebSocketConnection
- [x] Test: simple API calls work over WS when enabled (ws-transport.e2e.test.ts)

### Phase 2c: Event Subscriptions (SSE Replacement)
- [x] Server: track subscriptions per WS connection
- [x] Server: pipe session events to subscribed connections
- [x] Client: WebSocketConnection.subscribeSession() and subscribeActivity()
- [x] Handle multiple concurrent subscriptions (session + activity)
- [x] Test: live streaming works over WS (ws-transport.e2e.test.ts)

### Phase 2d: File Upload
- [x] Server: handle upload_start/chunk/end messages
- [x] Server: pipe to existing upload handler
- [x] Client: WebSocketConnection.upload() with progress
- [x] Test: file uploads work over WS

### Phase 2e: Integration Testing
- [ ] Switch app to WebSocketConnection
- [ ] Full E2E testing on localhost
- [ ] Handle edge cases (reconnection, errors, timeouts)

### Phase 3: SRP + Encryption
- [x] SRP helpers (generate verifier, client/server handshake)
- [x] NaCl encryption helpers (secretbox wrapper)
- [x] Unit tests for SRP + encryption
- [x] Add SRP handshake to `/ws` endpoint
- [x] Add encryption layer to WebSocketConnection → SecureConnection
- [x] SRP verifier storage in data dir
- [x] Settings UI for remote access (username/password setup)

### Phase 3.5: Static Site for Direct Secure Testing

Before adding relay complexity, validate the full secure connection flow using a GitHub Pages-hosted client that connects directly to the yepanywhere server.

**Static Site Build** (in `packages/client/`)
- [x] Add `remote.html` entrypoint and `remote-main.tsx`
- [x] Add `vite.config.remote.ts` for static site build
- [x] Add `pnpm build:remote` and `pnpm dev:remote` scripts
- [x] GitHub Actions workflow to deploy `dist-remote/` to GitHub Pages on push to main

**Login Entrypoint**
- [x] Standalone login page (RemoteLoginPage.tsx)
- [x] Form: WebSocket URL input (default: `ws://localhost:3400/ws`)
- [x] Form: Username and password fields
- [x] "Remember URL" option (stores URL/username in localStorage)
- [x] SRP handshake via SecureConnection
- [x] On success, render main app with SecureConnection

**Connection Flow**
- [x] Remote client uses SecureConnection exclusively (no DirectConnection)
- [x] All API calls go through encrypted WebSocket (global connection routing)
- [x] URL/username stored in localStorage for reconnection (password not stored)
- [x] Handle connection errors gracefully (shows error in login form)

**Testing Scenarios**
- [ ] Localhost dev server → localhost yepanywhere (primary development flow)
- [ ] LAN testing once localhost works (e.g., `ws://192.168.1.50:3400/ws`)

**Nice to Have**
- [ ] QR code generation on server settings page (encodes WS URL + username)
- [ ] QR scanner on static site login (phone camera → quick connect)

This phase validates:
1. SRP authentication works from external origin
2. SecureConnection handles all app traffic correctly
3. Encryption/decryption is seamless
4. The protocol is ready for relay passthrough

### Phase 3.6: Browser E2E Tests for Remote Login

Full Playwright browser tests that serve the remote client and perform real login flows.

**Test Infrastructure** (completed)
- [x] E2E test server uses auto-assigned ports (PORT=0)
- [x] Maintenance server enabled in dev-mock.ts for test configuration
- [x] Health check before tests start
- [x] `configureRemoteAccess()` / `disableRemoteAccess()` test helpers
- [x] `maintenanceURL` and `wsURL` Playwright fixtures

#### Implementation Plan

##### Step 1: Add Remote Client Dev Server Script

Add proper package.json scripts for running the remote client with HMR, usable for both development and E2E testing.

**File: `packages/client/package.json`** - Add scripts:
```json
{
  "scripts": {
    "dev:remote": "vite --config vite.config.remote.ts",
    "build:remote": "vite build --config vite.config.remote.ts",
    "preview:remote": "vite preview --config vite.config.remote.ts"
  }
}
```

**File: `packages/client/vite.config.remote.ts`** - Support dynamic port for E2E:
```typescript
const remoteDevPort = process.env.REMOTE_PORT
  ? Number.parseInt(process.env.REMOTE_PORT, 10)
  : 3403;

export default defineConfig({
  // ...existing config...
  server: {
    // When REMOTE_PORT=0, let Vite pick an available port
    port: remoteDevPort === 0 ? undefined : remoteDevPort,
    strictPort: remoteDevPort !== 0,
    host: true,
  },
});
```

##### Step 2: Start Remote Client Dev Server in Global Setup

**File: `packages/client/e2e/global-setup.ts`**

Add after main server startup:
```typescript
const REMOTE_CLIENT_PORT_FILE = join(tmpdir(), "claude-e2e-remote-port");
const REMOTE_CLIENT_PID_FILE = join(tmpdir(), "claude-e2e-remote-pid");

// Start remote client Vite dev server for E2E testing
console.log("[E2E] Starting remote client dev server...");
const clientRoot = join(repoRoot, "packages", "client");
const remoteClientProcess = spawn(
  "pnpm",
  ["exec", "vite", "--config", "vite.config.remote.ts"],
  {
    cwd: clientRoot,
    env: { ...process.env, REMOTE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }
);

if (remoteClientProcess.pid) {
  writeFileSync(REMOTE_CLIENT_PID_FILE, String(remoteClientProcess.pid));
}

// Parse port from Vite's "Local: http://localhost:XXXXX/" output
const remotePort = await new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timeout waiting for remote client")), 30000);
  let output = "";
  remoteClientProcess.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
    const match = output.match(/Local:\s+http:\/\/localhost:(\d+)/);
    if (match) {
      clearTimeout(timeout);
      resolve(Number.parseInt(match[1], 10));
    }
  });
});

writeFileSync(REMOTE_CLIENT_PORT_FILE, String(remotePort));
console.log(`[E2E] Remote client dev server on port ${remotePort}`);
remoteClientProcess.unref();
```

**File: `packages/client/e2e/global-teardown.ts`** - Kill remote client process:
```typescript
const REMOTE_CLIENT_PID_FILE = join(tmpdir(), "claude-e2e-remote-pid");

// Kill remote client process
if (existsSync(REMOTE_CLIENT_PID_FILE)) {
  const pid = Number.parseInt(readFileSync(REMOTE_CLIENT_PID_FILE, "utf-8"), 10);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  unlinkSync(REMOTE_CLIENT_PID_FILE);
}
```

##### Step 3: Add remoteClientURL Fixture

**File: `packages/client/e2e/fixtures.ts`**
```typescript
const REMOTE_CLIENT_PORT_FILE = join(tmpdir(), "claude-e2e-remote-port");

export const test = base.extend<{
  baseURL: string;
  maintenanceURL: string;
  wsURL: string;
  remoteClientURL: string;  // NEW
}>({
  // ...existing fixtures...
  remoteClientURL: async ({}, use) => {
    const port = readFileSync(REMOTE_CLIENT_PORT_FILE, "utf-8").trim();
    await use(`http://localhost:${port}`);
  },
});
```

##### Step 4: Configure CORS for Remote Client Origin

The yepanywhere server WebSocket endpoint must accept connections from the remote client origin.

**File: `packages/server/src/routes/ws.ts`** - Add origin validation:
```typescript
// In WebSocket upgrade handler
const origin = request.headers.get("origin");
const allowedOrigins = [
  /^https?:\/\/localhost:\d+$/,
  /^https?:\/\/127\.0\.0\.1:\d+$/,
  /^https:\/\/[\w-]+\.github\.io$/,  // GitHub Pages
];

const isAllowed = !origin || allowedOrigins.some((re) => re.test(origin));
if (!isAllowed) {
  return new Response("Forbidden", { status: 403 });
}
```

##### Step 5: Add data-testid Attributes to RemoteLoginPage

**File: `packages/client/src/pages/RemoteLoginPage.tsx`**

Add test IDs to form elements:
```tsx
<form data-testid="login-form" onSubmit={handleSubmit}>
  <input data-testid="ws-url-input" ... />
  <input data-testid="username-input" ... />
  <input data-testid="password-input" ... />
  <button data-testid="login-button" type="submit">Connect</button>
  {error && <div data-testid="login-error">{error}</div>}
</form>
```

##### Step 6: Create Remote Login E2E Test File

**File: `packages/client/e2e/remote-login.spec.ts`**

```typescript
import { expect } from "@playwright/test";
import { test, configureRemoteAccess, disableRemoteAccess } from "./fixtures";

test.describe("Remote Login Flow", () => {
  const testUsername = "e2e-test-user";
  const testPassword = "test-password-123";

  test.beforeEach(async ({ baseURL, page }) => {
    await configureRemoteAccess(baseURL, {
      username: testUsername,
      password: testPassword,
    });
    // Clear localStorage for fresh state
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRemoteAccess(baseURL);
  });

  test("successful login renders main app", async ({ page, remoteClientURL, wsURL }) => {
    await page.goto(remoteClientURL);

    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', testUsername);
    await page.fill('[data-testid="password-input"]', testPassword);
    await page.click('[data-testid="login-button"]');

    // Wait for main app (projects list)
    await expect(page.locator('[data-testid="projects-list"]')).toBeVisible({ timeout: 10000 });
  });

  test("wrong password shows error", async ({ page, remoteClientURL, wsURL }) => {
    await page.goto(remoteClientURL);

    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', testUsername);
    await page.fill('[data-testid="password-input"]', "wrong-password");
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible();
  });

  test("server unreachable shows connection error", async ({ page, remoteClientURL }) => {
    await page.goto(remoteClientURL);

    await page.fill('[data-testid="ws-url-input"]', "ws://localhost:9999/api/ws");
    await page.fill('[data-testid="username-input"]', testUsername);
    await page.fill('[data-testid="password-input"]', testPassword);
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
  });
});
```

##### Step 7: Add Encrypted Data Flow Tests

Add to `packages/client/e2e/remote-login.spec.ts`:

```typescript
test.describe("Encrypted Data Flow", () => {
  const testUsername = "e2e-test-user";
  const testPassword = "test-password-123";

  async function login(page, remoteClientURL, wsURL) {
    await page.goto(remoteClientURL);
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', testUsername);
    await page.fill('[data-testid="password-input"]', testPassword);
    await page.click('[data-testid="login-button"]');
    await expect(page.locator('[data-testid="projects-list"]')).toBeVisible({ timeout: 10000 });
  }

  test.beforeEach(async ({ baseURL }) => {
    await configureRemoteAccess(baseURL, { username: testUsername, password: testPassword });
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRemoteAccess(baseURL);
  });

  test("projects list loads via SecureConnection", async ({ page, remoteClientURL, wsURL }) => {
    await login(page, remoteClientURL, wsURL);
    // If we get here, encrypted fetch worked
    const projectItems = page.locator('[data-testid="project-item"]');
    await expect(projectItems.first()).toBeVisible();
  });

  test("can create session and receive streaming response", async ({ page, remoteClientURL, wsURL }) => {
    await login(page, remoteClientURL, wsURL);

    // Click on a project to create/view session
    await page.locator('[data-testid="project-item"]').first().click();

    // Create new session
    await page.click('[data-testid="new-session-button"]');

    // Send a message
    await page.fill('[data-testid="message-input"]', "Hello from E2E test");
    await page.click('[data-testid="send-button"]');

    // Verify streaming response appears
    await expect(page.locator('[data-testid="assistant-message"]')).toBeVisible({ timeout: 15000 });
  });
});
```

#### Checklist Summary

**Remote Client E2E Setup**
- [x] Add `dev:remote` / `build:remote` / `preview:remote` scripts to package.json
- [x] Update vite.config.remote.ts to support REMOTE_PORT=0 for auto-assign
- [x] Start remote client Vite dev server in global-setup.ts
- [x] Add `remoteClientURL` fixture to fixtures.ts
- [x] Kill remote client process in global-teardown.ts
- [x] Configure CORS in ws-relay.ts for remote client origins

**Full Login Flow Tests** (remote-login.spec.ts)
- [x] Add data-testid attributes to RemoteLoginPage.tsx
- [x] Test: login page renders correctly
- [x] Test: successful login renders main app
- [x] Test: wrong password shows error
- [x] Test: unknown username shows error
- [x] Test: server unreachable shows connection error
- [x] Test: empty fields show validation error

**Encrypted Data Flow Tests**
- [x] Test: sidebar navigation loads via SecureConnection
- [x] Test: activity subscription receives events
- [x] Test: mock project visible in sidebar
- [ ] Test: create session, send message, verify streaming (requires more UI instrumentation)
- [ ] Test: file upload through encrypted WebSocket (requires more UI instrumentation)

**Test Isolation**
- [x] beforeEach configures fresh remote access credentials
- [x] beforeEach clears localStorage/sessionStorage
- [x] afterEach disables remote access

This phase validates the complete user experience: a browser loading the remote client, entering credentials, and using the app through an encrypted WebSocket connection.

### Phase 3.7: Session Resumption

Enable page refresh and navigation without re-entering password by persisting the SRP session key.

**Problem**: Currently, the session key derived from SRP is stored only in memory. Page refresh, URL navigation, or browser restart requires full re-authentication with password.

**Solution**: Store the session key locally and add a session resumption protocol that skips the SRP handshake when a valid session exists.

#### Protocol Messages

Add to `packages/shared/src/relay.ts`:

```typescript
// Client → Server: Attempt to resume existing session
type SrpSessionResume = {
  type: "srp_resume";
  identity: string;           // Username
  sessionId: string;          // Session identifier from previous auth
  proof: string;              // Encrypted timestamp to prove key possession
};

// Server → Client: Session resumed successfully
type SrpSessionResumed = {
  type: "srp_resumed";
  sessionId: string;
};

// Server → Client: Session invalid, do full SRP
type SrpSessionInvalid = {
  type: "srp_invalid";
  reason: "expired" | "unknown" | "invalid_proof";
};
```

#### Server Changes

**Session storage** (`packages/server/src/services/remote-access.ts`):
- Store session keys in data dir: `{dataDir}/remote-sessions.json`
- Map: `{ [sessionId]: { username, sessionKey, createdAt, lastUsed } }`
- Session expiry: configurable (default 7 days idle, 30 days max)

**WebSocket handler** (`packages/server/src/routes/ws-relay.ts`):
- Handle `srp_resume` message before SRP hello
- Verify proof by decrypting with stored session key
- Send `srp_resumed` on success, `srp_invalid` on failure
- Update `lastUsed` timestamp on successful resume

#### Client Changes

**Session storage** (`packages/client/src/contexts/RemoteConnectionContext.tsx`):
```typescript
interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  sessionKey: string;  // Base64-encoded Uint8Array
  createdAt: number;
}
```
- Store in localStorage after successful SRP
- Clear on explicit logout or auth failure

**SecureConnection** (`packages/client/src/lib/connection/SecureConnection.ts`):
- Add `static fromStoredSession(session: StoredSession)` factory
- `connectAndAuthenticate()` tries resume first, falls back to SRP
- Generate proof: encrypt current timestamp with session key

#### Flow

```
Reconnect with stored session:

Client                           Server
  │                                │
  │ ── srp_resume ───────────────▶ │  (sessionId + encrypted timestamp)
  │                                │
  │ ◀── srp_resumed ────────────── │  (session valid)
  │                                │
  │ ══ encrypted traffic ════════▶ │  (using stored session key)

Session expired/invalid:

Client                           Server
  │                                │
  │ ── srp_resume ───────────────▶ │
  │                                │
  │ ◀── srp_invalid ────────────── │  (reason: expired)
  │                                │
  │    (fall back to full SRP handshake)
```

#### Security Considerations

- **Session key storage**: localStorage is accessible to JS on same origin. Acceptable for convenience vs. security tradeoff. Users can choose to not save session.
- **Proof mechanism**: Encrypting timestamp prevents replay attacks. Server validates timestamp is recent (within 5 minutes).
- **Session revocation**: Changing password invalidates all sessions. Add explicit "sign out everywhere" option.
- **Session limits**: Max 5 active sessions per user. Oldest evicted on new auth.

#### Checklist

**Protocol**
- [x] Add `SrpSessionResume`, `SrpSessionResumed`, `SrpSessionInvalid` types
- [x] Add type guards for new message types

**Server**
- [x] Add session storage service (create, lookup, delete, cleanup)
- [x] Handle `srp_resume` in ws-relay.ts
- [x] Session expiry cleanup (on startup + periodic)
- [x] Invalidate sessions on password change

**Client**
- [x] Update `StoredCredentials` to include sessionId and sessionKey
- [x] Add `SecureConnection.fromStoredSession()` factory
- [x] Try session resume in `connectAndAuthenticate()`
- [x] Fall back to SRP on `srp_invalid`
- [x] Add "Remember me" checkbox to login form (controls session storage)

**Tests**
- [ ] Unit tests for session storage service
- [ ] E2E test: login, refresh page, still authenticated
- [ ] E2E test: session expiry triggers re-login
- [ ] E2E test: password change invalidates sessions

### Phase 4: Relay
- [ ] Separate relay package/service
- [ ] Accept yepanywhere server connections (authenticated)
- [ ] Accept phone connections (passthrough SRP to yepanywhere server)
- [ ] Route encrypted messages (opaque blobs)
- [ ] Connection tracking (username → socket mapping)
- [ ] Reconnection handling

### Phase 5: Production
- [ ] Relay client in yepanywhere server (connect to relay on startup)
- [ ] Config endpoint on yepanywhere.com
- [ ] Deploy relay
- [ ] Multi-relay support (if needed)
- [ ] Monitoring/alerting

## Open Questions

1. **Username format** - Allow dots/dashes? Min/max length?
2. **Password requirements** - Minimum entropy? Passphrase suggestions?
3. **Session persistence** - ~~How long to cache session key on phone?~~ → See Phase 3.7 (7 days idle, 30 days max)
4. **Conflict handling** - When yepanywhere server moves to new machine, last-write-wins?
5. **Offline indicator** - Show "yepanywhere offline" vs "wrong password"?

## Alternatives Considered

### QR Code Pairing
- Pro: High-entropy key without password
- Con: Requires camera, awkward for second device
- Decision: Keep as optional optimization, password-first

### FCM/Push for Wake-up
- Pro: No persistent connection
- Con: FCM is client-focused, not for desktop/server applications
- Decision: Persistent WebSocket is fine for always-on yepanywhere servers

### Direct WebRTC
- Pro: True P2P, no relay bandwidth
- Con: Complex NAT traversal, TURN fallback needed anyway
- Decision: Relay is simpler, traffic is lightweight

## References

- [SRP Protocol](http://srp.stanford.edu/design.html)
- [TweetNaCl.js](https://tweetnacl.js.org/)
- [tssrp6a](https://github.com/midonet/tssrp6a) - TypeScript SRP-6a implementation (chosen library)

### SRP Library Choice: tssrp6a

Evaluated options:
- **tssrp6a** (chosen) - Zero dependencies, native TypeScript, SHA-512 default, built-in session serialization for stateless HTTP/WS
- secure-remote-password - Simpler API but unmaintained (7 years), JavaScript only
- thinbus-srp-npm - More complex, designed for Java backend interop
- mozilla/node-srp - Node-only, older crypto patterns

Key factors:
- Session serialization support (critical for relay protocol)
- Active maintenance (v3.0.0)
- Zero dependencies (minimal bundle size)
- Native TypeScript types

Caveats:
- Requires HTTPS/WSS (uses WebCrypto `Crypto.subtle`)
- Default config excludes user identity from verifier (allows username changes without password reset; can customize for strict RFC compliance)
