/**
 * Binary framing utilities for WebSocket relay protocol.
 *
 * Phase 0 - Unencrypted binary frames:
 * [1 byte: format][payload]
 *
 * Phase 1 - Encrypted binary envelope:
 * [1 byte: version][24 bytes: nonce][ciphertext]
 *
 * The ciphertext decrypts to:
 * [1 byte: format][payload]
 *
 * Format values:
 *   0x01 = UTF-8 JSON string
 *   0x02 = binary upload chunk (future - Phase 2)
 *   0x03 = gzip-compressed JSON (future - Phase 3)
 *   0x04-0xFF = reserved
 */

/** Format byte values for binary WebSocket frames */
export const BinaryFormat = {
  /** UTF-8 encoded JSON string */
  JSON: 0x01,
  /** Binary upload chunk (Phase 2) */
  BINARY_UPLOAD: 0x02,
  /** Gzip-compressed JSON (Phase 3) */
  COMPRESSED_JSON: 0x03,
} as const;

export type BinaryFormatValue =
  (typeof BinaryFormat)[keyof typeof BinaryFormat];

/** Error thrown when binary frame parsing fails */
export class BinaryFrameError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_FORMAT" | "INVALID_UTF8" | "INVALID_JSON",
  ) {
    super(message);
    this.name = "BinaryFrameError";
  }
}

/**
 * Encode a JSON message as a binary frame with format byte 0x01.
 *
 * @param message - Any JSON-serializable value
 * @returns ArrayBuffer containing [0x01][UTF-8 JSON bytes]
 */
export function encodeJsonFrame(message: unknown): ArrayBuffer {
  const json = JSON.stringify(message);
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(json);

  // Create buffer with format byte + JSON payload
  const buffer = new ArrayBuffer(1 + jsonBytes.length);
  const view = new Uint8Array(buffer);
  view[0] = BinaryFormat.JSON;
  view.set(jsonBytes, 1);

  return buffer;
}

/**
 * Decode a binary frame and return its format and payload.
 *
 * @param data - ArrayBuffer or Uint8Array containing the binary frame
 * @returns Object with format byte and remaining payload bytes
 * @throws BinaryFrameError if format byte is unknown
 */
export function decodeBinaryFrame(data: ArrayBuffer | Uint8Array): {
  format: BinaryFormatValue;
  payload: Uint8Array;
} {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

  if (bytes.length === 0) {
    throw new BinaryFrameError("Empty binary frame", "UNKNOWN_FORMAT");
  }

  const format = bytes[0] as number;

  // Validate format byte
  if (
    format !== BinaryFormat.JSON &&
    format !== BinaryFormat.BINARY_UPLOAD &&
    format !== BinaryFormat.COMPRESSED_JSON
  ) {
    throw new BinaryFrameError(
      `Unknown format byte: 0x${format.toString(16).padStart(2, "0")}`,
      "UNKNOWN_FORMAT",
    );
  }

  return {
    format: format as BinaryFormatValue,
    payload: bytes.slice(1),
  };
}

/**
 * Decode a JSON binary frame (format 0x01) directly to a parsed object.
 *
 * @param data - ArrayBuffer or Uint8Array containing the binary frame
 * @returns Parsed JSON value
 * @throws BinaryFrameError if frame is invalid or not format 0x01
 */
export function decodeJsonFrame<T = unknown>(
  data: ArrayBuffer | Uint8Array,
): T {
  const { format, payload } = decodeBinaryFrame(data);

  if (format !== BinaryFormat.JSON) {
    throw new BinaryFrameError(
      `Expected JSON format (0x01), got 0x${format.toString(16).padStart(2, "0")}`,
      "UNKNOWN_FORMAT",
    );
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let json: string;
  try {
    json = decoder.decode(payload);
  } catch {
    throw new BinaryFrameError("Invalid UTF-8 in payload", "INVALID_UTF8");
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    throw new BinaryFrameError("Invalid JSON in payload", "INVALID_JSON");
  }
}

/**
 * Check if data is a binary frame (ArrayBuffer or Buffer) vs text frame (string).
 *
 * In browser: binary data is ArrayBuffer
 * In Node.js: binary data is Buffer (which is Uint8Array)
 *
 * @param data - WebSocket message data
 * @returns true if data is binary, false if string
 */
export function isBinaryData(data: unknown): data is ArrayBuffer | Uint8Array {
  if (typeof data === "string") {
    return false;
  }
  // ArrayBuffer in browser
  if (data instanceof ArrayBuffer) {
    return true;
  }
  // Buffer or Uint8Array in Node.js (Buffer extends Uint8Array)
  if (data instanceof Uint8Array) {
    return true;
  }
  return false;
}

// =============================================================================
// Phase 1: Binary Encrypted Envelope
// =============================================================================

/**
 * Version byte values for binary encrypted envelope.
 * The version byte is outside the ciphertext to allow for protocol evolution.
 */
export const BinaryEnvelopeVersion = {
  /** Initial binary format (format byte inside ciphertext) */
  V1: 0x01,
} as const;

export type BinaryEnvelopeVersionValue =
  (typeof BinaryEnvelopeVersion)[keyof typeof BinaryEnvelopeVersion];

/** Length of NaCl secretbox nonce (24 bytes) */
export const NONCE_LENGTH = 24;

/** Length of version byte (1 byte) */
export const VERSION_LENGTH = 1;

/** Minimum binary envelope length: version (1) + nonce (24) + MAC (16) + format (1) */
export const MIN_BINARY_ENVELOPE_LENGTH =
  VERSION_LENGTH + NONCE_LENGTH + 16 + 1;

/** Error thrown when binary envelope parsing fails */
export class BinaryEnvelopeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNKNOWN_VERSION"
      | "INVALID_LENGTH"
      | "DECRYPTION_FAILED"
      | "INVALID_FORMAT",
  ) {
    super(message);
    this.name = "BinaryEnvelopeError";
  }
}

