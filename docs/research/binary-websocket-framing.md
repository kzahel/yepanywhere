# Binary WebSocket Framing

Research and design for optimizing the encrypted WebSocket relay protocol.

## Current State

### Encrypted Envelope (JSON + Base64)

All encrypted messages use a JSON envelope with base64-encoded fields:

```typescript
interface EncryptedEnvelope {
  type: "encrypted";
  nonce: string;      // 24 bytes → 32 chars base64
  ciphertext: string; // N bytes → ~1.33N chars base64
}
```

**Overhead:**
- Base64 encoding: ~33% size increase
- JSON framing: ~50 bytes per message (`{"type":"encrypted","nonce":"...","ciphertext":"..."}`)

### Upload Chunks (Double Base64)

For uploads via the encrypted relay (`SecureConnection.ts`), chunks are base64-encoded twice:

```typescript
// Inner message (before encryption)
interface RelayUploadChunk {
  type: "upload_chunk";
  uploadId: string;
  offset: number;
  data: string;  // First base64: raw bytes → base64
}

// After encryption, wrapped in EncryptedEnvelope
// Second base64: ciphertext → base64
```

**Wire cost for 1MB upload chunk:**
- Original: 1 MB
- After inner base64 (`data` field): ~1.33 MB
- After encryption: ~1.33 MB + 16 bytes (Poly1305 MAC)
- After outer base64 (envelope): **~1.77 MB**
- **Total overhead: 77%**

### WebSocket Paths Overview

| Path | File | Current Format | Target Format |
|------|------|----------------|---------------|
| Direct upload WS | `upload.ts` | Binary frames | No change needed |
| Unencrypted relay | `WebSocketConnection.ts` | JSON text + base64 | Binary frames |
| Encrypted relay | `SecureConnection.ts` | JSON + base64 + encrypt + base64 | Binary encrypted frames |

The unencrypted relay path is maintained for:
- Local development without auth overhead
- Testing binary format changes before adding encryption
- Architectural separation of concerns

### Message Flow

```
Current (JSON):
  plaintext JSON
  → JSON.stringify
  → encrypt (produces binary ciphertext)
  → base64 encode nonce + ciphertext
  → JSON.stringify envelope
  → ws.send(text frame)
```

## Target State

### Binary Envelope

Replace JSON envelope with raw binary:

```
[24 bytes: nonce][rest: ciphertext]
```

- No base64 overhead
- No JSON framing overhead
- WebSocket binary frame instead of text frame

### Inner Format Byte

Put format discriminator inside ciphertext to avoid metadata leakage:

```
After decryption:
[1 byte: format][payload]

Format values:
  0x01 = raw JSON (UTF-8 encoded)
  0x02 = binary upload chunk
  0x03 = gzip-compressed JSON
  0x04-0xFF = reserved for future use
```

An observer sees only encrypted blobs of varying sizes - cannot distinguish message types.

### Binary Upload Chunk Format

When format = 0x02:

```
[16 bytes: uploadId as raw UUID bytes]
[8 bytes: offset, big-endian uint64]
[rest: raw chunk data]
```

**Wire cost for 1MB upload chunk (after optimization):**
- Original: 1 MB
- Inner format + header: 25 bytes
- After encryption: ~1 MB + 16 bytes MAC
- **Total overhead: ~0.004%** (vs 77% before)

### Compression for Large JSON

For large JSON payloads (session files can be 1MB+), gzip compression before encryption:

```
Format 0x03:
[1 byte: 0x03][gzip-compressed JSON bytes]
```

**Compression candidates:**
- Session streaming data (JSONL, highly repetitive structure)
- Large API responses
- NOT upload chunks (images/PDFs already compressed)

**Threshold:** Only compress if payload > 1KB to avoid overhead on small messages.

**Browser API:** Native `CompressionStream` / `DecompressionStream` only (Chrome 80+, Firefox 113+, Safari 16.4+). No polyfill - older browsers get uncompressed JSON.

### Compression Negotiation

Compression is **client-controlled**. The server does not currently send unsolicited JSON messages (all server→client messages are responses to client requests or subscriptions).

**Negotiation approach:**
1. Client sends a capabilities message immediately after authentication (first encrypted message)
2. Message indicates supported formats: `{ "capabilities": { "formats": [0x01, 0x02, 0x03] } }`
3. Server records client capabilities and only uses formats the client supports
4. Client can use any format it wants; server must handle all defined formats

**Fallback:** If no capabilities message received, server assumes client only supports `0x01` (raw JSON). This maintains backward compatibility with older clients.

### Message Flow (Target)

