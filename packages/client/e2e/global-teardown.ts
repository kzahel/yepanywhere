import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

const PORT_FILE = join(tmpdir(), "claude-e2e-port");
const PID_FILE = join(tmpdir(), "claude-e2e-pid");
const REMOTE_CLIENT_PORT_FILE = join(tmpdir(), "claude-e2e-remote-port");
const REMOTE_CLIENT_PID_FILE = join(tmpdir(), "claude-e2e-remote-pid");
const RELAY_PORT_FILE = join(tmpdir(), "claude-e2e-relay-port");
const RELAY_PID_FILE = join(tmpdir(), "claude-e2e-relay-pid");

export default async function globalTeardown() {
  // Kill the server process
  if (existsSync(PID_FILE)) {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf-8"), 10);
    try {
      // Kill the process group (negative PID kills the group)
      process.kill(-pid, "SIGTERM");
      console.log(`[E2E] Killed server process group ${pid}`);
    } catch (err) {
      // Process may already be dead
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error("[E2E] Error killing server:", err);
      }
    }
    unlinkSync(PID_FILE);
  }

  // Clean up port file
  if (existsSync(PORT_FILE)) {
    unlinkSync(PORT_FILE);
  }

  // Kill the remote client process
  if (existsSync(REMOTE_CLIENT_PID_FILE)) {
    const pid = Number.parseInt(
      readFileSync(REMOTE_CLIENT_PID_FILE, "utf-8"),
      10,
    );
    try {
      process.kill(-pid, "SIGTERM");
      console.log(`[E2E] Killed remote client process group ${pid}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error("[E2E] Error killing remote client:", err);
      }
    }
    unlinkSync(REMOTE_CLIENT_PID_FILE);
  }

  // Clean up remote client port file
  if (existsSync(REMOTE_CLIENT_PORT_FILE)) {
    unlinkSync(REMOTE_CLIENT_PORT_FILE);
  }

  // Kill the relay server process
  if (existsSync(RELAY_PID_FILE)) {
    const pid = Number.parseInt(readFileSync(RELAY_PID_FILE, "utf-8"), 10);
    try {
      process.kill(-pid, "SIGTERM");
      console.log(`[E2E] Killed relay server process group ${pid}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error("[E2E] Error killing relay server:", err);
      }
    }
    unlinkSync(RELAY_PID_FILE);
  }

  // Clean up relay port file
  if (existsSync(RELAY_PORT_FILE)) {
    unlinkSync(RELAY_PORT_FILE);
  }

  // Clean up mock project data created by global-setup.ts
  // This cleans up ~/.claude/projects as a fallback (tests use isolated dirs)
  const mockProjectPath = join(tmpdir(), "mockproject");
  const encodedPath = mockProjectPath.replace(/\//g, "-");
  const mockProjectDir = join(
    homedir(),
    ".claude",
    "projects",
    hostname(),
    encodedPath,
  );

  try {
    rmSync(mockProjectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  try {
    rmSync(mockProjectDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
