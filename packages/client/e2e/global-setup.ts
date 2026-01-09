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
const PID_FILE = join(tmpdir(), "claude-e2e-pid");

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
  for (const file of [PORT_FILE, PID_FILE]) {
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

  // Start server with PORT=0 for auto-assignment, serving built assets
  // Pass isolated session directories via env vars
  const serverProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/dev-mock.ts"],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: "0",
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

  // Wait for server to output its port
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for server to start (30s)"));
    }, 30000);

    let output = "";

    serverProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      // Look for "Mock server running at http://localhost:XXXX"
      const match = output.match(
        /Mock server running at http:\/\/localhost:(\d+)/,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(Number.parseInt(match[1], 10));
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
  });

  // Write port to file for tests to read
  writeFileSync(PORT_FILE, String(port));
  console.log(`[E2E] Server started on port ${port}`);

  // Unref so the process doesn't block node exit
  serverProcess.unref();
}

export { PORT_FILE, PID_FILE };
