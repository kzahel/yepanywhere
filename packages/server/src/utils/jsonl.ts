/**
 * JSONL file reading utilities.
 *
 * Shared helpers for reading JSONL session files with BOM handling
 * and partial reads (to avoid loading multi-MB files entirely).
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import * as zlib from "node:zlib";
import { promisify, TextDecoder } from "node:util";
import {
  type JsonlLineRecord,
  iterateJsonlRecords,
} from "@yep-anywhere/shared/jsonl";

/** Strip UTF-8 BOM if present (common on Windows). */
export function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

type ZstdDecompress = (
  input: Buffer,
  callback: (error: Error | null, result: Buffer) => void,
) => void;
type ZstdStream = NodeJS.ReadWriteStream &
  AsyncIterable<Buffer | string> & {
    destroy(error?: Error): void;
  };
type CreateZstdDecompress = () => ZstdStream;

let zstdDecompressAsync:
  | ((input: Buffer) => Promise<Buffer>)
  | null
  | undefined;
let createZstdDecompressCached: CreateZstdDecompress | null | undefined;

function isZstdPath(filePath: string): boolean {
  return filePath.endsWith(".zst");
}

function getZstdDecompress(): ((input: Buffer) => Promise<Buffer>) | null {
  if (zstdDecompressAsync !== undefined) {
    return zstdDecompressAsync;
  }

  const candidate = (zlib as typeof zlib & { zstdDecompress?: ZstdDecompress })
    .zstdDecompress;
  zstdDecompressAsync =
    typeof candidate === "function" ? promisify(candidate) : null;
  return zstdDecompressAsync;
}

function getCreateZstdDecompress(): CreateZstdDecompress | null {
  if (createZstdDecompressCached !== undefined) {
    return createZstdDecompressCached;
  }

  const candidate = (
    zlib as typeof zlib & { createZstdDecompress?: CreateZstdDecompress }
  ).createZstdDecompress;
  createZstdDecompressCached =
    typeof candidate === "function" ? candidate : null;
  return createZstdDecompressCached;
}

export function isZstdJsonlSupported(): boolean {
  return Boolean(getZstdDecompress() && getCreateZstdDecompress());
}

function firstLineFromContent(content: string): string | null {
  const stripped = stripBom(content);
  const nl = stripped.indexOf("\n");
  const line = (nl > 0 ? stripped.slice(0, nl) : stripped).trim();
  return line || null;
}

async function readFirstLineFromZstd(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  const createZstdDecompress = getCreateZstdDecompress();
  if (!createZstdDecompress) {
    throw new Error("zstd-compressed JSONL is not supported by this Node.js");
  }

  const source = createReadStream(filePath);
  const decompressor = createZstdDecompress();
  // `pipe` does not forward source errors: a missing file would otherwise
  // escape as an uncaught stream error instead of rejecting this read.
  source.on("error", (error) => decompressor.destroy(error));
  const stream = source.pipe(decompressor);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let content = "";

  try {
    for await (const chunk of stream) {
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) break;

      const slice =
        buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(slice);
      totalBytes += slice.length;
      content = Buffer.concat(chunks).toString("utf-8");
      if (content.includes("\n")) break;
    }
  } finally {
    source.destroy();
    decompressor.destroy();
  }

  if (totalBytes === 0) return null;
  return firstLineFromContent(content);
}

/**
 * Read the first line of a file using a partial read.
 * Reads in chunks until it finds a newline, reaches EOF, or hits maxBytes.
 * Returns null for empty files or empty first lines.
 */
export async function readFirstLine(
  filePath: string,
  maxBytes = 4096,
): Promise<string | null> {
  if (isZstdPath(filePath)) {
    try {
      return await readFirstLineFromZstd(filePath, maxBytes);
    } catch {
      return null;
    }
  }

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const chunkSize = Math.min(4096, maxBytes);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let content = "";

    while (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      const buf = Buffer.alloc(Math.min(chunkSize, remaining));
      const { bytesRead } = await fd.read(buf, 0, buf.length, totalBytes);
      if (bytesRead === 0) break;

      chunks.push(buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
      content = Buffer.concat(chunks).toString("utf-8");
      if (content.includes("\n")) break;
    }

    if (totalBytes === 0) return null;

    return firstLineFromContent(content);
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

async function* streamPlainJsonlText(filePath: string): AsyncIterable<string> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  try {
    for await (const chunk of stream) {
      yield chunk;
    }
  } finally {
    stream.destroy();
  }
}

async function* streamZstdJsonlText(filePath: string): AsyncIterable<string> {
  const createZstdDecompress = getCreateZstdDecompress();
  if (!createZstdDecompress) {
    throw new Error("zstd-compressed JSONL is not supported by this Node.js");
  }

  const source = createReadStream(filePath);
  const decompressor = createZstdDecompress();
  // `pipe` does not forward source errors: a missing file would otherwise
  // escape as an uncaught stream error instead of rejecting this read.
  source.on("error", (error) => decompressor.destroy(error));
  const stream = source.pipe(decompressor);
  const decoder = new TextDecoder("utf-8");

  try {
    for await (const chunk of stream) {
      if (typeof chunk === "string") {
        yield chunk;
      } else {
        const text = decoder.decode(chunk, { stream: true });
        if (text) yield text;
      }
    }

    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    source.destroy();
    decompressor.destroy();
  }
}

/**
 * Stream JSONL records while retaining whether each line ended with a newline.
 * The distinction lets append-aware readers hold an in-progress final record
 * without treating it as corrupt durable history.
 */
export function iterateJsonlLineRecords(
  filePath: string,
): AsyncIterable<JsonlLineRecord> {
  const chunks = isZstdPath(filePath)
    ? streamZstdJsonlText(filePath)
    : streamPlainJsonlText(filePath);
  return iterateJsonlRecords(chunks);
}

/** Stream BOM-stripped lines, including empty lines for callers counting them. */
export async function* iterateJsonlLines(
  filePath: string,
): AsyncIterable<string> {
  for await (const record of iterateJsonlLineRecords(filePath)) {
    yield record.line;
  }
}
