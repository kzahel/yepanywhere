import {
  mkdtemp,
  writeFile,
  appendFile,
  readFile,
  stat,
  rm,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  readTranscriptFile,
  readTranscriptRange,
  readObservedTranscriptRange,
  isTranscriptAppend,
  TranscriptAppendMismatchError,
} from "../../src/sessions/transcript-ingestion.js";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const parse = (line: string, offset: number) => ({
  value: JSON.parse(line),
  offset,
});
it("preserves UTF-8 byte positions, CRLF/BOM and provisional replay across chunks", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-ingest-"));
  const file = join(directory, "source.jsonl");
  const first = "\ufeff" + JSON.stringify({ text: "z" + "𐐷".repeat(300000) }),
    last = JSON.stringify({ text: "provisional" });
  await writeFile(file, first + "\r\n\ninvalid\n" + last);
  const size = (await stat(file)).size;
  const snapshot = await readTranscriptFile(file, 0, size, parse);
  expect(snapshot.entries.map((e) => e.value)).toEqual([
    { text: "z" + "𐐷".repeat(300000) },
    { text: "provisional" },
  ]);
  expect(snapshot.committedEntries).toBe(1);
  expect(snapshot.malformedLines).toBe(1);
  expect(snapshot.entries[1]!.offset).toBe(
    Buffer.byteLength(first + "\r\n\ninvalid\n"),
  );
  expect(snapshot.partialLine.toString()).toBe(last);
  const added = "\n" + JSON.stringify({ text: "after" }) + "\n";
  await appendFile(file, added);
  const bytes = await readFile(file);
  let largest = 0,
    total = 0;
  const replay = await readTranscriptRange(
    async (_path, start, length) => {
      largest = Math.max(largest, length);
      total += length;
      return bytes.subarray(start, start + length);
    },
    file,
    size,
    Buffer.byteLength(added),
    parse,
    snapshot.partialLine,
  );
  const accepted = [
    ...snapshot.entries.slice(0, snapshot.committedEntries),
    ...replay.entries,
  ];
  const rebuilt = await readTranscriptFile(file, 0, bytes.length, parse);
  expect(accepted).toEqual(rebuilt.entries);
  expect(replay.committedEntries).toBe(2);
  expect(total).toBe(Buffer.byteLength(added));
  expect(largest).toBeLessThanOrEqual(1024 * 1024);
});
it("fences replacement, prefix rewriting and truncation without retaining payload", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-ingest-fence-"));
  const file = join(directory, "source.jsonl");
  await writeFile(file, JSON.stringify({ text: "x".repeat(20000) }) + "\n");
  const snapshot = await readTranscriptFile(
    file,
    0,
    (await stat(file)).size,
    parse,
  );
  const fence = snapshot.appendFence!;
  const read = async (_path: string, start: number, length: number) =>
    (await readFile(file)).subarray(start, start + length);
  await appendFile(file, "{}\n");
  expect(await isTranscriptAppend(read, file, fence, await stat(file))).toBe(
    true,
  );
  const replacement = join(directory, "replace");
  await writeFile(
    replacement,
    JSON.stringify({ text: "y".repeat(24000) }) + "\n",
  );
  await rename(replacement, file);
  expect(await isTranscriptAppend(read, file, fence, await stat(file))).toBe(
    false,
  );
  const replacedSnapshot = await readTranscriptFile(
    file,
    0,
    (await stat(file)).size,
    parse,
  );
  await writeFile(file, JSON.stringify({ text: "z".repeat(26000) }) + "\n");
  expect(
    await isTranscriptAppend(
      read,
      file,
      replacedSnapshot.appendFence!,
      await stat(file),
    ),
  ).toBe(false);
  await writeFile(file, "{}\n");
  expect(await isTranscriptAppend(read, file, fence, await stat(file))).toBe(
    false,
  );
});
it("rejects a source replaced during a bounded read", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-ingest-race-"));
  const file = join(directory, "source.jsonl");
  const text = JSON.stringify({ text: "x".repeat(20000) }) + "\n";
  await writeFile(file, text);
  let replaced = false;
  const read = async (_path: string, start: number, length: number) => {
    const buffer = (await readFile(file)).subarray(start, start + length);
    if (!replaced && length > 1024) {
      replaced = true;
      const replacement = join(directory!, "replace");
      await writeFile(replacement, text);
      await rename(replacement, file);
    }
    return buffer;
  };
  await expect(
    readObservedTranscriptRange(read, file, 0, Buffer.byteLength(text), parse),
  ).rejects.toThrow("Transcript changed");
});

it("classifies a missing append source without masking ordinary acquisition errors", async () => {
  directory = await mkdtemp(join(tmpdir(), "ya-ingest-"));
  const file = join(directory, "source.jsonl");
  await writeFile(file, '{"ok":true}\n');
  const previous = await readTranscriptFile(
    file,
    0,
    (await stat(file)).size,
    parse,
  );
  await rm(file);
  await expect(
    readTranscriptFile(file, 0, 1, parse, previous.appendFence),
  ).rejects.toBeInstanceOf(TranscriptAppendMismatchError);
  await expect(readTranscriptFile(file, 0, 1, parse)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