/**
 * Parsed components of a binary encrypted envelope.
 * Used for decryption - provides version, nonce, and ciphertext separately.
 */
export interface BinaryEnvelopeComponents {
  /** Protocol version (0x01 = initial) */
  version: BinaryEnvelopeVersionValue;
  /** Random 24-byte nonce */
  nonce: Uint8Array;
  /** Encrypted payload (format byte + inner payload) */
  ciphertext: Uint8Array;
}

/**
 * Parse a binary encrypted envelope into its components.
 *
 * Wire format: [1 byte: version][24 bytes: nonce][ciphertext]
 *
 * @param data - ArrayBuffer or Uint8Array containing the envelope
 * @returns Parsed components (version, nonce, ciphertext)
 * @throws BinaryEnvelopeError if envelope is invalid
 */
export function parseBinaryEnvelope(
  data: ArrayBuffer | Uint8Array,
): BinaryEnvelopeComponents {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

  if (bytes.length < MIN_BINARY_ENVELOPE_LENGTH) {
    throw new BinaryEnvelopeError(
      `Binary envelope too short: ${bytes.length} bytes (minimum ${MIN_BINARY_ENVELOPE_LENGTH})`,
      "INVALID_LENGTH",
    );
  }

  const version = bytes[0] as number;

  // Validate version byte
  if (version !== BinaryEnvelopeVersion.V1) {
    throw new BinaryEnvelopeError(
      `Unknown envelope version: 0x${version.toString(16).padStart(2, "0")}`,
      "UNKNOWN_VERSION",
    );
  }

  const nonce = bytes.slice(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH);
  const ciphertext = bytes.slice(VERSION_LENGTH + NONCE_LENGTH);

  return {
    version: version as BinaryEnvelopeVersionValue,
    nonce,
    ciphertext,
  };
}

/**
 * Create a binary encrypted envelope from components.
 *
 * @param nonce - 24-byte random nonce
 * @param ciphertext - Encrypted payload
 * @param version - Protocol version (default: V1)
 * @returns ArrayBuffer containing [version][nonce][ciphertext]
 */
export function createBinaryEnvelope(
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  version: BinaryEnvelopeVersionValue = BinaryEnvelopeVersion.V1,
): ArrayBuffer {
  if (nonce.length !== NONCE_LENGTH) {
    throw new BinaryEnvelopeError(
      `Invalid nonce length: ${nonce.length} (expected ${NONCE_LENGTH})`,
      "INVALID_LENGTH",
    );
  }

  const buffer = new ArrayBuffer(
    VERSION_LENGTH + NONCE_LENGTH + ciphertext.length,
  );
  const view = new Uint8Array(buffer);

  view[0] = version;
  view.set(nonce, VERSION_LENGTH);
  view.set(ciphertext, VERSION_LENGTH + NONCE_LENGTH);

  return buffer;
}

/**
 * Prepend a format byte to a payload.
 * Used before encryption to create the inner payload.
 *
 * @param format - Format byte (0x01 = JSON, 0x02 = binary upload, 0x03 = compressed)
 * @param payload - Raw payload bytes
 * @returns Uint8Array with [format][payload]
 */
export function prependFormatByte(
  format: BinaryFormatValue,
  payload: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(1 + payload.length);
  result[0] = format;
  result.set(payload, 1);
  return result;
}

