import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import {
  parseNativeSessionId,
  toUrlProjectId,
  type SteeringMode,
} from "@yep-anywhere/shared";
import { standaloneYaEnvironment } from "../../../client/e2e/support/standalone-environment.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { ClaudeGatewayProvider } from "../../src/sdk/providers/claude-gateway.js";
import { ClaudeOllamaProvider } from "../../src/sdk/providers/claude-ollama.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { CodexOSSProvider } from "../../src/sdk/providers/codex-oss.js";
import { AntigravityProvider } from "../../src/sdk/providers/antigravity.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";
import { OpenCodeProvider } from "../../src/sdk/providers/opencode.js";
import { GrokACPProvider } from "../../src/sdk/providers/grok-acp.js";
import type {
  AgentProvider,
  AgentSession,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import type { SDKMessage, ProviderCommandResult } from "../../src/sdk/types.js";
import { Process } from "../../src/supervisor/Process.js";
import * as logging from "../../src/logging/logger.js";
import pino from "pino";
import { modelServer, syntheticKey, type ModelWire } from "./model-server.js";
import { historyReader } from "./history.js";
import {
  expectedVersions,
  isClaude,
  isCodex,
  nativeExecutable,
  type NativeProvider,
} from "./runtimes.js";
export {
  baselineProviders,
  nativeProviders,
  type NativeProvider,
} from "./runtimes.js";

const exec = promisify(execFile);
const wireFor = (provider: NativeProvider): ModelWire =>
  isClaude(provider)
    ? "anthropic"
    : isCodex(provider) || provider === "grok"
      ? "responses"
      : provider === "antigravity"
        ? "gemini"
        : "chat";

interface FixtureOptions {
  permissionMode?: StartSessionOptions["permissionMode"];
  onToolApproval?: StartSessionOptions["onToolApproval"];
  gitProject?: boolean;
  piKeepRecentTokens?: number;
}

export async function nativeFixture(
  provider: NativeProvider,
  mode: SteeringMode = "gentle",
  options: FixtureOptions = {},
) {
  // Resolve before scrubbing env, so an explicit owned test executable is preserved.
  const executable = nativeExecutable(provider);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-native-provider-")),
  );
  const profile = join(root, "profile"),
    project = join(root, "project");
  const paths = {
    tempDir: root,
    profileDir: profile,
    dataDir: join(profile, "ya"),
    claudeSessionsDir: join(profile, "claude", "projects"),
    codexSessionsDir: join(profile, "codex", "sessions"),
    geminiSessionsDir: join(profile, ".gemini", "tmp"),
  };
  const configuredService =
    provider === "claude-gateway" || provider === "codex-oss";
  const modelId = isCodex(provider)
    ? "gpt-6.1-sol"
    : provider === "antigravity"
      ? "gemini-3.8-flash-high"
      : isClaude(provider)
        ? "claude-haiku-5-5"
        : "owned/m1";
  const model = await modelServer(wireFor(provider), {
    ...(configuredService ? { catalogModel: modelId } : {}),
    authOptional: provider === "codex-oss",
    syntheticKeys:
      provider === "claude-ollama"
        ? ["ollama"]
        : configuredService
          ? ["dummy"]
          : [],
    blockedHosts: [
      "chatgpt.com:443",
      "github.com:443",
      "api.github.com:443",
      "ab.chatgpt.com:443",
      ...(provider === "opencode" ? ["registry.npmjs.org:443"] : []),
    ],
    auxiliary(body, path) {
      if (
        isClaude(provider) &&
        path.startsWith("/v1/messages") &&
        body.max_tokens === 1 &&
        body.stream !== true &&
        Array.isArray(body.messages) &&
        body.messages.length === 1 &&
        JSON.stringify(body.messages[0]).includes('"text":"Hi"')
      )
        return "claude-model-validation";
      if (
        configuredService &&
        path === "/v1/chat/completions" &&
        JSON.stringify(body.messages) === '[{"role":"user","content":"."}]'
      )
        return "gateway-effort";
      if (provider === "grok") {
        if (path === "/") return "grok-health";
        const first = JSON.stringify(
          Array.isArray(body.input) ? body.input[0] : undefined,
        );
        const last = JSON.stringify(
          Array.isArray(body.input) ? body.input.at(-1) : undefined,
        );
        if (
          last?.includes(
            "<system-reminder>Generate a session title for the conversation above.",
          )
        )
          return "grok-title-refresh";
        if (
          first?.includes("You are tasked with generating the session title.")
        )
          return "grok-title";
        if (
          first?.includes(
            "Write an ultra-short dashboard line that captures the AGENT",
          )
        )
          return "grok-summary";
      }
      return undefined;
    },
  });
  const environment = standaloneYaEnvironment(
    paths,
    join(root, "runtime"),
    false,
    {
      ANTHROPIC_API_KEY: syntheticKey,
      OPENAI_API_KEY: syntheticKey,
      GEMINI_API_KEY: syntheticKey,
      FIXTURE_MODEL_KEY: syntheticKey,
      ANTHROPIC_BASE_URL: model.url,
      GOOGLE_GEMINI_BASE_URL: model.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      PI_OFFLINE: "1",
      OPENCODE_CONFIG: join(profile, "opencode.json"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      HTTP_PROXY: model.url,
      HTTPS_PROXY: model.url,
      ALL_PROXY: model.url,
      http_proxy: model.url,
      https_proxy: model.url,
      grpc_proxy: model.url,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      ...(isClaude(provider) ? { CLAUDE_CODE_EXECUTABLE: executable } : {}),
      ...(provider === "pi" ? { PI_EXECUTABLE: executable } : {}),
      ...(provider === "antigravity"
        ? { ANTIGRAVITY_ACP_PATH: executable }
        : {}),
    },
  );
  for (const name of new Set([
    ...Object.keys(process.env),
    ...Object.keys(environment),
  ]))
    vi.stubEnv(name, environment[name]);
  let proc: Process | undefined,
    session: AgentSession | undefined,
    nativeId: string | undefined;
  let adapter: AgentProvider;
  let stopping: Promise<void> | undefined, closing: Promise<void> | undefined;
  const events: SDKMessage[] = [],
    errors: Error[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "warn" },
    {
      write(line: string) {
        diagnostics.push(JSON.parse(line));
      },
    },
  );
  const loggerSpy = vi.spyOn(logging, "getLogger").mockReturnValue(logger);
  let resolveSteer!: (accepted: boolean) => void;
  let resolveCommand!: (result: ProviderCommandResult) => void;
  let commandResult = new Promise<ProviderCommandResult>((resolve) => {
    resolveCommand = resolve;
  });
  let steerAccepted = new Promise<boolean>((resolve) => {
    resolveSteer = resolve;
  });

  function waitForMessage(matches: (message: SDKMessage) => boolean) {
    if (events.some(matches)) return Promise.resolve();
    if (errors.length || proc?.state.type === "terminated")
      return Promise.reject(
        Error("Native owner stopped before expected message"),
      );
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = proc!.subscribe((event) => {
        if (event.type === "message" && matches(event.message)) {
          unsubscribe();
          resolve();
        } else if (
          event.type === "error" ||
          proc!.state.type === "terminated"
        ) {
          unsubscribe();
          reject(Error("Native owner stopped before expected message"));
        }
      });
    });
  }
  async function start(launch: Partial<StartSessionOptions> = {}) {
    stopping = undefined;
    steerAccepted = new Promise((resolve) => {
      resolveSteer = resolve;
    });
    commandResult = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    session = await adapter.startSession({
      cwd: project,
      model: provider === "grok" ? "owned" : modelId,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      onToolApproval:
        options.onToolApproval ??
        (async (_tool, input) => ({ behavior: "allow", updatedInput: input })),
      initialMessage: {
        text: "INITIAL_NATIVE_INPUT",
        uuid: "11111111-1111-4111-8111-111111111111",
      },
      ...launch,
    });
    const nativeSession = session;
    async function* observe() {
      for await (const message of nativeSession.iterator) {
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        )
          nativeId = message.session_id;
        yield message;
      }
    }
    proc = new Process(observe(), {
      sessionId: randomUUID(),
      projectPath: project,
      projectId: toUrlProjectId(project),
      provider,
      model: launch.model ?? modelId,
      queue: nativeSession.queue,
      pid: () =>
        typeof nativeSession.pid === "function"
          ? nativeSession.pid()
          : nativeSession.pid,
      abortFn: nativeSession.abort,
      interruptFn: nativeSession.interrupt,
      steerFn: nativeSession.steer
        ? async (message) => {
            const accepted = await nativeSession.steer!(message);
            resolveSteer(accepted);
            return accepted;
          }
        : undefined,
      steerUsesMessageQueue: nativeSession.steerUsesMessageQueue,
      setModelFn: nativeSession.setModel,
      setEffortFn: nativeSession.setEffort,
      runProviderCommandFn: nativeSession.runProviderCommand
        ? async (command, argument) => {
            const result = await nativeSession.runProviderCommand!(
              command,
              argument,
            );
            resolveCommand(result);
            return result;
          }
        : undefined,
      isProcessAlive: nativeSession.isProcessAlive,
      probeLivenessFn: nativeSession.probeLiveness,
      deferredDelivery: {
        joinWindowSeconds: 0,
        composeAnchors: false,
        turnTimestamps: "off",
      },
      idleTimeoutMs: 60_000,
    });
    proc.subscribe((event) => {
      if (event.type === "message") events.push(event.message);
      else if (event.type === "error") errors.push(event.error);
    });
  }
  const stop = () =>
    (stopping ??= (async () => {
      if (proc) await proc.abort();
      else await session?.abort();
    })());
  async function dispose() {
    try {
      await stop();
    } finally {
      try {
        if (provider === "claude-gateway")
          await ClaudeGatewayProvider.shutdownGateway();
      } finally {
        try {
          await model.close();
        } finally {
          try {
            await rm(root, { recursive: true, force: true });
          } finally {
            vi.unstubAllEnvs();
            loggerSpy.mockRestore();
          }
        }
      }
    }
  }
  const id = () => {
    if (!nativeId) throw Error("No native init identity received");
    return nativeId;
  };
  async function reader() {
    return historyReader(provider, project, environment, id(), executable);
  }
  try {
    await mkdir(project, { recursive: true });
    await mkdir(environment.CODEX_HOME!, { recursive: true });
    await mkdir(environment.PI_CODING_AGENT_DIR!, { recursive: true });
    await mkdir(join(environment.GEMINI_HOME!, "antigravity-acp"), {
      recursive: true,
    });
    await writeFile(join(project, "notes.txt"), "OWNED_TOOL_CONTENT\n");
    if (options.gitProject !== false)
      await exec("git", ["init", "--quiet"], {
        cwd: project,
        env: environment,
      });
    await writeFile(
      join(environment.CODEX_HOME!, "config.toml"),
      `model_provider = "owned_fixture"\n[model_providers.owned_fixture]\nname = "Owned local model"\nbase_url = "${model.url}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n[analytics]\nenabled = false\n`,
    );
    await writeFile(
      join(environment.PI_CODING_AGENT_DIR!, "models.json"),
      JSON.stringify({
        providers: {
          owned: {
            baseUrl: `${model.url}/v1`,
            api: "openai-completions",
            apiKey: syntheticKey,
            models: [
              {
                id: "m1",
                reasoning: true,
                contextWindow: 100_000,
                maxTokens: 4096,
              },
              {
                id: "m2",
                reasoning: true,
                contextWindow: 100_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    if (options.piKeepRecentTokens !== undefined)
      await writeFile(
        join(environment.PI_CODING_AGENT_DIR!, "settings.json"),
        JSON.stringify({
          compaction: {
            enabled: false,
            keepRecentTokens: options.piKeepRecentTokens,
          },
        }),
      );
    await writeFile(
      environment.OPENCODE_CONFIG!,
      JSON.stringify({
        autoupdate: false,
        model: "owned/m1",
        small_model: "owned/m1",
        enabled_providers: ["owned"],
        provider: {
          owned: {
            npm: "@ai-sdk/openai-compatible",
            name: "Owned fixture",
            options: { baseURL: `${model.url}/v1`, apiKey: syntheticKey },
            models: {
              m1: {
                name: "Owned m1",
                limit: { context: 100_000, output: 4096 },
              },
            },
          },
        },
      }),
    );
    await writeFile(
      join(environment.GROK_HOME!, "config.toml"),
      `[models]\ndefault = "owned"\n[model.owned]\nmodel = "m1"\nname = "Owned stub"\nbase_url = "${model.url}/v1"\nenv_key = "FIXTURE_MODEL_KEY"\napi_backend = "responses"\n[compat.cursor]\nagents = false\nrules = false\nskills = false\nhooks = false\nmcps = false\nsessions = false\n[compat.claude]\nagents = false\nrules = false\nskills = false\nhooks = false\nmcps = false\nsessions = false\n[compat.codex]\nhooks = false\nskills = false\nsessions = false\n`,
    );
    await writeFile(
      join(environment.GEMINI_HOME!, "antigravity-acp", "settings.json"),
      JSON.stringify({ auth: { type: "gemini-api-key" } }),
    );
    const script = provider === "pi";
    const version = (
      await exec(
        script ? process.execPath : executable,
        [...(script ? [executable] : []), "--version"],
        { cwd: project, env: environment, timeout: 5000 },
      )
    ).stdout.trim();
    const expected = expectedVersions[provider];
    if (!version.split(/\s+/).includes(expected))
      throw Error(
        `Native ${provider} version mismatch: expected ${expected}; got ${version}`,
      );
    if (provider === "claude") adapter = new ClaudeProvider();
    else if (provider === "claude-ollama") {
      ClaudeOllamaProvider.setOllamaUrl(model.url);
      adapter = new ClaudeOllamaProvider();
    } else if (provider === "claude-gateway") {
      await ClaudeGatewayProvider.configureGateway({ url: model.url });
      adapter = new ClaudeGatewayProvider();
      await adapter.getAvailableModels();
    } else if (provider === "codex") {
      const codex = new CodexProvider({
        codexPath: executable,
        codexHome: environment.CODEX_HOME,
      });
      codex.setSteeringModeGetter(() => mode);
      adapter = codex;
    } else if (provider === "codex-oss") {
      const codex = new CodexOSSProvider({ codexPath: executable });
      codex.setGatewayServices([
        {
          id: "owned",
          label: "Owned stub",
          shortName: "Owned",
          url: model.url,
          enabled: true,
          autoStop: false,
          autoStopAfterSeconds: 300,
          codexEnabled: true,
          codexWireApi: "responses",
        },
      ]);
      await codex.getAvailableModels();
      adapter = codex;
    } else if (provider === "antigravity") adapter = new AntigravityProvider();
    else if (provider === "pi")
      adapter = new PiProvider({ sessionsDir: environment.PI_SESSIONS_DIR });
    else if (provider === "opencode")
      adapter = new OpenCodeProvider({ opencodePath: executable });
    else adapter = new GrokACPProvider({ grokPath: executable });
    await start();
    return {
      provider,
      version,
      executable,
      root,
      project,
      model,
      events,
      errors,
      diagnostics,
      environment,
      get proc() {
        return proc!;
      },
      get session() {
        return session!;
      },
      get steerAccepted() {
        return steerAccepted;
      },
      get commandResult() {
        return commandResult;
      },
      nativeId: id,
      message: waitForMessage,
      output(text: string) {
        return waitForMessage(
          (message) =>
            message.type === "assistant" &&
            JSON.stringify(message).includes(text),
        );
      },
      async idle() {
        if (proc!.state.type === "idle") return;
        if (proc!.state.type === "terminated")
          throw Error("Native owner terminated before idle");
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = proc!.subscribe(() => {
            if (proc!.state.type === "idle") {
              unsubscribe();
              resolve();
            } else if (proc!.state.type === "terminated") {
              unsubscribe();
              reject(Error("Native owner terminated before idle"));
            }
          });
        });
      },
      async history() {
        const r = await reader();
        try {
          return await r.getSession(id(), toUrlProjectId(project));
        } finally {
          await r.close?.();
        }
      },
      async source() {
        const namespace = await adapter.getNewSessionNamespace!(project);
        const r = await reader();
        try {
          const filePath = await r.getSessionFilePath?.(id());
          if (!filePath)
            throw Error("Native reader did not locate the persisted session");
          return {
            native: {
              family: namespace.family,
              id: parseNativeSessionId(id()),
              storageScope: namespace.storageScope,
            },
            projectId: toUrlProjectId(project),
            filePath,
          };
        } finally {
          await r.close?.();
        }
      },
      async restart(launch: Partial<StartSessionOptions> = {}) {
        await stop();
        await start(launch);
      },
      stop,
      async nativeRows() {
        const result: unknown[] = [];
        async function scan(directory: string) {
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          }).catch(() => [])) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await scan(path);
            else if (entry.name.endsWith(".jsonl")) {
              const lines = (await readFile(path, "utf8")).split("\n");
              for (const [index, line] of lines.entries()) {
                if (!line) continue;
                try {
                  result.push(JSON.parse(line));
                } catch (error) {
                  if (index !== lines.length - 1) throw error;
                }
              }
            }
          }
        }
        await scan(
          isClaude(provider) ? paths.claudeSessionsDir : paths.codexSessionsDir,
        );
        return result;
      },
      close() {
        if (!closing) closing = dispose();
        return closing;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
