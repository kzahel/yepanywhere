import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isAbsolutePath } from "../projects/paths.js";
import { catalogFileVersion } from "./catalog-adapters/row.js";

export const ANTIGRAVITY_SESSION_ID =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const ANTIGRAVITY_METADATA_LIMIT = 2_000;

/** Native identity only. No database decoding, agent process or authentication. */
export async function readAntigravityMetadata(directory: string, id: string) {
  if (!ANTIGRAVITY_SESSION_ID.test(id)) return null;
  const base = join(directory, id);
  try {
    const [scope, metaPath, dbPath] = await Promise.all([
      realpath(directory),
      realpath(`${base}.meta`),
      realpath(`${base}.db`),
    ]);
    if (
      dirname(metaPath) !== scope ||
      dirname(dbPath) !== scope ||
      basename(metaPath) !== `${id}.meta` ||
      basename(dbPath) !== `${id}.db`
    )
      throw new Error("Antigravity session escapes its native store");
    const [metaInfo, info] = await Promise.all([stat(metaPath), stat(dbPath)]);
    if (!metaInfo.isFile() || !info.isFile() || metaInfo.size > 16_384)
      throw new Error("Invalid Antigravity session metadata");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as {
      cwd?: unknown;
    };
    if (typeof metadata.cwd !== "string" || !isAbsolutePath(metadata.cwd))
      throw new Error("Antigravity session has no absolute project path");
    // SQLite may append to the WAL without touching the database itself.
    const walPath = `${base}.db-wal`;
    let walInfo: Stats | undefined;
    try {
      const physical = await realpath(walPath);
      if (dirname(physical) !== scope || basename(physical) !== `${id}.db-wal`)
        throw new Error("Antigravity WAL escapes its native store");
      walInfo = await stat(physical);
      if (!walInfo.isFile()) throw new Error("Invalid Antigravity WAL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      scope,
      cwd: metadata.cwd,
      path: dbPath,
      info,
      updatedAtMs: Math.max(
        info.mtimeMs,
        metaInfo.mtimeMs,
        walInfo?.mtimeMs ?? 0,
      ),
      sourceVersion: [metaInfo, info, ...(walInfo ? [walInfo] : [])]
        .map(catalogFileVersion)
        .join("|"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