/**
 * Extract format byte and payload from decrypted data.
 *
 * @param decrypted - Decrypted bytes from envelope
 * @returns Object with format byte and payload
 * @throws BinaryEnvelopeError if format byte is invalid
 */
export function extractFormatAndPayload(decrypted: Uint8Array): {
  format: BinaryFormatValue;
  payload: Uint8Array;
} {
  if (decrypted.length === 0) {
    throw new BinaryEnvelopeError("Empty decrypted payload", "INVALID_FORMAT");
  }

  const format = decrypted[0] as number;

  // Validate format byte
  if (
    format !== BinaryFormat.JSON &&
    format !== BinaryFormat.BINARY_UPLOAD &&
    format !== BinaryFormat.COMPRESSED_JSON
  ) {
    throw new BinaryEnvelopeError(
      `Unknown format byte: 0x${format.toString(16).padStart(2, "0")}`,
      "INVALID_FORMAT",
    );
  }

  return {
    format: format as BinaryFormatValue,
    payload: decrypted.slice(1),
  };
}

// =============================================================================
// Phase 2: Binary Upload Chunks
// =============================================================================

/** Length of UUID in bytes (16 bytes) */
export const UUID_BYTE_LENGTH = 16;

/** Length of offset in bytes (8 bytes, big-endian uint64) */
export const OFFSET_BYTE_LENGTH = 8;

/** Header size for binary upload chunk: UUID (16) + offset (8) = 24 bytes */
export const UPLOAD_CHUNK_HEADER_SIZE = UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH;

/** Error thrown when upload chunk parsing fails */
export class UploadChunkError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_UUID"
      | "INVALID_OFFSET"
      | "INVALID_LENGTH"
      | "INVALID_FORMAT",
  ) {
    super(message);
    this.name = "UploadChunkError";
  }
}

/**
 * Parsed binary upload chunk data.
 */
export interface UploadChunkData {
  /** Upload ID as UUID string (with hyphens) */
  uploadId: string;
  /** Byte offset in the file */
  offset: number;
  /** Raw chunk bytes */
  data: Uint8Array;
}

/**
 * Convert a UUID string to 16 raw bytes.
 * Supports both hyphenated (8-4-4-4-12) and non-hyphenated (32 chars) formats.
 *
 * @param uuid - UUID string
 * @returns 16-byte Uint8Array
 * @throws UploadChunkError if UUID is invalid
 */
export function uuidToBytes(uuid: string): Uint8Array {
  // Remove hyphens if present
  const hex = uuid.replace(/-/g, "");

  if (hex.length !== 32) {
    throw new UploadChunkError(
      `Invalid UUID length: ${uuid} (expected 32 hex chars after removing hyphens)`,
      "INVALID_UUID",
    );
  }

  // Validate hex characters
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new UploadChunkError(
      `Invalid UUID: ${uuid} (contains non-hex characters)`,
      "INVALID_UUID",
    );
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert 16 raw bytes to a UUID string with hyphens.
 *
 * @param bytes - 16-byte Uint8Array
 * @returns UUID string in format 8-4-4-4-12
 * @throws UploadChunkError if bytes length is not 16
 */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new UploadChunkError(
      `Invalid UUID bytes length: ${bytes.length} (expected 16)`,
      "INVALID_UUID",
    );
  }

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Format as 8-4-4-4-12
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Encode a 64-bit unsigned integer as 8 bytes in big-endian format.
 * JavaScript numbers can safely represent integers up to 2^53-1.
 *
 * @param value - Non-negative integer offset
 * @returns 8-byte Uint8Array in big-endian format
 * @throws UploadChunkError if value is negative or too large
 */
export function offsetToBytes(value: number): Uint8Array {
  if (value < 0) {
    throw new UploadChunkError(
      `Invalid offset: ${value} (must be non-negative)`,
      "INVALID_OFFSET",
    );
  }

  if (!Number.isInteger(value)) {
    throw new UploadChunkError(
      `Invalid offset: ${value} (must be an integer)`,
      "INVALID_OFFSET",
    );
  }

  if (value > Number.MAX_SAFE_INTEGER) {
    throw new UploadChunkError(
      `Invalid offset: ${value} (exceeds MAX_SAFE_INTEGER)`,
      "INVALID_OFFSET",
    );
  }

  const bytes = new Uint8Array(8);
  // Use DataView for big-endian encoding
  // Split into high 32 bits and low 32 bits
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;

  const view = new DataView(bytes.buffer);
  view.setUint32(0, high, false); // Big-endian
  view.setUint32(4, low, false); // Big-endian

  return bytes;
}

/**
 * Decode 8 bytes in big-endian format to a 64-bit unsigned integer.
 *
 * @param bytes - 8-byte Uint8Array in big-endian format
 * @returns Decoded offset value
 * @throws UploadChunkError if bytes length is not 8 or value exceeds safe integer
 */
