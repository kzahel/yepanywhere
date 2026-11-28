import assert from "node:assert/strict";
import {
  BinaryFormat,
  TRANSPORT_CHUNK_HEADER_SIZE,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
  TransportChunkReassembler,
  type YepMessage,
  decodeBinaryFrame,
  decodeJsonFrame,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  decompressGzip,
  decryptBinaryEnvelope,
  decryptBinaryEnvelopeRaw,
} from "../../src/crypto/index.js";
import {
  createConnectionState,
  createSendFn,
} from "../../src/routes/ws-relay-handlers.js";

function largeResponse(): YepMessage {
  return {
    type: "response",
    id: "large-response",
    status: 200,
    body: { text: "transport-frame-content".repeat(30_000) },
  };
}

describe("WebSocket response framing", () => {
  it("frames validated JSON response bytes without changing their spelling", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        expect(typeof frame).not.toBe("string");
        frames.push(frame as ArrayBuffer);
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    state.useBinaryFrames = true;
    const bodyText = '{ "spaced": true, "value": "雪" }';
    const bodyBytes = new TextEncoder().encode(bodyText);

    createSendFn(ws, state).sendValidatedJsonResponse?.({
      type: "response",
      id: "raw-binary",
      status: 200,
      bodyBytes,
      bodyText,
    });

    expect(frames).toHaveLength(1);
    const [frame] = frames;
    assert.ok(frame);
    const { format, payload } = decodeBinaryFrame(frame);
    expect(format).toBe(BinaryFormat.JSON);
    const serialized = new TextDecoder().decode(payload);
    expect(serialized).toContain(`,"body":${bodyText}}`);
    expect(JSON.parse(serialized)).toMatchObject({
      type: "response",
      id: "raw-binary",
      body: { spaced: true, value: "雪" },
    });
  });

  it("encrypts and chunks validated JSON bytes in protocol order", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        if (typeof frame === "string") {
          throw new Error("Expected a binary response frame");
        }
        frames.push(
          frame instanceof ArrayBuffer
            ? frame
            : frame.buffer.slice(
                frame.byteOffset,
                frame.byteOffset + frame.byteLength,
              ),
        );
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    const sessionKey = new Uint8Array(32).fill(9);
    state.authState = "authenticated";
    state.sessionKey = sessionKey;
    state.supportedFormats = new Set([
      BinaryFormat.JSON,
      BinaryFormat.TRANSPORT_CHUNK,
    ]);
    const bodyText = JSON.stringify({
      text: "raw-encrypted-content".repeat(30_000),
    });

    createSendFn(ws, state).sendValidatedJsonResponse?.({
      type: "response",
      id: "raw-encrypted",
      status: 200,
      bodyBytes: new TextEncoder().encode(bodyText),
      bodyText,
    });

    expect(frames.length).toBeGreaterThan(1);
    const reassembler = new TransportChunkReassembler();
    let envelope: Uint8Array | undefined;
    for (const frame of frames) {
      envelope = reassembler.accept(frame) ?? envelope;
    }
    const decrypted = decryptBinaryEnvelopeRaw(
      envelope as Uint8Array,
      sessionKey,
    );
    expect(decrypted?.format).toBe(BinaryFormat.JSON);
    expect(JSON.parse(new TextDecoder().decode(decrypted?.payload))).toEqual({
      seq: 0,
      msg: {
        type: "response",
        id: "raw-encrypted",
        status: 200,
        body: JSON.parse(bodyText),
      },
    });
    expect(state.nextOutboundSeq).toBe(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("compresses validated JSON bytes before encryption", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        expect(typeof frame).not.toBe("string");
        frames.push(frame as ArrayBuffer);
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    const sessionKey = new Uint8Array(32).fill(11);
    state.authState = "authenticated";
    state.sessionKey = sessionKey;
    state.supportedFormats = new Set([
      BinaryFormat.JSON,
      BinaryFormat.COMPRESSED_JSON,
    ]);
    const bodyText = JSON.stringify({ text: "compressible".repeat(10_000) });

    createSendFn(ws, state).sendValidatedJsonResponse?.({
      type: "response",
      id: "raw-compressed",
      status: 200,
      bodyBytes: new TextEncoder().encode(bodyText),
      bodyText,
    });

    expect(frames).toHaveLength(1);
    const [frame] = frames;
    assert.ok(frame);
    const decrypted = decryptBinaryEnvelopeRaw(frame, sessionKey);
    expect(decrypted?.format).toBe(BinaryFormat.COMPRESSED_JSON);
    expect(JSON.parse(decompressGzip(decrypted!.payload))).toEqual({
      seq: 0,
      msg: {
        type: "response",
        id: "raw-compressed",
        status: 200,
        body: JSON.parse(bodyText),
      },
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("chunks and reassembles a negotiated encrypted response", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        if (typeof frame === "string") {
          throw new Error("Expected a binary response frame");
        }
        frames.push(
          frame instanceof ArrayBuffer
            ? frame
            : frame.buffer.slice(
                frame.byteOffset,
                frame.byteOffset + frame.byteLength,
              ),
        );
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    const sessionKey = new Uint8Array(32).fill(7);
    state.authState = "authenticated";
    state.sessionKey = sessionKey;
    state.supportedFormats = new Set([
      BinaryFormat.JSON,
      BinaryFormat.TRANSPORT_CHUNK,
    ]);

    createSendFn(ws, state)(largeResponse());

    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every(
        (frame) =>
          frame.byteLength <=
          1 + TRANSPORT_CHUNK_HEADER_SIZE + TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
      ),
    ).toBe(true);
    const reassembler = new TransportChunkReassembler();
    let envelope: Uint8Array | undefined;
    for (const frame of frames) {
      envelope = reassembler.accept(frame) ?? envelope;
    }
    expect(envelope).toBeDefined();
    const plaintext = decryptBinaryEnvelope(envelope as Uint8Array, sessionKey);
    expect(plaintext).not.toBeNull();
    expect(JSON.parse(plaintext as string)).toEqual({
      seq: 0,
      msg: largeResponse(),
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("keeps one complete binary frame for clients without chunk support", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        expect(typeof frame).not.toBe("string");
        frames.push(frame as ArrayBuffer);
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    state.useBinaryFrames = true;

    createSendFn(ws, state)(largeResponse());

    expect(frames).toHaveLength(1);
    const [frame] = frames;
    assert.ok(frame);
    expect(frame.byteLength).toBeGreaterThan(TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES);
    expect(decodeJsonFrame(frame)).toEqual(largeResponse());
    expect(ws.close).not.toHaveBeenCalled();
  });
});
