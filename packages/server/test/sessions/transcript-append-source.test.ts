import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readAppendSourceBatch,
  type AppendSourceBudget,
  type AppendSourceSegment,
} from "../../src/sessions/transcript-append-source.js";

interface Row {
  id: string;
  hold?: boolean;
}
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
});
async function directory() {
  const created = await mkdtemp(join(tmpdir(), "append-source-"));
  directories.push(created);
  return created;
}
const row = (id: string, extra: object = {}) =>
  JSON.stringify({ id, ...extra });
const rows = (...ids: string[]) => ids.map((id) => `${row(id)}\n`).join("");
const reader =
  (segments: AppendSourceSegment[], budget?: AppendSourceBudget) =>
  (cursor?: string) =>
    readAppendSourceBatch<Row>(segments, {
      cursor,
      budget,
      signal: new AbortController().signal,
      decode: (value) => value as Row,
      holdBack: (entry) => entry.hold === true,
    });
const ids = (batch: { records: Array<{ entry: Row }> }) =>
  batch.records.map((record) => record.entry.id);

/** Every batch to the end of the source, with the cursor the last one left. */
async function drain(read: ReturnType<typeof reader>, cursor?: string) {
  const seen: string[] = [];
  let batches = 0;
  for (;;) {
    const batch = await read(cursor);
    if (batch.reset) seen.length = 0;
    seen.push(...ids(batch));
    cursor = batch.cursor;
    if (batch.done) return { seen, cursor, batches: batches + 1, batch };
    if (++batches > 1000) throw new Error("source did not finish");
  }
}

it("reads every record once across record and byte budgets", async () => {
  const path = join(await directory(), "session.jsonl");
  const all = Array.from({ length: 50 }, (_, index) => `r${index}`);
  await writeFile(path, rows(...all));

  const byRecords = await drain(reader([{ path }], { records: 7 }));
  expect(byRecords.seen).toEqual(all);
  expect(byRecords.batches).toBe(8);

  // A byte budget that ends mid-record leaves that record for the next batch.
  const byBytes = await drain(
    reader([{ path }], { bytes: 100, recordBytes: 40 }),
  );
  expect(byBytes.seen).toEqual(all);
  expect(byBytes.batches).toBeGreaterThan(4);

  await appendFile(path, rows("later"));
  const appended = await reader([{ path }])(byRecords.cursor);
  expect(appended.reset).toBe(false);
  expect(ids(appended)).toEqual(["later"]);
  expect(appended.records[0]?.offset).toBe(Buffer.byteLength(rows(...all)));
});

it("waits for a record still being written and takes a complete one early", async () => {
  const path = join(await directory(), "session.jsonl");
  const second = row("second");
  await writeFile(path, `${rows("first")}${second.slice(0, 5)}`);
  const read = reader([{ path }]);

  const open = await read();
  expect(ids(open)).toEqual(["first"]);
  expect(open).toMatchObject({
    done: true,
    incomplete: true,
    recordErrors: false,
    diagnostics: [],
  });

  // The record now parses but has no newline: it is taken, and its newline
  // arriving later must not produce it a second time.
  await appendFile(path, second.slice(5));
  const complete = await read(open.cursor);
  expect(ids(complete)).toEqual(["second"]);
  expect(complete).toMatchObject({ done: true, incomplete: false });
  await appendFile(path, `\n${rows("third")}`);
  expect(ids(await read(complete.cursor))).toEqual(["third"]);
});

it("skips malformed and oversized records and says so until a reset", async () => {
  const path = join(await directory(), "session.jsonl");
  const prefix = rows("first");
  await writeFile(
    path,
    `${prefix}not-json\n${"x".repeat(500)}\n${rows("last")}`,
  );

  // The oversized record spans several batches without being buffered.
  const read = reader([{ path }], { bytes: 200, recordBytes: 64 });
  const first = await read();
  expect(ids(first)).toEqual(["first"]);
  expect(first.diagnostics).toMatchObject([
    { offset: Buffer.byteLength(prefix), recordIndex: 1 },
    { offset: Buffer.byteLength(`${prefix}not-json\n`), recordIndex: 1 },
  ]);
  expect(first.diagnostics[1]?.reason).toContain("64-byte");
  expect(first).toMatchObject({ done: false, recordErrors: true });

  const rest = await drain(read, first.cursor);
  expect(rest.seen).toEqual(["last"]);
  expect(rest.batches).toBe(2);
  // Only the batch that met a record reports it; the flag is cumulative.
  expect(rest.batch.diagnostics).toEqual([]);
  expect(rest.batch.recordErrors).toBe(true);
});

