import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile as realReadFile,
  rm,
  writeFile,
} from "node:fs/promises";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;
const createZstdDecompress = (
  zlib as typeof zlib & {
    createZstdDecompress?: () => NodeJS.ReadWriteStream;
  }
).createZstdDecompress;
const hasNativeZstd =
  typeof zstdCompressSync === "function" &&
  typeof createZstdDecompress === "function";
const itIfNativeZstd = hasNativeZstd ? it : it.skip;
const itIfNoNativeZstd = hasNativeZstd ? it.skip : it;

function zstdCompressed(content: string): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(Buffer.from(content, "utf-8"));
}

describe("jsonl utilities", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports whether the final streamed JSONL record is terminated", async () => {
    const dir = join(tmpdir(), `jsonl-records-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "records.jsonl");
    await writeFile(filePath, '{"complete":true}\n{"partial":');

    const { iterateJsonlLineRecords } = await import(
      "../../src/utils/jsonl.js"
    );
    const records = [];
    for await (const record of iterateJsonlLineRecords(filePath)) {
      records.push(record);
    }

    expect(records).toEqual([
      { line: '{"complete":true}', terminated: true },
      { line: '{"partial":', terminated: false },
    ]);
  });

  it("preserves long Unicode records, blank lines and a partial tail across stream chunks", async () => {
    const dir = join(tmpdir(), `jsonl-chunks-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const lines = [
      "",
      "a".repeat(65532),
      JSON.stringify({ text: "α😀".repeat(262144) }),
      "",
      "with carriage return\r",
      "unterminated😀".repeat(10000),
    ];
    const content = `\uFEFF${lines.join("\n")}`;
    const paths = [join(dir, "records.jsonl")];
    await writeFile(paths[0]!, content);
    if (hasNativeZstd) {
      paths.push(join(dir, "records.jsonl.zst"));
      await writeFile(paths[1]!, zstdCompressed(content));
    }
    const { iterateJsonlLineRecords } = await import(
      "../../src/utils/jsonl.js"
    );
    for (const path of paths) {
      const records = [];
      for await (const record of iterateJsonlLineRecords(path))
        records.push(record);
      expect(records).toEqual(
        lines.map((line, i) => ({ line, terminated: i < lines.length - 1 })),
      );
    }
  });

  itIfNativeZstd(
    "streams the first line of zstd JSONL without full file reads",
    async () => {
      const dir = join(tmpdir(), `jsonl-zstd-${randomUUID()}`);
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const firstLine = JSON.stringify({
        type: "session_meta",
        payload: {
          id: "streamed-zstd",
          cwd: "/tmp/project",
          timestamp: "2026-06-25T00:00:00.000Z",
        },
      });
      const filePath = join(dir, "rollout-streamed-zstd.jsonl.zst");
      await writeFile(
        filePath,
        zstdCompressed(`${firstLine}\n${"tail\n".repeat(20_000)}`),
      );

      vi.doMock("node:fs/promises", async () => {
        const actual =
          await vi.importActual<typeof import("node:fs/promises")>(
            "node:fs/promises",
          );
        return {
          ...actual,
          readFile: vi.fn(async (...args: Parameters<typeof realReadFile>) => {
            if (String(args[0]).endsWith(".zst")) {
              throw new Error("zstd first-line read used full-file read");
            }
            return realReadFile(...args);
          }),
        };
      });

      const { readFirstLine } = await import("../../src/utils/jsonl.js");

      await expect(readFirstLine(filePath, 1024 * 1024)).resolves.toBe(
        firstLine,
      );
    },
  );

  itIfNoNativeZstd(
    "returns null for zstd first-line reads without native zstd",
    async () => {
      const dir = join(tmpdir(), `jsonl-zstd-${randomUUID()}`);
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const filePath = join(dir, "rollout-unsupported.jsonl.zst");
      await writeFile(filePath, Buffer.from("not decoded on this runtime"));

      const { readFirstLine } = await import("../../src/utils/jsonl.js");

      await expect(readFirstLine(filePath, 1024 * 1024)).resolves.toBeNull();
    },
  );
});
