/**
 * JSONL file reading utilities.
 *
 * Shared helpers for reading JSONL session files with BOM handling
 * and partial reads (to avoid loading multi-MB files entirely).
 */

import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import * as zlib from "node:zlib";
import { promisify, TextDecoder } from "node:util";

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

async function readUtf8File(filePath: string): Promise<string> {
  if (!isZstdPath(filePath)) {
    return readFile(filePath, "utf-8");
  }

  const decompress = getZstdDecompress();
  if (!decompress) {
    throw new Error("zstd-compressed JSONL is not supported by this Node.js");
  }

  const raw = await readFile(filePath);
  const decompressed = await decompress(raw);
  return decompressed.toString("utf-8");
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
 * Returns null for missing/empty files. Other I/O errors remain distinguishable
 * from invalid metadata so discovery can retain an accepted snapshot and retry.
 */
export async function readFirstLine(
  filePath: string,
  maxBytes = 4096,
): Promise<string | null> {
  if (isZstdPath(filePath)) {
    if (!isZstdJsonlSupported()) return null;
    try {
      return await readFirstLineFromZstd(filePath, maxBytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      // Corrupt compressed content is invalid metadata, not an I/O outage.
      if (code?.startsWith("ZSTD_")) return null;
      throw error;
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  } finally {
    await fd?.close();
  }
}

/**
 * Read a file and return BOM-stripped lines.
 */
export async function readJsonlLines(filePath: string): Promise<string[]> {
  const raw = await readUtf8File(filePath);
  return stripBom(raw).trim().split("\n");
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
  const stream = source.pipe(decompressor);
  const decoder = new TextDecoder("utf-8");
  source.on("error", (error) => decompressor.destroy(error));

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
 * Stream a JSONL file as BOM-stripped lines without materializing the full file.
 *
 * Empty lines are yielded so callers can keep their own line counts; callers
 * that parse JSON should trim/skip blank lines.
 */
export interface JsonlLineRecord {
  line: string;
  terminated: boolean;
}

/**
 * Stream JSONL records while retaining whether each line ended with a newline.
 * The distinction lets append-aware readers hold an in-progress final record
 * without treating it as corrupt durable history.
 */
export async function* iterateJsonlLineRecords(
  filePath: string,
): AsyncIterable<JsonlLineRecord> {
  const chunks = isZstdPath(filePath)
    ? streamZstdJsonlText(filePath)
    : streamPlainJsonlText(filePath);
  let pending = "";
  let firstChunk = true;

  for await (const rawChunk of chunks) {
    const chunk = firstChunk ? stripBom(rawChunk) : rawChunk;
    firstChunk = false;
    pending += chunk;

    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      yield { line: pending.slice(0, newlineIndex), terminated: true };
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }
  }

  if (pending) {
    yield { line: pending, terminated: false };
  }
}

export async function* iterateJsonlLines(
  filePath: string,
): AsyncIterable<string> {
  for await (const record of iterateJsonlLineRecords(filePath)) {
    yield record.line;
  }
}
