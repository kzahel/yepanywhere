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
│  Phone/Browser  │────▶│  Relay Server   │◀────│ Yepanywhere     │
│                 │     │                 │     │ Server          │
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

Returns relay server URLs and version requirements. Allows migration without client updates.

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

Server fetches this on startup (already fetches version info).

### 2. Relay Server

Lightweight WebSocket router. Responsibilities:
- Accept server connections (authenticated via secret)
- Accept phone connections (SRP handshake, then encrypted traffic)
- Route encrypted messages between phone and server
- Track which server is connected to which relay (for multi-relay scaling)

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
- **SRP client** - Authenticate to server via relay
- **Encryption layer** - Encrypt/decrypt all traffic
- **Relay protocol** - Multiplex HTTP requests, SSE events, uploads over single WebSocket

## User Flow

### Setup (one-time)

1. User opens yepanywhere settings
2. Enables "Remote Access"
3. Enters username (e.g., `kgraehl`) - checked for availability
4. Enters password
5. Server stores SRP verifier (never the password)
6. Server connects to relay, registers username

### Connecting from Phone

1. User visits `yepanywhere.com/c/kgraehl`
2. Enters password
3. SRP handshake via relay (proves both sides know password)
4. Session key established
5. All traffic encrypted with session key
6. Phone stores derived key for future sessions (auto-reconnect)

## Protocol Details

### SRP Authentication

Using SRP-6a with SHA-256. Server stores verifier, never password.

```
Phone                      Relay                      Server
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

// Direct mode - normal fetch, WebSocket, SSE
class DirectConnection implements Connection { ... }

// Relay mode - everything over encrypted WebSocket
class RelayConnection implements Connection { ... }
```

## Multi-Relay Scaling

For load balancing across multiple relay servers:

1. **Registration** - Server registers with central DB (Redis/Postgres)
2. **Discovery** - Phone asks "where is kgraehl?" → gets assigned relay URL
3. **Routing** - Phone connects to correct relay

```
Phone ──▶ /api/relay/locate/kgraehl ──▶ { "relay": "wss://relay2.yepanywhere.com" }
      │
      └──▶ connect to relay2
```

This allows rebalancing by telling servers to reconnect to different relays.

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

### Phase 1: Foundation
- [ ] Relay protocol types (shared package)
- [ ] SRP + encryption helpers
- [ ] Loopback relay for local testing (server-side mock)

### Phase 2: Server Integration
- [ ] Relay client (connect to relay, handle reconnection)
- [ ] SRP verifier storage
- [ ] Settings UI for remote access
- [ ] Relay message handler (decrypt, route to existing handlers)

### Phase 3: Client Abstraction
- [ ] Connection interface
- [ ] DirectConnection (wrap existing fetch/WS/SSE)
- [ ] RelayConnection (encrypted WebSocket protocol)
- [ ] useConnection hook (pick mode based on context)

### Phase 4: Relay Server
- [ ] WebSocket server (accept connections)
- [ ] Server authentication
- [ ] Phone SRP handshake passthrough
- [ ] Encrypted message routing
- [ ] Connection tracking

### Phase 5: Production
- [ ] Config endpoint on yepanywhere.com
- [ ] Deploy relay server
- [ ] Multi-relay support (if needed)
- [ ] Monitoring/alerting

## Open Questions

1. **Username format** - Allow dots/dashes? Min/max length?
2. **Password requirements** - Minimum entropy? Passphrase suggestions?
3. **Session persistence** - How long to cache session key on phone?
4. **Conflict handling** - When server moves to new machine, last-write-wins?
5. **Offline indicator** - Show "server offline" vs "wrong password"?

## Alternatives Considered

### QR Code Pairing
- Pro: High-entropy key without password
- Con: Requires camera, awkward for second device
- Decision: Keep as optional optimization, password-first

### FCM/Push for Wake-up
- Pro: No persistent connection
- Con: FCM is client-focused, not server-focused
- Decision: Persistent WebSocket is fine for always-on servers

### Direct WebRTC
- Pro: True P2P, no relay bandwidth
- Con: Complex NAT traversal, TURN fallback needed anyway
- Decision: Relay is simpler, traffic is lightweight

## References

- [SRP Protocol](http://srp.stanford.edu/design.html)
- [TweetNaCl.js](https://tweetnacl.js.org/)
- [secure-remote-password npm](https://www.npmjs.com/package/secure-remote-password)
