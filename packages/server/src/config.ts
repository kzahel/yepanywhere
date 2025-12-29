import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode } from "./sdk/types.js";

/**
 * Server configuration loaded from environment variables.
 */
export interface Config {
  /** Directory where Claude projects are stored */
  claudeProjectsDir: string;
  /** Idle timeout in milliseconds before process cleanup */
  idleTimeoutMs: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode: PermissionMode;
  /** Server port */
  port: number;
}

/**
 * Load configuration from environment variables with defaults.
 */
export function loadConfig(): Config {
  return {
    claudeProjectsDir:
      process.env.CLAUDE_PROJECTS_DIR ??
      path.join(os.homedir(), ".claude", "projects"),
    idleTimeoutMs: parseIntOrDefault(
      process.env.IDLE_TIMEOUT_MS,
      5 * 60 * 1000,
    ),
    defaultPermissionMode: parsePermissionMode(process.env.PERMISSION_MODE),
    port: parseIntOrDefault(process.env.PORT, 3400),
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
