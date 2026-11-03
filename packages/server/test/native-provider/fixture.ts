import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { toUrlProjectId, type SteeringMode } from "@yep-anywhere/shared";
import { standaloneYaEnvironment } from "../../../client/e2e/support/standalone-environment.js";
import {
  ClaudeProvider,
  resolveClaudeSdkNativeExecutable,
} from "../../src/sdk/providers/claude.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { Process } from "../../src/supervisor/Process.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import type { AgentSession } from "../../src/sdk/providers/types.js";
import { modelServer } from "./model-server.js";

export const nativeProviders = ["claude", "codex"] as const;
export type NativeProvider = (typeof nativeProviders)[number];
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const repoPackage = JSON.parse(
  await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
);

function codexExecutable() {
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : undefined;
  const suffix = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  }[process.platform as "darwin" | "linux" | "win32"];
  if (!arch || !suffix)
    throw Error(
      `Native Codex tests are not qualified on ${process.platform}/${process.arch}`,
    );
  // A nested test dependency keeps the Codex bin off YA development PATH.
  const fromTestTools = createRequire(
    require.resolve("@yep-anywhere/native-test-executables/package.json"),
  );
  const fromCodex = createRequire(
    fromTestTools.resolve("@openai/codex/package.json"),
  );
  const platformPackage = fromCodex.resolve(
    `@openai/codex-${process.platform}-${process.arch}/package.json`,
  );
  return join(
    dirname(platformPackage),
    "vendor",
    `${arch}-${suffix}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

export async function nativeFixture(
  provider: NativeProvider,
  mode: SteeringMode = "gentle",
) {
  const root = await mkdtemp(join(tmpdir(), "ya-native-provider-"));
  const profile = join(root, "profile"),
    project = join(root, "project");
  const paths = {
    tempDir: root,
    profileDir: profile,
    dataDir: join(profile, "ya"),
    claudeSessionsDir: join(profile, "claude", "projects"),
    codexSessionsDir: join(profile, "codex", "sessions"),
    geminiSessionsDir: join(profile, "gemini", "tmp"),
  };
  const model = await modelServer(
    provider === "claude" ? "anthropic" : "responses",
  );
  let proc: Process | undefined;
  let session: AgentSession | undefined;
  const environment = standaloneYaEnvironment(
    paths,
    join(root, "runtime"),
    false,
    {
      ANTHROPIC_API_KEY: "owned-model-stub-only",
      OPENAI_API_KEY: "owned-model-stub-only",
      ANTHROPIC_BASE_URL: model.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      HTTP_PROXY: model.url,
      HTTPS_PROXY: model.url,
      ALL_PROXY: model.url,
      NO_PROXY: "127.0.0.1,localhost,::1",
    },
  );
  // The adapters read process env; every case owns and restores that entire boundary.
  for (const name of new Set([
    ...Object.keys(process.env),
    ...Object.keys(environment),
  ]))
    vi.stubEnv(name, environment[name]);
  try {
    await mkdir(project, { recursive: true });
    await mkdir(environment.CODEX_HOME!, { recursive: true });
    await writeFile(join(project, "notes.txt"), "OWNED_TOOL_CONTENT\n");
    await writeFile(
      join(environment.CODEX_HOME!, "config.toml"),
      `model_provider = "owned_fixture"\n[model_providers.owned_fixture]\nname = "Owned local model"\nbase_url = "${model.url}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n[analytics]\nenabled = false\n`,
    );
    const executable =
      provider === "claude"
        ? resolveClaudeSdkNativeExecutable()
        : codexExecutable();
    if (!executable)
      throw Error(
        `Missing required real ${provider} executable; install workspace optional dependencies`,
      );
    const version = (
      await exec(executable, ["--version"], {
        cwd: project,
        env: environment,
        timeout: 5000,
      })
    ).stdout.trim();
    const expected =
      provider === "claude"
        ? repoPackage.yepAnywhere.claudeCode.compatibleThroughVersion
        : repoPackage.yepAnywhere.codexCli.expectedVersion;
    if (!version.split(/\s+/).includes(expected))
      throw Error(
        `Native ${provider} version mismatch: expected ${expected}; got ${version}`,
      );
    if (provider === "claude") vi.stubEnv("CLAUDE_CODE_EXECUTABLE", executable);
    const adapter =
      provider === "claude"
        ? new ClaudeProvider()
        : new CodexProvider({
            codexPath: executable,
            codexHome: environment.CODEX_HOME,
          });
    if (adapter instanceof CodexProvider)
      adapter.setSteeringModeGetter(() => mode);
    session = await adapter.startSession({
      cwd: project,
      model: provider === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol",
      permissionMode: "bypassPermissions",
      initialMessage: {
        text: "INITIAL_NATIVE_INPUT",
        uuid: "11111111-1111-4111-8111-111111111111",
      },
    });
    const nativeSession = session;
    const events: SDKMessage[] = [];
    const errors: Error[] = [];
    let resolveSteer!: (accepted: boolean) => void;
    const steerAccepted = new Promise<boolean>((resolve) => {
      resolveSteer = resolve;
    });
    proc = new Process(session.iterator, {
      sessionId: randomUUID(),
      projectPath: project,
      projectId: toUrlProjectId(project),
      provider,
      queue: session.queue,
      pid: () =>
        typeof nativeSession.pid === "function"
          ? nativeSession.pid()
          : nativeSession.pid,
      abortFn: session.abort,
      interruptFn: session.interrupt,
      steerFn: session.steer
        ? async (message) => {
            const accepted = await nativeSession.steer!(message);
            resolveSteer(accepted);
            return accepted;
          }
        : undefined,
      steerUsesMessageQueue: session.steerUsesMessageQueue,
      isProcessAlive: session.isProcessAlive,
      probeLivenessFn: session.probeLiveness,
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
    function waitForMessage(matches: (message: SDKMessage) => boolean) {
      if (events.some(matches)) return Promise.resolve();
      if (errors.length || proc!.state.type === "terminated")
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
    let closing: Promise<void> | undefined;
    return {
      provider,
      version,
      root,
      project,
      model,
      proc,
      events,
      errors,
      steerAccepted,
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
                  // Only an unfinished final writer frame is allowed.
                  if (index !== lines.length - 1) throw error;
                }
              }
            }
          }
        }
        await scan(
          provider === "claude"
            ? paths.claudeSessionsDir
            : paths.codexSessionsDir,
        );
        return result;
      },
      close() {
        return (closing ??= (async () => {
          try {
            await proc!.abort();
          } finally {
            try {
              await model.close();
            } finally {
              try {
                await rm(root, { recursive: true, force: true });
              } finally {
                vi.unstubAllEnvs();
              }
            }
          }
        })());
      },
    };
  } catch (error) {
    try {
      if (proc) await proc.abort();
      else await session?.abort();
    } finally {
      try {
        await model.close();
      } finally {
        try {
          await rm(root, { recursive: true, force: true });
        } finally {
          vi.unstubAllEnvs();
        }
      }
    }
    throw error;
  }
}
