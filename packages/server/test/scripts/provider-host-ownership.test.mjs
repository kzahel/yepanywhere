import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requestProviderHost } from "../../../../scripts/provider-runtime-discovery.mjs";
import { processGroupAlive } from "../../../../scripts/provider-process-identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
async function waitFor(fn) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Ownership barrier timed out");
}

describe.skipIf(!["linux", "darwin"].includes(process.platform))(
  "provider host terminal ownership",
  () => {
    it.each([
      "wrapper-loss",
      "foreground",
      ...(process.platform === "darwin" ? ["source-owner"] : []),
    ])(
      "reaps only the tree owned by %s",
      async (mode) => {
        const directory = await mkdtemp(
          join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ya-owner-"),
        );
        const runtime = join(directory, "host");
        const bin = join(directory, "bin");
        const events = join(directory, "events.jsonl");
        await mkdir(bin);
        await copyFile(
          join(here, "fixtures/dev-wrapper-child.mjs"),
          join(bin, "pnpm"),
        );
        await chmod(join(bin, "pnpm"), 0o755);
        const env = {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          PORT: "3498",
          YA_TEST_WRAPPER_EVENTS: events,
          YEP_PROVIDER_HOST_ENABLED: "true",
          YEP_PROVIDER_HOST_RUNTIME_DIR: mode === "source-owner" ? "" : runtime,
          ...(mode === "source-owner"
            ? { YEP_PROVIDER_RUNTIME_DIR: runtime }
            : {}),
          YEP_PROVIDER_RUNTIME_WORKER_PATH: join(
            here,
            "../sdk/providers/fixtures/fake-provider-runtime-worker.mjs",
          ),
        };
        const children = [];
        let output = "";
        const start = (args) => {
          const child = spawn(process.execPath, args, {
            cwd: root,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.on("data", (c) => {
            output += c;
          });
          child.stderr.on("data", (c) => {
            output += c;
          });
          children.push(child);
          return child;
        };
        const descriptor = async () =>
          JSON.parse(await readFile(join(runtime, "host.json"), "utf8"));
        let worker;
        let cleanupError;
        try {
          let owner;
          if (mode === "foreground") {
            owner = start([
              join(root, "scripts/provider-runtime-host.mjs"),
              "--headless",
            ]);
            await waitFor(descriptor);
          }
          const wrapper =
            mode === "source-owner"
              ? start([
                  "--input-type=module",
                  "-e",
                  `import {attachOrStartProviderHost} from ${JSON.stringify(join(root, "scripts/attach-or-start-provider-host.mjs"))}; const result = await attachOrStartProviderHost(); if (result.state !== "started") throw new Error(JSON.stringify(result)); setInterval(()=>{},1000);`,
                ])
              : start([join(root, "scripts/dev.js")]);
          const host = await waitFor(descriptor);
          if (mode !== "source-owner")
            await waitFor(
              async () =>
                (await readFile(events, "utf8")).trim().split("\n").length ===
                2,
            );
          const connection = {
            controlSocketPath: host.controlSocketPath,
            token: (await readFile(join(runtime, "token"), "utf8")).trim(),
            protocolVersion: host.hostProtocolVersion,
          };
          worker = await requestProviderHost(
            connection,
            {
              op: "launch",
              auxiliaryOwned: true,
              providerName: "codex",
              projectPath: directory,
              sessionId: "ownership",
              options: {},
            },
            10_000,
          );
          expect(processGroupAlive(worker.processGroupId)).toBe(true);
          wrapper.kill(
            mode === "wrapper-loss" || mode === "source-owner"
              ? "SIGKILL"
              : "SIGTERM",
          );
          await waitFor(
            () => wrapper.exitCode !== null || wrapper.signalCode !== null,
          );
          if (mode === "foreground") {
            expect(
              (await requestProviderHost(connection, { op: "inventory" }))[0]
                .pid,
            ).toBe(worker.pid);
            expect(processGroupAlive(worker.processGroupId)).toBe(true);
            owner.kill("SIGHUP");
          }
          await waitFor(() => !processGroupAlive(worker.processGroupId));
          await waitFor(
            () =>
              !existsSync(join(runtime, "control.sock")) &&
              !existsSync(join(runtime, "host.json")),
          );
        } catch (error) {
          throw new Error(`${error.stack}\n${output}`);
        } finally {
          for (const child of children)
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGTERM");
          await Promise.all(
            children.map((child) =>
              waitFor(
                () => child.exitCode !== null || child.signalCode !== null,
              ).catch(() => child.kill("SIGKILL")),
            ),
          );
          // Fixture backend/frontend descendants have no IPC parent lease; the
          // wrapper-loss case deliberately kills their owner before it can reap them.
          if (existsSync(events))
            for (const event of (await readFile(events, "utf8"))
              .trim()
              .split("\n")
              .map(JSON.parse)) {
              try {
                process.kill(event.pid, "SIGTERM");
              } catch (error) {
                if (error.code !== "ESRCH") cleanupError ??= error;
              }
            }
          if (worker)
            await waitFor(() => !processGroupAlive(worker.processGroupId));
          await rm(directory, { recursive: true, force: true });
        }
        if (cleanupError) throw cleanupError;
      },
      60_000,
    );
  },
);
