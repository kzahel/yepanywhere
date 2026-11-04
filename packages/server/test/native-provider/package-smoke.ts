/** Installed-package acceptance. Only model responses are scripted. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { standaloneYaEnvironment } from "../../../client/e2e/support/standalone-environment.js";
import {
  captureLeaderStartTime,
  terminateChildProcess,
} from "../../../client/e2e/support/process-lifecycle.js";
import { modelServer, syntheticKey } from "./model-server.js";
import { readOwnedFile } from "./actions.js";

const exec = promisify(execFile);
const packageDir = resolve(process.argv[2]!);
const expectedVersion = process.argv[3];
assert.ok(
  expectedVersion,
  "Pass installed package directory and expected version",
);
const startupOnly = process.argv.includes("--startup-only");
const reportFile = process.argv
  .find((arg) => arg.startsWith("--report="))
  ?.slice(9);
const manifest = JSON.parse(
  await readFile(join(packageDir, "package.json"), "utf8"),
);
assert.equal(manifest.name, "yepanywhere");
assert.equal(manifest.version, expectedVersion);
const repoPackage = JSON.parse(
  await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
);
const started = performance.now();
const report: Record<string, unknown> = {
  version: expectedVersion,
  node: process.version,
  providers: [],
};
const logs: string[] = [];

// Same 30s cold-start budget as the existing package probe, also bounding each
// native/HTTP/WS action. Cleanup uses the existing identity-checked tree owner.
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function profile(label: string, inputs: NodeJS.ProcessEnv = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `ya-package-${label}-`)),
  );
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    const paths = {
      tempDir: root,
      profileDir: home,
      dataDir: join(home, "ya"),
      claudeSessionsDir: join(home, "claude", "projects"),
      codexSessionsDir: join(home, "codex", "sessions"),
      geminiSessionsDir: join(home, ".gemini", "tmp"),
    };
    // A small platform allowlist also excludes arbitrary inherited credentials,
    // package-manager hooks and proxies. The shared scrubber owns all profile roots.
    const platform = Object.fromEntries(
      [
        "PATH",
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
      ].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    const env = standaloneYaEnvironment(
      paths,
      join(root, "runtime"),
      false,
      {
        ENABLED_PROVIDERS: "claude",
        VOICE_INPUT: "false",
        ...inputs,
      },
      platform,
    );
    // Exercise production host discovery, including the scriptless npm fallback.
    // Neither the mock SDK nor an explicit host-disable override is allowed.
    delete env.YEP_PROVIDER_HOST_ENABLED;
    delete env.USE_MOCK_SDK;
    await mkdir(project, { recursive: true });
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(env.CODEX_HOME!, { recursive: true });
    await writeFile(
      join(paths.dataDir, "server-settings.json"),
      JSON.stringify({ version: 1, settings: { codexUpdatePolicy: "off" } }),
    );
    await writeFile(join(project, "notes.txt"), "OWNED_TOOL_CONTENT\n");
    await exec("git", ["init", "--quiet"], {
      cwd: project,
      env,
      timeout: 5000,
    });
    return { root, project, env };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

type Profile = Awaited<ReturnType<typeof profile>>;
async function launch(f: Profile) {
  const portFile = f.env.PORT_FILE!;
  await rm(portFile, { force: true });
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL(
        "../../../client/e2e/support/offline-update-check.mjs",
        import.meta.url,
      ).href,
      resolve(packageDir, manifest.bin.yepanywhere),
    ],
    {
      cwd: f.root,
      env: f.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-32_768);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((resolveClose) =>
    child.once("close", () => resolveClose()),
  );
  let identity: string | undefined;
  const stop = async () => {
    await terminateChildProcess(child, "installed npm server", identity);
    await bounded(closed, "server stdio close");
    logs.push(output);
  };
  const running = () => {
    assert.ok(
      !spawnError && child.exitCode === null && child.signalCode === null,
      `Installed server exited: ${spawnError ?? child.exitCode}\n${output}`,
    );
  };
  try {
    identity = child.pid ? await captureLeaderStartTime(child.pid) : undefined;
    const deadline = Date.now() + 30_000;
    let baseUrl = "";
    while (Date.now() < deadline) {
      running();
      try {
        const port = (await readFile(portFile, "utf8")).trim();
        if (/^\d+$/.test(port) && Number(port) > 0) {
          baseUrl = `http://127.0.0.1:${port}`;
          const response = await fetch(`${baseUrl}/api/version`, {
            signal: AbortSignal.timeout(1000),
          });
          assert.equal(response.status, 200);
          const version = await response.json();
          assert.equal(version.current, expectedVersion);
          assert.notEqual(
            version.providerHostDegraded,
            true,
            `providerHostDegraded: ${JSON.stringify(version)}`,
          );
          assert.deepEqual(version.sqlite, { state: "ready" });
          assert.doesNotMatch(
            output,
            /provider.host.*(?:failed|failure)|ERR_MODULE_NOT_FOUND.*provider-runtime/i,
          );
          return { baseUrl, stop, output: () => output };
        }
      } catch (error) {
        if (
          !(error instanceof TypeError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as Error).name !== "TimeoutError"
        )
          throw error;
      }
      await delay(50);
    }
    throw Error(`Installed package startup timed out: ${baseUrl}`);
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `Startup and cleanup failed\n${output}`,
      );
    }
    throw new Error(`${error}\n${output}`, { cause: error });
  }
}

type Server = Awaited<ReturnType<typeof launch>>;
async function request(server: Server, path: string, body?: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${JSON.stringify(result)}`,
  );
  return result;
}

async function socket(server: Server, sessionId?: string) {
  const ws = new WebSocket(`${server.baseUrl.replace("http:", "ws:")}/api/ws`);
  const events: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => {
    events.push(JSON.parse(String(event.data)));
    for (const wake of waiters) wake();
  });
  const wait = (matches: (event: Record<string, unknown>) => boolean) =>
    bounded(
      new Promise<void>((resolveWait, reject) => {
        const check = () => {
          const error = events.find(
            (event) =>
              event.type === "error" ||
              event.eventType === "error" ||
              (event.type === "response" && Number(event.status) >= 400),
          );
          if (error) {
            waiters.delete(check);
            reject(Error(JSON.stringify(error)));
          } else if (events.some(matches)) {
            waiters.delete(check);
            resolveWait();
          }
        };
        waiters.add(check);
        check();
      }),
      "WebSocket event",
    );
  try {
    await bounded(
      new Promise<void>((resolveOpen, reject) => {
        ws.addEventListener("open", () => resolveOpen(), { once: true });
        ws.addEventListener("error", () => reject(Error("WebSocket failed")), {
          once: true,
        });
      }),
      "WebSocket open",
    );
    if (sessionId)
      ws.send(
        JSON.stringify({
          type: "subscribe",
          subscriptionId: "package-smoke",
          channel: "session",
          sessionId,
        }),
      );
    else {
      ws.send(JSON.stringify({ type: "ping" }));
      await wait((event) => event.type === "pong");
    }
    return { ws, events, wait };
  } catch (error) {
    ws.close();
    throw error;
  }
}

async function productionStartup() {
  const f = await profile("startup");
  try {
    const server = await launch(f);
    try {
      const connection = await socket(server);
      connection.ws.close();
      report.startup = "passed";
      console.log(
        "Installed production startup passed (no credentials, normal provider-host decision)",
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}

async function providerScenario(provider: "claude" | "codex") {
  const codexExecutable =
    provider === "codex"
      ? (await import("./runtimes.js")).nativeExecutable("codex")
      : undefined;
  const model = await modelServer(
    provider === "claude" ? "anthropic" : "responses",
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
  let f: Profile | undefined,
    server: Server | undefined,
    connection: Awaited<ReturnType<typeof socket>> | undefined;
  const startedProvider = performance.now();
  try {
    f = await profile(provider, {
      ENABLED_PROVIDERS: provider,
      [provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]:
        syntheticKey,
      ANTHROPIC_BASE_URL: model.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      HTTP_PROXY: model.url,
      HTTPS_PROXY: model.url,
      ALL_PROXY: model.url,
      http_proxy: model.url,
      https_proxy: model.url,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      ...(provider === "codex"
        ? { YEP_DESKTOP_CODEX_CLI_PATH: codexExecutable }
        : {}),
    });
    const installed = createRequire(join(packageDir, "package.json"));
    const sdk = createRequire(
      installed.resolve("@anthropic-ai/claude-agent-sdk"),
    );
    const executable =
      provider === "codex"
        ? f.env.YEP_DESKTOP_CODEX_CLI_PATH!
        : sdk.resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
          );
    const version = (
      await exec(executable, ["--version"], {
        env: f.env,
        cwd: f.root,
        timeout: 5000,
      })
    ).stdout.trim();
    // npm resolves the published SDK range independently of the source lockfile.
    // Exercise its installed bundled CLI; the deeper native suite stays pinned.
    const sdkVersion = JSON.parse(
      await readFile(
        join(
          dirname(installed.resolve("@anthropic-ai/claude-agent-sdk")),
          "package.json",
        ),
        "utf8",
      ),
    ).version;
    if (provider === "codex") {
      const expected = repoPackage.yepAnywhere.codexCli.expectedVersion;
      assert.ok(
        version.split(/\s+/).includes(expected),
        `${provider}: expected ${expected}; got ${version}`,
      );
    } else assert.match(version, /^\d+\.\d+\.\d+ \(Claude Code\)$/);
    await writeFile(
      join(f.env.CODEX_HOME!, "config.toml"),
      `model_provider = "owned_fixture"\n[model_providers.owned_fixture]\nname = "Owned local model"\nbase_url = "${model.url}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n[analytics]\nenabled = false\n`,
    );
    server = await launch(f);
    const { project } = await request(server, "/api/projects", {
      path: f.project,
    });
    const prompt = `PACKAGE_${provider.toUpperCase()}_INPUT`;
    const reply = `PACKAGE_${provider.toUpperCase()}_REPLY`;
    const receipt = await request(
      server,
      `/api/projects/${project.id}/session-creations`,
      {
        requestId: `package-${provider}-creation`,
        provider,
        message: prompt,
        model: provider === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol",
        mode: "bypassPermissions",
      },
    );
    assert.ok(receipt.sessionId, JSON.stringify(receipt));
    const initial = await bounded(
      model.next(),
      `${provider} initial model request`,
    );
    assert.ok(JSON.stringify(initial.body).includes(prompt));
    assert.ok(!JSON.stringify(initial.body).includes("OWNED_TOOL_CONTENT"));
    connection = await socket(server, receipt.sessionId);
    readOwnedFile(provider, f.project, initial);
    const afterTool = await bounded(model.next(), `${provider} real file tool`);
    assert.ok(JSON.stringify(afterTool.body).includes("OWNED_TOOL_CONTENT"));
    afterTool.partial(reply);
    await connection.wait(
      (event) =>
        event.type === "event" && JSON.stringify(event.data).includes(reply),
    );
    afterTool.finish("");
    await connection.wait(
      (event) =>
        event.type === "event" &&
        event.eventType === "message" &&
        JSON.stringify(event.data).includes('"type":"result"'),
    );
    const terminal = connection.events
      .map(
        (event) =>
          event.data as
            | { type?: string; is_error?: boolean; subtype?: string }
            | undefined,
      )
      .find((data) => data?.type === "result");
    assert.ok(terminal, "Missing native terminal result");
    assert.notEqual(terminal.is_error, true, JSON.stringify(terminal));
    assert.ok(!terminal.subtype?.startsWith("error"), JSON.stringify(terminal));
    assert.deepEqual(model.failures, []);
    assert.equal(model.requests.length, 2);
    const detailPath = `/api/projects/${project.id}/sessions/${receipt.sessionId}`;
    // A completed live projection is insufficient: restart the real server and
    // read native history through the same public URL and production readers.
    connection.ws.close();
    connection = undefined;
    await server.stop();
    server = undefined;
    server = await launch(f);
    const detail = await request(server, detailPath);
    const history = JSON.stringify(detail);
    for (const text of [prompt, reply, "OWNED_TOOL_CONTENT"])
      assert.ok(
        history.includes(text),
        `Missing persisted ${text}: ${history}`,
      );
    assert.deepEqual(model.failures, []);
    assert.equal(
      model.requests.length,
      2,
      "Reading persisted history must not start inference",
    );
    (report.providers as unknown[]).push({
      provider,
      version,
      ...(provider === "claude" ? { sdkVersion } : {}),
      milliseconds: Math.round(performance.now() - startedProvider),
      requests: model.requests.length,
      blockedConnections: model.blockedConnections,
    });
    console.log(
      `Installed ${provider} API/tool/stream/restart/history passed (${version})`,
    );
  } catch (error) {
    logs.push(
      JSON.stringify({
        provider,
        requests: model.requests.map((r) => r.body),
        failures: model.failures,
        events: connection?.events,
      }).slice(-32_768),
    );
    throw error;
  } finally {
    connection?.ws.close();
    try {
      await server?.stop();
    } finally {
      await model.close();
      if (f) await rm(f.root, { recursive: true, force: true });
    }
  }
}

try {
  await productionStartup();
  if (!startupOnly)
    for (const provider of ["claude", "codex"] as const)
      await providerScenario(provider);
  report.milliseconds = Math.round(performance.now() - started);
  if (reportFile) {
    await writeFile(`${reportFile}.log`, logs.join("\n"));
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  console.error(logs.join("\n"));
  if (reportFile)
    await writeFile(
      `${reportFile}.failure.log`,
      `${error}\n${logs.join("\n")}`,
    );
  throw error;
}
