import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { InstallService } from "../../../server/src/services/InstallService.js";
import { standaloneYaEnvironment } from "./standalone-environment.js";
import { stopProviderHostRuntime } from "./provider-host-runtime.js";
import { getE2EProfileDirectory, getE2ERunDirectory } from "./run-directory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..", "..");
const serverRoot = join(repoRoot, "packages", "server");
const fixtureRuntimePreload = pathToFileURL(
  join(__dirname, "fixture-runtime.mjs"),
).href;
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;

import { terminateChildProcess } from "./process-lifecycle.js";
import {
  registerProcess,
  unregisterProcess,
  readRegisteredProcess,
} from "./process-registry.js";

export interface MockClaudeSession {
  assistantContent?: string;
  content: string;
  projectPath: string;
  sessionId: string;
  timestamp?: string;
}

export interface YaServerProfilePaths {
  claudeSessionsDir: string;
  codexSessionsDir: string;
  dataDir: string;
  geminiSessionsDir: string;
  profileDir: string;
  tempDir: string;
}

export interface StartYaServerProcessOptions {
  label: string;
  /** Own all provider/config/tmp roots; host mode is explicit and defaults off. */
  standalone?: { providerHostEnabled?: boolean };
  /** Select Node or Bun for the server; the coordinator retains native cleanup. */
  serverExecutable?: string;
  /** Serve this invocation's immutable bundle from the private YA listener. */
  serveBuiltClient?: boolean;
  tempPrefix?: string;
  mockClaudeSession?: MockClaudeSession;
  setupProfile?: (paths: YaServerProfilePaths) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** A seeded profile owned by the worker; global teardown removes it. */
  profilePaths?: YaServerProfilePaths;
  startupDeadline?: number;
}

export interface YaServerProcess {
  serverExecutable: string;
  baseUrl: string;
  claudeSessionsDir: string;
  codexSessionsDir: string;
  dataDir: string;
  geminiSessionsDir: string;
  label: string;
  output: {
    stderr: string[];
    stdout: string[];
  };
  port: number;
  portFile: string;
  process: ChildProcess;
  restartEnv: NodeJS.ProcessEnv;
  tempDir: string;
  wsUrl: string;
  ownsTempDir: boolean;
  registryFile?: string;
}

async function waitForPortFile(
  portFile: string,
  label: string,
  deadline: number,
  assertRunning: () => void,
): Promise<number> {
  while (Date.now() < deadline) {
    assertRunning();
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = Number.parseInt(content, 10);
      if (port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${label} port file`);
}

async function waitForHealth(
  baseUrl: string,
  label: string,
  deadline: number,
  assertRunning: () => void,
): Promise<void> {
  const healthUrl = `${baseUrl}/health`;
  while (Date.now() < deadline) {
    assertRunning();
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(1_000, deadline - Date.now())),
        ),
      });
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} health check failed: ${healthUrl}`);
}

function writeServerSettings(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "server-settings.json"),
    JSON.stringify(
      {
        version: 1,
        settings: {
          codexUpdatePolicy: "off",
        },
      },
      null,
      2,
    ),
  );
}

