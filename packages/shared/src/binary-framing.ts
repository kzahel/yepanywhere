/**
 * Binary framing utilities for WebSocket relay protocol (Phase 0).
 *
 * Wire format for unencrypted binary frames:
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