```
Target (Binary):
  plaintext
  → maybe gzip (if large JSON)
  → prepend format byte
  → encrypt
  → prepend nonce
  → ws.send(binary frame)
```

## Distinguishing Encrypted vs Plaintext

SRP handshake messages are plaintext JSON (before encryption is established). After auth, all messages are encrypted binary.

**Detection method:** WebSocket frame type
- Text frame (`typeof event.data === 'string'`) → plaintext JSON (SRP)
- Binary frame (`event.data instanceof ArrayBuffer`) → encrypted

No additional framing needed; WebSocket protocol already distinguishes.

## Envelope Extensibility

The outer envelope includes a version byte for future-proofing:

```
[1 byte: version][24 bytes: nonce][ciphertext]

Version 0x01 = initial binary format (format byte inside ciphertext)
```

This allows incompatible protocol changes without breaking existing clients. The version byte is outside ciphertext (minor metadata leak: "which protocol version") but enables graceful upgrades.

### Potential Future Fields

| Field | Purpose | Notes |
|-------|---------|-------|
| Key ID | Multi-key support | If we ever rotate keys mid-session |
| Sequence number | Ordering/replay detection | Random nonce already prevents replay |
| Flags | Feature negotiation | Compression, etc. (but format byte inside is better) |

These could be added in a future version (0x02+) if needed.

## Implementation Phases

These optimizations can be implemented independently. The unencrypted WebSocket relay path is maintained for testing and architectural cleanliness.

### Phase 0: Binary Format for Unencrypted Relay (Test Bed)
- Add binary frame support to unencrypted `WebSocketConnection.ts` and server `ws-relay.ts`
- Same inner format: `[format byte][payload]`
- No encryption wrapper - raw binary WebSocket frames
- Allows testing binary parsing/serialization without encryption complexity
- **Files:** `WebSocketConnection.ts`, `ws-relay.ts`, `relay.ts` types

**Unit tests** (`packages/shared/test/`):
- `binary-framing.test.ts` - Format byte encoding/decoding
  - Encode/decode format 0x01 (raw JSON)
  - Round-trip JSON messages through binary format
  - Handle UTF-8 edge cases (emoji, multi-byte chars)
  - Reject invalid format bytes

**Server E2E tests** (`packages/server/test/e2e/`):
- Add to `ws-transport.e2e.test.ts`:
  - `should handle binary frame with format 0x01 (JSON)`
  - `should handle text frame fallback for backwards compat`
  - `should reject unknown format bytes`
  - `should handle mixed text/binary frames`

**Browser E2E tests** (`packages/client/e2e/`):
- Add to `ws-transport.spec.ts`:
  - `can send binary frame with format 0x01`
  - `can receive binary frame response`
  - `handles ArrayBuffer correctly in browser`

### Phase 1: Binary Encrypted Envelope
- Wrap binary format with encryption: `[version][nonce][ciphertext]`
- Include version byte from the start (0x01)
- Encrypted inner payload uses same format as Phase 0
- **Files:** `nacl-wrapper.ts` (client + server), `ws-relay.ts`, `SecureConnection.ts`, `encryption-types.ts`

**Unit tests** (`packages/server/test/crypto/`):
- `binary-envelope.test.ts` - Binary encrypted envelope
  - Encode/decode `[version][nonce][ciphertext]`
  - Version byte 0x01 validation
  - Reject invalid version bytes
  - Round-trip encrypt/decrypt with format byte inside

**Server E2E tests** (`packages/server/test/e2e/`):
- Add to `ws-secure.e2e.test.ts`:
  - `should handle binary encrypted frame`
  - `should send binary encrypted response`
  - `should distinguish text (SRP) from binary (encrypted) frames`
  - `should reject binary frame before auth complete`

**Browser E2E tests** (`packages/client/e2e/`):
- Add to `ws-secure.spec.ts`:
  - `can send/receive binary encrypted frames after SRP`
  - `handles ArrayBuffer encryption in browser`
  - `version byte validation`

### Phase 2: Binary Upload Chunks
- New format `0x02` for upload chunks
- Eliminates base64 in upload chunk data (~33% savings on uploads for unencrypted, ~77% for encrypted)
- Works on both unencrypted and encrypted paths
- **Files:** `SecureConnection.ts`, `WebSocketConnection.ts`, `ws-relay.ts`, `relay.ts` types

**Unit tests** (`packages/shared/test/`):
- Add to `binary-framing.test.ts`:
  - Encode/decode format 0x02 (binary upload chunk)
  - Parse uploadId UUID from 16 bytes
  - Parse offset from 8-byte big-endian uint64
  - Handle large offsets (>4GB)
  - Round-trip binary chunk data