function writeMockClaudeSession(
  claudeSessionsDir: string,
  fixture: MockClaudeSession,
): void {
  const timestamp = fixture.timestamp ?? "2026-01-01T00:00:00.000Z";
  mkdirSync(fixture.projectPath, { recursive: true });
  const encodedPath = fixture.projectPath.replace(/\//g, "-");
  const sessionDir = join(claudeSessionsDir, hostname(), encodedPath);
  mkdirSync(sessionDir, { recursive: true });
  const messages = [
    {
      type: "user",
      cwd: fixture.projectPath,
      message: { role: "user", content: fixture.content },
      timestamp,
      uuid: "fixture-user-message",
    },
    ...(fixture.assistantContent
      ? [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: fixture.assistantContent }],
            },
            timestamp: fixture.timestamp ?? "2026-01-01T00:00:01.000Z",
            uuid: "fixture-assistant-message",
            parentUuid: "fixture-user-message",
          },
        ]
      : []),
  ];
  writeFileSync(
    join(sessionDir, `${fixture.sessionId}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

function captureOutput(
  stream: NodeJS.ReadableStream | null,
  target: string[],
): void {
  let retained = 0;
  stream?.on("data", (data: Buffer | string) => {
    const text = data.toString();
    if (!text.includes("ExperimentalWarning")) {
      const tail = text.slice(-16_384);
      target.push(tail);
      retained += tail.length;
      while (retained > 16_384 && target.length > 1)
        retained -= target.shift()!.length;
    }
  });
}

function formatStartFailure(
  label: string,
  error: unknown,
  output: YaServerProcess["output"],
): Error {
  const detail = [...output.stderr, ...output.stdout].join("").trim();
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    detail
      ? `${label} failed to start: ${message}\n${detail}`
      : `${label} failed to start: ${message}`,
  );
}

function monitorStartup(child: ChildProcess, label: string): () => void {
  let launchError: Error | undefined;
  child.on("error", (error) => {
    launchError = error;
  });
  return () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `${label} exited during startup (${child.exitCode}/${child.signalCode})`,
      );
  };
}

export async function startYaServerProcess(
  options: StartYaServerProcessOptions,
): Promise<YaServerProcess> {
  if (process.platform === "darwin" && process.versions.bun)
    throw new Error(
      "Use a Node fixture coordinator on macOS; select Bun with serverExecutable",
    );
  const serverExecutable = options.serverExecutable ?? process.execPath;
  if (!isAbsolute(serverExecutable))
    throw new Error("Fixture serverExecutable must be absolute");
  const frontendEnv: NodeJS.ProcessEnv = {};
  if (options.serveBuiltClient) {
    const runDirectory = getE2ERunDirectory();
    const clientDist = runDirectory && join(runDirectory, "client-dist");
    if (!clientDist || !existsSync(join(clientDist, "index.html"))) {
      throw new Error("Built client fixture requires the E2E invocation build");
    }
    frontendEnv.SERVE_FRONTEND = "true";
    frontendEnv.CLIENT_DIST_PATH = clientDist;
  }
  const deadline = options.startupDeadline ?? Date.now() + 30_000;
  const parent = options.standalone
    ? tmpdir()
    : (getE2EProfileDirectory() ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const tempDir =
    options.profilePaths?.tempDir ??
    mkdtempSync(join(parent, options.tempPrefix ?? "ya-e2e-server-"));
  const profileDir =
    options.profilePaths?.profileDir ?? join(tempDir, "profile");
  const portFile = join(tempDir, "port");
  const claudeSessionsDir =
    options.profilePaths?.claudeSessionsDir ??
    join(profileDir, "claude", "projects");
  const codexSessionsDir =
    options.profilePaths?.codexSessionsDir ??
    join(profileDir, "codex", "sessions");
  const geminiSessionsDir =
    options.profilePaths?.geminiSessionsDir ??
    join(profileDir, options.standalone ? ".gemini" : "gemini", "tmp");
  const dataDir =
    options.profilePaths?.dataDir ?? join(profileDir, "yep-anywhere");
  // A short run-owned sibling path keeps per-provider Unix sockets below
  // macOS's limit regardless of the profile label or retry worker index.
  const runtimeDir = mkdtempSync(
    join(
      (options.standalone ? undefined : getE2ERunDirectory()) ??
        (process.platform === "darwin" ? "/tmp" : tmpdir()),
      "h-",
    ),
  );

  const discardUnlaunched = () => {
    rmSync(runtimeDir, { recursive: true, force: true });
    if (!options.profilePaths)
      rmSync(tempDir, { recursive: true, force: true });
  };
  let childEnv: NodeJS.ProcessEnv;
  try {
    mkdirSync(claudeSessionsDir, { recursive: true });
    mkdirSync(codexSessionsDir, { recursive: true });
    mkdirSync(geminiSessionsDir, { recursive: true });
    writeServerSettings(dataDir);
    if (options.mockClaudeSession) {
      writeMockClaudeSession(claudeSessionsDir, options.mockClaudeSession);
      // A retained-session fixture must enroll its store as well as write history.
      const install = new InstallService({ dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["claude"]);
    }
    await options.setupProfile?.({
      claudeSessionsDir,
      codexSessionsDir,
      dataDir,
      geminiSessionsDir,
      profileDir,
      tempDir,
    });

    const inheritedEnv = { ...process.env };
    for (const name of [
      "YEP_PROVIDER_RUNTIME_SOCKET",
      "YEP_PROVIDER_RUNTIME_TOKEN",
      "YEP_PROVIDER_RUNTIME_TOKEN_FILE",
      "YEP_PROVIDER_RUNTIME_DESCRIPTOR",
      "YEP_PROVIDER_RUNTIME_DIR",
      "YEP_PROVIDER_RUNTIME_RECEIPTS",
      "YEP_SERVER_GENERATION",
    ])
      delete inheritedEnv[name];
    childEnv = {
      ...inheritedEnv,
      // Provider installation gates are per OS-user home, not YEP_DATA_DIR.
      // A private fixture must not contend with the developer's live providers.
      HOME: profileDir,
      USERPROFILE: profileDir,
      // Ordinary fixtures exercise the production shell. Development-session
      // reload flags otherwise enable source watchers and obstruct phone controls.
      NO_BACKEND_RELOAD: "false",
      NO_FRONTEND_RELOAD: "false",
      PORT: "0",
      PORT_FILE: portFile,
      MAINTENANCE_PORT: "0",
      SERVE_FRONTEND: "false",
      LOG_LEVEL: "warn",
      LOG_FILE_LEVEL: "warn",
      LOG_TO_FILE: "false",
      AUTH_DISABLED: "true",
      HTTPS_SELF_SIGNED: "",
      NODE_ENV: "production",
      OPEN_BROWSER: "false",
      CLAUDE_SESSIONS_DIR: claudeSessionsDir,
      CODEX_SESSIONS_DIR: codexSessionsDir,
      GEMINI_SESSIONS_DIR: geminiSessionsDir,
      YEP_DATA_DIR: dataDir,
      // Each server owns its runtime inventory as well as its persisted profile.
      YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeDir,
      ...options.env,
      ...frontendEnv,
    };
    if (options.standalone) {
      childEnv = {
        ...standaloneYaEnvironment(
          {
            claudeSessionsDir,
            codexSessionsDir,
            geminiSessionsDir,
            dataDir,
            profileDir,
            tempDir,
          },
          runtimeDir,
          options.standalone.providerHostEnabled ?? false,
          options.env,
        ),
        NO_BACKEND_RELOAD: "false",
        NO_FRONTEND_RELOAD: "false",
        ...frontendEnv,
      };
    }
    if (childEnv.FORCE_COLOR) {
      delete childEnv.NO_COLOR;
    }
  } catch (error) {
    discardUnlaunched();
    throw error;
  }

  let child: ChildProcess;
  try {
    child = spawn(
      serverExecutable,
      [
        "--import",
        tsxLoader,
        "--import",
        fixtureRuntimePreload,
        "--conditions",
        "source",
        "src/index.ts",
      ],
      {
        cwd: serverRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
  } catch (error) {
    discardUnlaunched();
    throw error;
  }
  const assertRunning = monitorStartup(child, options.label);
  const output = { stderr: [] as string[], stdout: [] as string[] };
  captureOutput(child.stdout, output.stdout);
  captureOutput(child.stderr, output.stderr);

  const pending: YaServerProcess = {
    serverExecutable,
    baseUrl: "",
    claudeSessionsDir,
    codexSessionsDir,
    dataDir,
    geminiSessionsDir,
    label: options.label,
    output,
    port: 0,
    portFile,
    process: child,
    restartEnv: childEnv,
    tempDir,
    wsUrl: "",
    ownsTempDir: !options.profilePaths,
  };

  try {
    if (child.pid) {
      writeFileSync(join(tempDir, "pid"), String(child.pid));
      pending.registryFile = await registerProcess(
        {
          pid: child.pid,
          label: options.label,
          runtimeDir: childEnv.YEP_PROVIDER_HOST_RUNTIME_DIR,
        },
        options.standalone ? join(tempDir, "process.json") : undefined,
      );
    }
    const port = await waitForPortFile(
      portFile,
      options.label,
      deadline,
      assertRunning,
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, options.label, deadline, assertRunning);
    child.unref();
    return {
      ...pending,
      baseUrl,
      port,
      wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    };
  } catch (error) {
    throw await failedStart(pending, error);
  }
}

export async function terminateYaServerProcess(
  server: YaServerProcess,
): Promise<void> {
  await terminateChildProcess(
    server.process,
    server.label,
    readRegisteredProcess(server.registryFile)?.leaderStartTime,
  );
}

export async function restartYaServerProcess(
  server: YaServerProcess,
): Promise<YaServerProcess> {
  await terminateYaServerProcess(server);
  if (existsSync(server.portFile)) {
    rmSync(server.portFile);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...server.restartEnv,
    PORT: String(server.port),
    PORT_FILE: server.portFile,
  };
  let child: ChildProcess;
  try {
    child = spawn(
      server.serverExecutable ?? process.execPath,
      [
        "--import",
        tsxLoader,
        "--import",
        fixtureRuntimePreload,
        "--conditions",
        "source",
        "src/index.ts",
      ],
      {
        cwd: serverRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
  } catch (error) {
    throw await failedStart(server, error);
  }
  const deadline = Date.now() + 30_000;
  const assertRunning = monitorStartup(child, `${server.label} restart`);
  const output = { stderr: [] as string[], stdout: [] as string[] };
  captureOutput(child.stdout, output.stdout);
  captureOutput(child.stderr, output.stderr);
  const pending: YaServerProcess = {
    ...server,
    output,
    process: child,
    restartEnv: childEnv,
    registryFile: undefined,
  };

  try {
    if (child.pid) {
      writeFileSync(join(server.tempDir, "pid"), String(child.pid));
      pending.registryFile = await registerProcess(
        {
          pid: child.pid,
          label: server.label,
          runtimeDir: childEnv.YEP_PROVIDER_HOST_RUNTIME_DIR,
        },
        server.registryFile,
      );
    }
    const port = await waitForPortFile(
      server.portFile,
      `${server.label} restart`,
      deadline,
      assertRunning,
    );
    if (port !== server.port) {
      throw new Error(
        `${server.label} restarted on port ${port}, expected ${server.port}`,
      );
    }
    await waitForHealth(
      server.baseUrl,
      `${server.label} restart`,
      deadline,
      assertRunning,
    );
    child.unref();
    return pending;
  } catch (error) {
    throw await failedStart(pending, error);
  }
}

async function failedStart(
  server: YaServerProcess,
  error: unknown,
): Promise<Error> {
  const startup = formatStartFailure(server.label, error, server.output);
  try {
    await disposeYaServerProcess(server);
    return startup;
  } catch (cleanup) {
    return new AggregateError(
      [startup, cleanup],
      `${server.label} startup and cleanup failed`,
    );
  }
}

/** Reap the server and its detached host before removing owned storage. */
export async function disposeYaServerProcess(
  server: YaServerProcess | null,
): Promise<void> {
  if (!server) return;
  const failures: unknown[] = [];
  try {
    await terminateYaServerProcess(server);
  } catch (error) {
    failures.push(error);
  }
  const runtimeDir = server.restartEnv.YEP_PROVIDER_HOST_RUNTIME_DIR!;
  try {
    await stopProviderHostRuntime(runtimeDir);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Failed to dispose ${server.label}; recovery records retained`,
    );
  rmSync(runtimeDir, { recursive: true, force: true });
  unregisterProcess(server.registryFile);
  rmSync(join(server.tempDir, "pid"), { force: true });
  if (server.ownsTempDir)
    rmSync(server.tempDir, { recursive: true, force: true });
}
