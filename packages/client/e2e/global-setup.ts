import { registerSharedServiceProcess } from "./support/shared-service-process.js";
import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureColorEmojiFont } from "../scripts/emoji-font.js";

import { providerHostRuntimeDir } from "./support/provider-host-runtime.js";
import {
  createE2ERunDirectory,
  usesWorkerServers,
} from "./support/run-directory.js";
import { seedDefaultProfile } from "./support/default-profile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// These will be set after creating the unique temp directory
let E2E_TEMP_DIR: string;
let PORT_FILE: string;
let MAINTENANCE_PORT_FILE: string;
let PID_FILE: string;
let REMOTE_CLIENT_PORT_FILE: string;
let REMOTE_CLIENT_PID_FILE: string;
let REMOTE_PREVIEW_PORT_FILE: string;
let REMOTE_PREVIEW_PID_FILE: string;
let RELAY_PORT_FILE: string;
let RELAY_PID_FILE: string;

// Isolated test directories to avoid polluting real ~/.claude, ~/.codex, ~/.gemini
let E2E_TEST_DIR: string;
let E2E_CLAUDE_SESSIONS_DIR: string;
let E2E_CODEX_SESSIONS_DIR: string;
let E2E_GEMINI_SESSIONS_DIR: string;
let E2E_DATA_DIR: string;
let E2E_PROVIDER_HOST_RUNTIME_DIR: string;

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

function runBuild(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`pnpm ${args.join(" ")} failed (${code ?? signal})`));
    });
  });
}

function shouldStartRelay(): boolean {
  const setting = process.env.YEP_E2E_START_RELAY?.toLowerCase();
  return setting !== "0" && setting !== "false" && setting !== "no";
}

