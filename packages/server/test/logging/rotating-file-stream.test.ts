import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRotatingFileStream } from "../../src/logging/rotating-file-stream.js";

function write(stream: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.write(line, (error) => (error ? reject(error) : resolve())),
  );
}

function end(stream: Writable): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

describe("createRotatingFileStream", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ya-rotating-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rotates by size, keeps a bounded number of files and loses no line", async () => {
    const path = join(dir, "server.log");
    const stream = createRotatingFileStream(path, { maxBytes: 20, keep: 2 });
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}\n`);
    // Both awaited single writes and a burst that arrives buffered.
    for (const line of lines.slice(0, 4)) await write(stream, line);
    await Promise.all(lines.slice(4).map((line) => write(stream, line)));
    await end(stream);

    expect((await readdir(dir)).sort()).toEqual([
      "server.log",
      "server.log.1",
      "server.log.2",
    ]);
    const kept = [
      await readFile(`${path}.2`, "utf8"),
      await readFile(`${path}.1`, "utf8"),
      await readFile(path, "utf8"),
    ];
    // A buffered burst arrives as one chunk and may overshoot by itself.
    for (const content of kept) expect(content).toMatch(/^(line-\d+\n)+$/);
    expect(kept.join("").length).toBeLessThan(lines.join("").length);
    // The newest lines survive in order; only the oldest file was dropped.
    expect(kept.join("")).toBe(
      lines.slice(-kept.join("").split("\n").length + 1).join(""),
    );
  });

  it("keeps the archives and the log when a rotation cannot move the file", async () => {
    const path = join(dir, "server.log");
    await writeFile(`${path}.1`, "archive\n");
    // A non-empty directory where the live file would be moved aside.
    await mkdir(join(`${path}.rotating`, "blocker"), { recursive: true });
    const stream = createRotatingFileStream(path, { maxBytes: 10, keep: 2 });
    await write(stream, "first-line\n");
    await write(stream, "second-line\n");
    await end(stream);
    expect(await readFile(path, "utf8")).toBe("first-line\nsecond-line\n");
    expect(await readFile(`${path}.1`, "utf8")).toBe("archive\n");
    await expect(readFile(`${path}.2`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rotates a file that is already over the limit on the first write", async () => {
    const path = join(dir, "sdk-raw.jsonl");
    await writeFile(path, "x".repeat(100));
    const stream = createRotatingFileStream(path, { maxBytes: 50, keep: 1 });
    await write(stream, "fresh\n");
    await end(stream);
    expect(await readFile(path, "utf8")).toBe("fresh\n");
    expect(await readFile(`${path}.1`, "utf8")).toBe("x".repeat(100));
  });
});
