import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Level as LogLevel } from "pino";
import type { PermissionMode } from "./sdk/types.js";

/**
 * Get the data directory for yep-anywhere state files.
 * Supports profiles for running multiple instances (like Chrome profiles).
 *
 * Priority:
 * 1. YEP_ANYWHERE_DATA_DIR - Full path override
 * 2. YEP_ANYWHERE_PROFILE - Appends suffix: ~/.yep-anywhere-{profile}
 * 3. Default: ~/.yep-anywhere
 */
export function getDataDir(): string {
  if (process.env.YEP_ANYWHERE_DATA_DIR) {
    return process.env.YEP_ANYWHERE_DATA_DIR;
  }
  const profile = process.env.YEP_ANYWHERE_PROFILE;
  if (profile) {
    return path.join(os.homedir(), `.yep-anywhere-${profile}`);
  }
  return path.join(os.homedir(), ".yep-anywhere");
}

/**
 * Server configuration loaded from environment variables.
 */
export interface Config {
  /** Data directory for yep-anywhere state files (indexes, metadata, uploads, etc.) */
  dataDir: string;
  /** Directory where Claude projects are stored */
  claudeProjectsDir: string;
  /** Claude sessions directory (~/.claude/projects) */
  claudeSessionsDir: string;
  /** Gemini sessions directory (~/.gemini/tmp) */
  geminiSessionsDir: string;
  /** Codex sessions directory (~/.codex/sessions) */
  codexSessionsDir: string;
  /** Idle timeout in milliseconds before process cleanup */
  idleTimeoutMs: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode: PermissionMode;
  /** Server port */
  port: number;
  /** File to write the actual port to after binding (for test harnesses) */
  portFile: string | null;
  /** Host/interface to bind to (default: 127.0.0.1). Use 0.0.0.0 to bind all interfaces. */
  host: string;
  /** Maintenance server port (default: 0 = disabled). Set to enable (e.g., PORT + 1). */
  maintenancePort: number;
  /** File to write the actual maintenance port to after binding (for test harnesses) */
  maintenancePortFile: string | null;
  /** Use mock SDK instead of real Claude SDK */
  useMockSdk: boolean;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs: number;
  /** Whether to serve frontend (proxy in dev, static in prod) */
  serveFrontend: boolean;
  /** Vite dev server port for frontend proxy */
  vitePort: number;
  /** Path to built client dist directory */
  clientDistPath: string;
  /** Path to stable (emergency) client dist directory */
  stableDistPath: string;
  /** Maximum upload file size in bytes. 0 = unlimited (default: 100MB) */
  maxUploadSizeBytes: number;
  /** Maximum queue size for pending requests. 0 = unlimited (default: 100) */
  maxQueueSize: number;
  /** Directory for log files. Default: ~/.yep-anywhere/logs */
  logDir: string;
  /** Log filename. Default: server.log */
  logFile: string;
  /** Minimum log level for console. Default: info */
  logLevel: LogLevel;
  /** Minimum log level for file. Default: same as logLevel or LOG_FILE_LEVEL */
  logFileLevel: LogLevel;
  /** Whether to log to file. Default: true */
  logToFile: boolean;
  /** Whether to log to console. Default: true */
  logToConsole: boolean;
  /** Whether cookie-based auth is disabled by env var (--auth-disable or AUTH_DISABLED=true). Used for recovery. */
  authDisabled: boolean;
  /** Cookie signing secret. Auto-generated if not provided. */
  authCookieSecret?: string;
  /** Session TTL in milliseconds. Default: 30 days */
  authSessionTtlMs: number;
}

/**
 * Load configuration from environment variables with defaults.
 */
