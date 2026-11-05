import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachOrStartProviderHost } from "../../../../scripts/attach-or-start-provider-host.mjs";
import { InstallService } from "../../../server/src/services/InstallService.js";
import { toUrlProjectId } from "../../../shared/src/index.js";
import { stopProviderHostRuntime } from "./provider-host-runtime.js";
import {
  startYaServerProcess,
  restartYaServerProcess,
  disposeYaServerProcess,
  type StartYaServerProcessOptions,
} from "./ya-server-process.js";

/** Own every server, provider process and storage root used for fault injection. */
export async function createCodexCreationFixture(
  hosted: boolean,
  independentHost = false,
  inputs: NodeJS.ProcessEnv = {},
  options: Pick<StartYaServerProcessOptions, "serveBuiltClient"> = {},
) {
  let projectId = "",
    gate = "",
    requestsFile = "";
  const env: NodeJS.ProcessEnv = {
    USE_MOCK_SDK: "false",
    OPENAI_API_KEY: "owned-fixture-only",
    ENABLED_PROVIDERS: "codex",
    ...inputs,
  };
  let server = await startYaServerProcess({
    label: "owned creation recovery",
    serveBuiltClient: options.serveBuiltClient,
    standalone: { providerHostEnabled: hosted && !independentHost },
    serverExecutable: process.env.YA_STANDALONE_TEST_RUNTIME,
    env,
    async setupProfile(paths) {
      const cwd = join(paths.profileDir, "project");
      await mkdir(cwd);
      projectId = toUrlProjectId(await realpath(cwd));
      gate = join(paths.profileDir, "release");
      requestsFile = join(paths.profileDir, "requests.jsonl");
      const cli = join(paths.profileDir, "owned-codex.mjs");
      Object.assign(env, {
        YEP_DESKTOP_CODEX_CLI_PATH: cli,
        YEP_E2E_CREATION_CWD: await realpath(cwd),
        YEP_E2E_CREATION_NATIVE_FILE: join(
          await realpath(paths.codexSessionsDir),
          "rollout-019a0000-cccc-7ccc-8ccc-cccccccccccc.jsonl",
        ),
        YEP_E2E_CREATION_REQUESTS: requestsFile,
        YEP_E2E_CREATION_GATE: gate,
      });
      await writeFile(
        cli,
        `#!${process.execPath}\n${await readFile(new URL("./fixtures/creation-codex.mjs", import.meta.url), "utf8")}`,
        { mode: 0o755 },
      );
      const install = new InstallService({ dataDir: paths.dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["codex"]);
      await writeFile(
        join(paths.dataDir, "onboarding.json"),
        JSON.stringify({ complete: true }),
      );
    },
  });
  try {
    if (independentHost) {
      // The test coordinator owns the host lease, like the dev wrapper. macOS
      // auto-bootstrap deliberately ends its host when that Hono launcher dies.
      const result = await attachOrStartProviderHost({
        env: { ...server.restartEnv, YEP_PROVIDER_HOST_ENABLED: "true" },
        projectRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
      });
      if (result.state !== "started")
        throw new Error("Owned independent host did not start");
      server.restartEnv.YEP_PROVIDER_HOST_ENABLED = "true";
      server = await restartYaServerProcess(server);
    }
  } catch (error) {
    await disposeYaServerProcess(server);
    throw error;
  }
  return {
    projectId,
    get server() {
      return server;
    },
    request(path: string, body?: unknown) {
      return fetch(`${server.baseUrl}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async requests() {
      return (await readFile(requestsFile, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async launches(): Promise<string[][]> {
      return (
        await readFile(`${requestsFile}.launches`, "utf8").catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    releaseCompactBoundary: () =>
      writeFile(`${gate}.compact-boundary`, "release"),
    releaseCompactCompletion: () =>
      writeFile(`${gate}.compact-completion`, "release"),
    releaseFork: () => writeFile(`${gate}.fork`, "release"),
    releaseAck: () => writeFile(`${gate}.ack`, "release"),
    releaseBinding: () => writeFile(`${gate}.binding`, "release"),
    releaseReply: () => writeFile(`${gate}.reply`, "release"),
    async crashServer() {
      const child = server.process;
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Owned Hono process is not live");
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      // Signal exactly this owned Hono process, preserving detached host workers.
      process.kill(child.pid, "SIGKILL");
      await exited;
    },
    async loseHost() {
      await stopProviderHostRuntime(
        server.restartEnv.YEP_PROVIDER_HOST_RUNTIME_DIR!,
      );
    },
    async restart() {
      server = await restartYaServerProcess(server);
    },
    async close() {
      await disposeYaServerProcess(server);
    },
  };
}
