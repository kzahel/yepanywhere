import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openSqliteOrThrow, type SqliteDatabase } from "../src/sqlite.js";

it("refuses writes and file creation while reading newly committed WAL data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-read-only-sqlite-"));
  const path = join(directory, "provider.db");
  let writer: SqliteDatabase | undefined;
  let reader: SqliteDatabase | undefined;
  try {
    expect(() => openSqliteOrThrow(path, { readOnly: true })).toThrow();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    writer = openSqliteOrThrow(path);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages (text TEXT)");
    const insert = writer.prepare("INSERT INTO messages VALUES (?)");
    insert.run("first");
    const original = await readFile(path);
    reader = openSqliteOrThrow(path, { readOnly: true });
    const query = reader.prepare("SELECT text FROM messages ORDER BY rowid");
    expect(query.all()).toEqual([{ text: "first" }]);
    insert.run("committed in WAL");
    expect(query.all()).toEqual([
      { text: "first" },
      { text: "committed in WAL" },
    ]);
    expect(() =>
      reader!.exec("INSERT INTO messages VALUES ('refused')"),
    ).toThrow();
    reader.close();
    reader = undefined;
    expect(await readFile(path)).toEqual(original);
    writer.close();
    writer = undefined;
    reader = openSqliteOrThrow(path, { readOnly: true });
    expect(
      reader.prepare("SELECT count(*) AS count FROM messages").get(),
    ).toEqual({ count: 2 });
  } finally {
    reader?.close();
    writer?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
