import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT_FILE = join(tmpdir(), "claude-e2e-port");
const PID_FILE = join(tmpdir(), "claude-e2e-pid");

export default async function globalSetup() {
  // Clean up any stale files
  for (const file of [PORT_FILE, PID_FILE]) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  const repoRoot = join(__dirname, "..", "..", "..");
  const serverRoot = join(repoRoot, "packages", "server");
  const clientDist = join(repoRoot, "packages", "client", "dist");

  // Always build client to ensure we test latest code
  console.log("[E2E] Building client...");
  execSync("pnpm --filter @yep-anywhere/client build", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // Start server with PORT=0 for auto-assignment, serving built assets
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
