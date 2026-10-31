import type { RemoteClientMessage } from "@yep-anywhere/shared";
import {
  MIN_BINARY_ENVELOPE_LENGTH,
  isEncryptedEnvelope,
  isSequencedEncryptedPayload,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ConnectionState, WSAdapter } from "./ws-relay-handlers.js";
import {
  hasEstablishedSrpTransport,
  tryLockWsConnectionMode,
} from "./ws-transport-auth.js";

/**
 * Check if binary data is a binary encrypted envelope.
 * Binary envelope: [1 byte: version 0x01][24 bytes: nonce][ciphertext]
 * vs Phase 0 binary: [1 byte: format 0x01-0x03][payload]
 *
 * The auth state is the primary discriminator:
 * authenticated connections always use encrypted envelopes, while
 * unauthenticated connections use Phase 0 frames. These are mutually exclusive
 * because clients must complete SRP before sending application messages.
 */
export function isBinaryEncryptedEnvelope(
  bytes: Uint8Array,
  connState: ConnectionState,
): boolean {
  if (!hasEstablishedSrpTransport(connState)) {
    if (bytes.length >= MIN_BINARY_ENVELOPE_LENGTH && bytes[0] === 0x01) {
      getLogger().warn(
        `[WS Relay] Binary envelope rejected: authState=${connState.authState}, hasKey=${!!connState.sessionKey}`,
      );
    }
    return false;
  }

  if (bytes.length < MIN_BINARY_ENVELOPE_LENGTH) {
    return false;
  }

  if (bytes[0] !== 0x01) {
    return false;
  }

  return true;
}

/**
 * Enforce that an SRP-authenticated connection does not send plaintext binary frames.
 * Returns true when the message was rejected and the caller should stop processing.
 */
export function rejectPlaintextBinaryWhenEncryptedRequired(
  ws: WSAdapter,
  connState: ConnectionState,
  srpRequiredPolicy: boolean,
): boolean {
  if (
    srpRequiredPolicy &&
    hasEstablishedSrpTransport(connState) &&
    connState.requiresEncryptedMessages
  ) {
    getLogger().warn(
      "[WS Relay] Received plaintext binary frame after authentication",
    );
    ws.close(4005, "Encrypted message required");
    return true;
  }

  return false;
}

function validateInboundSequence(
  ws: WSAdapter,
  connState: Pick<ConnectionState, "lastInboundSeq">,
  seq: number,
): boolean {
  const last = connState.lastInboundSeq;
  if (last === null && seq !== 0) {
    getLogger().warn(
      `[WS Relay] Invalid initial encrypted sequence: expected 0, got ${seq}`,
    );
    ws.close(4004, "Invalid sequence");
    return false;
  }
  if (last !== null && seq <= last) {
    getLogger().warn(
      `[WS Relay] Replay/old encrypted sequence rejected: seq=${seq}, last=${last}`,
    );
    ws.close(4004, "Replay detected");
    return false;
  }
  connState.lastInboundSeq = seq;
  return true;
}

export function unwrapSequencedClientMessage(
  ws: WSAdapter,
  connState: Pick<ConnectionState, "lastInboundSeq">,
  parsed: unknown,
): RemoteClientMessage | null {
  if (!isSequencedEncryptedPayload(parsed)) {
    getLogger().warn("[WS Relay] Missing encrypted sequence wrapper");
    ws.close(4004, "Invalid sequence");
    return null;
  }

  if (!validateInboundSequence(ws, connState, parsed.seq)) {
    return null;
  }

  return parsed.msg as RemoteClientMessage;
}

type PublicShareReadRequest = RemoteClientMessage & { type: "request" };

function canonicalizePublicShareRequestTarget(path: string): string | null {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#")
  ) {
    return null;
  }
  let target: URL;
  try {
    target = new URL(path, "http://relay.internal");
  } catch {
    return null;
  }
  if (target.origin !== "http://relay.internal") return null;
  const canonicalTarget = `${target.pathname}${target.search}`;
  if (canonicalTarget !== path) return null;
  if (
    !/^\/public-api\/shares\/[A-Za-z0-9_-]+(?:\/(?:metadata|session-chunks|files(?:\/raw)?))?$/.test(
      target.pathname,
    )
  ) {
    return null;
  }
  return canonicalTarget;
}

function getPublicShareReadRequest(
  parsed: unknown,
): PublicShareReadRequest | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const message = parsed as {
    body?: unknown;
    method?: unknown;
    path?: unknown;
    type?: unknown;
  };
  if (
    message.type !== "request" ||
    message.method !== "GET" ||
    typeof message.path !== "string" ||
    message.body !== undefined
  ) {
    return null;
  }
  const path = canonicalizePublicShareRequestTarget(message.path);
  return path
    ? ({
        ...(parsed as PublicShareReadRequest),
        path,
      } as PublicShareReadRequest)
    : null;
}

/**
 * Parse an application-level message after SRP control messages are ruled out.
 * Handles plaintext policy checks and rejects obsolete encrypted text envelopes.
 * Returns null if the message was rejected/closed.
 */
export function parseApplicationClientMessage(
  ws: WSAdapter,
  connState: ConnectionState,
  srpRequiredPolicy: boolean,
  parsed: unknown,
): RemoteClientMessage | null {
  if (isEncryptedEnvelope(parsed)) {
    if (!hasEstablishedSrpTransport(connState)) {
      getLogger().warn(
        "[WS Relay] Received encrypted message but not authenticated",
      );
      ws.close(4001, "Authentication required");
      return null;
    }

    getLogger().warn("[WS Relay] Received obsolete encrypted text envelope");
    ws.close(4005, "Binary encrypted message required");
    return null;
  }

  if (srpRequiredPolicy && !hasEstablishedSrpTransport(connState)) {
    const publicShareRequest = getPublicShareReadRequest(parsed);
    if (
      publicShareRequest &&
      tryLockWsConnectionMode(connState, "public_read_only")
    ) {
      return publicShareRequest;
    }
    getLogger().warn("[WS Relay] Received plaintext message but auth required");
    ws.close(4001, "Authentication required");
    return null;
  }

  if (
    srpRequiredPolicy &&
    hasEstablishedSrpTransport(connState) &&
    connState.requiresEncryptedMessages
  ) {
    getLogger().warn(
      "[WS Relay] Received plaintext message after authentication",
    );
    ws.close(4005, "Encrypted message required");
    return null;
  }

  return parsed as RemoteClientMessage;
}
