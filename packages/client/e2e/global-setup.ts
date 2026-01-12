import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT_FILE = join(tmpdir(), "claude-e2e-port");
const MAINTENANCE_PORT_FILE = join(tmpdir(), "claude-e2e-maintenance-port");
const PID_FILE = join(tmpdir(), "claude-e2e-pid");
const REMOTE_CLIENT_PORT_FILE = join(tmpdir(), "claude-e2e-remote-port");
const REMOTE_CLIENT_PID_FILE = join(tmpdir(), "claude-e2e-remote-pid");
const RELAY_PORT_FILE = join(tmpdir(), "claude-e2e-relay-port");
const RELAY_PID_FILE = join(tmpdir(), "claude-e2e-relay-pid");

// Isolated test directories to avoid polluting real ~/.claude, ~/.codex, ~/.gemini
const E2E_TEST_DIR = join(tmpdir(), "claude-e2e-sessions");
const E2E_CLAUDE_SESSIONS_DIR = join(E2E_TEST_DIR, "claude", "projects");
const E2E_CODEX_SESSIONS_DIR = join(E2E_TEST_DIR, "codex", "sessions");
const E2E_GEMINI_SESSIONS_DIR = join(E2E_TEST_DIR, "gemini", "tmp");
const E2E_DATA_DIR = join(E2E_TEST_DIR, "yep-anywhere");

// Export paths for tests to use
export {
  E2E_TEST_DIR,
  E2E_CLAUDE_SESSIONS_DIR,
  E2E_CODEX_SESSIONS_DIR,
  E2E_GEMINI_SESSIONS_DIR,
  E2E_DATA_DIR,
};

