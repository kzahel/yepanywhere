import { request } from "node:http";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
  createAgentApiRuntime,
  type AgentApiRuntime,
} from "../src/agent-api/runtime.js";
import { SUPERUSER } from "../src/auth/principal.js";
import { serverAgentApiAdmission } from "../src/server-agent-api-admission.js";
import {
  beginServerShutdown,
  drainServerRequests,
  finishServerRestart,
  holdQueueRecoveryAdmission,
  serverAdmissionMiddleware,
  setServerRestartHandler,
} from "../src/server-restart-control.js";

function sendAgentInput(
  runtime: AgentApiRuntime,
  token: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(runtime.baseUrl);
    const req = request(
      {
        socketPath: runtime.socketPath,
        hostname: url.hostname,
        port: url.port,
        path: "/v0/servers/self/sessions/owner/inputs",
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          "Idempotency-Key": "restart-input-0001",
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify({ type: "prompt", text: "continue" }));
  });
}

it("fences real provider HTTP ingress and joins agent/browser writes before restart", async () => {
  let releaseBrowser!: () => void;
  let browserEntered!: () => void;
  let releaseAgent!: () => void;
  let agentEntered!: () => void;
  const browserHeld = new Promise<void>((resolve) => {
    releaseBrowser = resolve;
  });
  const browserStarted = new Promise<void>((resolve) => {
    browserEntered = resolve;
  });
  const agentHeld = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });
  const agentStarted = new Promise<void>((resolve) => {
    agentEntered = resolve;
  });
  const read = vi.fn(async () => {
    agentEntered();
    await agentHeld;
    return { id: "admitted-input" };
  });
  const runtime = await createAgentApiRuntime({ serverId: "restart-test" });
  const lease = runtime.issue({
    principal: SUPERUSER,
    sessionId: () => "owner",
    management: true,
  });
  runtime.attachController({
    serverId: runtime.serverId,
    read: serverAgentApiAdmission(read),
  });
  const app = new Hono();
  app.use("*", serverAdmissionMiddleware);
  app.post("/write", async (c) => {
    browserEntered();
    await browserHeld;
    return c.json({ saved: true });
  });
  try {
    holdQueueRecoveryAdmission(true);
    expect(
      await sendAgentInput(
        runtime,
        lease.environment.AGENT_YA_V0_AUTHORIZATION!,
      ),
    ).toBe(503);
    expect(read).not.toHaveBeenCalled();
    expect(await drainServerRequests()).toBe(true);
    holdQueueRecoveryAdmission(false);
    const agentWrite = sendAgentInput(
      runtime,
      lease.environment.AGENT_YA_V0_AUTHORIZATION!,
    );
    const browserWrite = app.request("/write", { method: "POST" });
    await Promise.all([agentStarted, browserStarted]);
    beginServerShutdown();
    let drained = false;
    const drain = drainServerRequests().then((result) => {
      drained = result;
    });
    expect((await app.request("/write", { method: "POST" })).status).toBe(503);
    expect(
      await sendAgentInput(
        runtime,
        lease.environment.AGENT_YA_V0_AUTHORIZATION!,
      ),
    ).toBe(503);
    releaseBrowser();
    expect((await browserWrite).status).toBe(200);
    expect(drained).toBe(false); // The provider's admitted write is still pending.
    releaseAgent();
    expect(await agentWrite).toBe(202);
    await drain;
    expect(drained).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    const restart = vi.fn();
    setServerRestartHandler(restart);
    finishServerRestart(0);
    expect(restart).toHaveBeenCalledOnce();
  } finally {
    releaseAgent();
    releaseBrowser();
    lease.dispose();
    await runtime.close();
  }
});
