import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";
import { createNetworkGate } from "../../client/e2e/lifecycle-study/network-gate.mjs";
import { startFixture } from "../../mobile-core/scripts/fixture.mjs";

export async function startRecoveryFixture() {
  const { createRelayServer } = await tsImport(
    "../../relay/src/server.ts",
    import.meta.url,
  );
  const dataDir = await mkdtemp(join(tmpdir(), "ya-ios-relay-"));
  const startRelay = (port) =>
    createRelayServer({
      port,
      dataDir,
      disableTelemetry: true,
      disablePrettyPrint: true,
      logLevel: "error",
    });
  let relay, fixture, direct, mux, control;
  const stop = async () => {
    if (control) {
      control.closeAllConnections();
      await new Promise((done) => control.close(done));
    }
    await Promise.all([direct?.close(), mux?.close()]);
    await fixture?.stop();
    await relay?.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    relay = await startRelay(0);
    const relayPort = relay.port;
    fixture = await startFixture({
      relayURL: `ws://127.0.0.1:${relayPort}/ws`,
    });
    const host = `http://127.0.0.1:${fixture.port}`;
    const projects = await (await fetch(host + "/api/projects")).json();
    const samples = join(projects.projects[0].path, "ios-preview");
    await mkdir(samples);
    const previewPath = join(samples, "report.html");
    await Promise.all([
      writeFile(previewPath, "<title>Report</title>"),
      writeFile(
        join(samples, "report.js"),
        "document.documentElement.dataset.script = 'loaded'",
      ),
      writeFile(join(samples, "report.css"), "body { color: rgb(12, 34, 56) }"),
      writeFile(join(samples, "values.json"), JSON.stringify({ value: 42 })),
    ]);
    direct = await createNetworkGate(fixture.port);
    mux = await createNetworkGate(relayPort);
    const token = randomUUID();
    control = createServer(async (request, response) => {
      const [, key, route, action] = request.url.split("/");
      const gate = route === "direct" ? direct : route === "mux" ? mux : null;
      if (key !== token || request.method !== "POST" || !gate) {
        response.writeHead(404).end();
        return;
      }
      try {
        let result;
        if (["pass", "refuse", "silent"].includes(action)) gate.setMode(action);
        else if (action === "disconnect") gate.disconnect();
        else if (action === "stop-relay" && route === "mux" && relay) {
          await relay.close();
          relay = undefined;
        } else if (action === "start-relay" && route === "mux" && !relay) {
          relay = await startRelay(relayPort);
        } else if (action === "append") {
          const update = await fetch(host + "/__probe/append", {
            method: "POST",
          });
          if (!update.ok) throw new Error("Fixture append failed");
          result = await update.json();
        } else if (action !== "status") {
          response.writeHead(400).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result ?? gate.snapshot()));
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise((done, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", done);
    });
    const deadline = Date.now() + 30000;
    while (!relay.connectionManager.getActiveServers().length) {
      if (Date.now() > deadline)
        throw new Error("Fixture did not register at the relay");
      await pause(100);
    }
    return {
      stop,
      config: {
        control: `http://127.0.0.1:${control.address().port}/${token}`,
        direct: `ws://127.0.0.1:${direct.port}/api/ws`,
        mux: `ws://127.0.0.1:${mux.port}/ws`,
        previewPath,
        sessionPath: `/projects/${projects.projects[0].id}/sessions/android-preview-session`,
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
