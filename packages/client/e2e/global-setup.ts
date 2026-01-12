import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session file stores the path to the unique temp directory for this test run
// This is the only fixed-path file - everything else goes in the unique temp dir
const SESSION_FILE = join(tmpdir(), "claude-e2e-session");

// These will be set after creating the unique temp directory
let E2E_TEMP_DIR: string;
let PORT_FILE: string;
let MAINTENANCE_PORT_FILE: string;
let PID_FILE: string;
let REMOTE_CLIENT_PORT_FILE: string;
let REMOTE_CLIENT_PID_FILE: string;
let RELAY_PORT_FILE: string;
let RELAY_PID_FILE: string;

// Isolated test directories to avoid polluting real ~/.claude, ~/.codex, ~/.gemini
let E2E_TEST_DIR: string;
let E2E_CLAUDE_SESSIONS_DIR: string;
let E2E_CODEX_SESSIONS_DIR: string;
let E2E_GEMINI_SESSIONS_DIR: string;
let E2E_DATA_DIR: string;

/**
 * Wait for a port file to be written with a valid port number.
 */
async function waitForPortFile(
  portFile: string,
  name: string,
  timeoutMs = 30000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = Number.parseInt(content, 10);
      if (port > 0) {
        return port;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${name} port file (${timeoutMs}ms)`);
}

export default async function globalSetup() {
  // Create a unique temp directory for this test run
  // This prevents collisions between parallel test runs
  E2E_TEMP_DIR = mkdtempSync(join(tmpdir(), "claude-e2e-"));
  console.log(`[E2E] Using temp directory: ${E2E_TEMP_DIR}`);

  // Write session file so teardown can find our temp directory
  writeFileSync(SESSION_FILE, E2E_TEMP_DIR);

  // Set up file paths within the unique temp directory
  PORT_FILE = join(E2E_TEMP_DIR, "port");
  MAINTENANCE_PORT_FILE = join(E2E_TEMP_DIR, "maintenance-port");
  PID_FILE = join(E2E_TEMP_DIR, "pid");
  REMOTE_CLIENT_PORT_FILE = join(E2E_TEMP_DIR, "remote-port");
  REMOTE_CLIENT_PID_FILE = join(E2E_TEMP_DIR, "remote-pid");
  RELAY_PORT_FILE = join(E2E_TEMP_DIR, "relay-port");
  RELAY_PID_FILE = join(E2E_TEMP_DIR, "relay-pid");

  // Set up isolated test directories within the temp dir
  E2E_TEST_DIR = join(E2E_TEMP_DIR, "sessions");
  E2E_CLAUDE_SESSIONS_DIR = join(E2E_TEST_DIR, "claude", "projects");
  E2E_CODEX_SESSIONS_DIR = join(E2E_TEST_DIR, "codex", "sessions");
  E2E_GEMINI_SESSIONS_DIR = join(E2E_TEST_DIR, "gemini", "tmp");
  E2E_DATA_DIR = join(E2E_TEST_DIR, "yep-anywhere");

  // Create isolated test directories
  console.log(`[E2E] Creating isolated test directories at ${E2E_TEST_DIR}`);
  mkdirSync(E2E_CLAUDE_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_CODEX_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_GEMINI_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });

  // Write paths file for tests to import
  const pathsFile = join(E2E_TEMP_DIR, "paths.json");
  writeFileSync(
    pathsFile,
    JSON.stringify({
      tempDir: E2E_TEMP_DIR,
      testDir: E2E_TEST_DIR,
      claudeSessionsDir: E2E_CLAUDE_SESSIONS_DIR,
      codexSessionsDir: E2E_CODEX_SESSIONS_DIR,
      geminiSessionsDir: E2E_GEMINI_SESSIONS_DIR,
      dataDir: E2E_DATA_DIR,
      portFile: PORT_FILE,
      maintenancePortFile: MAINTENANCE_PORT_FILE,
      pidFile: PID_FILE,
      remoteClientPortFile: REMOTE_CLIENT_PORT_FILE,
      remoteClientPidFile: REMOTE_CLIENT_PID_FILE,
      relayPortFile: RELAY_PORT_FILE,
      relayPidFile: RELAY_PID_FILE,
    }),
  );

  // Create mock project data for tests that expect a session to exist
  const mockProjectPath = join(E2E_TEMP_DIR, "mockproject");
  mkdirSync(mockProjectPath, { recursive: true });
  const encodedPath = mockProjectPath.replace(/\//g, "-");
  const mockSessionDir = join(E2E_CLAUDE_SESSIONS_DIR, hostname(), encodedPath);
  mkdirSync(mockSessionDir, { recursive: true });
  const sessionFile = join(mockSessionDir, "mock-session-001.jsonl");
  const mockMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Previous message" },
      timestamp: new Date().toISOString(),
      uuid: "1",
    },
  ];
  writeFileSync(
    sessionFile,
    mockMessages.map((m) => JSON.stringify(m)).join("\n"),
  );
  console.log(`[E2E] Created mock session at ${sessionFile}`);

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
        RELAY_PORT_FILE: RELAY_PORT_FILE,
        RELAY_DATA_DIR: relayDataDir,
        RELAY_LOG_LEVEL: "warn", // Reduce noise, port comes from file
        RELAY_LOG_TO_FILE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (relayProcess.pid) {
    writeFileSync(RELAY_PID_FILE, String(relayProcess.pid));
  }

  // Log stderr for debugging
  relayProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Relay]", msg);
    }
  });

  relayProcess.on("error", (err) => {
    console.error("[E2E Relay] Process error:", err);
  });

  // Wait for port file
  const relayPort = await waitForPortFile(
    RELAY_PORT_FILE,
    "relay server",
    30000,
  );
  console.log(`[E2E] Relay server on port ${relayPort}`);
  relayProcess.unref();

  // Start main server with PORT_FILE for port reporting
  console.log("[E2E] Starting main server...");
  const serverProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/index.ts"],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: "0",
        PORT_FILE: PORT_FILE,
        MAINTENANCE_PORT: "-1", // Auto-assign
        MAINTENANCE_PORT_FILE: MAINTENANCE_PORT_FILE,
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: clientDist,
        LOG_FILE: "e2e-server.log",
        LOG_LEVEL: "warn", // Reduce noise, port comes from file
        AUTH_DISABLED: "true",
        NODE_ENV: "production",
        CLAUDE_SESSIONS_DIR: E2E_CLAUDE_SESSIONS_DIR,
        CODEX_SESSIONS_DIR: E2E_CODEX_SESSIONS_DIR,
        GEMINI_SESSIONS_DIR: E2E_GEMINI_SESSIONS_DIR,
        YEP_ANYWHERE_DATA_DIR: E2E_DATA_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (serverProcess.pid) {
    writeFileSync(PID_FILE, String(serverProcess.pid));
  }

  // Log stderr for debugging
  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Server]", msg);
    }
  });

  serverProcess.on("error", (err) => {
    console.error("[E2E Server] Process error:", err);
  });

  // Wait for both port files
  const [mainPort, maintenancePort] = await Promise.all([
    waitForPortFile(PORT_FILE, "main server", 30000),
    waitForPortFile(MAINTENANCE_PORT_FILE, "maintenance server", 30000),
  ]);
  console.log(`[E2E] Server started on port ${mainPort}`);
  console.log(`[E2E] Maintenance server on port ${maintenancePort}`);

  // Health check: wait for server to be ready
  const healthCheckUrl = `http://localhost:${mainPort}/health`;
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

  serverProcess.unref();

  // Start remote client Vite dev server
  console.log("[E2E] Starting remote client dev server...");
  const remoteClientProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "e2e/start-vite-remote.ts"],
    {
      cwd: join(repoRoot, "packages", "client"),
      env: {
        ...process.env,
        VITE_PORT_FILE: REMOTE_CLIENT_PORT_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (remoteClientProcess.pid) {
    writeFileSync(REMOTE_CLIENT_PID_FILE, String(remoteClientProcess.pid));
  }

  // Log stderr for debugging
  remoteClientProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Remote Client]", msg);
    }
  });

  remoteClientProcess.on("error", (err) => {
    console.error("[E2E Remote Client] Process error:", err);
  });

  // Wait for port file
  const remotePort = await waitForPortFile(
    REMOTE_CLIENT_PORT_FILE,
    "remote client",
    30000,
  );
  console.log(`[E2E] Remote client dev server on port ${remotePort}`);
  remoteClientProcess.unref();
}

// Export session file path for teardown
export { SESSION_FILE };
