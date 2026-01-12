import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Session file stores the path to the unique temp directory for this test run
const SESSION_FILE = join(tmpdir(), "claude-e2e-session");

export default async function globalTeardown() {
  // Read the session file to find our temp directory
  if (!existsSync(SESSION_FILE)) {
    console.log("[E2E] No session file found, nothing to clean up");
    return;
  }

  const tempDir = readFileSync(SESSION_FILE, "utf-8").trim();
  if (!tempDir || !existsSync(tempDir)) {
    console.log("[E2E] Temp directory not found, cleaning up session file");
    unlinkSync(SESSION_FILE);
    return;
  }

  console.log(`[E2E] Cleaning up temp directory: ${tempDir}`);

  // Read paths from the temp directory
  const pathsFile = join(tempDir, "paths.json");
  let paths: {
    pidFile?: string;
    remoteClientPidFile?: string;
    relayPidFile?: string;
  } = {};

  if (existsSync(pathsFile)) {
    try {
      paths = JSON.parse(readFileSync(pathsFile, "utf-8"));
    } catch {
      // Ignore parse errors
    }
  }

  // Kill processes using PID files
  const pidFiles = [
    { file: paths.pidFile ?? join(tempDir, "pid"), name: "server" },
    {
      file: paths.remoteClientPidFile ?? join(tempDir, "remote-pid"),
      name: "remote client",
    },
    {
      file: paths.relayPidFile ?? join(tempDir, "relay-pid"),
      name: "relay server",
    },
  ];

  for (const { file, name } of pidFiles) {
    if (existsSync(file)) {
      const pid = Number.parseInt(readFileSync(file, "utf-8"), 10);
      try {
        // Kill the process group (negative PID kills the group)
        process.kill(-pid, "SIGTERM");
        console.log(`[E2E] Killed ${name} process group ${pid}`);
      } catch (err) {
        // Process may already be dead
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(`[E2E] Error killing ${name}:`, err);
        }
      }
    }
  }

  // Clean up the entire temp directory
  try {
    rmSync(tempDir, { recursive: true, force: true });
    console.log(`[E2E] Removed temp directory: ${tempDir}`);
  } catch (err) {
    console.error("[E2E] Error removing temp directory:", err);
  }

  // Clean up the session file
  try {
    unlinkSync(SESSION_FILE);
  } catch {
    // Ignore if already deleted
  }
}
