import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Level as LogLevel } from "pino";
import {
  ALL_PERMISSION_MODES,
  CODEX_PLAN_TOOL_MODES,
  isCodexPlanToolMode,
  type CodexPlanToolMode,
} from "@yep-anywhere/shared";
import "./startupEnv.js";
import { readArtifactConfig, type ArtifactConfig } from "./artifacts/config.js";
import {
  parseSqliteMode,
  type SqliteMode,
} from "./storage/discovery-sqlite.js";
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from "./defaults.js";
import { captureStartupEnvSettings } from "./envSettings.js";
import { getDefaultCodexSessionsDir } from "./projects/codex-scanner.js";
import type { PermissionMode } from "./sdk/types.js";
import {
  parseSummaryParserWorkerMode,
  type SummaryParserWorkerMode,
} from "./sessions/summary-parser-worker-protocol.js";
import { getModuleEnv, harvestYaModuleEnv } from "./yaModuleEnv.js";

function parseCodexPlanToolMode(value: string | undefined): CodexPlanToolMode {
  if (value === undefined) return "provider-default";
  if (isCodexPlanToolMode(value)) return value;
  throw new Error(
    `YEP_CODEX_UPDATE_PLAN must be one of: ${CODEX_PLAN_TOOL_MODES.join(", ")}`,
  );
}

/**
 * Get the data directory for yep-anywhere state files.
 * Supports profiles for running multiple instances (like Chrome profiles).
 *
 * Priority:
 * 1. YEP_DATA_DIR - Full path override
 * 2. YEP_PROFILE - Appends suffix: ~/.yep-anywhere-{profile}
 * 3. Default: ~/.yep-anywhere
 */
export function getDataDir(): string {
  if (process.env.YEP_DATA_DIR) {
    return process.env.YEP_DATA_DIR;
  }
  const profile = process.env.YEP_PROFILE;
  if (profile) {
    return path.join(os.homedir(), `.yep-anywhere-${profile}`);
  }
  return path.join(os.homedir(), ".yep-anywhere");
}

/**
 * Server configuration loaded from environment variables.
 */
