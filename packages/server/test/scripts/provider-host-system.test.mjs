import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requestProviderHost } from "../../../../scripts/provider-runtime-discovery.mjs";
import { processGroupAlive } from "../../../../scripts/provider-process-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(fn, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Assembled provider-host barrier timed out");
}

describe.skipIf(!["linux", "darwin"].includes(process.platform))(
  "assembled production provider worker",
  () => {
    it("retains the original callback, provider and worker across real Hono/wrapper replacement", async () => {
      const directory = await mkdtemp(
        join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ya-system-"),
      );
      const projectPath = join(directory, "project");
      await mkdir(projectPath);
      const port = await freePort();
      const vitePort = await freePort();
      const env = {
        ...process.env,
        NODE_OPTIONS: `--import ${tsxLoader} --import ${join(root, "packages/server/test/scripts/fixtures/provider-host-preload.mjs")}`,
        YA_HOST_TEST_ROOT: directory,
        YEP_DATA_DIR: join(directory, "data"),
        YEP_PROVIDER_HOST_ENABLED: "true",
        YEP_PROVIDER_HOST_RUNTIME_DIR: join(directory, "host"),
        CLAUDE_CONFIG_DIR: join(directory, "claude"),
        CODEX_HOME: join(directory, "codex"),
        ENABLED_PROVIDERS: "claude",
        AUTH_DISABLED: "true",
        PORT: String(port),
        VITE_PORT: String(vitePort),
        MAINTENANCE_PORT: "0",
        VITE_DISABLE_ONBOARDING: "true",
        VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        NO_BACKEND_RELOAD: "true",
        USE_MOCK_SDK: "false",
      };
      for (const name of Object.keys(env))
        if (/^(npm_|PNPM_)/i.test(name)) delete env[name];
      delete env.VITEST;
      delete env.YEP_PROVIDER_RUNTIME_WORKER_PATH;
      const wrapper = spawn(process.execPath, [join(root, "scripts/dev.js")], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      wrapper.stdout.on("data", (c) => {
        output += c;
      });
      wrapper.stderr.on("data", (c) => {
        output += c;
      });
      const api = async (path, body, method) => {
        const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
          method: method ?? (body === undefined ? "GET" : "POST"),
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error(
            `${path}: ${response.status} ${await response.text()}`,
          );
        return response.json();
      };
      const barriers = async () =>
        (await readFile(join(directory, "barriers.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
      let worker;
      try {
        await waitFor(() => api("/version"));
        const project = await api("/projects", { path: projectPath });
        const session = await api(`/projects/${project.project.id}/sessions`, {
          message: "hold",
          provider: "claude",
          mode: "bypassPermissions",
        });
        await waitFor(async () =>
          (await barriers()).find((e) => e.type === "turn-started"),
        );
        const descriptor = JSON.parse(
          await readFile(join(directory, "host/host.json"), "utf8"),
        );
        const connection = {
          controlSocketPath: descriptor.controlSocketPath,
          token: (await readFile(join(directory, "host/token"), "utf8")).trim(),
          protocolVersion: 3,
        };
        const inventory = () =>
          requestProviderHost(connection, { op: "inventory" });
        const before = await inventory();
        worker = before.runtimes?.[0] ?? before[0];
        expect(worker.pid).toBeGreaterThan(1);
        await api(
          `/sessions/${session.sessionId}/mode`,
          { mode: "default" },
          "PUT",
        );
        const oldGeneration = worker.attachedServerGeneration;
        // Stop Hono consumption at the actual detach boundary. The worker emits
        // output and asks for approval while no replacement owns its callback.
        await api("/server/restart", {});
        await waitFor(async () => {
          const list = await inventory();
          return (list.runtimes?.[0] ?? list[0])?.state === "detached";
        });
        await writeFile(join(directory, "emit-detached"), "go");
        await waitFor(async () => {
          const list = await inventory();
          const current = list.runtimes?.[0] ?? list[0];
          return (
            current?.attachedServerGeneration &&
            current.attachedServerGeneration !== oldGeneration
          );
        });
        await waitFor(async () => {
          const value = await api(`/sessions/${session.sessionId}/process`);
          return JSON.stringify(value).includes("waiting-input") && value;
        });
        const pending = (
          await api(`/sessions/${session.sessionId}/pending-input`)
        ).request;
        expect(pending?.id ?? pending?.requestId).toBeTruthy();
        await api(`/sessions/${session.sessionId}/input`, {
          requestId: pending.id ?? pending.requestId,
          response: "approve",
        });
        await waitFor(async () =>
          (await barriers()).find((e) => e.type === "turn-complete"),
        );
        await api(`/sessions/${session.sessionId}/messages`, {
          message: "second turn",
        });
        await waitFor(
          async () =>
            (await barriers()).filter((e) => e.type === "turn-complete")
              .length === 2,
        );
        const facts = await barriers();
        expect(facts.filter((e) => e.type === "provider-started")).toHaveLength(
          1,
        );
        expect(facts.find((e) => e.type === "approval-resolved").pid).toBe(
          worker.pid,
        );
        const after = await inventory();
        expect((after.runtimes?.[0] ?? after[0]).pid).toBe(worker.pid);
        expect(
          facts.filter(
            (e) => e.type === "module" && e.target.endsWith("/src/index.ts"),
          ).length,
        ).toBeGreaterThanOrEqual(2);
      } catch (error) {
        throw new Error(`${error.stack}\n${output.slice(-16000)}`);
      } finally {
        wrapper.kill("SIGTERM");
        await waitFor(
          () => wrapper.exitCode !== null || wrapper.signalCode !== null,
          15_000,
        ).catch(() => wrapper.kill("SIGKILL"));
        if (worker)
          await waitFor(() => !processGroupAlive(worker.processGroupId), 5000);
        expect(existsSync(join(directory, "host/control.sock"))).toBe(false);
        await rm(directory, { recursive: true, force: true });
      }
    }, 150_000);
  },
);