export default async function globalSetup() {
  // Clean up any stale files
  for (const file of [
    PORT_FILE,
    MAINTENANCE_PORT_FILE,
    PID_FILE,
    REMOTE_CLIENT_PORT_FILE,
    REMOTE_CLIENT_PID_FILE,
    RELAY_PORT_FILE,
    RELAY_PID_FILE,
  ]) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  // Clean up and create isolated test directories
  // This ensures tests don't pollute real ~/.claude, ~/.codex, ~/.gemini
  console.log(`[E2E] Creating isolated test directories at ${E2E_TEST_DIR}`);
  try {
    rmSync(E2E_TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }
  mkdirSync(E2E_CLAUDE_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_CODEX_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_GEMINI_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });

  // Write paths file for tests to import
  const pathsFile = join(tmpdir(), "claude-e2e-paths.json");
  writeFileSync(
    pathsFile,
    JSON.stringify({
      testDir: E2E_TEST_DIR,
      claudeSessionsDir: E2E_CLAUDE_SESSIONS_DIR,
      codexSessionsDir: E2E_CODEX_SESSIONS_DIR,
      geminiSessionsDir: E2E_GEMINI_SESSIONS_DIR,
      dataDir: E2E_DATA_DIR,
    }),
  );

  const repoRoot = join(__dirname, "..", "..", "..");
  const serverRoot = join(repoRoot, "packages", "server");
  const clientDist = join(repoRoot, "packages", "client", "dist");

  // Build shared first (client depends on it), then client
  console.log("[E2E] Building shared package...");
  execSync("pnpm --filter @yep-anywhere/shared build", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("[E2E] Building client...");
  execSync("pnpm --filter @yep-anywhere/client build", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // Start relay server for relay integration tests
  // Use isolated data dir to avoid polluting real ~/.yep-relay/
  const relayDataDir = join(E2E_TEST_DIR, "relay");
  mkdirSync(relayDataDir, { recursive: true });

  console.log("[E2E] Starting relay server...");
  const relayRoot = join(repoRoot, "packages", "relay");
  const relayProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/index.ts"],
    {
      cwd: relayRoot,
      env: {
        ...process.env,
        RELAY_PORT: "0", // Auto-assign port
        RELAY_DATA_DIR: relayDataDir,
        RELAY_LOG_LEVEL: "info", // Need info level to see startup message
        RELAY_LOG_TO_FILE: "false", // Don't write log files during tests
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (relayProcess.pid) {
    writeFileSync(RELAY_PID_FILE, String(relayProcess.pid));
  }

  // Wait for relay server to output its port
  const relayPort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timeout waiting for relay server (30s)")),
      30000,
    );
    let output = "";
    relayProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      // Look for "Relay server listening on http://localhost:XXXX"
      // Strip ANSI escape codes before matching
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for stripping ANSI codes
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
      const match = cleanOutput.match(
        /Relay server listening on http:\/\/localhost:(\d+)/,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(Number.parseInt(match[1], 10));
      }
    });

    relayProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      if (!msg.includes("ExperimentalWarning")) {
        console.error("[E2E Relay]", msg);
      }
    });

    relayProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    relayProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Relay server exited with code ${code}`));
      }
    });
  });

  writeFileSync(RELAY_PORT_FILE, String(relayPort));
  console.log(`[E2E] Relay server on port ${relayPort}`);
  relayProcess.unref();

  // Start server with PORT=0 for auto-assignment, serving built assets
  // Pass isolated session directories via env vars
  // Enable maintenance server for test configuration (also auto-assign port)
  const serverProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/dev-mock.ts"],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: "0",
        // Note: dev-mock.ts always starts maintenance server with auto-assign port
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: clientDist,
        LOG_FILE: "e2e-server.log",
        LOG_LEVEL: "warn",
        // Isolated session directories for test isolation
        CLAUDE_SESSIONS_DIR: E2E_CLAUDE_SESSIONS_DIR,
        CODEX_SESSIONS_DIR: E2E_CODEX_SESSIONS_DIR,
        GEMINI_SESSIONS_DIR: E2E_GEMINI_SESSIONS_DIR,
        YEP_ANYWHERE_DATA_DIR: E2E_DATA_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  // Save PID for cleanup
  if (serverProcess.pid) {
    writeFileSync(PID_FILE, String(serverProcess.pid));
  }

  // Wait for both main server and maintenance server to output their ports
  const ports = await new Promise<{ main: number; maintenance: number }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for server to start (30s)"));
      }, 30000);

      let output = "";
      let mainPort: number | null = null;
      let maintenancePort: number | null = null;

      const checkComplete = () => {
        if (mainPort !== null && maintenancePort !== null) {
          clearTimeout(timeout);
          resolve({ main: mainPort, maintenance: maintenancePort });
        }
      };

      serverProcess.stdout?.on("data", (data: Buffer) => {
        output += data.toString();

        // Look for "Mock server running at http://localhost:XXXX"
        if (mainPort === null) {
          const mainMatch = output.match(
            /Mock server running at http:\/\/localhost:(\d+)/,
          );
          if (mainMatch) {
            mainPort = Number.parseInt(mainMatch[1], 10);
            checkComplete();
          }
        }

        // Look for "[Maintenance] Server running at http://..."
        if (maintenancePort === null) {
          const maintenanceMatch = output.match(
            /\[Maintenance\] Server running at http:\/\/[^:]+:(\d+)/,
          );
          if (maintenanceMatch) {
            maintenancePort = Number.parseInt(maintenanceMatch[1], 10);
            checkComplete();
          }
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString();
        if (!msg.includes("ExperimentalWarning")) {
          console.error("[E2E Server]", msg);
        }
      });

      serverProcess.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    },
  );

  // Write ports to files for tests to read
  writeFileSync(PORT_FILE, String(ports.main));
  writeFileSync(MAINTENANCE_PORT_FILE, String(ports.maintenance));
  console.log(`[E2E] Server started on port ${ports.main}`);
  console.log(`[E2E] Maintenance server on port ${ports.maintenance}`);

  // Health check: wait for server to be ready
  const healthCheckUrl = `http://localhost:${ports.main}/health`;
  let attempts = 0;
  const maxAttempts = 30;
  while (attempts < maxAttempts) {
    try {
      const response = await fetch(healthCheckUrl);
      if (response.ok) {
        console.log("[E2E] Server health check passed");
        break;
      }
    } catch {
      // Server not ready yet
    }
    attempts++;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (attempts >= maxAttempts) {
    throw new Error("Server health check failed after 30 attempts");
  }

  // Unref so the process doesn't block node exit
  serverProcess.unref();

  // Start remote client Vite dev server for E2E testing
  console.log("[E2E] Starting remote client dev server...");
  const clientRoot = join(repoRoot, "packages", "client");
  const remoteClientProcess = spawn(
    "pnpm",
    ["exec", "vite", "--config", "vite.config.remote.ts"],
    {
      cwd: clientRoot,
      env: { ...process.env, REMOTE_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (remoteClientProcess.pid) {
    writeFileSync(REMOTE_CLIENT_PID_FILE, String(remoteClientProcess.pid));
  }

  // Parse port from Vite's "Local: http://localhost:XXXXX/" output
  const remotePort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timeout waiting for remote client (30s)")),
      30000,
    );
    let output = "";
    remoteClientProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      const match = output.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number.parseInt(match[1], 10));
      }
    });

    remoteClientProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      if (!msg.includes("ExperimentalWarning")) {
        console.error("[E2E Remote Client]", msg);
      }
    });

    remoteClientProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    remoteClientProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Remote client exited with code ${code}`));
      }
    });
  });

  writeFileSync(REMOTE_CLIENT_PORT_FILE, String(remotePort));
  console.log(`[E2E] Remote client dev server on port ${remotePort}`);
  remoteClientProcess.unref();
}

export {
  PORT_FILE,
  MAINTENANCE_PORT_FILE,
  PID_FILE,
  REMOTE_CLIENT_PORT_FILE,
  REMOTE_CLIENT_PID_FILE,
  RELAY_PORT_FILE,
  RELAY_PID_FILE,
};
