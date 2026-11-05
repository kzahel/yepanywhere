import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requestProviderHost } from "../../../../scripts/provider-runtime-discovery.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");

async function readEvents(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function reload({ port, token }) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () =>
      socket.destroy(new Error("reload timed out")),
    );
    let response = "";
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ token, op: "reload" })}\n`),
    );
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        resolveRequest(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// The real shared provider host and its process-group ownership run on Linux and macOS.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "development wrapper reload",
  () => {
    it("builds before replacing the backend and retains the last client on failure", async () => {
      const directory = await mkdtemp(join(tmpdir(), "ya-built-client-test-"));
      const bin = join(directory, "bin");
      const eventsFile = join(directory, "events.jsonl");
      await mkdir(bin);
      await copyFile(
        join(here, "fixtures/dev-wrapper-child.mjs"),
        join(bin, "pnpm"),
      );
      await chmod(join(bin, "pnpm"), 0o755);
      const checkout = join(directory, "checkout");
      await mkdir(join(checkout, "scripts"), { recursive: true });
      await mkdir(join(checkout, "packages/client/src"), { recursive: true });
      await mkdir(join(checkout, "packages/shared"), { recursive: true });
      await writeFile(join(checkout, "package.json"), '{"type":"module"}');
      await writeFile(join(checkout, "packages/client/src/app.js"), "before");
      await copyFile(
        join(root, "scripts/dev.js"),
        join(checkout, "scripts/dev.js"),
      );
      for (const name of [
        "dev-built-client.mjs",
        "dev-instance-provenance.mjs",
        "provider-runtime-discovery.mjs",
        "provider-process-identity.mjs",
        "safe-home.js",
      ]) {
        await symlink(
          join(root, "scripts", name),
          join(checkout, "scripts", name),
        );
      }
      const wrapper = spawn(
        process.execPath,
        [join(checkout, "scripts/dev.js"), "--built-client"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            PORT: "3497",
            YA_TEST_WRAPPER_EVENTS: eventsFile,
            YEP_PROVIDER_HOST_ENABLED: "false",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      wrapper.stdout.on("data", (chunk) => {
        output += chunk;
      });
      wrapper.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const servers = async () =>
        (await readEvents(eventsFile)).filter(
          (event) => event.role === "server",
        );
      try {
        await expect
          .poll(async () => (await servers()).length, { timeout: 10000 })
          .toBe(1);
        const first = (await servers())[0];
        expect(first.nodeEnv).toBe("production");
        expect(
          await readFile(join(first.distPath, "index.html"), "utf8"),
        ).toContain("built");
        const firstAssets = await readdir(join(first.distPath, "assets"));
        await reload(first);
        await expect
          .poll(async () => (await servers()).length, { timeout: 10000 })
          .toBe(2);
        const unchanged = (await servers())[1];
        expect(unchanged.distPath).toBe(first.distPath);
        expect(
          (await readEvents(eventsFile)).filter(
            (event) => event.role === "build",
          ),
        ).toHaveLength(1);
        expect(output).toContain("Reused unchanged bundled client");
        await writeFile(join(checkout, "packages/client/src/app.js"), "after");
        await writeFile(`${eventsFile}.fail`, "fail build");
        await reload(unchanged);
        await expect
          .poll(() => output, { timeout: 10000 })
          .toContain("Client build failed; keeping the running backend");
        expect(await servers()).toHaveLength(2);
        expect(() => process.kill(unchanged.pid, 0)).not.toThrow();
        await rm(`${eventsFile}.fail`);
        await reload(unchanged);
        await expect
          .poll(async () => (await servers()).length, { timeout: 10000 })
          .toBe(3);
        const second = (await servers())[2];
        expect(second.distPath).not.toBe(first.distPath);
        expect(await readdir(join(second.distPath, "assets"))).toEqual(
          expect.arrayContaining(firstAssets),
        );
        expect(() => process.kill(first.pid, 0)).toThrow();
        expect(
          (await readEvents(eventsFile)).some(
            (event) => event.role === "client",
          ),
        ).toBe(false);
        await expect
          .poll(async () => {
            try {
              await readdir(first.distPath);
              return true;
            } catch (error) {
              if (error.code === "ENOENT") return false;
              throw error;
            }
          })
          .toBe(false);
      } catch (error) {
        throw new Error(`${error.message}\n${output}`, { cause: error });
      } finally {
        wrapper.kill("SIGTERM");
        await expect
          .poll(() => wrapper.exitCode ?? wrapper.signalCode, {
            timeout: 10000,
          })
          .not.toBeNull();
        for (const event of await readEvents(eventsFile)) {
          expect(() => process.kill(event.pid, 0)).toThrow();
          if (event.distPath)
            await expect(readdir(event.distPath)).rejects.toMatchObject({
              code: "ENOENT",
            });
        }
        await rm(directory, { recursive: true });
      }
    }, 30000);

    it("keeps provider hosting disabled when explicitly configured", async () => {
      const directory = await mkdtemp(
        join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          "ya-dev-no-provider-host-",
        ),
      );
      const bin = join(directory, "bin");
      const runtime = join(directory, "host");
      const eventsFile = join(directory, "events.jsonl");
      await mkdir(bin);
      await copyFile(
        join(here, "fixtures/dev-wrapper-child.mjs"),
        join(bin, "pnpm"),
      );
      await chmod(join(bin, "pnpm"), 0o755);
      const wrapper = spawn(
        process.execPath,
        [join(root, "scripts/dev.js"), "--no-frontend-reload"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            PORT: "3498",
            YA_TEST_WRAPPER_EVENTS: eventsFile,
            YEP_PROVIDER_HOST_ENABLED: "false",
            YEP_PROVIDER_HOST_RUNTIME_DIR: runtime,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      wrapper.stdout.on("data", (chunk) => {
        output += chunk;
      });
      wrapper.stderr.on("data", (chunk) => {
        output += chunk;
      });
      try {
        await expect
          .poll(async () => (await readEvents(eventsFile)).length, {
            timeout: 10000,
          })
          .toBe(2);
        expect(output).toContain("Provider host: DISABLED");
        expect(() => process.kill(wrapper.pid, 0)).not.toThrow();
        await expect(
          readFile(join(runtime, "host.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } catch (error) {
        throw new Error(`${error.message}\n${output}`, { cause: error });
      } finally {
        wrapper.kill("SIGTERM");
        await expect
          .poll(() => wrapper.exitCode ?? wrapper.signalCode, {
            timeout: 10000,
          })
          .not.toBeNull();
        for (const event of await readEvents(eventsFile)) {
          expect(() => process.kill(event.pid, 0)).toThrow();
        }
        await rm(directory, { recursive: true });
      }
    }, 30000);

    it("replaces frontend and backend while preserving a live provider worker", async () => {
      const directory = await mkdtemp(
        join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          "ya-dev-reload-",
        ),
      );
      const bin = join(directory, "bin");
      const runtime = join(directory, "host");
      const eventsFile = join(directory, "events.jsonl");
      await mkdir(bin);
      await copyFile(
        join(here, "fixtures/dev-wrapper-child.mjs"),
        join(bin, "pnpm"),
      );
      await chmod(join(bin, "pnpm"), 0o755);
      const wrapper = spawn(
        process.execPath,
        [join(root, "scripts/dev.js"), "--no-frontend-reload"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            PORT: "3499",
            YA_TEST_WRAPPER_EVENTS: eventsFile,
            YEP_PROVIDER_HOST_ENABLED: "true",
            YEP_PROVIDER_HOST_RUNTIME_DIR: runtime,
            YEP_PROVIDER_RUNTIME_WORKER_PATH: join(
              here,
              "../sdk/providers/fixtures/fake-provider-runtime-worker.mjs",
            ),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      wrapper.stdout.on("data", (chunk) => {
        output += chunk;
      });
      wrapper.stderr.on("data", (chunk) => {
        output += chunk;
      });
      try {
        await expect
          .poll(async () => (await readEvents(eventsFile)).length, {
            timeout: 10000,
          })
          .toBe(2);
        const before = await readEvents(eventsFile);
        const descriptor = JSON.parse(
          await readFile(join(runtime, "host.json"), "utf8"),
        );
        const connection = {
          controlSocketPath: descriptor.controlSocketPath,
          token: (await readFile(join(runtime, "token"), "utf8")).trim(),
          protocolVersion: descriptor.hostProtocolVersion,
        };
        const worker = await requestProviderHost(
          connection,
          {
            op: "launch",
            auxiliaryOwned: true,
            providerName: "codex",
            projectPath: directory,
            sessionId: "reload-worker",
            options: {},
          },
          5000,
        );
        expect(worker.pid).toBeGreaterThan(1);
        const backend = before.find((event) => event.role === "server");
        const responses = await Promise.all([reload(backend), reload(backend)]);
        expect(responses.every((response) => response.ok)).toBe(true);
        await expect
          .poll(
            async () =>
              (await readEvents(eventsFile)).filter(
                (event) => event.role === "server",
              ).length,
            { timeout: 10000 },
          )
          .toBe(2);
        await expect
          .poll(
            async () =>
              (await readEvents(eventsFile)).filter(
                (event) => event.role === "client",
              ).length,
            { timeout: 2000 },
          )
          .toBe(2);
        const after = await readEvents(eventsFile);
        for (const role of ["server", "client"]) {
          const pids = after
            .filter((event) => event.role === role)
            .map((event) => event.pid);
          expect(new Set(pids).size).toBe(2);
          expect(() => process.kill(pids[0], 0)).toThrow();
        }
        expect(
          JSON.parse(await readFile(join(runtime, "host.json"), "utf8")),
        ).toMatchObject({
          descriptorId: descriptor.descriptorId,
          owner: descriptor.owner,
          startedAt: descriptor.startedAt,
        });
        const inventory = await requestProviderHost(connection, {
          op: "inventory",
        });
        expect(inventory).toEqual([
          expect.objectContaining({
            pid: worker.pid,
            sessionId: "reload-worker",
          }),
        ]);
        expect(() => process.kill(worker.pid, 0)).not.toThrow();
        // A frontend crash must not turn a recoverable reload into provider loss.
        process.kill(
          after.filter((event) => event.role === "client").at(-1).pid,
          "SIGTERM",
        );
        await expect
          .poll(() => output)
          .toContain("backend and provider host remain running");
        expect(wrapper.exitCode ?? wrapper.signalCode).toBeNull();
        wrapper.kill("SIGHUP");
        await expect
          .poll(
            async () =>
              (await readEvents(eventsFile)).filter(
                (event) => event.role === "client",
              ).length,
            { timeout: 10000 },
          )
          .toBe(3);
        expect(
          await requestProviderHost(connection, { op: "inventory" }),
        ).toEqual(inventory);
      } catch (error) {
        throw new Error(`${error.message}\n${output}`, { cause: error });
      } finally {
        wrapper.kill("SIGTERM");
        await expect
          .poll(() => wrapper.exitCode ?? wrapper.signalCode, {
            timeout: 10000,
          })
          .not.toBeNull();
        for (const event of await readEvents(eventsFile)) {
          expect(() => process.kill(event.pid, 0)).toThrow();
        }
        await rm(directory, { recursive: true });
      }
    }, 30000);
  },
);
