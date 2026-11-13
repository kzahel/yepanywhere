import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { reportDevWrapperListening } from "./dev-wrapper-client.js";
import { writeFileAtomically } from "./utils/writeFileAtomically.js";
import { getModuleEnv } from "./yaModuleEnv.js";

/**
 * Local instance record: `{dataDir}/server-instance.json` names the process
 * serving this data directory, so local tools (`pnpm ya:instance`) can find
 * and stop exactly that instance instead of matching command lines. The
 * contract is in topics/server-runtime.md#local-instance-record.
 */
export const SERVER_INSTANCE_RECORD_FILE = "server-instance.json";

export interface ServerInstanceRecord {
  version: 1;
  instanceId: string;
  pid: number;
  /** Process start, epoch ms; with pid it rejects a reused PID. */
  startedAt: number;
  host: string;
  port: number;
  url: string;
  dataDir: string;
  profile: string | null;
  /** The process that ends this YA lifetime when signalled, if not `pid`. */
  supervisor: { kind: "dev-wrapper"; pid: number; startedAt: number } | null;
  writtenAt: number;
}

const instanceId = randomUUID();
let publishedPath: string | null = null;

function devWrapperSupervisor(): ServerInstanceRecord["supervisor"] {
  const wrapper = getModuleEnv("dev-wrapper");
  const pid = Number(wrapper.PID);
  const startedAt = Number(wrapper.STARTED_AT);
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(startedAt)) {
    return null;
  }
  return { kind: "dev-wrapper", pid, startedAt };
}

function removeOwnRecord(): void {
  if (!publishedPath) return;
  try {
    const record = JSON.parse(readFileSync(publishedPath, "utf8"));
    // A later server for the same data directory owns a newer record.
    if (record?.pid === process.pid && record?.instanceId === instanceId) {
      unlinkSync(publishedPath);
    }
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

export async function publishServerInstanceRecord(args: {
  dataDir: string;
  protocol: string;
  host: string;
  port: number;
}): Promise<void> {
  const record: ServerInstanceRecord = {
    version: 1,
    instanceId,
    pid: process.pid,
    startedAt: Math.round(performance.timeOrigin),
    host: args.host,
    port: args.port,
    url: `${args.protocol}://${args.host}:${args.port}`,
    dataDir: args.dataDir,
    profile: process.env.YEP_PROFILE || null,
    supervisor: devWrapperSupervisor(),
    writtenAt: Date.now(),
  };
  const path = join(args.dataDir, SERVER_INSTANCE_RECORD_FILE);
  await writeFileAtomically(path, `${JSON.stringify(record, null, 2)}\n`);
  if (!publishedPath) process.once("exit", removeOwnRecord);
  publishedPath = path;
}

/**
 * Announce the acquired localhost bind: to the dev wrapper, which may then
 * reap obsolete instances of the same bind, and to local tools through the
 * instance record.
 */
export function announceLocalhostListening(
  port: number,
  dataDir: string,
  protocol: string,
): void {
  const host = "127.0.0.1";
  void reportDevWrapperListening({ host, port }).catch((error) => {
    console.error(
      "[DevWrapper] Failed to report acquired localhost bind:",
      error,
    );
  });
  void publishServerInstanceRecord({ dataDir, protocol, host, port }).catch(
    (error) => {
      console.error(
        "[ServerInstance] Failed to publish instance record:",
        error,
      );
    },
  );
}
