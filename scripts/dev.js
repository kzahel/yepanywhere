#!/usr/bin/env node

/**
 * Dev server wrapper script with configurable reload behavior.
 *
 * Usage:
 *   pnpm dev                      # Default: both auto-reload
 *   pnpm dev --no-backend-reload  # Backend watches but doesn't restart
 *   pnpm dev --no-frontend-reload # Frontend watches but doesn't HMR
 *   pnpm dev --manual             # Neither auto-reloads
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm dev [options]

Options:
  --no-backend-reload  Backend watches but doesn't auto-restart
  --no-frontend-reload Frontend watches but doesn't HMR
  --manual             Neither auto-reloads (same as both --no-* flags)
  -h, --help           Show this help message
`);
  process.exit(0);
}
const noBackendReload =
  args.includes("--no-backend-reload") || args.includes("--manual");
const noFrontendReload =
  args.includes("--no-frontend-reload") || args.includes("--manual");

console.log("Starting dev server...");
if (noBackendReload) console.log("  Backend auto-reload: DISABLED");
if (noFrontendReload) console.log("  Frontend HMR: DISABLED");
if (!noBackendReload && !noFrontendReload)
  console.log("  Auto-reload: ENABLED for both");

// Build environment for child processes
const env = {
  ...process.env,
  NO_BACKEND_RELOAD: noBackendReload ? "true" : "",
  NO_FRONTEND_RELOAD: noFrontendReload ? "true" : "",
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
 * Spawn a server process with restart capability
 */
function startServer() {
  const serverScript = noBackendReload ? "dev:no-reload" : "dev";

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

    // If server exited with code 0 and we're in no-reload mode,
    // it was a manual reload request - restart it
    if (noBackendReload && code === 0 && signal === null) {
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
