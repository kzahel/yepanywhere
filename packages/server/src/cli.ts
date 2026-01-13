#!/usr/bin/env node

/**
 * CLI entry point for yepanywhere
 *
 * Usage:
 *   yepanywhere                    # Start server with defaults
 *   yepanywhere --help            # Show help
 *   yepanywhere --version         # Show version
 *
 * Environment variables:
 *   PORT                          # Server port (default: 3400)
 *   YEP_ANYWHERE_DATA_DIR         # Data directory override
 *   YEP_ANYWHERE_PROFILE          # Profile name (creates ~/.yep-anywhere-{profile}/)
 *   AUTH_ENABLED                  # Enable cookie auth (default: false)
 *   LOG_LEVEL                     # Log level: fatal, error, warn, info, debug, trace
 *   ... (see CLAUDE.md for full list)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MINIMUM_NODE_VERSION = 20;

/**
 * Check if Node.js version meets minimum requirements.
 * Exits with error if version is too low.
 */
function checkNodeVersion(): void {
  const currentVersion = process.versions.node;
  const majorVersion = Number.parseInt(currentVersion.split(".")[0] ?? "0", 10);

  if (majorVersion < MINIMUM_NODE_VERSION) {
    console.error(`Error: Node.js ${MINIMUM_NODE_VERSION}+ is required.`);
    console.error(`Current version: ${currentVersion}`);
    console.error("");
    console.error("Please upgrade Node.js: https://nodejs.org/");
    process.exit(1);
  }
}

/**
 * Check if Claude CLI is installed and warn if not found.
 * Does not exit - Claude is optional but recommended.
 */
function checkClaudeCli(): void {
  try {
    execSync("which claude", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    console.warn("Warning: Claude CLI not found.");
    console.warn(
      "Claude Code is the primary supported agent. Install it to use Claude sessions:",
    );
    console.warn("  curl -fsSL https://claude.ai/install.sh | bash");
    console.warn("");
  }
}

function showHelp(): void {
  console.log(`
yepanywhere - A mobile-first supervisor for Claude Code agents

USAGE:
  yepanywhere [OPTIONS]

OPTIONS:
  --help, -h            Show this help message
  --version, -v         Show version number
  --port <number>       Server port (default: 3400)
  --host <address>      Host/interface to bind to (default: localhost)
                        Use 0.0.0.0 to bind all interfaces
  --auth-disable        Disable authentication (bypass auth even if enabled in settings)
                        Use this to recover if you forget your password

ENVIRONMENT VARIABLES:
  PORT                          Server port (default: 3400)
  HOST                          Host/interface to bind (default: localhost)
  YEP_ANYWHERE_DATA_DIR         Data directory override
  YEP_ANYWHERE_PROFILE          Profile name (creates ~/.yep-anywhere-{profile}/)
  AUTH_DISABLED                 Disable auth (bypass even if enabled in settings)
  LOG_LEVEL                     Log level: fatal, error, warn, info, debug, trace
  MAINTENANCE_PORT              Maintenance server port (default: disabled)

EXAMPLES:
  # Start with defaults (port 3400, localhost only)
  yepanywhere

  # Start on custom port
  yepanywhere --port 8000

  # Bind to all interfaces (accessible from network)
  yepanywhere --host 0.0.0.0

  # Custom port and host
  yepanywhere --port 8000 --host 0.0.0.0

  # Use development profile (separate data directory)
  YEP_ANYWHERE_PROFILE=dev yepanywhere

  # Bypass auth if you forgot your password
  yepanywhere --auth-disable

DOCUMENTATION:
  For full documentation, see: https://github.com/kzahel/yepanywhere

DATA DIRECTORY:
  Default: ~/.yep-anywhere/
  Contains: logs/, indexes/, uploads/, session metadata, push subscriptions

REQUIREMENTS:
  - Node.js >= 20
  - Claude CLI installed (curl -fsSL https://claude.ai/install.sh | bash)
`);
}

function getVersion(): string {
  try {
    // Read package.json from the package root
    const packageJsonPath = path.resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "unknown";
  } catch (error) {
    return "unknown";
  }
}

function showVersion(): void {
  console.log(`yepanywhere v${getVersion()}`);
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  showVersion();
  process.exit(0);
}

// Parse --port option
const portIndex = args.indexOf("--port");
if (portIndex !== -1) {
  const portValue = args[portIndex + 1];
  if (!portValue || portValue.startsWith("-")) {
    console.error("Error: --port requires a value (e.g., --port 8000)");
    process.exit(1);
  }
  const portNum = Number.parseInt(portValue, 10);
  if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
    console.error("Error: --port must be a valid port number (1-65535)");
    process.exit(1);
  }
  process.env.PORT = portValue;
  // Mark that port was explicitly set via CLI (prevents runtime changes)
  process.env.CLI_PORT_OVERRIDE = "true";
  // Remove --port and its value from args
  args.splice(portIndex, 2);
}

// Parse --host option
const hostIndex = args.indexOf("--host");
if (hostIndex !== -1) {
  const hostValue = args[hostIndex + 1];
  if (!hostValue || hostValue.startsWith("-")) {
    console.error("Error: --host requires a value (e.g., --host 0.0.0.0)");
    process.exit(1);
  }
  process.env.HOST = hostValue;
  // Mark that host was explicitly set via CLI (prevents runtime changes)
  process.env.CLI_HOST_OVERRIDE = "true";
  // Remove --host and its value from args
  args.splice(hostIndex, 2);
}

// Parse --auth-disable flag
const authDisableIndex = args.indexOf("--auth-disable");
if (authDisableIndex !== -1) {
  process.env.AUTH_DISABLED = "true";
  args.splice(authDisableIndex, 1);
}

// If there are unknown arguments, show error and help
if (args.length > 0) {
  console.error(`Error: Unknown arguments: ${args.join(" ")}`);
  console.error("");
  console.error("Run 'yepanywhere --help' for usage information.");
  process.exit(1);
}

// Run prerequisite checks before starting
checkNodeVersion();
checkClaudeCli();

// Set NODE_ENV to production if not already set (CLI users expect production mode)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// Start the server by importing the main module
// This ensures all initialization happens in index.ts as designed
async function start() {
  try {
    await import("./index.js");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
