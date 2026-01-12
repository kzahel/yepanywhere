import { homedir } from "node:os";
import { join } from "node:path";
import type { LogConfig, LogLevel } from "./logger.js";

export interface RelayConfig {
  /** Port for the relay server (default: 4400) */
  port: number;
  /** File to write the actual port to after binding (for test harnesses) */
  portFile: string | null;
  /** Data directory for SQLite database (default: ~/.yep-relay/) */
  dataDir: string;
  /** Ping interval for waiting connections in ms (default: 60000) */
  pingIntervalMs: number;
  /** Pong timeout in ms - drop connection if no pong (default: 30000) */
  pongTimeoutMs: number;
  /** Days of inactivity before username can be reclaimed (default: 90) */
  reclaimDays: number;
  /** Logging configuration */
  logging: LogConfig;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "false" && value !== "0";
}

export function loadConfig(): RelayConfig {
  const dataDir = process.env.RELAY_DATA_DIR ?? join(homedir(), ".yep-relay");
  const logLevel = (process.env.RELAY_LOG_LEVEL ?? "info") as LogLevel;
  const fileLevel = (process.env.RELAY_LOG_FILE_LEVEL ?? logLevel) as LogLevel;

  return {
    port: getEnvNumber("RELAY_PORT", 4400),
    portFile: process.env.RELAY_PORT_FILE ?? null,
    dataDir,
    pingIntervalMs: getEnvNumber("RELAY_PING_INTERVAL_MS", 60_000),
    pongTimeoutMs: getEnvNumber("RELAY_PONG_TIMEOUT_MS", 30_000),
    reclaimDays: getEnvNumber("RELAY_RECLAIM_DAYS", 90),
    logging: {
      logDir: process.env.RELAY_LOG_DIR ?? join(dataDir, "logs"),
      logFile: process.env.RELAY_LOG_FILE ?? "relay.log",
      consoleLevel: logLevel,
      fileLevel,
      logToConsole: getEnvBoolean("RELAY_LOG_TO_CONSOLE", true),
      logToFile: getEnvBoolean("RELAY_LOG_TO_FILE", true),
      prettyPrint: process.env.NODE_ENV !== "production",
    },
  };
}
