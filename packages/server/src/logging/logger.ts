import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { createRotatingFileStream } from "./rotating-file-stream.js";

/**
 * Valid log levels.
 */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogConfig {
  /** Directory for log files. Default: ~/.yep-anywhere/logs */
  logDir: string;
  /** Log filename. Default: server.log */
  logFile: string;
  /** Minimum log level for console. Default: info */
  consoleLevel: LogLevel;
  /** Minimum log level for file. Default: info (or LOG_FILE_LEVEL env var) */
  fileLevel: LogLevel;
  /** Log to file. Default: true */
  logToFile: boolean;
  /** Use pretty printing for console. Default: true in dev */
  prettyPrint: boolean;
}

function getDefaultConfig(): LogConfig {
  const autoConsoleLevel = process.env.VITEST === "true" ? "warn" : "info";
  return {
    logDir:
      process.env.LOG_DIR ?? path.join(os.homedir(), ".yep-anywhere", "logs"),
    logFile: process.env.LOG_FILE ?? "server.log",
    consoleLevel: (process.env.LOG_LEVEL as LogLevel) || autoConsoleLevel,
    fileLevel:
      (process.env.LOG_FILE_LEVEL as LogLevel) ||
      (process.env.LOG_LEVEL as LogLevel) ||
      "info",
    // Auto-init logger stays console-only. The real server startup path calls
    // initLogger(loadConfig()), so configured file logging still works there.
    logToFile: false,
    prettyPrint: !["false", "0", "no", "off"].includes(
      (process.env.LOG_PRETTY ?? "").toLowerCase(),
    ),
  };
}

let logger: pino.Logger | null = null;
/** Current console log level (for dynamic adjustment) */
let currentConsoleLevel: LogLevel = getDefaultConfig().consoleLevel;
/** Current file log level (for dynamic adjustment) */
let currentFileLevel: LogLevel = getDefaultConfig().fileLevel;
/** Multistream instance (needed for dynamic level changes) */
let multistream: pino.MultiStreamRes | null = null;
let originalConsole: {
  log: typeof console.log;
  error: typeof console.error;
  warn: typeof console.warn;
  info: typeof console.info;
  debug: typeof console.debug;
} | null = null;

/**
 * Initialize the logger with the given configuration.
 * This should be called once at server startup.
 */
export function initLogger(config: Partial<LogConfig> = {}): pino.Logger {
  const finalConfig = { ...getDefaultConfig(), ...config };
  let fileLoggingInitError: Error | null = null;

  // Store current levels
  currentConsoleLevel = finalConfig.consoleLevel;
  currentFileLevel = finalConfig.fileLevel;

  const streams: pino.StreamEntry[] = [];

  // Console stream
  if (finalConfig.consoleLevel !== "silent") {
    if (finalConfig.prettyPrint) {
      const pretty = pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname,console",
        },
      });
      streams.push({
        stream: pretty,
        level: finalConfig.consoleLevel as pino.Level,
      });
    } else {
      streams.push({
        stream: process.stdout,
        level: finalConfig.consoleLevel as pino.Level,
      });
    }
  }

  // File stream
  if (finalConfig.logToFile) {
    try {
      fs.mkdirSync(finalConfig.logDir, { recursive: true });
      const logPath = path.join(finalConfig.logDir, finalConfig.logFile);
      const fileStream = createRotatingFileStream(logPath);
      fileStream.on("error", () => {
        fileStream.destroy();
      });
      streams.push({
        stream: fileStream,
        level: finalConfig.fileLevel as pino.Level,
      });
    } catch (err) {
      fileLoggingInitError =
        err instanceof Error ? err : new Error(String(err));
    }
  }

  // Determine minimum level across all streams (pino needs base level <= stream levels)
  const minLevel = getMinLevel(finalConfig.consoleLevel, finalConfig.fileLevel);

  if (streams.length === 0) {
    // No streams configured, use a silent logger
    logger = pino({ level: "silent" });
    multistream = null;
  } else if (streams.length === 1 && streams[0]) {
    logger = pino({ level: streams[0].level }, streams[0].stream);
    multistream = null;
  } else {
    multistream = pino.multistream(streams);
    logger = pino({ level: minLevel }, multistream);
  }

  if (fileLoggingInitError) {
    logger.warn(
      { err: fileLoggingInitError, logDir: finalConfig.logDir },
      "Failed to initialize file logging; continuing with console-only logger",
    );
  }

  return logger;
}

