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

Using SRP-6a with SHA-256. Yepanywhere server stores verifier, never password.

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
3. **Session persistence** - How long to cache session key on phone?
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
