import { describe, expect, it } from "vitest";
import {
  BinaryEnvelopeError,
  BinaryEnvelopeVersion,
  BinaryFormat,
  BinaryFrameError,
  MIN_BINARY_ENVELOPE_LENGTH,
  NONCE_LENGTH,
  OFFSET_BYTE_LENGTH,
  UPLOAD_CHUNK_HEADER_SIZE,
  UUID_BYTE_LENGTH,
  UploadChunkError,
  VERSION_LENGTH,
  bytesToOffset,
  bytesToUuid,
  createBinaryEnvelope,
  decodeBinaryFrame,
  decodeJsonFrame,
  decodeUploadChunkFrame,
  decodeUploadChunkPayload,
  encodeJsonFrame,
  encodeUploadChunkFrame,
  encodeUploadChunkPayload,
  extractFormatAndPayload,
  isBinaryData,
  offsetToBytes,
  parseBinaryEnvelope,
  prependFormatByte,
  uuidToBytes,
} from "../src/binary-framing.js";

describe("binary-framing", () => {
  describe("encodeJsonFrame", () => {
    it("encodes a simple object", () => {
      const msg = { type: "request", id: "123" };
      const result = encodeJsonFrame(msg);

      expect(result).toBeInstanceOf(ArrayBuffer);
      const bytes = new Uint8Array(result);
      expect(bytes[0]).toBe(BinaryFormat.JSON);

      // Decode the rest as UTF-8 JSON
      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toEqual(msg);
    });

    it("encodes null", () => {
      const result = encodeJsonFrame(null);
      const bytes = new Uint8Array(result);
      expect(bytes[0]).toBe(BinaryFormat.JSON);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toBe(null);
    });

    it("encodes arrays", () => {
      const msg = [1, 2, 3];
      const result = encodeJsonFrame(msg);
      const bytes = new Uint8Array(result);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toEqual([1, 2, 3]);
    });

    it("encodes strings", () => {
      const msg = "hello world";
      const result = encodeJsonFrame(msg);
      const bytes = new Uint8Array(result);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toBe("hello world");
    });

    it("handles UTF-8 characters (emoji)", () => {
      const msg = { text: "Hello 👋 World 🌍" };
      const result = encodeJsonFrame(msg);
      const bytes = new Uint8Array(result);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toEqual({ text: "Hello 👋 World 🌍" });
    });

    it("handles multi-byte UTF-8 characters", () => {
      const msg = { text: "日本語テスト" };
      const result = encodeJsonFrame(msg);
      const bytes = new Uint8Array(result);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toEqual({ text: "日本語テスト" });
    });

    it("handles mixed ASCII and UTF-8", () => {
      const msg = { greeting: "Hello, 世界! 🎉 Привет мир!" };
      const result = encodeJsonFrame(msg);
      const bytes = new Uint8Array(result);

      const decoder = new TextDecoder();
      const json = decoder.decode(bytes.slice(1));
      expect(JSON.parse(json)).toEqual({
        greeting: "Hello, 世界! 🎉 Привет мир!",
      });
    });
  });

  describe("decodeBinaryFrame", () => {
    it("decodes a format 0x01 frame", () => {
      const payload = new TextEncoder().encode('{"test": true}');
      const buffer = new Uint8Array(1 + payload.length);
      buffer[0] = BinaryFormat.JSON;
      buffer.set(payload, 1);

      const result = decodeBinaryFrame(buffer);
      expect(result.format).toBe(BinaryFormat.JSON);
      expect(result.payload).toEqual(payload);
    });

    it("works with ArrayBuffer input", () => {
      const payload = new TextEncoder().encode('{"test": true}');
      const buffer = new ArrayBuffer(1 + payload.length);
      const view = new Uint8Array(buffer);
      view[0] = BinaryFormat.JSON;
      view.set(payload, 1);

      const result = decodeBinaryFrame(buffer);
      expect(result.format).toBe(BinaryFormat.JSON);
    });

    it("throws BinaryFrameError for empty frame", () => {
      const buffer = new Uint8Array(0);
      expect(() => decodeBinaryFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeBinaryFrame(buffer);
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryFrameError);
        expect((err as BinaryFrameError).code).toBe("UNKNOWN_FORMAT");
      }
    });

    it("throws BinaryFrameError for unknown format byte", () => {
      const buffer = new Uint8Array([0x00, 0x01, 0x02]); // 0x00 is invalid
      expect(() => decodeBinaryFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeBinaryFrame(buffer);
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryFrameError);
        expect((err as BinaryFrameError).code).toBe("UNKNOWN_FORMAT");
        expect((err as BinaryFrameError).message).toContain("0x00");
      }
    });

    it("throws for format byte 0x04 (reserved)", () => {
      const buffer = new Uint8Array([0x04, 0x01, 0x02]);
      expect(() => decodeBinaryFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeBinaryFrame(buffer);
      } catch (err) {
        expect((err as BinaryFrameError).code).toBe("UNKNOWN_FORMAT");
      }
    });

    it("throws for format byte 0xFF (reserved)", () => {
      const buffer = new Uint8Array([0xff, 0x01, 0x02]);
      expect(() => decodeBinaryFrame(buffer)).toThrow(BinaryFrameError);
    });

    it("accepts format 0x02 (BINARY_UPLOAD)", () => {
      const buffer = new Uint8Array([BinaryFormat.BINARY_UPLOAD, 0x01, 0x02]);
      const result = decodeBinaryFrame(buffer);
      expect(result.format).toBe(BinaryFormat.BINARY_UPLOAD);
      expect(result.payload).toEqual(new Uint8Array([0x01, 0x02]));
    });

    it("accepts format 0x03 (COMPRESSED_JSON)", () => {
      const buffer = new Uint8Array([BinaryFormat.COMPRESSED_JSON, 0x01, 0x02]);
      const result = decodeBinaryFrame(buffer);
      expect(result.format).toBe(BinaryFormat.COMPRESSED_JSON);
      expect(result.payload).toEqual(new Uint8Array([0x01, 0x02]));
    });
  });

  describe("decodeJsonFrame", () => {
    it("round-trips a simple object", () => {
      const original = {
        type: "request",
        id: "test-123",
        data: { foo: "bar" },
      };
      const encoded = encodeJsonFrame(original);
      const decoded = decodeJsonFrame(encoded);
      expect(decoded).toEqual(original);
    });

    it("round-trips UTF-8 content", () => {
      const original = { emoji: "👋🌍🎉", japanese: "こんにちは" };
      const encoded = encodeJsonFrame(original);
      const decoded = decodeJsonFrame(encoded);
      expect(decoded).toEqual(original);
    });

    it("round-trips complex nested structure", () => {
      const original = {
        type: "response",
        id: "resp-1",
        status: 200,
        body: {
          users: [
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ],
          meta: { total: 2, page: 1 },
        },
      };
      const encoded = encodeJsonFrame(original);
      const decoded = decodeJsonFrame(encoded);
      expect(decoded).toEqual(original);
    });

    it("throws BinaryFrameError for wrong format byte", () => {
      const buffer = new Uint8Array([BinaryFormat.BINARY_UPLOAD, 0x01, 0x02]);
      expect(() => decodeJsonFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeJsonFrame(buffer);
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryFrameError);
        expect((err as BinaryFrameError).code).toBe("UNKNOWN_FORMAT");
        expect((err as BinaryFrameError).message).toContain(
          "Expected JSON format",
        );
      }
    });

    it("throws BinaryFrameError for invalid UTF-8", () => {
      // Create a frame with format byte 0x01 but invalid UTF-8 payload
      const buffer = new Uint8Array([BinaryFormat.JSON, 0xff, 0xfe]);
      expect(() => decodeJsonFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeJsonFrame(buffer);
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryFrameError);
        expect((err as BinaryFrameError).code).toBe("INVALID_UTF8");
      }
    });

    it("throws BinaryFrameError for invalid JSON", () => {
      const payload = new TextEncoder().encode("not valid json {");
      const buffer = new Uint8Array(1 + payload.length);
      buffer[0] = BinaryFormat.JSON;
      buffer.set(payload, 1);

      expect(() => decodeJsonFrame(buffer)).toThrow(BinaryFrameError);
      try {
        decodeJsonFrame(buffer);
      } catch (err) {
        expect(err).toBeInstanceOf(BinaryFrameError);
        expect((err as BinaryFrameError).code).toBe("INVALID_JSON");
      }
    });

    it("handles empty JSON object", () => {
      const original = {};
      const encoded = encodeJsonFrame(original);
      const decoded = decodeJsonFrame(encoded);
      expect(decoded).toEqual({});
    });

    it("handles empty JSON array", () => {
      const original: unknown[] = [];
      const encoded = encodeJsonFrame(original);
      const decoded = decodeJsonFrame(encoded);
      expect(decoded).toEqual([]);
    });
  });

  describe("isBinaryData", () => {
    it("returns false for strings", () => {
      expect(isBinaryData("hello")).toBe(false);
      expect(isBinaryData("")).toBe(false);
      expect(isBinaryData('{"type":"test"}')).toBe(false);
    });

    it("returns true for ArrayBuffer", () => {
      const buffer = new ArrayBuffer(10);
      expect(isBinaryData(buffer)).toBe(true);
    });

    it("returns true for Uint8Array", () => {
      const array = new Uint8Array([1, 2, 3]);
      expect(isBinaryData(array)).toBe(true);
    });

    it("returns true for Buffer (Node.js)", () => {
      const buffer = Buffer.from([1, 2, 3]);
      expect(isBinaryData(buffer)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isBinaryData(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isBinaryData(undefined)).toBe(false);
    });

    it("returns false for numbers", () => {
      expect(isBinaryData(123)).toBe(false);
    });

    it("returns false for plain objects", () => {
      expect(isBinaryData({ type: "test" })).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isBinaryData([1, 2, 3])).toBe(false);
    });
  });

  describe("BinaryFormat constants", () => {
    it("has correct values", () => {
      expect(BinaryFormat.JSON).toBe(0x01);
      expect(BinaryFormat.BINARY_UPLOAD).toBe(0x02);
      expect(BinaryFormat.COMPRESSED_JSON).toBe(0x03);
    });
  });

  describe("BinaryFrameError", () => {
    it("has correct name", () => {
      const err = new BinaryFrameError("test message", "UNKNOWN_FORMAT");
      expect(err.name).toBe("BinaryFrameError");
    });

    it("has correct message", () => {
      const err = new BinaryFrameError("test message", "UNKNOWN_FORMAT");
      expect(err.message).toBe("test message");
    });

    it("has correct code", () => {
      const err = new BinaryFrameError("test message", "INVALID_UTF8");
      expect(err.code).toBe("INVALID_UTF8");
    });

    it("is instanceof Error", () => {
      const err = new BinaryFrameError("test", "UNKNOWN_FORMAT");
      expect(err).toBeInstanceOf(Error);
    });
  });
});

