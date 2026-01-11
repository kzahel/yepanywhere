import { describe, expect, it } from "vitest";
import {
  BinaryFormat,
  BinaryFrameError,
  decodeBinaryFrame,
  decodeJsonFrame,
  encodeJsonFrame,
  isBinaryData,
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
