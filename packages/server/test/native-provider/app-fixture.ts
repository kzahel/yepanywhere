/** Real source app/host/native ownership; only the model endpoint is scripted. */
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { standaloneYaEnvironment } from "../../../client/e2e/support/standalone-environment.js";
import {
  captureLeaderStartTime,
  terminateChildProcess,
} from "../../../client/e2e/support/process-lifecycle.js";
import { stopProviderHostRuntime } from "../../../client/e2e/support/provider-host-runtime.js";
import { modelServer, syntheticKey } from "./model-server.js";
import { nativeExecutable, expectedVersions } from "./runtimes.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const exec = promisify(execFile);
class AppFixtureClosed extends Error {}
export type AppProvider = "claude" | "codex";
export interface NativeWorker {
  pid: number;
  runtimeId: string;
  providerSessionId: string;
  providerProcessGroupIds: number[];
  attachedServerGeneration: string;
}

// Same bounded cold-start horizon as the existing standalone app helper.
export async function appBarrier<T>(
  observe: () => Promise<T | false>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await observe();
      if (value !== false) return value;
    } catch (error) {
      if (error instanceof AppFixtureClosed) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Native app barrier ${label}: ${lastError ?? "no observation"}`);
}

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function nativeAppFixture(
  provider: AppProvider,
  options: {
    agentApiManagement?: boolean;
    additionalProviders?: readonly AppProvider[];
    signal?: AbortSignal;
  } = {},
) {
  if (!["darwin", "linux"].includes(process.platform))
    throw Error(
      "Native app reload requires the production POSIX Node provider host",
    );
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const phases: Array<{ phase: string; elapsedMs: number }> = [];
  const mark = (phase: string) => {
    if (phases.length < 64)
      phases.push({
        phase,
        elapsedMs: Math.round(performance.now() - started),
      });
  };
  const root = await realpath(await mkdtemp("/tmp/ya-app-"));
  mark("private root");
  const project = join(root, "project"),
    home = join(root, "home"),
    host = join(root, "host");
  let ownedModel: Awaited<ReturnType<typeof modelServer>> | undefined;
  const timingReport = () => ({
    nativeApp: provider,
    startedAt,
    phases,
    modelRequests:
      ownedModel?.requests.slice(0, 16).map((request) => ({
        wire: request.wire,
        elapsedMs: Math.round(request.receivedAt - started),
      })) ?? [],
  });
  const sockets = new Set<WebSocket>();
  const observedPids = new Map<number, string>();
  async function observePid(pid: number) {
    if (!observedPids.has(pid)) {
      const start = await captureLeaderStartTime(pid);
      if (start) observedPids.set(pid, start);
    }
  }
  let child: ReturnType<typeof spawn> | undefined, identity: string | undefined;
  let output = "",
    closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      mark("cleanup start");
      for (const socket of sockets) socket.close();
      try {
        if (child)
          await terminateChildProcess(child, "native app wrapper", identity);
        mark("wrapper stopped");
      } finally {
        try {
          await stopProviderHostRuntime(host);
          mark("provider host stopped");
        } finally {
          try {
            await ownedModel?.close();
            mark("model listener stopped");
          } finally {
            try {
              await rm(root, { recursive: true, force: true });
              mark("private root removed");
            } finally {
              console.info(JSON.stringify(timingReport()));
            }
          }
        }
      }
      for (const [pid, start] of observedPids)
        if ((await captureLeaderStartTime(pid)) === start)
          throw Error(`Owned app process ${pid} survived teardown`);
    })());
  function assertOpen() {
    if (closing || options.signal?.aborted)
      throw new AppFixtureClosed("Native app fixture is closed or cancelled");
  }
  try {
    assertOpen();
    const enabledProviders = [
      ...new Set([provider, ...(options.additionalProviders ?? [])]),
    ];
    const model = await modelServer(
      enabledProviders.map((selected) =>
        selected === "claude" ? "anthropic" : "responses",
      ),
      {
        blockedHosts: [
          "chatgpt.com:443",
          "github.com:443",
          "api.github.com:443",
          "ab.chatgpt.com:443",
        ],
        auxiliary(body, path) {
          if (
            path === "/v1/messages" &&
            body.max_tokens === 1 &&
            body.stream !== true &&
            JSON.stringify(body.messages).includes('"text":"Hi"')
          )
            return "claude-model-validation";
          return undefined;
        },
      },
    );
    ownedModel = model;
    mark("model listener");
    assertOpen();
    const paths = {
      tempDir: root,
      profileDir: home,
      dataDir: join(home, "ya"),
      claudeSessionsDir: join(home, "claude/projects"),
      codexSessionsDir: join(home, "codex/sessions"),
      geminiSessionsDir: join(home, ".gemini/tmp"),
    };
    const parent = Object.fromEntries(
      [
        "PATH",
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
      ].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    );
    const env = standaloneYaEnvironment(
      paths,
      host,
      true,
      {
        ENABLED_PROVIDERS: enabledProviders.join(","),
        ANTHROPIC_API_KEY: syntheticKey,
        OPENAI_API_KEY: syntheticKey,
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_EXECUTABLE: nativeExecutable("claude"),
        YEP_DESKTOP_CODEX_CLI_PATH: nativeExecutable("codex"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        HTTP_PROXY: model.url,
        HTTPS_PROXY: model.url,
        ALL_PROXY: model.url,
        http_proxy: model.url,
        https_proxy: model.url,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
        VITE_DISABLE_ONBOARDING: "true",
        VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        VOICE_INPUT: "false",
      },
      parent,
    );
    // The real wrapper loads checkout .env. Explicit empty values suppress that
    // ambient authority without copying or printing any of its values.
    const dotenv = await readFile(join(repo, ".env"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const line of dotenv.split("\n")) {
      const name = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
      if (name && !(name in env)) env[name] = "";
    }
    assertOpen();
    env.PORT = String(await freePort());
    env.VITE_PORT = String(await freePort());
    env.MAINTENANCE_PORT = "0";
    env.SERVE_FRONTEND = "true";
    env.NODE_ENV = "development";
    env.NODE_OPTIONS = `--import ${pathToFileURL(join(repo, "packages/client/e2e/support/offline-update-check.mjs")).href}`;
    env.LOG_TO_FILE = "true";
    env.LOG_DIR = join(root, "logs");
    env.LOG_FILE_LEVEL = "info";
    const baseUrl = `http://127.0.0.1:${env.PORT}`;
    mark("environment");
    assertOpen();
    await mkdir(project, { recursive: true });
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(env.CODEX_HOME!, { recursive: true });
    await writeFile(join(project, "notes.txt"), "OWNED_TOOL_CONTENT\n");
    await exec("git", ["init", "--quiet"], {
      cwd: project,
      env,
      signal: options.signal,
    });
    await writeFile(
      join(paths.dataDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          codexUpdatePolicy: "off",
          recapMode: "off",
          promptSuggestionMode: "off",
          ...(options.agentApiManagement
            ? { agentApiEnabled: true, agentApiManagementEnabled: true }
            : {}),
        },
      }),
    );
    await writeFile(
      join(env.CODEX_HOME!, "config.toml"),
      `model_provider = "owned_fixture"\n[model_providers.owned_fixture]\nname = "Owned local model"\nbase_url = "${model.url}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n[analytics]\nenabled = false\n`,
    );
    mark("profile files");
    for (const selected of enabledProviders) {
      assertOpen();
      mark(`version ${selected} start`);
      const version = (
        await exec(nativeExecutable(selected), ["--version"], {
          cwd: project,
          env,
          timeout: 5000,
          signal: options.signal,
        })
      ).stdout.trim();
      if (!version.split(/\s+/).includes(expectedVersions[selected]))
        throw Error(`Unexpected native ${selected} version ${version}`);
      mark(`version ${selected} complete`);
    }
    assertOpen();
    child = spawn(process.execPath, [join(repo, "scripts/dev.js")], {
      cwd: repo,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    mark("wrapper spawned");
    child.stdout!.once("data", () => mark("first wrapper output"));
    let hostReported = false;
    child.stdout!.on("data", (chunk) => {
      output = (output + chunk).slice(-64_000);
      if (!hostReported && output.includes("wrapper host listening")) {
        hostReported = true;
        mark("provider host listening");
      }
    });
    child.stderr!.on("data", (chunk) => {
      output = (output + chunk).slice(-64_000);
    });
    child.on("error", (error) => {
      output += String(error);
    });
    identity = child.pid ? await captureLeaderStartTime(child.pid) : undefined;
    assertOpen();
    let replacementPending = false;
    const attachedGenerations = new Set<string>();
    async function api(path: string, body?: unknown, method?: string) {
      assertOpen();
      const requestMethod = method ?? (body === undefined ? "GET" : "POST");
      const replacement =
        path === "/server/restart" && requestMethod === "POST";
      if (replacement) {
        replacementPending = true;
        mark("API replacement requested");
      }
      const response = await fetch(`${baseUrl}/api${path}`, {
        method: requestMethod,
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
      if (replacement) mark("API replacement accepted");
      else if (replacementPending) {
        replacementPending = false;
        mark("API answered after replacement request");
      }
      return data;
    }
    async function inventory(): Promise<NativeWorker[]> {
      assertOpen();
      const descriptor = JSON.parse(
        await readFile(join(host, "host.json"), "utf8"),
      );
      const discovery = await import(
        pathToFileURL(join(repo, "scripts/provider-runtime-discovery.mjs")).href
      );
      const result = await discovery.requestProviderHost(
        {
          controlSocketPath: descriptor.controlSocketPath,
          token: (await readFile(join(host, "token"), "utf8")).trim(),
          protocolVersion: 3,
        },
        { op: "inventory" },
        4000,
      );
      const workers: NativeWorker[] = result.runtimes ?? result;
      if (descriptor.owner?.pid) await observePid(descriptor.owner.pid);
      for (const worker of workers) {
        const generation = JSON.stringify([
          worker.runtimeId,
          worker.attachedServerGeneration,
        ]);
        if (
          worker.attachedServerGeneration &&
          !attachedGenerations.has(generation) &&
          attachedGenerations.size < 64
        ) {
          attachedGenerations.add(generation);
          mark(`generation attached ${attachedGenerations.size}`);
        }
        await observePid(worker.pid);
        for (const pid of worker.providerProcessGroupIds) await observePid(pid);
      }
      return workers;
    }
    async function connect(sessionId: string) {
      assertOpen();
      const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/ws`);
      sockets.add(ws);
      const events: Record<string, unknown>[] = [];
      ws.onmessage = (event) => {
        events.push(JSON.parse(String(event.data)));
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(Error("Native app WebSocket failed"));
        ws.onclose = () =>
          reject(new AppFixtureClosed("Native app WebSocket closed"));
      });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          subscriptionId: "native-app",
          channel: "session",
          sessionId,
        }),
      );
      return {
        ws,
        events,
        wait: (label: string, after = 0) =>
          appBarrier(
            async () =>
              events
                .slice(after)
                .some((e) => JSON.stringify(e).includes(label)) || false,
            `WebSocket ${label}`,
          ),
      };
    }
    return {
      root,
      project,
      env,
      provider,
      baseUrl,
      model,
      api,
      inventory,
      connect,
      async processes() {
        assertOpen();
        const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="]);
        const rows = stdout.split("\n").flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                  command: match[3]!,
                },
              ]
            : [];
        });
        const owned = new Set([child!.pid!]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const row of rows)
            if (owned.has(row.parent) && !owned.has(row.pid)) {
              owned.add(row.pid);
              changed = true;
            }
        }
        const leaf = (pattern: RegExp) => {
          const matches = rows.filter(
            (row) => owned.has(row.pid) && pattern.test(row.command),
          );
          const target = matches.find(
            (row) => !matches.some((candidate) => candidate.parent === row.pid),
          );
          if (!target)
            throw Error(`Owned app process not observed: ${pattern}`);
          return target.pid;
        };
        const processes = {
          wrapper: child!.pid!,
          backend: leaf(/src\/index\.ts/),
          frontend: leaf(/vite(?:\/bin\/vite\.js| --|$)/),
        };
        for (const pid of Object.values(processes)) await observePid(pid);
        return processes;
      },
      async reload() {
        assertOpen();
        replacementPending = true;
        mark("API replacement requested");
        const pid = child!.pid!;
        if (!identity || (await captureLeaderStartTime(pid)) !== identity)
          throw Error("Native app wrapper identity changed");
        process.kill(pid, "SIGHUP");
      },
      async crashBackend() {
        const pid = (await this.processes()).backend;
        const started = observedPids.get(pid);
        if (!started || (await captureLeaderStartTime(pid)) !== started)
          throw Error("Native app backend identity changed");
        replacementPending = true;
        mark("backend crash requested");
        process.kill(pid, "SIGKILL");
      },
      output: () => output,
      async diagnostics() {
        const logs = await readdir(join(root, "logs")).catch(() => []);
        const details = await Promise.all(
          logs.slice(-4).map(async (name) => {
            const content = await readFile(
              join(root, "logs", name),
              "utf8",
            ).catch(() => "");
            return `${name}:\n${content.slice(-32_000)}`;
          }),
        );
        return [JSON.stringify(timingReport()), output, ...details].join("\n");
      },
      async ready() {
        await appBarrier(async () => {
          if (child!.exitCode !== null || child!.signalCode !== null)
            throw Error(`Wrapper exited: ${output}`);
          return await api("/version");
        }, "server startup");
        mark("API ready");
        await appBarrier(async () => {
          assertOpen();
          const r = await fetch(baseUrl, {
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
              : AbortSignal.timeout(5000),
          });
          return (r.ok && (await r.text()).includes("/@vite/client")) || false;
        }, "frontend startup");
        mark("frontend ready");
      },
      async create(text: string, mode = "bypassPermissions") {
        mark("creation requested");
        const { project: p } = await api("/projects", { path: project });
        const receipt = await api(`/projects/${p.id}/session-creations`, {
          requestId: `app-${provider}-${crypto.randomUUID()}`,
          provider,
          message: text,
          model: provider === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol",
          mode,
          recapMode: "off",
          promptSuggestionMode: "off",
        });
        mark("creation saved");
        return {
          sessionId: receipt.sessionId as string,
          projectId: p.id as string,
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw Error(`${error}\n${output}`, { cause: error });
  }
}