// =============================================================================
// Phase 1: Binary Encrypted Envelope Tests
// =============================================================================

describe("binary-envelope (Phase 1)", () => {
  describe("BinaryEnvelopeVersion constants", () => {
    it("has correct values", () => {
      expect(BinaryEnvelopeVersion.V1).toBe(0x01);
    });
  });

  describe("constants", () => {
    it("NONCE_LENGTH is 24", () => {
      expect(NONCE_LENGTH).toBe(24);
    });

    it("VERSION_LENGTH is 1", () => {
      expect(VERSION_LENGTH).toBe(1);
    });

    it("MIN_BINARY_ENVELOPE_LENGTH is correct", () => {
      // version (1) + nonce (24) + MAC (16) + format (1) = 42
      expect(MIN_BINARY_ENVELOPE_LENGTH).toBe(42);
    });
  });

  describe("prependFormatByte", () => {
    it("prepends format byte 0x01 to JSON payload", () => {
      const payload = new TextEncoder().encode('{"test":"data"}');
      const result = prependFormatByte(BinaryFormat.JSON, payload);

      expect(result[0]).toBe(BinaryFormat.JSON);
      expect(result.slice(1)).toEqual(payload);
    });

    it("prepends format byte 0x02 to binary payload", () => {
      const payload = new Uint8Array([0xff, 0xfe, 0xfd]);
      const result = prependFormatByte(BinaryFormat.BINARY_UPLOAD, payload);

      expect(result[0]).toBe(BinaryFormat.BINARY_UPLOAD);
      expect(result.slice(1)).toEqual(payload);
    });

    it("prepends format byte 0x03 to compressed payload", () => {
      const payload = new Uint8Array([0x1f, 0x8b, 0x08]); // gzip magic
      const result = prependFormatByte(BinaryFormat.COMPRESSED_JSON, payload);

      expect(result[0]).toBe(BinaryFormat.COMPRESSED_JSON);
      expect(result.slice(1)).toEqual(payload);
    });

    it("handles empty payload", () => {
      const payload = new Uint8Array(0);
      const result = prependFormatByte(BinaryFormat.JSON, payload);

      expect(result.length).toBe(1);
      expect(result[0]).toBe(BinaryFormat.JSON);
    });
  });

  describe("extractFormatAndPayload", () => {
    it("extracts format 0x01 and payload", () => {
      const data = new Uint8Array([BinaryFormat.JSON, 0x7b, 0x7d]); // 0x01 + "{}"
      const { format, payload } = extractFormatAndPayload(data);

      expect(format).toBe(BinaryFormat.JSON);
      expect(new TextDecoder().decode(payload)).toBe("{}");
    });

    it("extracts format 0x02 and binary payload", () => {
      const data = new Uint8Array([BinaryFormat.BINARY_UPLOAD, 0xff, 0xfe]);
      const { format, payload } = extractFormatAndPayload(data);

      expect(format).toBe(BinaryFormat.BINARY_UPLOAD);
      expect(payload).toEqual(new Uint8Array([0xff, 0xfe]));
    });

    it("throws for empty input", () => {
      const data = new Uint8Array(0);
      expect(() => extractFormatAndPayload(data)).toThrow(BinaryEnvelopeError);
      try {
        extractFormatAndPayload(data);
      } catch (err) {
        expect((err as BinaryEnvelopeError).code).toBe("INVALID_FORMAT");
      }
    });

    it("throws for unknown format byte", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02]); // 0x00 is invalid
      expect(() => extractFormatAndPayload(data)).toThrow(BinaryEnvelopeError);
      try {
        extractFormatAndPayload(data);
      } catch (err) {
        expect((err as BinaryEnvelopeError).code).toBe("INVALID_FORMAT");
        expect((err as BinaryEnvelopeError).message).toContain("0x00");
      }
    });

    it("round-trips with prependFormatByte", () => {
      const original = new TextEncoder().encode('{"round":"trip"}');
      const withFormat = prependFormatByte(BinaryFormat.JSON, original);
      const { format, payload } = extractFormatAndPayload(withFormat);

      expect(format).toBe(BinaryFormat.JSON);
      expect(payload).toEqual(original);
    });
  });

  describe("createBinaryEnvelope", () => {
    it("creates envelope with correct structure", () => {
      const nonce = new Uint8Array(NONCE_LENGTH).fill(0x42);
      const ciphertext = new Uint8Array([0xaa, 0xbb, 0xcc]);

      const envelope = createBinaryEnvelope(nonce, ciphertext);
      const view = new Uint8Array(envelope);

      expect(view[0]).toBe(BinaryEnvelopeVersion.V1);
      expect(view.slice(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH)).toEqual(
        nonce,
      );
      expect(view.slice(VERSION_LENGTH + NONCE_LENGTH)).toEqual(ciphertext);
    });

    it("uses provided version", () => {
      const nonce = new Uint8Array(NONCE_LENGTH);
      const ciphertext = new Uint8Array([0x00]);

      const envelope = createBinaryEnvelope(
        nonce,
        ciphertext,
        BinaryEnvelopeVersion.V1,
      );
      const view = new Uint8Array(envelope);

      expect(view[0]).toBe(0x01);
    });

    it("throws for wrong nonce length", () => {
      const shortNonce = new Uint8Array(16);
      const ciphertext = new Uint8Array([0x00]);

      expect(() => createBinaryEnvelope(shortNonce, ciphertext)).toThrow(
        BinaryEnvelopeError,
      );
    });

    it("handles large ciphertext", () => {
      const nonce = new Uint8Array(NONCE_LENGTH);
      const ciphertext = new Uint8Array(100000).fill(0xab);

      const envelope = createBinaryEnvelope(nonce, ciphertext);
      expect(envelope.byteLength).toBe(VERSION_LENGTH + NONCE_LENGTH + 100000);
    });
  });

  describe("parseBinaryEnvelope", () => {
    it("parses valid envelope", () => {
      const nonce = new Uint8Array(NONCE_LENGTH).fill(0x42);
      // Ciphertext needs to be at least 17 bytes (16 MAC + 1 format byte minimum)
      const ciphertext = new Uint8Array(17).fill(0xaa);
      const envelope = createBinaryEnvelope(nonce, ciphertext);

      const parsed = parseBinaryEnvelope(envelope);

      expect(parsed.version).toBe(BinaryEnvelopeVersion.V1);
      expect(parsed.nonce).toEqual(nonce);
      expect(parsed.ciphertext).toEqual(ciphertext);
    });

    it("works with Uint8Array input", () => {
      const nonce = new Uint8Array(NONCE_LENGTH).fill(0x11);
      // Ciphertext needs to be at least 17 bytes (16 MAC + 1 format byte minimum)
      const ciphertext = new Uint8Array(17).fill(0x22);
      const envelope = createBinaryEnvelope(nonce, ciphertext);

      const parsed = parseBinaryEnvelope(new Uint8Array(envelope));

      expect(parsed.version).toBe(BinaryEnvelopeVersion.V1);
      expect(parsed.nonce).toEqual(nonce);
    });

    it("throws for too-short envelope", () => {
      const tooShort = new ArrayBuffer(MIN_BINARY_ENVELOPE_LENGTH - 1);
      expect(() => parseBinaryEnvelope(tooShort)).toThrow(BinaryEnvelopeError);
      try {
        parseBinaryEnvelope(tooShort);
      } catch (err) {
        expect((err as BinaryEnvelopeError).code).toBe("INVALID_LENGTH");
      }
    });

    it("throws for unknown version byte", () => {
      // Create valid-length envelope with wrong version
      const buffer = new ArrayBuffer(MIN_BINARY_ENVELOPE_LENGTH);
      const view = new Uint8Array(buffer);
      view[0] = 0x02; // Invalid version

      expect(() => parseBinaryEnvelope(buffer)).toThrow(BinaryEnvelopeError);
      try {
        parseBinaryEnvelope(buffer);
      } catch (err) {
        expect((err as BinaryEnvelopeError).code).toBe("UNKNOWN_VERSION");
        expect((err as BinaryEnvelopeError).message).toContain("0x02");
      }
    });

    it("throws for version 0x00", () => {
      const buffer = new ArrayBuffer(MIN_BINARY_ENVELOPE_LENGTH);
      const view = new Uint8Array(buffer);
      view[0] = 0x00;

      expect(() => parseBinaryEnvelope(buffer)).toThrow(BinaryEnvelopeError);
    });

    it("round-trips with createBinaryEnvelope", () => {
      const nonce = new Uint8Array(NONCE_LENGTH);
      // Fill with pseudo-random values
      for (let i = 0; i < NONCE_LENGTH; i++) {
        nonce[i] = (i * 7) % 256;
      }
      const ciphertext = new Uint8Array([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
      ]);

      const envelope = createBinaryEnvelope(nonce, ciphertext);
      const parsed = parseBinaryEnvelope(envelope);

      expect(parsed.version).toBe(BinaryEnvelopeVersion.V1);
      expect(parsed.nonce).toEqual(nonce);
      expect(parsed.ciphertext).toEqual(ciphertext);
    });
  });

  describe("BinaryEnvelopeError", () => {
    it("has correct name", () => {
      const err = new BinaryEnvelopeError("test", "UNKNOWN_VERSION");
      expect(err.name).toBe("BinaryEnvelopeError");
    });

    it("has correct message", () => {
      const err = new BinaryEnvelopeError("custom message", "INVALID_LENGTH");
      expect(err.message).toBe("custom message");
    });

    it("has correct code", () => {
      const err = new BinaryEnvelopeError("test", "DECRYPTION_FAILED");
      expect(err.code).toBe("DECRYPTION_FAILED");
    });

    it("is instanceof Error", () => {
      const err = new BinaryEnvelopeError("test", "INVALID_FORMAT");
      expect(err).toBeInstanceOf(Error);
    });
  });
});