/**
 * Get the minimum (most verbose) of two log levels.
 */
function getMinLevel(a: LogLevel, b: LogLevel): LogLevel {
  const order: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5,
    silent: 6,
  };
  return order[a] <= order[b] ? a : b;
}

/**
 * Get the logger instance. Must call initLogger first.
 */
export function getLogger(): pino.Logger {
  if (!logger) {
    // Auto-initialize with defaults if not yet initialized
    return initLogger();
  }
  return logger;
}

/**
 * Intercept console.log/error/warn/info and route through pino logger.
 * Call this after initLogger() to capture all console output.
 */
export function interceptConsole(): void {
  if (originalConsole) {
    // Already intercepted
    return;
  }

  const log = getLogger();

  // Save original console methods
  originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  // Replace console methods
  console.log = (...args: unknown[]) => {
    log.info({ console: true }, formatConsoleArgs(args));
  };

  console.error = (...args: unknown[]) => {
    log.error({ console: true }, formatConsoleArgs(args));
  };

  console.warn = (...args: unknown[]) => {
    log.warn({ console: true }, formatConsoleArgs(args));
  };

  console.info = (...args: unknown[]) => {
    log.info({ console: true }, formatConsoleArgs(args));
  };

  console.debug = (...args: unknown[]) => {
    log.debug({ console: true }, formatConsoleArgs(args));
  };
}

/**
 * Restore original console methods.
 */
export function restoreConsole(): void {
  if (originalConsole) {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
    originalConsole = null;
  }
}

/**
 * Format console arguments into a string for pino.
 */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Get the path to the current log file.
 */
export function getLogFilePath(config: Partial<LogConfig> = {}): string {
  const finalConfig = { ...getDefaultConfig(), ...config };
  return path.join(finalConfig.logDir, finalConfig.logFile);
}

/**
 * Get the log directory path.
 */
export function getLogDir(config: Partial<LogConfig> = {}): string {
  const finalConfig = { ...getDefaultConfig(), ...config };
  return finalConfig.logDir;
}

/**
 * Set log levels dynamically at runtime.
 * Changes take effect immediately for new log calls.
 *
 * Note: Due to pino's multistream architecture, dynamic level changes
 * work by updating the base logger level. Individual stream levels
 * are set at initialization and filtered at the stream level.
 *
 * @param console - New console log level (optional)
 * @param file - New file log level (optional)
 */
export function setLogLevels(options: {
  console?: LogLevel;
  file?: LogLevel;
}): void {
  if (options.console !== undefined) {
    currentConsoleLevel = options.console;
  }
  if (options.file !== undefined) {
    currentFileLevel = options.file;
  }

  // Update the base logger level to the minimum of both
  // This ensures messages can flow to the appropriate streams
  const log = getLogger();
  const minLevel = getMinLevel(currentConsoleLevel, currentFileLevel);
  log.level = minLevel;

  // Note: For true per-stream dynamic levels, we'd need to reinitialize
  // the logger with new streams. The current approach works for the
  // common case of making console quieter while keeping file verbose.
}

/**
 * Get current log levels for both console and file.
 */
export function getLogLevels(): { console: LogLevel; file: LogLevel } {
  return {
    console: currentConsoleLevel,
    file: currentFileLevel,
  };
}

/**
 * Set the log level dynamically at runtime (legacy, sets both).
 * @deprecated Use setLogLevels({ console, file }) instead
 */
export function setLogLevel(level: LogLevel): void {
  setLogLevels({ console: level, file: level });
}

/**
 * Get the current base log level.
 * @deprecated Use getLogLevels() instead
 */
export function getLogLevel(): LogLevel {
  const log = getLogger();
  return log.level as LogLevel;
}