export function loadConfig(): Config {
  // SERVE_FRONTEND defaults to true (unified server mode)
  // Set SERVE_FRONTEND=false to disable frontend serving (API-only mode)
  const serveFrontend = process.env.SERVE_FRONTEND !== "false";

  // Get data directory (supports profiles for multiple instances)
  const dataDir = getDataDir();

  // Session directories can be overridden via env vars for test isolation
  const claudeSessionsDir =
    process.env.CLAUDE_SESSIONS_DIR ??
    path.join(os.homedir(), ".claude", "projects");
  const geminiSessionsDir =
    process.env.GEMINI_SESSIONS_DIR ??
    path.join(os.homedir(), ".gemini", "tmp");
  const codexSessionsDir =
    process.env.CODEX_SESSIONS_DIR ??
    path.join(os.homedir(), ".codex", "sessions");

  return {
    dataDir,
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? claudeSessionsDir,
    claudeSessionsDir,
    geminiSessionsDir,
    codexSessionsDir,
    idleTimeoutMs: parseIntOrDefault(process.env.IDLE_TIMEOUT, 5 * 60) * 1000,
    defaultPermissionMode: parsePermissionMode(process.env.PERMISSION_MODE),
    port: parseIntOrDefault(process.env.PORT, 3400),
    portFile: process.env.PORT_FILE ?? null,
    // Host defaults to 127.0.0.1 for security and consistency (avoids IPv6 ambiguity with "localhost")
    host: process.env.HOST ?? "127.0.0.1",
    // Maintenance port disabled by default, set to enable (e.g., PORT + 1)
    maintenancePort: parseIntOrDefault(process.env.MAINTENANCE_PORT, 0),
    maintenancePortFile: process.env.MAINTENANCE_PORT_FILE ?? null,
    useMockSdk: process.env.USE_MOCK_SDK === "true",
    maxWorkers: parseIntOrDefault(process.env.MAX_WORKERS, 0),
    idlePreemptThresholdMs:
      parseIntOrDefault(process.env.IDLE_PREEMPT_THRESHOLD, 10) * 1000,
    serveFrontend,
    // Vite port defaults to main port + 2, keeping all ports sequential
    vitePort: parseIntOrDefault(
      process.env.VITE_PORT,
      parseIntOrDefault(process.env.PORT, 3400) + 2,
    ),
    // Client dist path: Check bundled location first (npm package), then monorepo (dev)
    clientDistPath:
      process.env.CLIENT_DIST_PATH ??
      (() => {
        // When published to npm, client assets are bundled into ./client-dist
        const bundledPath = path.resolve(import.meta.dirname, "../client-dist");
        if (fs.existsSync(bundledPath)) {
          return bundledPath;
        }
        // In development (monorepo), use ../client/dist
        return path.resolve(import.meta.dirname, "../../client/dist");
      })(),
    // Stable (emergency) UI build with /_stable/ base path
    stableDistPath:
      process.env.STABLE_DIST_PATH ??
      path.resolve(import.meta.dirname, "../../client/dist-stable"),
    // Default 100MB max upload size
    maxUploadSizeBytes:
      parseIntOrDefault(process.env.MAX_UPLOAD_SIZE_MB, 100) * 1024 * 1024,
    // Default 100 max queue size
    maxQueueSize: parseIntOrDefault(process.env.MAX_QUEUE_SIZE, 100),
    // Logging configuration (uses dataDir as base)
    logDir: process.env.LOG_DIR ?? path.join(dataDir, "logs"),
    logFile: process.env.LOG_FILE ?? "server.log",
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    logFileLevel: parseLogLevel(
      process.env.LOG_FILE_LEVEL ?? process.env.LOG_LEVEL,
    ),
    logToFile: process.env.LOG_TO_FILE !== "false",
    logToConsole: process.env.LOG_TO_CONSOLE !== "false",
    // Auth disabled override (for recovery if user forgets password)
    authDisabled: process.env.AUTH_DISABLED === "true",
    authCookieSecret: process.env.AUTH_COOKIE_SECRET,
    authSessionTtlMs:
      parseIntOrDefault(process.env.AUTH_SESSION_TTL_DAYS, 30) *
      24 *
      60 *
      60 *
      1000,
  };
}

/**
 * Parse an integer from string or return default value.
 */
function parseIntOrDefault(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse permission mode from string or return default.
 */
function parsePermissionMode(value: string | undefined): PermissionMode {
  if (value === "bypassPermissions" || value === "acceptEdits") {
    return value;
  }
  return "default";
}

/**
 * Parse log level from string or return default.
 */
function parseLogLevel(value: string | undefined): LogLevel {
  const validLevels: LogLevel[] = [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
  ];
  if (value && validLevels.includes(value as LogLevel)) {
    return value as LogLevel;
  }
  return "info";
}
