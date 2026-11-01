import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getE2ERunDirectory } from "./run-directory.js";
import { captureLeaderStartTime } from "./process-lifecycle.js";

export interface OwnedProcess {
  pid: number;
  label: string;
  runtimeDir?: string;
  leaderStartTime?: string;
}

/** Survives worker crashes so the coordinator can reclaim detached children. */
export async function registerProcess(
  record: OwnedProcess,
  filename?: string,
): Promise<string | undefined> {
  const root = getE2ERunDirectory();
  if (!root && !filename) return undefined;
  const file = filename ?? join(root!, "processes", `${randomUUID()}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  // Retain the launch location even if native identity capture fails. Such a
  // record cannot authorize coordinator signaling, but preserves diagnostics
  // and the private host recovery path instead of losing the launch entirely.
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, file);
  const leaderStartTime = await captureLeaderStartTime(record.pid);
  if (process.platform !== "win32" && !leaderStartTime)
    throw new Error(`Could not record process identity for ${record.label}`);
  writeFileSync(temporary, JSON.stringify({ ...record, leaderStartTime }));
  renameSync(temporary, file);
  return file;
}

export function readRegisteredProcess(
  file: string | undefined,
): OwnedProcess | undefined {
  return file && existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as OwnedProcess)
    : undefined;
}

export function unregisterProcess(file: string | undefined): void {
  if (file) rmSync(file, { force: true });
}