it("restarts when the source was truncated, rewritten or replaced", async () => {
  const path = join(await directory(), "session.jsonl");
  const read = reader([{ path }]);
  const fresh = async (...written: string[]) => {
    await writeFile(path, rows(...written));
    return (await read()).cursor;
  };

  let cursor = await fresh("a", "b", "c");
  await truncate(path, Buffer.byteLength(rows("a")));
  let next = await read(cursor);
  expect(next.reset).toBe(true);
  expect(ids(next)).toEqual(["a"]);

  // Same size and same bytes near the cursor, so only the mtime differs.
  cursor = await fresh("a", "b", "c");
  await writeFile(path, rows("x", "b", "c"));
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  next = await read(cursor);
  expect(next.reset).toBe(true);
  expect(ids(next)).toEqual(["x", "b", "c"]);

  // A longer replacement under the same name is a different file.
  cursor = await fresh("a", "b", "c");
  const replacement = `${path}.new`;
  await writeFile(replacement, rows("a", "b", "c", "d"));
  await rename(replacement, path);
  next = await read(cursor);
  expect(next.reset).toBe(true);
  expect(ids(next)).toEqual(["a", "b", "c", "d"]);

  // Grown in place, but the bytes before the cursor are no longer the same.
  cursor = await fresh("a", "b", "c");
  await writeFile(path, rows("a", "b", "z", "d"));
  next = await read(cursor);
  expect(next.reset).toBe(true);
  expect(ids(next)).toEqual(["a", "b", "z", "d"]);

  // A cursor from an older layout is not an error; the source starts over.
  next = await read(JSON.stringify({ segment: 0, offset: 4, skipping: false }));
  expect(next.reset).toBe(true);
  expect(ids(next)).toEqual(["a", "b", "z", "d"]);
});

it("walks a fork's ancestors to their fork points, then the leaf", async () => {
  const root = await directory();
  const ancestor = join(root, "ancestor.jsonl");
  const leaf = join(root, "leaf.jsonl");
  // The ancestor kept growing after the fork; the fork sees its first two.
  await writeFile(ancestor, rows("a1", "a2", "a3"));
  await writeFile(leaf, rows("l1", "l2"));
  const segments = [
    { path: ancestor, end: Buffer.byteLength(rows("a1", "a2")) },
    { path: leaf },
  ];

  const whole = await drain(reader(segments, { records: 3 }));
  expect(whole.seen).toEqual(["a1", "a2", "l1", "l2"]);
  const first = await reader(segments, { records: 3 })();
  expect(first.records.map((record) => record.segment)).toEqual([0, 0, 1]);
  expect(first.records[2]?.offset).toBe(0);

  await appendFile(ancestor, rows("a4"));
  await appendFile(leaf, rows("l3"));
  const appended = await reader(segments)(whole.cursor);
  expect(appended.reset).toBe(false);
  expect(ids(appended)).toEqual(["l3"]);

  // The same leaf under another lineage is another source.
  const moved = await reader([{ path: leaf }])(whole.cursor);
  expect(moved.reset).toBe(true);
  expect(ids(moved)).toEqual(["l1", "l2", "l3"]);
});

it("leaves a record that needs its successor for the batch that has it", async () => {
  const path = join(await directory(), "session.jsonl");
  await writeFile(
    path,
    `${rows("a")}${row("held", { hold: true })}\n${rows("b")}`,
  );
  const read = reader([{ path }], { records: 2 });

  const first = await read();
  expect(ids(first)).toEqual(["a"]);
  const second = await read(first.cursor);
  expect(ids(second)).toEqual(["held", "b"]);
  expect(second.done).toBe(true);

  // At the end of the source there is no successor to wait for.
  await appendFile(path, `${row("tail", { hold: true })}\n`);
  expect(ids(await read(second.cursor))).toEqual(["tail"]);
});
