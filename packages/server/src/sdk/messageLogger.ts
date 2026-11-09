import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { loadConfig } from "../config.js";
import { createRotatingFileStream } from "../logging/rotating-file-stream.js";

/**
 * Simple JSONL logger for raw SDK messages.
 * Captures exact message shapes for analysis.
 *
 * Disabled by default. Enable via LOG_SDK_MESSAGES=true
 * Output: {logDir}/sdk-raw.jsonl, rotated by size like server.log.
 */

let writeStream: Writable | null = null;
let enabled = false;

function disableMessageLogger(stream: Writable): void {
  if (writeStream !== stream) return;
  enabled = false;
  writeStream = null;
  stream.destroy();
}

/**
 * Initialize the SDK message logger.
 * Call once at server startup.
 */
export function initMessageLogger(): void {
  enabled = process.env.LOG_SDK_MESSAGES === "true";
  if (!enabled) return;

  const config = loadConfig();
  const logPath = path.join(config.logDir, "sdk-raw.jsonl");

  try {
    // Ensure log directory exists
    fs.mkdirSync(config.logDir, { recursive: true });

    const stream = createRotatingFileStream(logPath);
    stream.on("error", () => {
      disableMessageLogger(stream);
    });
    writeStream = stream;
  } catch {
    enabled = false;
    writeStream = null;
    return;
  }

  // Log startup
  logRaw({
    _meta: "logger_started",
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });
}

/**
 * Log a raw SDK message.
 */
export function logSDKMessage(
  sessionId: string,
  message: unknown,
  options?: {
    provider?: string;
  },
): void {
  if (!enabled || !writeStream) return;

  const base = {
    _ts: Date.now(),
    _sid: sessionId,
    ...(options?.provider ? { _provider: options.provider } : {}),
  };

  if (message && typeof message === "object" && !Array.isArray(message)) {
    logRaw({
      ...base,
      ...(message as Record<string, unknown>),
    });
    return;
  }

  logRaw({
    ...base,
    _message: message,
  });
}

/**
 * Log any object as a raw line.
 */
function logRaw(obj: unknown): void {
  if (!enabled || !writeStream) return;
  let line: string;
  try {
    line = `${JSON.stringify(obj)}\n`;
  } catch {
    return;
  }
  const stream = writeStream;
  try {
    stream.write(line);
  } catch {
    disableMessageLogger(stream);
  }
}

/**
 * Close the logger.
 */
export function closeMessageLogger(): void {
  const stream = writeStream;
  enabled = false;
  writeStream = null;
  if (stream) {
    stream.end();
  }
}