**Unit tests** (`packages/client/src/api/`):
- Update `upload.test.ts`:
  - `sends binary format 0x02 chunks (not base64 JSON)`
  - `correctly encodes uploadId as 16-byte UUID`
  - `correctly encodes offset as big-endian uint64`

**Server E2E tests** (`packages/server/test/e2e/`):
- Add to `ws-transport.e2e.test.ts`:
  - `should handle binary upload chunk format 0x02`
  - `should accept mixed JSON start/end with binary chunks`
  - `should handle large file with binary chunks`
  - `should report correct progress with binary chunks`

- Add to `ws-secure.e2e.test.ts`:
  - `should handle encrypted binary upload chunk`
  - `should complete upload with binary chunks through encrypted relay`

**Browser E2E tests** (`packages/client/e2e/`):
- Add upload tests:
  - `can upload file using binary chunks (unencrypted relay)`
  - `can upload file using binary chunks (encrypted relay)`
  - `upload progress works with binary chunks`

### Phase 3: Compression
- New format `0x03` for gzip-compressed JSON
- Client-controlled via capabilities negotiation
- Threshold-based (>1KB)
- Significant savings on session file streaming
- Works on both unencrypted and encrypted paths
- **Files:** Same as above, plus compression utilities, capabilities message type

**Unit tests** (`packages/shared/test/`):
- `compression.test.ts` - Compression utilities
  - Compress/decompress JSON payloads
  - Verify gzip format output
  - Round-trip various payload sizes
  - Threshold logic (skip compression <1KB)
  - Handle already-compressed data gracefully

**Unit tests** (`packages/server/test/`):
- `capabilities.test.ts` - Capabilities negotiation
  - Parse capabilities message
  - Store client format support
  - Default to 0x01 only when no capabilities
  - Validate format arrays

**Server E2E tests** (`packages/server/test/e2e/`):
- Add to `ws-transport.e2e.test.ts`:
  - `should handle compressed JSON format 0x03`
  - `should decompress and parse message correctly`
  - `should send compressed response when client supports it`
  - `should skip compression for small payloads (<1KB)`

- Add to `ws-secure.e2e.test.ts`:
  - `should handle capabilities message after auth`
  - `should send compressed encrypted responses`
  - `should fall back to 0x01 without capabilities`

**Browser E2E tests** (`packages/client/e2e/`):
- `ws-compression.spec.ts`:
  - `can send capabilities message after auth`
  - `can receive compressed response`
  - `CompressionStream API works in browser`
  - `large session data is compressed`
  - `small messages are not compressed`

## Wire Format Summary

### Outer Envelope

```
[1 byte: version = 0x01][24 bytes: nonce][ciphertext]
```

Total overhead: 25 bytes + 16 bytes MAC = 41 bytes per message.

### Inner Payload (after decryption)

```
[1 byte: format][payload]

Format 0x01 - Raw JSON:
  [UTF-8 encoded JSON string]

Format 0x02 - Binary Upload Chunk:
  [16 bytes: uploadId UUID]
  [8 bytes: offset, big-endian uint64]
  [raw bytes: chunk data]

Format 0x03 - Compressed JSON:
  [gzip-compressed UTF-8 JSON]
```

## Security Considerations

- **Metadata leakage:** Format byte is inside ciphertext, preventing traffic analysis based on message type
- **Nonce uniqueness:** Random 24-byte nonce per message (XSalsa20 requirement)
- **Authentication:** NaCl secretbox includes Poly1305 MAC (16 bytes)
- **Replay protection:** Random nonces prevent replay; no sequence numbers needed
- **Compression oracle attacks:** Compressing before encryption can leak info if attacker controls part of plaintext. For our use case (user's own data, no attacker-controlled content mixed in), this is low risk.

## Bandwidth Savings Estimate

| Message Type | Current Overhead | After Optimization |
|--------------|------------------|-------------------|
| Small JSON (<1KB) | ~40% (base64 + JSON framing) | ~3% (nonce + MAC + format byte) |
| Large JSON (1MB session) | ~40% | ~3% + compression (5-10x smaller) |
| Upload chunk (1MB) | ~77% (double base64) | ~0.004% |

## Design Decisions

- **Version byte:** Include from the start (0x01)
- **Upload chunk offset:** 8 bytes (uint64) for large file support
- **Compression:** Client-controlled via capabilities negotiation
- **Compression library:** Native `CompressionStream` only (no polyfill)
- **Compression threshold:** 1KB
- **Capabilities timing:** Post-auth message (first encrypted message after SRP completes)

## References

- Current implementation: `packages/shared/src/crypto/encryption-types.ts`
- NaCl secretbox: XSalsa20-Poly1305 authenticated encryption
- [CompressionStream MDN](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream)