export function bytesToOffset(bytes: Uint8Array): number {
  if (bytes.length !== 8) {
    throw new UploadChunkError(
      `Invalid offset bytes length: ${bytes.length} (expected 8)`,
      "INVALID_OFFSET",
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(0, false); // Big-endian
  const low = view.getUint32(4, false); // Big-endian

  const value = high * 0x100000000 + low;

  if (value > Number.MAX_SAFE_INTEGER) {
    throw new UploadChunkError(
      `Offset exceeds MAX_SAFE_INTEGER: ${value}`,
      "INVALID_OFFSET",
    );
  }

  return value;
}

/**
 * Encode an upload chunk as a binary frame with format byte 0x02.
 *
 * Wire format:
 * [1 byte: 0x02][16 bytes: uploadId UUID][8 bytes: offset big-endian uint64][data]
 *
 * @param uploadId - Upload ID as UUID string
 * @param offset - Byte offset in the file
 * @param data - Raw chunk data
 * @returns ArrayBuffer containing the binary frame
 */
export function encodeUploadChunkFrame(
  uploadId: string,
  offset: number,
  data: Uint8Array,
): ArrayBuffer {
  const uuidBytes = uuidToBytes(uploadId);
  const offsetBytes = offsetToBytes(offset);

  // Format byte (1) + UUID (16) + offset (8) + data
  const totalSize = 1 + UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH + data.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new Uint8Array(buffer);

  let pos = 0;
  view[pos++] = BinaryFormat.BINARY_UPLOAD;
  view.set(uuidBytes, pos);
  pos += UUID_BYTE_LENGTH;
  view.set(offsetBytes, pos);
  pos += OFFSET_BYTE_LENGTH;
  view.set(data, pos);

  return buffer;
}

/**
 * Decode a binary upload chunk frame (format 0x02) to structured data.
 *
 * @param data - ArrayBuffer or Uint8Array containing the binary frame
 * @returns Parsed upload chunk data
 * @throws UploadChunkError if frame is invalid
 * @throws BinaryFrameError if format byte is not 0x02
 */
export function decodeUploadChunkFrame(
  data: ArrayBuffer | Uint8Array,
): UploadChunkData {
  const { format, payload } = decodeBinaryFrame(data);

  if (format !== BinaryFormat.BINARY_UPLOAD) {
    throw new BinaryFrameError(
      `Expected binary upload format (0x02), got 0x${format.toString(16).padStart(2, "0")}`,
      "UNKNOWN_FORMAT",
    );
  }

  return decodeUploadChunkPayload(payload);
}

/**
 * Decode an upload chunk payload (without format byte).
 * Used when format byte has already been extracted.
 *
 * @param payload - Uint8Array containing [UUID][offset][data]
 * @returns Parsed upload chunk data
 * @throws UploadChunkError if payload is invalid
 */
export function decodeUploadChunkPayload(payload: Uint8Array): UploadChunkData {
  if (payload.length < UPLOAD_CHUNK_HEADER_SIZE) {
    throw new UploadChunkError(
      `Upload chunk payload too short: ${payload.length} bytes (minimum ${UPLOAD_CHUNK_HEADER_SIZE})`,
      "INVALID_LENGTH",
    );
  }

  const uuidBytes = payload.slice(0, UUID_BYTE_LENGTH);
  const offsetBytes = payload.slice(
    UUID_BYTE_LENGTH,
    UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH,
  );
  const chunkData = payload.slice(UPLOAD_CHUNK_HEADER_SIZE);

  return {
    uploadId: bytesToUuid(uuidBytes),
    offset: bytesToOffset(offsetBytes),
    data: chunkData,
  };
}

/**
 * Encode upload chunk data (without format byte) for use inside encrypted envelope.
 * The format byte will be added when encrypting.
 *
 * @param uploadId - Upload ID as UUID string
 * @param offset - Byte offset in the file
 * @param data - Raw chunk data
 * @returns Uint8Array containing [UUID][offset][data]
 */
export function encodeUploadChunkPayload(
  uploadId: string,
  offset: number,
  data: Uint8Array,
): Uint8Array {
  const uuidBytes = uuidToBytes(uploadId);
  const offsetBytes = offsetToBytes(offset);

  // UUID (16) + offset (8) + data
  const totalSize = UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH + data.length;
  const result = new Uint8Array(totalSize);

  let pos = 0;
  result.set(uuidBytes, pos);
  pos += UUID_BYTE_LENGTH;
  result.set(offsetBytes, pos);
  pos += OFFSET_BYTE_LENGTH;
  result.set(data, pos);

  return result;
}
