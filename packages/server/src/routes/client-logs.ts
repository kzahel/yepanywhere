import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { getLogger } from "../logging/logger.js";

const MAX_ENTRIES_PER_REQUEST = 500;
/** Daily files older than this are deleted when a new day's first post lands. */
export const CLIENT_LOG_RETENTION_DAYS = 14;
/** One device's file for one day stops growing here; later posts are dropped. */
export const CLIENT_LOG_FILE_MAX_BYTES = 32 * 1024 * 1024;
const DAILY_FILE = /^client-(\d{4}-\d{2}-\d{2})-[A-Za-z0-9-]+\.jsonl$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogEntry {
  id?: number;
  timestamp: number;
  level: string;
  prefix: string;
  message: string;
  /** Which tab wrote the entry; one device's tabs share a collection queue. */
  tabId?: string;
}

interface ClientLogsBody {
  entries: LogEntry[];
  deviceId?: string;
}

export interface ClientLogsRoutesOptions {
  dataDir: string;
}

export function createClientLogsRoutes(options: ClientLogsRoutesOptions): Hono {
  const app = new Hono();
  const logsDir = join(options.dataDir, "logs", "client-logs");
  let prepared: { date: string; done: Promise<void> } | null = null;

  /** Once per server day: create the directory and drop expired files. */
  function prepare(date: string): Promise<void> {
    if (prepared?.date !== date) {
      const done = prune(date).catch((error: unknown) => {
        if (prepared?.done === done) prepared = null;
        throw error;
      });
      prepared = { date, done };
    }
    return prepared.done;
  }

  async function prune(date: string): Promise<void> {
    await mkdir(logsDir, { recursive: true });
    const cutoff = new Date(
      Date.parse(date) - CLIENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    // Retention is best effort: a file that cannot be removed must not stop
    // today's logs, and the next server day retries.
    try {
      for (const name of await readdir(logsDir)) {
        const day = DAILY_FILE.exec(name)?.[1];
        if (day && day < cutoff) await rm(join(logsDir, name), { force: true });
      }
    } catch (error) {
      getLogger().warn({ err: error }, "CLIENT_LOGS: retention prune failed");
    }
  }

  async function sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  app.post("/", async (c) => {
    let body: ClientLogsBody;
    try {
      body = await c.req.json<ClientLogsBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return c.json({ error: "entries must be a non-empty array" }, 400);
    }

    const entries = body.entries.slice(0, MAX_ENTRIES_PER_REQUEST);

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let filename: string;
    if (body.deviceId && UUID_REGEX.test(body.deviceId)) {
      filename = `client-${date}-${body.deviceId}.jsonl`;
    } else {
      const random = Math.random().toString(36).slice(2, 8);
      filename = `client-${date}-${random}.jsonl`;
    }

    await prepare(date);
    const path = join(logsDir, filename);
    if ((await sizeOf(path)) >= CLIENT_LOG_FILE_MAX_BYTES) {
      return c.json({ received: 0, dropped: entries.length });
    }

    const lines = entries.map((entry) =>
      JSON.stringify({
        ...entry,
        _receivedAt: Date.now(),
      }),
    );

    await appendFile(path, `${lines.join("\n")}\n`);

    return c.json({ received: entries.length });
  });

  return app;
}
