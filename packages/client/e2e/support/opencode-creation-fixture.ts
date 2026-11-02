import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InstallService } from "../../../server/src/services/InstallService.js";
import { toUrlProjectId } from "../../../shared/src/index.js";
import {
  startYaServerProcess,
  restartYaServerProcess,
  disposeYaServerProcess,
} from "./ya-server-process.js";

/** Isolated native HTTP/SSE, storage, controller and optional host ownership. */
export async function createOpenCodeCreationFixture(
  hosted = false,
  inputs: NodeJS.ProcessEnv = {},
) {
  let projectId = "",
    gate = "",
    requestsFile = "";
  const env: NodeJS.ProcessEnv = {
    USE_MOCK_SDK: "false",
    ENABLED_PROVIDERS: "opencode",
    ...inputs,
  };
  let server = await startYaServerProcess({
    label: "owned OpenCode creation",
    standalone: { providerHostEnabled: hosted },
    serverExecutable: process.env.YA_STANDALONE_TEST_RUNTIME,
    env,
    async setupProfile(paths) {
      const project = join(paths.profileDir, "project"),
        bin = join(paths.profileDir, ".opencode", "bin");
      await mkdir(project);
      await mkdir(bin, { recursive: true });
      projectId = toUrlProjectId(await realpath(project));
      gate = join(paths.profileDir, "release");
      requestsFile = join(paths.profileDir, "requests.jsonl");
      Object.assign(env, {
        YEP_E2E_OPENCODE_GATE: gate,
        YEP_E2E_OPENCODE_REQUESTS: requestsFile,
      });
      await writeFile(
        join(bin, "opencode"),
        `#!${process.execPath}\n${await readFile(new URL("./fixtures/creation-opencode.mjs", import.meta.url), "utf8")}`,
        { mode: 0o755 },
      );
      const install = new InstallService({ dataDir: paths.dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["opencode"]);
      await writeFile(
        join(paths.dataDir, "onboarding.json"),
        JSON.stringify({ complete: true }),
      );
    },
  });
  return {
    projectId,
    get server() {
      return server;
    },
    request(path: string, body?: unknown) {
      return fetch(server.baseUrl + "/api" + path, {
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
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    releaseStream: () => writeFile(gate + ".stream", "release"),
    releaseReply: () => writeFile(gate + ".reply", "release"),
    async restart() {
      server = await restartYaServerProcess(server);
    },
    async crashServer() {
      const child = server.process;
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Owned Hono is not live");
      const done = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      process.kill(child.pid, "SIGKILL");
      await done;
    },
    async close() {
      await disposeYaServerProcess(server);
    },
  };
}
