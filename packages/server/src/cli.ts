#!/usr/bin/env node

import { checkServerRuntime } from "./runtimePreflight.js";
import {
  SERVER_NODE_RANGE,
  SERVER_BUN_RANGE,
} from "@yep-anywhere/shared/server-runtime";

checkServerRuntime();

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
 *   YEP_DATA_DIR                  # Data directory override
 *   YEP_PROFILE                   # Profile name (creates ~/.yep-anywhere-{profile}/)
 *   AUTH_ENABLED                  # Enable cookie auth (default: false)
 *   LOG_LEVEL                     # Log level: fatal, error, warn, info, debug, trace
 *   ... (see CLAUDE.md for full list)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { request as requestHttps } from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { whichCommand } from "./sdk/which-command.js";
import { takeSetupAuthPassword } from "./setup-auth-password.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  yepanywhere browser-debug <info|events|eval> ...

AGENT COMMANDS:
  browser-debug         Inspect one explicitly enabled tab from a YA-launched agent shell; run yepanywhere browser-debug --help

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
                        --setup-auth=<password> accepts one beginning with -.
  --setup-auth-pwfile <path>
                        As --setup-auth, reading the password from a file
                        (- for stdin), keeping it out of the process list
                        and shell history. A trailing newline is dropped.
                        Bare --setup-auth reads YEP_AUTH_PASSWORD instead.

  --setup-remote-access --username <name> --password <pass> [--relay <url>]
                        Set up remote access with SRP authentication.
                        Registers with the relay to verify username availability.
                        Exits with error if username is taken.
                        --username: Relay username (3-32 chars, lowercase alphanumeric + hyphens)
                        --password: SRP password (min 8 characters)
                        --relay: Relay URL (default: wss://relay.yepanywhere.com/ws)

ENVIRONMENT VARIABLES:
  PORT                          Server port (default: 3400)
  HOST                          Host/interface to bind (default: localhost)
  YEP_DATA_DIR                  Data directory override
  YEP_PROFILE                   Profile name (creates ~/.yep-anywhere-{profile}/)
  AUTH_DISABLED                 Disable auth (bypass even if enabled in settings)
  YEP_AUTH_PASSWORD             Password for bare --setup-auth; always removed
                                from the environment at startup
  HTTPS_SELF_SIGNED             Enable HTTPS with a self-signed certificate
  LOG_LEVEL                     Log level: fatal, error, warn, info, debug, trace
  LOG_PRETTY                    Pretty-print console logs (default: true)
  MAINTENANCE_PORT              Maintenance server port (default: disabled)
  YEP_CODEX_DISABLE_LIVE_DELTAS
                                Drop Codex live delta notifications before raw logging and client emit
  CODEX_WATCH_PERIODIC_RESCAN_MS
                                Codex watcher periodic check interval in ms; thread-index hinted, full rescan as fallback (default: 5000 on macOS/Windows, 0 elsewhere)
  SESSION_INDEX_FULL_VALIDATION_MS
                                Session index full validation interval in ms (default: 30000, 0 = validate every request)
  SESSION_INDEX_SUMMARY_PARSE_CONCURRENCY
                                Max concurrent session-summary parses during cold index fills (default: 1)
  CLAUDE_SUMMARY_PARSER_WORKER  Claude summary parser child-process mode:
                                off, on, or required (default: off)
  CODEX_SUMMARY_PARSER_WORKER   Codex summary parser child-process mode:
                                off, on, or required (default: on when unset;
                                explicit blank/invalid values are off)
  SESSION_INDEX_LOG_PERF
                                Log session-index performance timings
  CODEX_READER_LOG_PARSE
                                Log Codex entry-read parse/cache timings and memory deltas
  CLAUDE_READER_LOG_PARSE
                                Log Claude summary stream timings and memory deltas
  SESSION_AUTO_ARCHIVE_DAYS
                                Hide older sessions from default scans (default: 0 = disabled)
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
  YEP_PROFILE=dev yepanywhere

  # Reset local auth password (headless recovery)
  yepanywhere --setup-auth "mypassword123"

  # Same, without the password in the process list or shell history
  yepanywhere --setup-auth-pwfile /run/secrets/yep-password

  # Emergency auth bypass (temporary)
  yepanywhere --auth-disable

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
  - Node.js ${SERVER_NODE_RANGE}, or Bun ${SERVER_BUN_RANGE}
  - For Bun execution: bunx --bun yepanywhere
  - Claude CLI installed (curl -fsSL https://claude.ai/install.sh | bash)
`);
}

function getVersion(): string {
  try {
    // Read package.json from the package root
    const packageJsonPath = path.resolve(__dirname, "../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}

function showVersion(): void {
  console.log(`yepanywhere v${getVersion()}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const isBrowserDebugCommand = args[0] === "browser-debug";

// Informational commands must work before application dependencies are loaded.
// The browser-debug subcommand owns its own help and argument handling.
if (
  !isBrowserDebugCommand &&
  (args.includes("--help") || args.includes("-h"))
) {
  showHelp();
  process.exit(0);
}

if (
  !isBrowserDebugCommand &&
  (args.includes("--version") || args.includes("-v"))
) {
  showVersion();
  process.exit(0);
}

await import("./startupEnv.js");

if (isBrowserDebugCommand) {
  await runBrowserDebugCommand(args.slice(1));
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

// Parse --setup-auth and --setup-auth-pwfile; always scrubs YEP_AUTH_PASSWORD
const setupAuth = takeSetupAuthPassword(args, process.env, (file) =>
  fs.readFileSync(file, "utf-8"),
);
if ("error" in setupAuth) {
  console.error(`Error: ${setupAuth.error}`);
  process.exit(1);
}
const setupAuthPassword = setupAuth.password;

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

// Set NODE_ENV to production if not already set (CLI users expect production mode)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// Handle setup commands (exit after completion)
if (setupAuthPassword || setupRemoteAccess) {
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

interface BrowserDebugGrant {
  leaseId: string;
  grantSecret: string;
}

const MAX_BROWSER_DEBUG_RESPONSE_BYTES = 4 * 1024 * 1024;

interface BrowserDebugEndpoint {
  url: URL;
  caCertificate?: Buffer;
}

function browserDebugEndpoint(
  baseUrl: string,
  grant: BrowserDebugGrant,
  suffix: string,
): BrowserDebugEndpoint {
  const url = new URL(baseUrl);
  const encodedCa = new URLSearchParams(url.hash.slice(1)).get("ya-ca");
  url.hash = "";
  const [suffixPath, suffixQuery] = suffix.split("?", 2);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/leases/${encodeURIComponent(grant.leaseId)}${suffixPath ?? ""}`;
  url.search = suffixQuery === undefined ? "" : `?${suffixQuery}`;
  return {
    url,
    ...(encodedCa
      ? { caCertificate: Buffer.from(encodedCa, "base64url") }
      : {}),
  };
}

async function requestJsonWithPrivateCa(
  endpoint: BrowserDebugEndpoint,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  if (endpoint.url.protocol !== "https:" || !endpoint.caCertificate) {
    throw new Error("Invalid private browser diagnostic trust anchor");
  }
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("Browser diagnostic request body must be text");
  }
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Length", String(Buffer.byteLength(init.body, "utf8")));
  }
  return await new Promise((resolve, reject) => {
    const request = requestHttps(
      endpoint.url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        ca: endpoint.caCertificate,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BROWSER_DEBUG_RESPONSE_BYTES) {
            response.destroy(
              new Error("Browser diagnostic response exceeded the size limit"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload: unknown = null;
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, payload });
        });
      },
    );
    request.on("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function parseBrowserDebugGrant(value: string | undefined): BrowserDebugGrant {
  if (!value) {
    throw new Error("A yep-browser-debug grant URL is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid browser diagnostic grant URL");
  }
  const leaseId = url.hostname;
  const grantSecret = url.searchParams.get("grant") ?? "";
  if (url.protocol !== "yep-browser-debug:" || !leaseId || !grantSecret) {
    throw new Error("Invalid browser diagnostic grant URL");
  }
  return { leaseId, grantSecret };
}

async function requestBrowserDebug(
  grant: BrowserDebugGrant,
  suffix: string,
  init?: RequestInit,
): Promise<unknown> {
  const baseUrl = process.env.YEP_BROWSER_DEBUG_AGENT_URL?.trim();
  const callerToken = process.env.YEP_BROWSER_DEBUG_CALLER_TOKEN?.trim();
  if (!baseUrl || !callerToken) {
    throw new Error(
      "Browser diagnostics require a YA-launched agent process with the current browser-debug environment; this process does not have it",
    );
  }
  const endpoint = browserDebugEndpoint(baseUrl, grant, suffix);
  const requestInit: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${callerToken}`,
      "X-YA-Browser-Debug-Grant": grant.grantSecret,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  };
  const response = endpoint.caCertificate
    ? await requestJsonWithPrivateCa(endpoint, requestInit)
    : await fetch(endpoint.url, requestInit).then(async (result) => ({
        ok: result.ok,
        status: result.status,
        payload: await result.json().catch(() => null),
      }));
  const payload = response.payload as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Browser diagnostic request failed (${response.status})`,
    );
  }
  return response.payload;
}

function browserDebugEvaluationValue(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    throw new Error("Browser diagnostic evaluation returned an invalid result");
  }
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object") {
    throw new Error("Browser diagnostic evaluation returned an invalid result");
  }
  const evaluation = result as Record<string, unknown>;
  if (evaluation.ok !== true) {
    throw new Error(
      typeof evaluation.error === "string"
        ? evaluation.error
        : "Browser diagnostic evaluation failed",
    );
  }
  return evaluation.value;
}

function printBrowserDebugHelp(): void {
  console.log(`
USAGE:
  yepanywhere browser-debug info <grant-url>
  yepanywhere browser-debug snapshot <grant-url>
  yepanywhere browser-debug events <grant-url> [--after <sequence>] [--follow]
  yepanywhere browser-debug eval <grant-url> <javascript>

The command requires a YA-launched agent process with the current browser-debug
environment. On first deployment, restart the provider host before launching
or resuming that process. The separately pasted grant URL selects one explicitly
enabled browser tab for the remainder of its 30-minute lease.
`);
}

async function runBrowserDebugCommand(commandArgs: string[]): Promise<void> {
  try {
    const [command, grantUrl, ...rest] = commandArgs;
    if (!command || command === "help" || command === "--help") {
      printBrowserDebugHelp();
      return;
    }
    const grant = parseBrowserDebugGrant(grantUrl);
    if (command === "info") {
      console.log(
        JSON.stringify(await requestBrowserDebug(grant, ""), null, 2),
      );
      return;
    }
    if (command === "snapshot") {
      const payload = await requestBrowserDebug(grant, "/eval", {
        method: "POST",
        body: JSON.stringify({
          code: "window.__YA_BROWSER_DEBUG__.performance.snapshot()",
        }),
      });
      console.log(
        JSON.stringify(browserDebugEvaluationValue(payload), null, 2),
      );
      return;
    }
    if (command === "eval") {
      const code = rest.join(" ");
      if (!code) throw new Error("eval requires JavaScript source");
      console.log(
        JSON.stringify(
          await requestBrowserDebug(grant, "/eval", {
            method: "POST",
            body: JSON.stringify({ code }),
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "events") {
      const followIndex = rest.indexOf("--follow");
      const afterIndex = rest.indexOf("--after");
      let after =
        afterIndex >= 0 ? Number.parseInt(rest[afterIndex + 1] ?? "0", 10) : 0;
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new Error("--after requires a non-negative sequence number");
      }
      const follow = followIndex >= 0;
      do {
        const payload = (await requestBrowserDebug(
          grant,
          `/events?after=${after}`,
        )) as { events?: Array<{ sequence?: number }> };
        for (const event of payload.events ?? []) {
          console.log(JSON.stringify(event));
          if (Number.isSafeInteger(event.sequence)) {
            after = Math.max(after, event.sequence ?? after);
          }
        }
        if (follow) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      } while (follow);
      return;
    }
    throw new Error(`Unknown browser-debug command: ${command}`);
  } catch (error) {
    console.error(
      `Browser diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