export interface Config {
  artifacts?: ArtifactConfig;
  /** Data directory for yep-anywhere state files (indexes, metadata, uploads, etc.) */
  dataDir: string;
  /** Whether this server was launched by the Tauri desktop app. */
  desktopRuntime: boolean;
  /** Optional discovery storage; evaluated once at startup. */
  sqliteMode: SqliteMode;
  /** Desktop-provided Codex CLI path. When set, it is authoritative. */
  codexCliPath?: string;
  /** Startup fallback for Codex update_plan availability. */
  codexPlanToolMode: CodexPlanToolMode;
  /** Directory where Claude projects are stored */
  claudeProjectsDir: string;
  /** Claude sessions directory (~/.claude/projects) */
  claudeSessionsDir: string;
  /** Gemini sessions directory (~/.gemini/tmp) */
  geminiSessionsDir: string;
  /** Codex sessions directory (~/.codex/sessions) */
  codexSessionsDir: string;
  /** pi sessions directory (~/.pi/agent/sessions) */
  piSessionsDir: string;
  /**
   * Minimum periodic full-tree rescan interval for codex session watcher (ms).
   * The watcher backs off above this floor when rescans are slow. 0 disables it.
   */
  codexWatchPeriodicRescanMs: number;
  /**
   * Session index full validation interval (ms).
   * 0 = validate every request (legacy behavior).
   */
  sessionIndexFullValidationMs: number;
  /** Session index write lock timeout (ms) for cross-process coordination. */
  sessionIndexWriteLockTimeoutMs: number;
  /** Session index lock staleness threshold (ms). */
  sessionIndexWriteLockStaleMs: number;
  /** Max concurrent summary parses across all session-index scopes. */
  sessionIndexSummaryParseConcurrency: number;
  /** Claude summary parser worker mode. Default off. */
  claudeSummaryParserWorkerMode: SummaryParserWorkerMode;
  /** Codex summary parser worker mode. Default on when unset. */
  codexSummaryParserWorkerMode: SummaryParserWorkerMode;
  /** Default active session window in days. 0 disables auto-archiving. */
  sessionAutoArchiveDays: number;
  /** Project scanner cache TTL (ms). 0 = rescan every request. */
  projectScanCacheTtlMs: number;
  /** Idle timeout in milliseconds before process cleanup */
  idleTimeoutMs: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode: PermissionMode;
  /** Server port */
  port: number;
  /** Publicly reachable HTTP(S) base used by remote session-wake clients. */
  sessionWakeBaseUrl?: string;
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
  /** Whether to log to file. Default: false */
  logToFile: boolean;
  /** Whether to pretty-print console logs. Default: true */
  logPretty: boolean;
  /** Enabled provider names. Empty = all providers enabled. */
  enabledProviders: string[];
  /**
   * Max seconds between consecutive compose times for deferred
   * (queued-while-busy) turns to join into one provider turn joined with
   * `--------` separators at a delivery boundary
   * (YEP_DEFERRED_JOIN_WINDOW_S). Default 0: never join — one verbatim
   * deferred turn is promoted per boundary, matching first-party queue
   * behavior (topics/vanilla-defaults.md). The UI-configurable server
   * setting `deferredJoinWindowSeconds` overrides this when set.
   */
  deferredJoinWindowSeconds: number;
  /**
   * Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors to
   * delivered deferred turns (YEP_COMPOSE_ANCHORS=1). Default false: queued
   * text reaches the provider verbatim
   * (topics/compose-time-context-anchors.md).
   */
  composeAnchors: boolean;
  /**
   * Absolute compose-time `[sent <ISO-8601>]` markers on provider-bound
   * user turns, placed before or after the message text
   * (YEP_TURN_TIMESTAMPS=before|after). Experimental, default off; the
   * timestamp format matches provider session jsonl so transcript and
   * context agree (topics/compose-time-context-anchors.md).
   */
  turnTimestamps: "off" | "before" | "after";
  /** Whether voice input is enabled. Default: true */
  voiceInputEnabled: boolean;
  /** Explicitly enabled server-routed voice backend ids. Empty = none. */
  voiceBackends: string[];
  /** Deepgram API key for the ya-deepgram backend (from YEP_STT_DEEPGRAM_API_KEY). */
  deepgramApiKey?: string;
  /** xAI key for the ya-grok backend (from YEP_STT_XAI_API_KEY, or scrubbed XAI_API_KEY fallback). */
  xaiSttApiKey?: string;
  /** General xAI API key from XAI_API_KEY, scrubbed from process.env after load. */
  ambientXaiApiKey?: string;
  /** Whether authenticated clients may borrow the server's xAI STT key. */
  shareXaiSttApiKeyWithClients: boolean;
  /** Whisper model name for ya-whisper backend (default: distil-large-v3). */
  whisperModel?: string;
  /** Whisper device for ya-whisper backend (default: cpu). */
  whisperDevice?: string;
  /** Whisper compute type for ya-whisper backend (default: int8). */
  whisperComputeType?: string;
  /** Parakeet fallback model name for ya-parakeet backend (default: nvidia/parakeet-tdt-0.6b-v3). */
  parakeetModel?: string;
  /** Parakeet device for ya-parakeet backend (default: auto). */
  parakeetDevice?: string;
  /** NeMo Parakeet fallback model name for ya-nemo backend (default: nvidia/parakeet-tdt-0.6b-v3). */
  nemoModel?: string;
  /** NeMo Parakeet device for ya-nemo backend (default: auto). */
  nemoDevice?: string;
  /** Allowed directory prefixes for serving local images (e.g., ["/tmp"]). Empty = disabled. */
  allowedImagePaths: string[];
  /** Managed uploads directory ({dataDir}/uploads); always part of the file-access set. */
  managedUploadsDir: string;
  /** Per-OS temp prefixes the "Temp folders" file-access toggle expands to. */
  fileAccessTempPaths: string[];
  /** Env-pinned file-access allow-list (ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS); null = unset. */
  fileAccessEnvPaths: string[] | null;