export default async function globalSetup() {
  // Screenshots of emoji-bearing UI are only truthful when the host has a color
  // emoji font; this installs one once per machine and is silent afterwards.
  const emojiFont = await ensureColorEmojiFont();
  if (emojiFont.status !== "present")
    console.log(`[E2E] Emoji font: ${emojiFont.detail}`);
  const serverLogLevel = process.env.E2E_SERVER_LOG_LEVEL ?? "warn";
  const serverFileLogLevel =
    process.env.E2E_SERVER_FILE_LOG_LEVEL ?? serverLogLevel;

  // Create a unique temp directory for this test run
  // This prevents collisions between parallel test runs
  E2E_TEMP_DIR = createE2ERunDirectory();
  console.log(`[E2E] Using temp directory: ${E2E_TEMP_DIR}`);

  // Set up file paths within the unique temp directory
  PORT_FILE = join(E2E_TEMP_DIR, "port");
  MAINTENANCE_PORT_FILE = join(E2E_TEMP_DIR, "maintenance-port");
  PID_FILE = join(E2E_TEMP_DIR, "pid");
  REMOTE_CLIENT_PORT_FILE = join(E2E_TEMP_DIR, "remote-port");
  REMOTE_CLIENT_PID_FILE = join(E2E_TEMP_DIR, "remote-pid");
  REMOTE_PREVIEW_PORT_FILE = join(E2E_TEMP_DIR, "remote-preview-port");
  REMOTE_PREVIEW_PID_FILE = join(E2E_TEMP_DIR, "remote-preview-pid");
  RELAY_PORT_FILE = join(E2E_TEMP_DIR, "relay-port");
  RELAY_PID_FILE = join(E2E_TEMP_DIR, "relay-pid");

  // Set up isolated test directories within the temp dir
  E2E_TEST_DIR = join(E2E_TEMP_DIR, "sessions");
  E2E_CLAUDE_SESSIONS_DIR = join(E2E_TEST_DIR, "claude", "projects");
  E2E_CODEX_SESSIONS_DIR = join(E2E_TEST_DIR, "codex", "sessions");
  E2E_GEMINI_SESSIONS_DIR = join(E2E_TEST_DIR, "gemini", "tmp");
  E2E_DATA_DIR = join(E2E_TEST_DIR, "yep-anywhere");
  // The provider host otherwise lives at a per-user path under XDG_RUNTIME_DIR
  // shared by every YA server on the machine. A developer's own running YA
  // holds that path with a host built from whatever sources it started with,
  // so this server would find an incompatible host, decline to replace it, and
  // serve the whole suite in its "provider host is not running" degraded mode.
  E2E_PROVIDER_HOST_RUNTIME_DIR = providerHostRuntimeDir(E2E_TEMP_DIR);

  if (!usesWorkerServers()) await seedDefaultProfile(E2E_TEMP_DIR);

  const repoRoot = join(__dirname, "..", "..", "..");
  const serverRoot = join(repoRoot, "packages", "server");
  const clientDist = join(E2E_TEMP_DIR, "client-dist");
  const remoteClientDist = join(E2E_TEMP_DIR, "remote-dist");

  // Build shared first (client depends on it), then client
  console.log("[E2E] Building shared package...");
  execSync("pnpm --filter @yep-anywhere/shared build", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // The two bundles are independent; building them concurrently removes about
  // 20s of the serial setup every invocation and CI shard pays.
  console.log("[E2E] Building client and remote client production preview...");
  await Promise.all([
    runBuild(
      [
        "--filter",
        "@yep-anywhere/client",
        "exec",
        "vite",
        "build",
        "--outDir",
        clientDist,
        "--emptyOutDir",
      ],
      {
        // Global first-run overlays are outside this suite's contracts and can
        // arrive after a page-specific readiness check, obscuring its controls.
        VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        VITE_DISABLE_ONBOARDING: "true",
        VITE_E2E_SOURCE_TRANSPORT_SMOKE: "true",
      },
      repoRoot,
    ),
    runBuild(
      [
        "--filter",
        "@yep-anywhere/client",
        "exec",
        "vite",
        "build",
        "--config",
        "vite.config.remote.ts",
        "--base",
        "/",
        "--outDir",
        remoteClientDist,
        "--emptyOutDir",
      ],
      {
        VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        VITE_DISABLE_ONBOARDING: "true",
      },
      repoRoot,
    ),
  ]);
  copyFileSync(
    join(remoteClientDist, "remote.html"),
    join(remoteClientDist, "index.html"),
  );

  if (shouldStartRelay() && !usesWorkerServers()) {
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
          HOME: E2E_TEMP_DIR,
          USERPROFILE: E2E_TEMP_DIR,
          NO_BACKEND_RELOAD: "false",
          NO_FRONTEND_RELOAD: "false",
          RELAY_PORT: "0", // Auto-assign port
          RELAY_PORT_FILE: RELAY_PORT_FILE,
          RELAY_DATA_DIR: relayDataDir,
          RELAY_ALLOWED_ORIGINS: "*",
          RELAY_LOG_LEVEL: "warn", // Reduce noise, port comes from file
          RELAY_LOG_TO_FILE: "false",
          // Large logical responses and uploads must use bounded application
          // frames rather than depending on the relay's parser allowance.
          RELAY_WEBSOCKET_MAX_MESSAGE_BYTES: String(1024 * 1024),
          // The multi-host matrix deliberately remounts the same three targets
          // seven times in under a minute. Raw relay tests cover the production
          // per-target default; keep the browser lifecycle matrix below its
          // own higher test-only ceiling.
          RELAY_MUX_OPEN_ATTEMPTS_PER_MINUTE_PER_IP_USERNAME: "20",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    await registerSharedServiceProcess(relayProcess, {
      label: "run relay",
      pidFile: RELAY_PID_FILE,
    });

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
  } else {
    console.log(
      "[E2E] Skipping relay server startup (YEP_E2E_START_RELAY disabled)",
    );
  }

  if (!usesWorkerServers()) {
    // Start main server with PORT_FILE for port reporting
    console.log("[E2E] Starting main server...");
    const serverProcess = spawn(
      "pnpm",
      [
        "exec",
        "tsx",
        "--import",
        pathToFileURL(join(__dirname, "support", "fixture-runtime.mjs")).href,
        "--conditions",
        "source",
        "src/index.ts",
      ],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          HOME: E2E_TEMP_DIR,
          USERPROFILE: E2E_TEMP_DIR,
          NO_BACKEND_RELOAD: "false",
          NO_FRONTEND_RELOAD: "false",
          PORT: "0",
          PORT_FILE: PORT_FILE,
          MAINTENANCE_PORT: "-1", // Auto-assign
          MAINTENANCE_PORT_FILE: MAINTENANCE_PORT_FILE,
          SERVE_FRONTEND: "true",
          CLIENT_DIST_PATH: clientDist,
          LOG_FILE: "e2e-server.log",
          LOG_LEVEL: serverLogLevel, // Override in targeted tests when log assertions are needed.
          LOG_FILE_LEVEL: serverFileLogLevel,
          AUTH_DISABLED: "true",
          HTTPS_SELF_SIGNED: "", // force HTTP so health check URL works
          NODE_ENV: "production",
          CLAUDE_SESSIONS_DIR: E2E_CLAUDE_SESSIONS_DIR,
          CODEX_SESSIONS_DIR: E2E_CODEX_SESSIONS_DIR,
          GEMINI_SESSIONS_DIR: E2E_GEMINI_SESSIONS_DIR,
          YEP_DATA_DIR: E2E_DATA_DIR,
          YEP_PROVIDER_HOST_RUNTIME_DIR: E2E_PROVIDER_HOST_RUNTIME_DIR,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    await registerSharedServiceProcess(serverProcess, {
      label: "run server",
      pidFile: PID_FILE,
      runtimeDir: E2E_PROVIDER_HOST_RUNTIME_DIR,
    });

    // Drain both pipes: the shared server outlives setup, and a full stdout
    // pipe must not become backpressure on its logging path. Keep bounded
    // context for a failure annotation without retaining the whole run in RAM.
    let serverOutput = "";
    const rememberServerOutput = (message: string) => {
      serverOutput = `${serverOutput}${message}`.slice(-16_384);
    };
    serverProcess.stdout?.on("data", (data: Buffer) => {
      rememberServerOutput(data.toString());
    });
    serverProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      rememberServerOutput(msg);
      if (!msg.includes("ExperimentalWarning")) {
        console.error("[E2E Server]", msg);
      }
    });

    serverProcess.on("error", (err) => {
      console.error("[E2E Server] Process error:", err);
    });
    serverProcess.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") return;
      const message = `E2E main server exited (${code}/${signal})\n${serverOutput}`;
      console.error(message);
      if (process.env.GITHUB_ACTIONS === "true") {
        console.error(
          `::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
        );
      }
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
  } else {
    console.log("[E2E] Mutable services will start on demand in each worker");
  }

  // Keep the source-enabled development server for tests that install browser
  // fixtures by importing modules directly from /src.
  console.log("[E2E] Starting remote client development server...");
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

  await registerSharedServiceProcess(remoteClientProcess, {
    label: "remote client",
    pidFile: REMOTE_CLIENT_PID_FILE,
  });

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
  console.log(`[E2E] Remote client development server on port ${remotePort}`);
  remoteClientProcess.unref();

  // Generated-chunk and source-independent relay/share fixtures reuse the
  // immutable remote build. Source-entry contracts retain the dev server above.
  console.log("[E2E] Starting remote client production preview...");
  const remotePreviewProcess = spawn(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions",
      "source",
      "e2e/start-vite-remote-preview.ts",
    ],
    {
      cwd: join(repoRoot, "packages", "client"),
      env: {
        ...process.env,
        YEP_E2E_REMOTE_DIST: remoteClientDist,
        VITE_PORT_FILE: REMOTE_PREVIEW_PORT_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  await registerSharedServiceProcess(remotePreviewProcess, {
    label: "remote preview",
    pidFile: REMOTE_PREVIEW_PID_FILE,
  });

  remotePreviewProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Remote Preview]", msg);
    }
  });

  remotePreviewProcess.on("error", (err) => {
    console.error("[E2E Remote Preview] Process error:", err);
  });

  const remotePreviewPort = await waitForPortFile(
    REMOTE_PREVIEW_PORT_FILE,
    "remote preview",
    30000,
  );
  console.log(
    `[E2E] Remote client production preview on port ${remotePreviewPort}`,
  );
  remotePreviewProcess.unref();
}