// =============================================================================
// Phase 2: Binary Upload Chunks Tests
// =============================================================================

describe("binary-upload-chunks (Phase 2)", () => {
  const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";
  const TEST_UUID_BYTES = new Uint8Array([
    0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66,
    0x55, 0x44, 0x00, 0x00,
  ]);

  describe("constants", () => {
    it("UUID_BYTE_LENGTH is 16", () => {
      expect(UUID_BYTE_LENGTH).toBe(16);
    });

    it("OFFSET_BYTE_LENGTH is 8", () => {
      expect(OFFSET_BYTE_LENGTH).toBe(8);
    });

    it("UPLOAD_CHUNK_HEADER_SIZE is 24", () => {
      expect(UPLOAD_CHUNK_HEADER_SIZE).toBe(24);
    });
  });

  describe("uuidToBytes", () => {
    it("converts hyphenated UUID to bytes", () => {
      const bytes = uuidToBytes(TEST_UUID);
      expect(bytes).toEqual(TEST_UUID_BYTES);
    });

    it("converts non-hyphenated UUID to bytes", () => {
      const uuid = "550e8400e29b41d4a716446655440000";
      const bytes = uuidToBytes(uuid);
      expect(bytes).toEqual(TEST_UUID_BYTES);
    });

    it("handles lowercase hex", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const bytes = uuidToBytes(uuid);
      expect(bytes.length).toBe(16);
    });

    it("handles uppercase hex", () => {
      const uuid = "550E8400-E29B-41D4-A716-446655440000";
      const bytes = uuidToBytes(uuid);
      expect(bytes).toEqual(TEST_UUID_BYTES);
    });

    it("handles mixed case hex", () => {
      const uuid = "550E8400-e29b-41D4-A716-446655440000";
      const bytes = uuidToBytes(uuid);
      expect(bytes).toEqual(TEST_UUID_BYTES);
    });

    it("throws for invalid UUID length", () => {
      expect(() => uuidToBytes("12345")).toThrow(UploadChunkError);
      try {
        uuidToBytes("12345");
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_UUID");
      }
    });

    it("throws for non-hex characters", () => {
      expect(() => uuidToBytes("550e8400-e29b-41d4-a716-44665544000g")).toThrow(
        UploadChunkError,
      );
      try {
        uuidToBytes("550e8400-e29b-41d4-a716-44665544000g");
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_UUID");
        expect((err as UploadChunkError).message).toContain("non-hex");
      }
    });

    it("throws for too long UUID", () => {
      expect(() => uuidToBytes(`${TEST_UUID}00`)).toThrow(UploadChunkError);
    });
  });

  describe("bytesToUuid", () => {
    it("converts bytes to hyphenated UUID", () => {
      const uuid = bytesToUuid(TEST_UUID_BYTES);
      expect(uuid).toBe(TEST_UUID);
    });

    it("produces lowercase hex", () => {
      const uuid = bytesToUuid(TEST_UUID_BYTES);
      expect(uuid).toMatch(/^[0-9a-f-]+$/);
    });

    it("throws for wrong byte length", () => {
      expect(() => bytesToUuid(new Uint8Array(15))).toThrow(UploadChunkError);
      expect(() => bytesToUuid(new Uint8Array(17))).toThrow(UploadChunkError);
      try {
        bytesToUuid(new Uint8Array(10));
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_UUID");
      }
    });

    it("round-trips with uuidToBytes", () => {
      const original = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const bytes = uuidToBytes(original);
      const roundTripped = bytesToUuid(bytes);
      expect(roundTripped).toBe(original);
    });
  });

  describe("offsetToBytes", () => {
    it("encodes zero", () => {
      const bytes = offsetToBytes(0);
      expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    });

    it("encodes small numbers", () => {
      const bytes = offsetToBytes(255);
      expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]));
    });

    it("encodes numbers that fit in 4 bytes", () => {
      const bytes = offsetToBytes(0xffffffff);
      expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]));
    });

    it("encodes numbers larger than 4GB", () => {
      // 5GB = 5 * 1024^3 = 5368709120
      const bytes = offsetToBytes(5368709120);
      const view = new DataView(bytes.buffer);
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      expect(high * 0x100000000 + low).toBe(5368709120);
    });

    it("encodes MAX_SAFE_INTEGER", () => {
      const bytes = offsetToBytes(Number.MAX_SAFE_INTEGER);
      expect(bytes.length).toBe(8);
      // Verify round-trip
      const decoded = bytesToOffset(bytes);
      expect(decoded).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("throws for negative numbers", () => {
      expect(() => offsetToBytes(-1)).toThrow(UploadChunkError);
      try {
        offsetToBytes(-1);
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_OFFSET");
        expect((err as UploadChunkError).message).toContain("non-negative");
      }
    });

    it("throws for non-integers", () => {
      expect(() => offsetToBytes(1.5)).toThrow(UploadChunkError);
      try {
        offsetToBytes(1.5);
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_OFFSET");
        expect((err as UploadChunkError).message).toContain("integer");
      }
    });

    it("uses big-endian format", () => {
      // Test with a value that can be represented safely
      // High 4 bytes: 0x00000102, Low 4 bytes: 0x03040506
      const testValue = 0x0102 * 0x100000000 + 0x03040506;
      const bytes = offsetToBytes(testValue);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x00);
      expect(bytes[2]).toBe(0x01);
      expect(bytes[3]).toBe(0x02);
      expect(bytes[4]).toBe(0x03);
      expect(bytes[5]).toBe(0x04);
      expect(bytes[6]).toBe(0x05);
      expect(bytes[7]).toBe(0x06);
    });
  });

  describe("bytesToOffset", () => {
    it("decodes zero", () => {
      const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(bytesToOffset(bytes)).toBe(0);
    });

    it("decodes small numbers", () => {
      const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]);
      expect(bytesToOffset(bytes)).toBe(255);
    });

    it("decodes numbers that fit in 4 bytes", () => {
      const bytes = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]);
      expect(bytesToOffset(bytes)).toBe(0xffffffff);
    });

    it("decodes numbers larger than 4GB", () => {
      // Create bytes for 5GB
      const encoded = offsetToBytes(5368709120);
      const decoded = bytesToOffset(encoded);
      expect(decoded).toBe(5368709120);
    });

    it("throws for wrong byte length", () => {
      expect(() => bytesToOffset(new Uint8Array(7))).toThrow(UploadChunkError);
      expect(() => bytesToOffset(new Uint8Array(9))).toThrow(UploadChunkError);
      try {
        bytesToOffset(new Uint8Array(4));
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_OFFSET");
      }
    });

    it("round-trips with offsetToBytes", () => {
      const testValues = [0, 1, 255, 65535, 0xffffffff, 5368709120];
      for (const value of testValues) {
        const bytes = offsetToBytes(value);
        const decoded = bytesToOffset(bytes);
        expect(decoded).toBe(value);
      }
    });

    it("reads from correct buffer offset (slice)", () => {
      // Simulate a Uint8Array that's a view into a larger buffer
      const largeBuffer = new ArrayBuffer(100);
      const fullView = new Uint8Array(largeBuffer);
      // Write offset at position 50
      fullView.set([0, 0, 0, 0, 0, 0, 1, 0], 50); // value = 256
      const slice = fullView.slice(50, 58);
      expect(bytesToOffset(slice)).toBe(256);
    });
  });

  describe("encodeUploadChunkFrame", () => {
    it("creates frame with correct format byte", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const frame = encodeUploadChunkFrame(TEST_UUID, 0, data);
      const view = new Uint8Array(frame);
      expect(view[0]).toBe(BinaryFormat.BINARY_UPLOAD);
    });

    it("includes UUID bytes after format byte", () => {
      const data = new Uint8Array([1, 2, 3]);
      const frame = encodeUploadChunkFrame(TEST_UUID, 0, data);
      const view = new Uint8Array(frame);
      const uuidBytes = view.slice(1, 1 + UUID_BYTE_LENGTH);
      expect(uuidBytes).toEqual(TEST_UUID_BYTES);
    });

    it("includes offset bytes after UUID", () => {
      const offset = 1024;
      const data = new Uint8Array([1, 2, 3]);
      const frame = encodeUploadChunkFrame(TEST_UUID, offset, data);
      const view = new Uint8Array(frame);
      const offsetBytes = view.slice(
        1 + UUID_BYTE_LENGTH,
        1 + UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH,
      );
      expect(bytesToOffset(offsetBytes)).toBe(offset);
    });

    it("includes chunk data after header", () => {
      const data = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
      const frame = encodeUploadChunkFrame(TEST_UUID, 0, data);
      const view = new Uint8Array(frame);
      const chunkData = view.slice(1 + UPLOAD_CHUNK_HEADER_SIZE);
      expect(chunkData).toEqual(data);
    });

    it("calculates correct total size", () => {
      const data = new Uint8Array(1000);
      const frame = encodeUploadChunkFrame(TEST_UUID, 0, data);
      // 1 (format) + 16 (UUID) + 8 (offset) + 1000 (data) = 1025
      expect(frame.byteLength).toBe(1 + UPLOAD_CHUNK_HEADER_SIZE + 1000);
    });

    it("handles empty chunk data", () => {
      const data = new Uint8Array(0);
      const frame = encodeUploadChunkFrame(TEST_UUID, 0, data);
      const view = new Uint8Array(frame);
      expect(view.length).toBe(1 + UPLOAD_CHUNK_HEADER_SIZE);
    });

    it("handles large offset (>4GB)", () => {
      const offset = 5368709120; // 5GB
      const data = new Uint8Array([1]);
      const frame = encodeUploadChunkFrame(TEST_UUID, offset, data);
      const view = new Uint8Array(frame);
      const offsetBytes = view.slice(
        1 + UUID_BYTE_LENGTH,
        1 + UUID_BYTE_LENGTH + OFFSET_BYTE_LENGTH,
      );
      expect(bytesToOffset(offsetBytes)).toBe(offset);
    });
  });

  describe("decodeUploadChunkFrame", () => {
    it("decodes frame to structured data", () => {
      const offset = 2048;
      const data = new Uint8Array([0x11, 0x22, 0x33]);
      const frame = encodeUploadChunkFrame(TEST_UUID, offset, data);

      const decoded = decodeUploadChunkFrame(frame);
      expect(decoded.uploadId).toBe(TEST_UUID);
      expect(decoded.offset).toBe(offset);
      expect(decoded.data).toEqual(data);
    });

    it("works with ArrayBuffer input", () => {
      const data = new Uint8Array([1, 2, 3]);
      const frame = encodeUploadChunkFrame(TEST_UUID, 100, data);

      const decoded = decodeUploadChunkFrame(frame);
      expect(decoded.uploadId).toBe(TEST_UUID);
    });

    it("works with Uint8Array input", () => {
      const data = new Uint8Array([1, 2, 3]);
      const frame = encodeUploadChunkFrame(TEST_UUID, 100, data);

      const decoded = decodeUploadChunkFrame(new Uint8Array(frame));
      expect(decoded.uploadId).toBe(TEST_UUID);
    });

    it("throws for wrong format byte", () => {
      // Create a JSON frame
      const jsonFrame = encodeJsonFrame({ type: "test" });
      expect(() => decodeUploadChunkFrame(jsonFrame)).toThrow(BinaryFrameError);
      try {
        decodeUploadChunkFrame(jsonFrame);
      } catch (err) {
        expect((err as BinaryFrameError).code).toBe("UNKNOWN_FORMAT");
        expect((err as BinaryFrameError).message).toContain(
          "Expected binary upload",
        );
      }
    });

    it("throws for payload too short", () => {
      // Create a frame with format byte but too short payload
      const tooShort = new Uint8Array([BinaryFormat.BINARY_UPLOAD, 0x01, 0x02]);
      expect(() => decodeUploadChunkFrame(tooShort)).toThrow(UploadChunkError);
      try {
        decodeUploadChunkFrame(tooShort);
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_LENGTH");
      }
    });

    it("round-trips various payloads", () => {
      const testCases = [
        { uuid: TEST_UUID, offset: 0, data: new Uint8Array([]) },
        { uuid: TEST_UUID, offset: 0, data: new Uint8Array([1]) },
        { uuid: TEST_UUID, offset: 1024, data: new Uint8Array(100).fill(0xab) },
        {
          uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          offset: 5368709120,
          data: new Uint8Array([0xff, 0xfe, 0xfd]),
        },
      ];

      for (const { uuid, offset, data } of testCases) {
        const frame = encodeUploadChunkFrame(uuid, offset, data);
        const decoded = decodeUploadChunkFrame(frame);
        expect(decoded.uploadId).toBe(uuid);
        expect(decoded.offset).toBe(offset);
        expect(decoded.data).toEqual(data);
      }
    });
  });

  describe("encodeUploadChunkPayload", () => {
    it("creates payload without format byte", () => {
      const data = new Uint8Array([1, 2, 3]);
      const payload = encodeUploadChunkPayload(TEST_UUID, 0, data);
      // Should not have format byte
      expect(payload[0]).not.toBe(BinaryFormat.BINARY_UPLOAD);
      // First 16 bytes should be UUID
      expect(payload.slice(0, UUID_BYTE_LENGTH)).toEqual(TEST_UUID_BYTES);
    });

    it("calculates correct size (no format byte)", () => {
      const data = new Uint8Array(1000);
      const payload = encodeUploadChunkPayload(TEST_UUID, 0, data);
      // 16 (UUID) + 8 (offset) + 1000 (data) = 1024
      expect(payload.length).toBe(UPLOAD_CHUNK_HEADER_SIZE + 1000);
    });

    it("can be used with prependFormatByte", () => {
      const data = new Uint8Array([0xaa, 0xbb]);
      const payload = encodeUploadChunkPayload(TEST_UUID, 512, data);
      const withFormat = prependFormatByte(BinaryFormat.BINARY_UPLOAD, payload);

      // Should now match encodeUploadChunkFrame output
      const directFrame = encodeUploadChunkFrame(TEST_UUID, 512, data);
      expect(withFormat).toEqual(new Uint8Array(directFrame));
    });
  });

  describe("decodeUploadChunkPayload", () => {
    it("decodes payload without format byte", () => {
      const data = new Uint8Array([1, 2, 3]);
      const payload = encodeUploadChunkPayload(TEST_UUID, 256, data);

      const decoded = decodeUploadChunkPayload(payload);
      expect(decoded.uploadId).toBe(TEST_UUID);
      expect(decoded.offset).toBe(256);
      expect(decoded.data).toEqual(data);
    });

    it("throws for payload too short", () => {
      const tooShort = new Uint8Array(23); // Less than 24-byte header
      expect(() => decodeUploadChunkPayload(tooShort)).toThrow(
        UploadChunkError,
      );
      try {
        decodeUploadChunkPayload(tooShort);
      } catch (err) {
        expect((err as UploadChunkError).code).toBe("INVALID_LENGTH");
      }
    });

    it("handles empty chunk data", () => {
      const data = new Uint8Array(0);
      const payload = encodeUploadChunkPayload(TEST_UUID, 0, data);
      const decoded = decodeUploadChunkPayload(payload);
      expect(decoded.data.length).toBe(0);
    });

    it("round-trips with encodeUploadChunkPayload", () => {
      const uuid = "fedcba98-7654-3210-fedc-ba9876543210";
      const offset = 999999;
      const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

      const payload = encodeUploadChunkPayload(uuid, offset, data);
      const decoded = decodeUploadChunkPayload(payload);

      expect(decoded.uploadId).toBe(uuid);
      expect(decoded.offset).toBe(offset);
      expect(decoded.data).toEqual(data);
    });
  });

  describe("UploadChunkError", () => {
    it("has correct name", () => {
      const err = new UploadChunkError("test", "INVALID_UUID");
      expect(err.name).toBe("UploadChunkError");
    });

    it("has correct message", () => {
      const err = new UploadChunkError("custom message", "INVALID_OFFSET");
      expect(err.message).toBe("custom message");
    });

    it("has correct code", () => {
      const err = new UploadChunkError("test", "INVALID_LENGTH");
      expect(err.code).toBe("INVALID_LENGTH");
    });

    it("is instanceof Error", () => {
      const err = new UploadChunkError("test", "INVALID_FORMAT");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("integration with existing binary framing", () => {
    it("decodeBinaryFrame accepts format 0x02", () => {
      const frame = encodeUploadChunkFrame(
        TEST_UUID,
        100,
        new Uint8Array([1, 2]),
      );
      const { format, payload } = decodeBinaryFrame(frame);
      expect(format).toBe(BinaryFormat.BINARY_UPLOAD);
      expect(payload.length).toBe(UPLOAD_CHUNK_HEADER_SIZE + 2);
    });

    it("extractFormatAndPayload works with upload chunks", () => {
      const payload = encodeUploadChunkPayload(
        TEST_UUID,
        0,
        new Uint8Array([1]),
      );
      const withFormat = prependFormatByte(BinaryFormat.BINARY_UPLOAD, payload);

      const { format, payload: extracted } =
        extractFormatAndPayload(withFormat);
      expect(format).toBe(BinaryFormat.BINARY_UPLOAD);
      expect(extracted).toEqual(payload);
    });

    it("can be used in encrypted envelope flow", () => {
      // Simulate the encryption flow:
      // 1. Create upload chunk payload
      const chunkData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const payload = encodeUploadChunkPayload(TEST_UUID, 4096, chunkData);

      // 2. Prepend format byte (done before encryption)
      const withFormat = prependFormatByte(BinaryFormat.BINARY_UPLOAD, payload);

      // 3. (encryption would happen here - we just simulate)
      // 4. Simulate decryption - extract format and payload
      const { format, payload: extracted } =
        extractFormatAndPayload(withFormat);

      // 5. Decode the upload chunk
      expect(format).toBe(BinaryFormat.BINARY_UPLOAD);
      const decoded = decodeUploadChunkPayload(extracted);
      expect(decoded.uploadId).toBe(TEST_UUID);
      expect(decoded.offset).toBe(4096);
      expect(decoded.data).toEqual(chunkData);
    });
  });
});
