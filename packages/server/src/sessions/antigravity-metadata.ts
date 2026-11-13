import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { antigravitySummariesPath } from "../sdk/providers/antigravity-runtime.js";
import { loadSqliteDriver } from "../storage/sqlite.js";
import { isAbsolutePath } from "../projects/paths.js";
import { catalogFileVersion } from "./catalog-adapters/row.js";

export const ANTIGRAVITY_SESSION_ID =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const ANTIGRAVITY_METADATA_LIMIT = 2_000;

async function readMetaFile(metaPath: string) {
  const handle = await open(
    metaPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metaInfo = await handle.stat();
    if (!metaInfo.isFile() || metaInfo.size > 16_384)
      throw new Error("Invalid Antigravity session metadata");
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (
      bytesRead > 16_384 ||
      catalogFileVersion(metaInfo) !== catalogFileVersion(await handle.stat())
    )
      throw new Error("Antigravity metadata changed during discovery");
    const metadata = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    ) as { cwd?: unknown };
    return { cwd: metadata.cwd, metaInfo };
  } finally {
    await handle.close();
  }
}

// One parsed workspace map per summaries database version, shared by scans.
const summaryWorkspaces = new Map<
  string,
  { version: string; workspaces: Map<string, { cwd: string; title?: string }> }
>();

/** `agy` 1.5+ records each conversation's workspace in its summaries index
 * instead of a `.meta` file. Reads only the id and workspace URI columns. */
async function cliWorkspace(directory: string, id: string) {
  const path = antigravitySummariesPath(directory);
  const versions = await Promise.all(
    [path, `${path}-wal`].map((file) =>
      stat(file).then(catalogFileVersion, (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }),
    ),
  );
  if (!versions[0]) return undefined;
  const version = versions.join("|");
  let cached = summaryWorkspaces.get(path);
  if (cached?.version !== version) {
    const driver = loadSqliteDriver();
    if (!driver) throw new Error("SQLite is unavailable");
    const workspaces = new Map<string, { cwd: string; title?: string }>();
    const database = driver.open(path, { readOnly: true });
    try {
      const query = database.prepare(
        "SELECT conversation_id, workspace_uris, title FROM conversation_summaries LIMIT ?",
      );
      try {
        for (const row of query.all<{
          conversation_id: string;
          workspace_uris: string;
          title: string | null;
        }>(ANTIGRAVITY_METADATA_LIMIT * 5)) {
          try {
            const uris = JSON.parse(row.workspace_uris) as unknown;
            // agy lists the resolved path first and the cwd it was given
            // last (`/private/tmp/x`, `/tmp/x`). YA binds the given cwd.
            const given = Array.isArray(uris)
              ? (uris as unknown[])
                  .filter(
                    (uri): uri is string =>
                      typeof uri === "string" && uri.startsWith("file://"),
                  )
                  .at(-1)
              : undefined;
            if (given)
              workspaces.set(row.conversation_id, {
                cwd: fileURLToPath(given),
                ...(row.title ? { title: row.title } : {}),
              });
          } catch {
            /* A malformed row leaves only that conversation undiscovered. */
          }
        }
      } finally {
        query.finalize();
      }
    } finally {
      database.close();
    }
    cached = { version, workspaces };
    summaryWorkspaces.set(path, cached);
  }
  return cached.workspaces.get(id);
}

/** Native identity only. No conversation decoding, agent process or authentication. */
export async function readAntigravityMetadata(directory: string, id: string) {
  if (!ANTIGRAVITY_SESSION_ID.test(id)) return null;
  const base = join(directory, id);
  try {
    const [scope, dbPath] = await Promise.all([
      realpath(directory),
      realpath(`${base}.db`),
    ]);
    if (dirname(dbPath) !== scope || basename(dbPath) !== `${id}.db`)
      throw new Error("Antigravity session escapes its native store");
    const info = await stat(dbPath);
    if (!info.isFile()) throw new Error("Invalid Antigravity database");
    let metaInfo: Stats | undefined;
    let cwd: unknown;
    let title: string | undefined;
    const metaPath = await realpath(`${base}.meta`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metaPath) {
      if (dirname(metaPath) !== scope || basename(metaPath) !== `${id}.meta`)
        throw new Error("Antigravity session escapes its native store");
      ({ cwd, metaInfo } = await readMetaFile(metaPath));
    } else {
      const workspace = await cliWorkspace(directory, id);
      if (!workspace) return null;
      ({ cwd, title } = workspace);
    }
    if (typeof cwd !== "string" || !isAbsolutePath(cwd))
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
      cwd,
      title,
      path: dbPath,
      info,
      updatedAtMs: Math.max(
        info.mtimeMs,
        metaInfo?.mtimeMs ?? 0,
        walInfo?.mtimeMs ?? 0,
      ),
      sourceVersion: [
        ...(metaInfo ? [metaInfo] : []),
        info,
        ...(walInfo ? [walInfo] : []),
      ]
        .map(catalogFileVersion)
        .concat(title ? [title] : [])
        .join("|"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