  /** Whether cookie-based auth is disabled by env var (--auth-disable or AUTH_DISABLED=true). Used for recovery. */
  authDisabled: boolean;
  /** Cookie signing secret. Auto-generated if not provided. */
  authCookieSecret?: string;
  /** Session TTL in milliseconds. Default: 30 days */
  authSessionTtlMs: number;
  /** Whether port was explicitly set via CLI (prevents runtime changes) */
  cliPortOverride: boolean;
  /** Whether host was explicitly set via CLI (prevents runtime changes) */
  cliHostOverride: boolean;
  /** Whether to open the dashboard in the default browser on startup */
  openBrowser: boolean;
  /** Enable HTTPS with an auto-generated self-signed certificate. */
  httpsSelfSigned: boolean;
  /** Desktop auth token for Tauri app. Requests with matching X-Desktop-Token header bypass auth. */
  desktopAuthToken?: string;
}

/**
 * Load configuration from environment variables with defaults.
 */
export function loadConfig(): Config {
  // Snapshot the documented env for the Environment settings panel before any
  // secrets are harvested/stripped below, redacting secrets at capture time.
  captureStartupEnvSettings();
  const authCookieSecret = process.env.AUTH_COOKIE_SECRET;
  const desktopAuthToken = process.env.DESKTOP_AUTH_TOKEN || undefined;
  delete process.env.AUTH_COOKIE_SECRET;
  delete process.env.DESKTOP_AUTH_TOKEN;
  // These are parent-session capabilities, never YA server configuration.
  // A server launched from an agent shell must not relay that parent's wake
  // credential into provider children it starts later.
  delete process.env.YEP_SESSION_WAKE_TOKEN;
  delete process.env.YEP_SESSION_WAKE_URL;
  // Harvest private YEP_STT_* values into the private store and strip them from
  // process.env before anything can spawn a child that would inherit them.
  harvestYaModuleEnv();
  const sttEnv = getModuleEnv("stt");
  const ambientXaiApiKey = process.env.XAI_API_KEY || undefined;
  // xAI documents XAI_API_KEY as the general API key name. YA accepts it as an
  // STT convenience fallback, then deletes it so provider CLIs such as Grok
  // Build cannot inherit it and silently switch to metered API billing.
  delete process.env.XAI_API_KEY;

  // SERVE_FRONTEND defaults to true (unified server mode)
  // Set SERVE_FRONTEND=false to disable frontend serving (API-only mode)
  const serveFrontend = process.env.SERVE_FRONTEND !== "false";

  // Get data directory (supports profiles for multiple instances)
  const dataDir = getDataDir();
  const desktopRuntime = parseBooleanOrDefault(process.env.YEP_DESKTOP, false);
  const codexCliPath = parseOptionalPath(
    process.env.YEP_DESKTOP_CODEX_CLI_PATH,
  );

  // Session directories can be overridden via env vars for test isolation
  const claudeSessionsDir =
    process.env.CLAUDE_SESSIONS_DIR ??
    path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "projects",
    );
  const geminiSessionsDir =
    process.env.GEMINI_SESSIONS_DIR ??
    path.join(os.homedir(), ".gemini", "tmp");
  const codexSessionsDir =
    process.env.CODEX_SESSIONS_DIR ?? getDefaultCodexSessionsDir();
  const piSessionsDir =
    process.env.PI_SESSIONS_DIR ??
    path.join(os.homedir(), ".pi", "agent", "sessions");
  // Enable periodic rescan on macOS (fs.watch misses deep file writes)
  // and Windows (fs.watch({ recursive: true }) can be unreliable for deep trees)
  const defaultCodexWatchPeriodicRescanMs =
    process.platform === "darwin" || process.platform === "win32" ? 5000 : 0;
  const codexWatchPeriodicRescanMs = Math.max(
    0,
    parseIntOrDefault(
      process.env.CODEX_WATCH_PERIODIC_RESCAN_MS,
      defaultCodexWatchPeriodicRescanMs,
    ),
  );
  const sessionIndexFullValidationMs = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_INDEX_FULL_VALIDATION_MS, 30000),
  );
  const sessionIndexWriteLockTimeoutMs = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS, 2000),
  );
  const sessionIndexWriteLockStaleMs = Math.max(
    1000,
    parseIntOrDefault(process.env.SESSION_INDEX_WRITE_LOCK_STALE_MS, 10000),
  );
  const sessionIndexSummaryParseConcurrency = Math.max(
    1,
    parseIntOrDefault(process.env.SESSION_INDEX_SUMMARY_PARSE_CONCURRENCY, 1),
  );
  const claudeSummaryParserWorkerMode = parseSummaryParserWorkerMode(
    process.env.CLAUDE_SUMMARY_PARSER_WORKER,
  );
  const codexSummaryParserWorkerMode =
    process.env.CODEX_SUMMARY_PARSER_WORKER === undefined
      ? "on"
      : parseSummaryParserWorkerMode(process.env.CODEX_SUMMARY_PARSER_WORKER);
  const projectScanCacheTtlMs = Math.max(
    0,
    parseIntOrDefault(process.env.PROJECT_SCAN_CACHE_TTL_MS, 5000),
  );
  const sessionAutoArchiveDays = Math.max(
    0,
    parseIntOrDefault(process.env.SESSION_AUTO_ARCHIVE_DAYS, 0),
  );
  const managedUploadsDir = path.join(dataDir, "uploads");
  const extraAllowedImagePaths =
    process.env.ALLOWED_IMAGE_PATHS !== undefined
      ? parseCommaSeparatedList(process.env.ALLOWED_IMAGE_PATHS)
      : getDefaultAllowedImagePaths();
  // File-access env override governs BOTH the media doors and the project-files
  // door. ALLOWED_FILE_PATHS is the generalized name; ALLOWED_IMAGE_PATHS is the
  // legacy alias. When either is set it pins (replaces) the editable allow-set
  // and the UI renders read-only. `null` = no env override (use UI settings).
  const fileAccessEnvRaw =
    process.env.ALLOWED_FILE_PATHS ?? process.env.ALLOWED_IMAGE_PATHS;
  const fileAccessEnvPaths =
    fileAccessEnvRaw !== undefined
      ? parseCommaSeparatedList(fileAccessEnvRaw)
      : null;

  return {
    dataDir,
    artifacts: readArtifactConfig(process.env),
    desktopRuntime,
    sqliteMode: parseSqliteMode(process.env.YEP_SQLITE),
    codexCliPath,
    codexPlanToolMode: parseCodexPlanToolMode(
      process.env.YEP_CODEX_UPDATE_PLAN,
    ),
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? claudeSessionsDir,
    claudeSessionsDir,
    geminiSessionsDir,
    codexSessionsDir,
    piSessionsDir,
    codexWatchPeriodicRescanMs,
    sessionIndexFullValidationMs,
    sessionIndexWriteLockTimeoutMs,
    sessionIndexWriteLockStaleMs,
    sessionIndexSummaryParseConcurrency,
    claudeSummaryParserWorkerMode,
    codexSummaryParserWorkerMode,
    sessionAutoArchiveDays,
    projectScanCacheTtlMs,
    idleTimeoutMs:
      parseIntOrDefault(
        process.env.IDLE_TIMEOUT,
        DEFAULT_IDLE_TIMEOUT_SECONDS,
      ) * 1000,
    defaultPermissionMode: parsePermissionMode(process.env.PERMISSION_MODE),
    port: parseIntOrDefault(process.env.PORT, 3400),
    sessionWakeBaseUrl: parseSessionWakeBaseUrl(
      process.env.YEP_SESSION_WAKE_BASE_URL,
    ),
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
    logToFile: process.env.LOG_TO_FILE === "true",
    logPretty: parseBooleanOrDefault(process.env.LOG_PRETTY, true),
    // Enabled providers (comma-separated). Empty = all providers.
    enabledProviders: process.env.ENABLED_PROVIDERS
      ? process.env.ENABLED_PROVIDERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    // Deferred (queued-while-busy) delivery knobs; both default off so
    // queued turns reach the provider verbatim, one per delivery boundary.
    deferredJoinWindowSeconds: Math.max(
      0,
      Number(process.env.YEP_DEFERRED_JOIN_WINDOW_S) || 0,
    ),
    composeAnchors: process.env.YEP_COMPOSE_ANCHORS === "1",
    turnTimestamps:
      process.env.YEP_TURN_TIMESTAMPS === "before" ||
      process.env.YEP_TURN_TIMESTAMPS === "after"
        ? process.env.YEP_TURN_TIMESTAMPS
        : "off",
    // Voice input (default: true, set VOICE_INPUT=false to disable)
    voiceInputEnabled: process.env.VOICE_INPUT !== "false",
    // Explicit local/test voice backends (cloud backends auto-enable on key
    // presence). Example: YEP_VOICE_BACKENDS=ya-whisper
    voiceBackends: parseCommaSeparatedList(process.env.YEP_VOICE_BACKENDS),
    deepgramApiKey: sttEnv.DEEPGRAM_API_KEY || undefined,
    xaiSttApiKey: sttEnv.XAI_API_KEY || ambientXaiApiKey,
    ambientXaiApiKey,
    shareXaiSttApiKeyWithClients: parseBooleanOrDefault(
      sttEnv.SHARE_XAI_KEY_WITH_CLIENTS,
      false,
    ),
    whisperModel: process.env.WHISPER_MODEL || undefined,
    whisperDevice: process.env.WHISPER_DEVICE || undefined,
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE || undefined,
    parakeetModel: process.env.PARAKEET_MODEL || undefined,
    parakeetDevice: process.env.PARAKEET_DEVICE || undefined,
    nemoModel: process.env.NEMO_MODEL || undefined,
    nemoDevice: process.env.NEMO_DEVICE || undefined,
    // Always allow yep-managed uploads. ALLOWED_IMAGE_PATHS adds external paths
    // like /tmp; an empty value disables only those extras.
    allowedImagePaths: Array.from(
      new Set([managedUploadsDir, ...extraAllowedImagePaths]),
    ),
    managedUploadsDir,
    fileAccessTempPaths: getDefaultAllowedImagePaths(),
    fileAccessEnvPaths,
    // Auth disabled override (for recovery if user forgets password)
    authDisabled: process.env.AUTH_DISABLED === "true",
    authCookieSecret,
    authSessionTtlMs:
      parseIntOrDefault(process.env.AUTH_SESSION_TTL_DAYS, 30) *
      24 *
      60 *
      60 *
      1000,
    // CLI override flags (set by cli.ts when --port or --host are used)
    // Also treat PORT env var as an override when explicitly set (e.g., PORT=0 for test harnesses)
    cliPortOverride:
      process.env.CLI_PORT_OVERRIDE === "true" ||
      process.env.PORT !== undefined,
    cliHostOverride: process.env.CLI_HOST_OVERRIDE === "true",
    openBrowser: process.env.OPEN_BROWSER === "true",
    httpsSelfSigned: process.env.HTTPS_SELF_SIGNED === "true",
    desktopAuthToken,
  };
}

function parseOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseSessionWakeBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "YEP_SESSION_WAKE_BASE_URL must be an absolute HTTP(S) URL",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "YEP_SESSION_WAKE_BASE_URL must be an HTTP(S) URL without credentials, query parameters, or a fragment",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

function parseCommaSeparatedList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

export function getDefaultAllowedImagePaths(
  platform: NodeJS.Platform = process.platform,
  tmpDir: string = os.tmpdir(),
): string[] {
  // Windows has no `/tmp`; the real temp dir is `os.tmpdir()`
  // (%LOCALAPPDATA%\Temp / %TEMP%). Posix keeps `/tmp`.
  if (platform === "win32") {
    return Array.from(new Set([tmpDir]));
  }
  return ["/tmp"];
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
 * Parse boolean-ish env values with a default fallback.
 */
function parseBooleanOrDefault(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return defaultValue;
}

/**
 * Parse permission mode from string or return default.
 */
function parsePermissionMode(value: string | undefined): PermissionMode {
  if (
    typeof value === "string" &&
    (ALL_PERMISSION_MODES as readonly string[]).includes(value)
  ) {
    return value as PermissionMode;
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
