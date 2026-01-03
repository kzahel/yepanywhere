#!/usr/bin/env node

/**
 * Dev server wrapper script with configurable reload behavior.
 *
 * Usage:
 *   pnpm dev                      # Default: no Enter-to-restart
 *   pnpm dev --watch              # Enable backend auto-reload on file changes
 *   pnpm dev --no-frontend-reload # Frontend watches but doesn't HMR
 *
 * Environment:
 *   Create a .env file in the project root to set defaults:
 *     LOG_LEVEL=debug
 *     PORT=4000
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Load .env file if it exists (simple parser, no dependencies)
function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only set if not already in environment (CLI overrides .env)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm dev [options]

Options:
  --watch              Enable backend auto-reload (tsx watch mode)
  --no-frontend-reload Frontend watches but doesn't HMR
  -h, --help           Show this help message
`);
  process.exit(0);
}

// Backend auto-reload is OFF by default (no Enter-to-restart behavior)
// Use --watch to enable tsx watch mode
const backendWatch = args.includes("--watch");
const noFrontendReload = args.includes("--no-frontend-reload");

// Port configuration: PORT + 0 = server, PORT + 1 = maintenance, PORT + 2 = vite
const basePort = process.env.PORT
  ? Number.parseInt(process.env.PORT, 10)
  : 3400;
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : basePort + 2;

console.log("Starting dev server...");
console.log(`  Access at: http://localhost:${basePort}`);
console.log(
  `  Ports: server=${basePort}, maintenance=${basePort + 1}, vite=${vitePort}`,
);
if (backendWatch) console.log("  Backend auto-reload: ENABLED (--watch)");
if (noFrontendReload) console.log("  Frontend HMR: DISABLED");
if (!backendWatch && !noFrontendReload)
  console.log("  Frontend HMR: ENABLED, Backend: manual restart only");

// Build environment for child processes
const env = {
  ...process.env,
  // When not using --watch, enable manual reload mode (shows banner on file changes)
  NO_BACKEND_RELOAD: backendWatch ? "" : "true",
  NO_FRONTEND_RELOAD: noFrontendReload ? "true" : "",
  // Pass vite port to both server and client for consistency
  VITE_PORT: String(vitePort),
};

// Track child processes for cleanup
const children = [];

function cleanup() {
  for (const child of children) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

/**
 * Spawn a server process
 */
function startServer() {
  // Use dev:watch for auto-reload, dev for no-reload (default)
  const serverScript = backendWatch ? "dev:watch" : "dev";

  const server = spawn("pnpm", ["--filter", "server", serverScript], {
    cwd: rootDir,
    env,
    stdio: "inherit",
    shell: true,
  });

  children.push(server);

  server.on("exit", (code, signal) => {
    // Remove from children list
    const idx = children.indexOf(server);
    if (idx !== -1) children.splice(idx, 1);

    // If server exited cleanly (code 0) and we're in manual reload mode,
    // it was a reload request - restart it
    if (!backendWatch && code === 0 && signal === null) {
      console.log("\nRestarting server...");
      startServer();
    } else if (code !== null && code !== 0) {
      console.error(`Server exited with code ${code}`);
    }
  });

  return server;
}

/**
 * Start the client dev server
 */
function startClient() {
  const client = spawn("pnpm", ["--filter", "client", "dev"], {
    cwd: rootDir,
    env,
    stdio: "inherit",
    shell: true,
  });

  children.push(client);

  client.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Client exited with code ${code}`);
    }
  });

  return client;
}

// Start both processes
startServer();
startClient();
