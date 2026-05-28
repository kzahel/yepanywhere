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
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { whichCommand } from "./sdk/cli-detection.js";

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
    execSync(whichCommand("claude"), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    console.warn("Warning: Claude CLI not found.");
    console.warn(
      "Claude Code is the primary supported agent. Install it to use Claude sessions:",
    );
    console.warn(
      os.platform() === "win32"
        ? "  irm https://claude.ai/install.ps1 | iex"
        : "  curl -fsSL https://claude.ai/install.sh | bash",
    );
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
  --https-self-signed   Enable HTTPS using a self-signed certificate
                        stored in the app data directory
  --open                Open the dashboard in your default browser on startup
  --auth-disable        Disable authentication (bypass auth even if enabled in settings)
                        Emergency recovery mode; re-enable auth after fixing config

SETUP OPTIONS (for headless installation):
  --setup-auth <password>
                        Set up local authentication with the given password
                        (min 6 characters). Exits after setup.

  --setup-remote-access --username <name> --password <pass> [--relay <url>]
                        Set up remote access with SRP authentication.
                        Registers with the relay to verify username availability.
                        Exits with error if username is taken.
                        --username: Relay username (3-32 chars, lowercase alphanumeric + hyphens)
                        --password: SRP password (min 8 characters)
                        --relay: Relay URL (default: wss://relay.yepanywhere.com/ws)

AUTO-START SERVICE:
  --install-service     Install yepanywhere to start automatically at login,
                        running silently in the background (no console window).
                        Uses the platform-native mechanism: a Scheduled Task on
                        Windows, a launchd LaunchAgent on macOS, or a systemd
                        user service on Linux. Pass --port/--host to bake them
                        into the service. Starts immediately after installing.
  --uninstall-service   Remove the auto-start service.
  --service-status      Show whether the auto-start service is installed.

ENVIRONMENT VARIABLES:
  PORT                          Server port (default: 3400)
  HOST                          Host/interface to bind (default: localhost)
  YEP_ANYWHERE_DATA_DIR         Data directory override
  YEP_ANYWHERE_PROFILE          Profile name (creates ~/.yep-anywhere-{profile}/)
  AUTH_DISABLED                 Disable auth (bypass even if enabled in settings)
  HTTPS_SELF_SIGNED             Enable HTTPS with a self-signed certificate
  LOG_LEVEL                     Log level: fatal, error, warn, info, debug, trace
  LOG_PRETTY                    Pretty-print console logs (default: true)
  MAINTENANCE_PORT              Maintenance server port (default: disabled)
  CODEX_WATCH_PERIODIC_RESCAN_MS
                                Codex watcher fallback rescan interval in ms (default: 5000 on macOS, 0 elsewhere)
  SESSION_INDEX_FULL_VALIDATION_MS
                                Session index full validation interval in ms (default: 30000, 0 = validate every request)
  SESSION_INDEX_WRITE_LOCK_TIMEOUT_MS
                                Session index write lock timeout in ms (default: 2000)
  SESSION_INDEX_WRITE_LOCK_STALE_MS
                                Session index stale lock threshold in ms (default: 10000)
  PROJECT_SCAN_CACHE_TTL_MS
                                Project scan cache TTL in ms (default: 5000, 0 = rescan every request)

EXAMPLES:
  # Start with defaults (port 3400, localhost only)
  yepanywhere

  # Start on custom port
  yepanywhere --port 8000

  # Bind to all interfaces (accessible from network)
  yepanywhere --host 0.0.0.0

  # HTTPS on localhost/LAN with auto-generated self-signed cert
  yepanywhere --host 0.0.0.0 --https-self-signed

  # Custom port and host
  yepanywhere --port 8000 --host 0.0.0.0

  # Use development profile (separate data directory)
  YEP_ANYWHERE_PROFILE=dev yepanywhere

  # Reset local auth password (headless recovery)
  yepanywhere --setup-auth "mypassword123"

  # Emergency auth bypass (temporary)
  yepanywhere --auth-disable

  # Start automatically at login (silent background service)
  yepanywhere --install-service

  # Auto-start on a custom port bound to the LAN
  yepanywhere --install-service --port 8000 --host 0.0.0.0

  # Remove the auto-start service
  yepanywhere --uninstall-service

  # Headless setup: configure remote access
  yepanywhere --setup-remote-access --username myserver --password "secretpass123"

  # Headless setup: remote access with custom relay
  yepanywhere --setup-remote-access --username myserver --password "secretpass123" --relay wss://my-relay.example.com/ws

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

// Parse --open flag
const openIndex = args.indexOf("--open");
if (openIndex !== -1) {
  process.env.OPEN_BROWSER = "true";
  args.splice(openIndex, 1);
}

// Parse --https-self-signed flag
const httpsSelfSignedIndex = args.indexOf("--https-self-signed");
if (httpsSelfSignedIndex !== -1) {
  process.env.HTTPS_SELF_SIGNED = "true";
  args.splice(httpsSelfSignedIndex, 1);
}

// Parse --auth-disable flag
const authDisableIndex = args.indexOf("--auth-disable");
if (authDisableIndex !== -1) {
  process.env.AUTH_DISABLED = "true";
  args.splice(authDisableIndex, 1);
}

// Parse auto-start service flags
const installServiceIndex = args.indexOf("--install-service");
let installServiceFlag = false;
if (installServiceIndex !== -1) {
  installServiceFlag = true;
  args.splice(installServiceIndex, 1);
}

const uninstallServiceIndex = args.indexOf("--uninstall-service");
let uninstallServiceFlag = false;
if (uninstallServiceIndex !== -1) {
  uninstallServiceFlag = true;
  args.splice(uninstallServiceIndex, 1);
}

const serviceStatusIndex = args.indexOf("--service-status");
let serviceStatusFlag = false;
if (serviceStatusIndex !== -1) {
  serviceStatusFlag = true;
  args.splice(serviceStatusIndex, 1);
}

// Parse --setup-auth flag
const setupAuthIndex = args.indexOf("--setup-auth");
let setupAuthPassword: string | undefined;
if (setupAuthIndex !== -1) {
  const passwordValue = args[setupAuthIndex + 1];
  if (!passwordValue || passwordValue.startsWith("-")) {
    console.error("Error: --setup-auth requires a password value");
    process.exit(1);
  }
  setupAuthPassword = passwordValue;
  args.splice(setupAuthIndex, 2);
}

// Parse --setup-remote-access flag and its options
const setupRemoteIndex = args.indexOf("--setup-remote-access");
let setupRemoteAccess = false;
let remoteUsername: string | undefined;
let remotePassword: string | undefined;
let remoteRelay: string | undefined;

if (setupRemoteIndex !== -1) {
  setupRemoteAccess = true;
  args.splice(setupRemoteIndex, 1);

  // Parse --username
  const usernameIndex = args.indexOf("--username");
  if (usernameIndex !== -1) {
    const usernameValue = args[usernameIndex + 1];
    if (!usernameValue || usernameValue.startsWith("-")) {
      console.error("Error: --username requires a value");
      process.exit(1);
    }
    remoteUsername = usernameValue;
    args.splice(usernameIndex, 2);
  }

  // Parse --password
  const passwordIndex = args.indexOf("--password");
  if (passwordIndex !== -1) {
    const passwordValue = args[passwordIndex + 1];
    if (!passwordValue || passwordValue.startsWith("-")) {
      console.error("Error: --password requires a value");
      process.exit(1);
    }
    remotePassword = passwordValue;
    args.splice(passwordIndex, 2);
  }

  // Parse --relay (optional)
  const relayIndex = args.indexOf("--relay");
  if (relayIndex !== -1) {
    const relayValue = args[relayIndex + 1];
    if (!relayValue || relayValue.startsWith("-")) {
      console.error("Error: --relay requires a URL value");
      process.exit(1);
    }
    remoteRelay = relayValue;
    args.splice(relayIndex, 2);
  }

  // Validate required options
  if (!remoteUsername) {
    console.error("Error: --setup-remote-access requires --username");
    process.exit(1);
  }
  if (!remotePassword) {
    console.error("Error: --setup-remote-access requires --password");
    process.exit(1);
  }
}

// If there are unknown arguments, show error and help
if (args.length > 0) {
  console.error(`Error: Unknown arguments: ${args.join(" ")}`);
  console.error("");
  console.error("Run 'yepanywhere --help' for usage information.");
  process.exit(1);
}

// Run prerequisite checks
checkNodeVersion();

// Set NODE_ENV to production if not already set (CLI users expect production mode)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// Reconstruct startup args to embed in an installed auto-start service,
// so the service launches with the same port/host the user specified.
const serviceLaunchArgs: string[] = [];
if (process.env.CLI_PORT_OVERRIDE === "true" && process.env.PORT) {
  serviceLaunchArgs.push("--port", process.env.PORT);
}
if (process.env.CLI_HOST_OVERRIDE === "true" && process.env.HOST) {
  serviceLaunchArgs.push("--host", process.env.HOST);
}

// Handle commands that exit after completion
if (installServiceFlag || uninstallServiceFlag || serviceStatusFlag) {
  runServiceCommand(
    installServiceFlag,
    uninstallServiceFlag,
    serviceStatusFlag,
    serviceLaunchArgs,
  );
} else if (setupAuthPassword || setupRemoteAccess) {
  runSetup(
    setupAuthPassword,
    setupRemoteAccess,
    remoteUsername,
    remotePassword,
    remoteRelay,
  );
} else {
  // Only check for Claude CLI when starting the server (not for setup commands)
  checkClaudeCli();
  // Normal server startup
  runServer();
}

async function runServiceCommand(
  install: boolean,
  uninstall: boolean,
  status: boolean,
  launchArgs: string[],
): Promise<never> {
  try {
    const { installService, uninstallService, serviceStatus } = await import(
      "./cli-service.js"
    );

    if (install) {
      await installService({
        nodePath: process.execPath,
        scriptPath: __filename,
        launchArgs,
      });
    } else if (uninstall) {
      await uninstallService();
    } else if (status) {
      await serviceStatus();
    }

    process.exit(0);
  } catch (error) {
    console.error(
      `Service command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

async function runSetup(
  authPassword: string | undefined,
  remoteAccess: boolean,
  username: string | undefined,
  password: string | undefined,
  relay: string | undefined,
): Promise<never> {
  try {
    const { setupAuth, setupRemoteAccess } = await import("./cli-setup.js");

    if (authPassword) {
      await setupAuth({ password: authPassword });
    }

    if (remoteAccess && username && password) {
      await setupRemoteAccess({ username, password, relayUrl: relay });
    }

    process.exit(0);
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

/**
 * Start the server by importing the main module.
 * This ensures all initialization happens in index.ts as designed.
 */
function runServer(): void {
  import("./index.js").catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
