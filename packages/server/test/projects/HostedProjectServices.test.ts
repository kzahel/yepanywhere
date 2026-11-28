import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { ProviderRuntimeHost } from "../../../../scripts/provider-runtime-host.mjs";
import { HostedProjectServices } from "../../src/projects/HostedProjectServices.js";
import { ProjectServiceManager } from "../../src/projects/ProjectServiceManager.js";
import { proxyLoopbackVhost } from "../../src/artifacts/vhost-proxy.js";
import { ArtifactServer } from "../../src/artifacts/ArtifactServer.js";
import { ProjectAppDelivery } from "../../src/artifacts/ProjectAppDelivery.js";
import { ProjectAppStore } from "../../src/projects/ProjectAppStore.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { probeSessionSandboxAvailability } from "../../src/session-sandbox.js";
import {
  closeProviderRuntimeHostRegistration,
  initializeProviderRuntimeHost,
} from "../../src/sdk/providers/provider-runtime-host.js";

const sandboxAvailable =
  (await probeSessionSandboxAvailability()).state === "available";

it.skipIf(!sandboxAvailable).each(["shutdown", "worker-loss"])(
  "keeps the same sandbox app across controller replacement and cleans up on %s",
  {
    timeout: 30_000,
  },
  async (termination) => {
    const root = await realpath(
      await mkdtemp(
        join(
          resolve(import.meta.dirname, "../../../../.artifacts"),
          "hosted-app-",
        ),
      ),
    );
    const runtimeDir = await mkdtemp(join(tmpdir(), "ya-app-host-"));
    const dataDir = join(root, "data");
    const project = join(root, "project");
    const controlSocketPath = join(runtimeDir, "control.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir,
      controlSocketPath,
      token: "app-test-token",
    });
    const appStore = new ProjectAppStore(dataDir);
    const artifactServers: ArtifactServer[] = [];
    const deliveryFor = (services: HostedProjectServices) => {
      const artifacts = new ArtifactServer(
        { port: 4402, localOrigin: "http://artifacts.localhost:4402" },
        createLocalResourcePathPolicy({ allowedPaths: [project] }),
        { stateDir: join(dataDir, "artifacts") },
      );
      artifactServers.push(artifacts);
      const delivery = new ProjectAppDelivery(artifacts, services, appStore);
      artifacts.setProjectAppDelivery(delivery);
      return { artifacts, delivery };
    };
    try {
      await mkdir(join(project, ".project-template"), { recursive: true });
      await writeFile(
        join(project, ".project-template/app.json"),
        JSON.stringify({
          service: {
            version: 1,
            where: { kind: "process", cwd: ".", entry: "/" },
            start: { argv: [process.execPath, "server.mjs"], portEnv: "PORT" },
            status: {
              probe: "http",
              path: "/",
              readyStatus: 200,
              startupTimeoutMs: 5000,
            },
            stop: { signal: "SIGTERM", graceMs: 1000 },
            serving: {
              target: "sandbox-loopback",
              protocol: "http",
            },
          },
        }),
      );
      await writeFile(
        join(project, "server.mjs"),
        `import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
appendFileSync('starts.txt', 'started\\n');
createServer((_req, res) => res.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1');
`,
      );
      await host.start();
      vi.stubEnv("YEP_PROVIDER_RUNTIME_SOCKET", controlSocketPath);
      vi.stubEnv("YEP_PROVIDER_RUNTIME_TOKEN", "app-test-token");
      vi.stubEnv("YEP_SERVER_GENERATION", "first-app-controller");
      expect(await initializeProviderRuntimeHost()).toBe(true);
      const first = new HostedProjectServices(dataDir);
      const authorize = vi.fn(async () => {});
      const record = await first.start("app", project, authorize);
      expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
      const original = await first.upstream("app");
      expect(original).not.toBeNull();
      const readApp = async () =>
        (
          await proxyLoopbackVhost(
            new Request("http://app.invalid/"),
            original!.port,
            undefined,
            original!.brokerSocket,
          )
        ).text();
      const pid = await readApp();
      const before = deliveryFor(first);
      const link = await before.delivery.open("app", "local");
      expect(
        await (await before.artifacts.dispatchHost(
          new Request(link.url),
        ))!.text(),
      ).toBe(pid);
      await before.artifacts.close();
      await first.close();
      closeProviderRuntimeHostRegistration();
      vi.stubEnv("YEP_SERVER_GENERATION", "replacement-app-controller");
      expect(await initializeProviderRuntimeHost()).toBe(true);
      const replacement = new HostedProjectServices(dataDir);
      expect(await replacement.status("app")).toMatchObject({
        generation: record.generation,
        observed: "running",
        owner: "provider-host",
      });
      expect(await replacement.upstream("app")).toEqual(original);
      expect(await readApp()).toBe(pid);
      const after = deliveryFor(replacement);
      await after.delivery.ready;
      expect(
        await (await after.artifacts.dispatchHost(
          new Request(link.url),
        ))!.text(),
      ).toBe(pid);
      const ordinary = new ProjectServiceManager(dataDir);
      await expect(
        ordinary.start("app", project, async () => {}),
      ).rejects.toThrow("provider host");
      await expect(ordinary.stop("app", async () => {})).rejects.toThrow(
        "provider hosting",
      );
      await expect(
        replacement.stop("app", async () => {
          throw new Error("Revoked");
        }),
      ).rejects.toThrow("Revoked");
      let checks = 0;
      const revoked = new HTTPException(403, {
        message: "Revoked while queued",
      });
      await expect(
        replacement.stop("app", async () => {
          if (++checks > 1) throw revoked;
        }),
      ).rejects.toBe(revoked);
      expect(await readApp()).toBe(pid);
      await replacement.stop("app", async () => {});
      expect(await replacement.upstream("app")).toBeNull();
      expect(await readFile(join(project, "starts.txt"), "utf8")).toBe(
        "started\n",
      );
      await replacement.start("app", project, async () => {});
      const finalUpstream = await replacement.upstream("app");
      if (termination === "worker-loss") {
        const child = host.projectServices.child;
        assert.ok(child);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await host.projectServices.cleanup;
        await expect(replacement.status("app")).rejects.toThrow(
          "App worker exited",
        );
      }
      await host.shutdown();
      expect(
        (
          await proxyLoopbackVhost(
            new Request("http://app.invalid/"),
            finalUpstream!.port,
            undefined,
            finalUpstream!.brokerSocket,
          )
        ).status,
      ).toBe(502);
      const saved = new ProjectServiceManager(dataDir, "provider-host");
      // Either way the app still wants to run, so opening it relaunches it.
      expect(await saved.status("app")).toMatchObject({
        observed: "stopped",
        desired: "running",
      });
      expect(await readFile(join(project, "starts.txt"), "utf8")).toBe(
        "started\nstarted\n",
      );
    } finally {
      closeProviderRuntimeHostRegistration();
      await host.shutdown();
      for (const artifacts of artifactServers) await artifacts.close();
      await appStore.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true });
      await rm(runtimeDir, { recursive: true });
    }
  },
);
