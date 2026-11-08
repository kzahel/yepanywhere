import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentAuthRouterRoutes } from "../src/routes/agent-auth-router.js";
import { routerFixtureFor } from "./utils/agent-auth-router-fixture.js";
import { closeTestDiscoveryDatabases } from "./utils/session-metadata-database.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  closeTestDiscoveryDatabases();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = routerFixtureFor(cleanups);
const POOL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

async function setup() {
  const f = await fixture(true);
  await f.connector.connect(f.socketPath);
  const abort = vi.fn(async (_sessionId: string) => null);
  let process: object | undefined = {
    provider: "codex",
    resolvedModel: "fixture-model",
  };
  const app = new Hono().route(
    "/api",
    createAgentAuthRouterRoutes(f.connector, () => ({
      getProcessForSession: () => process as never,
      abortSessionWithVerification: abort,
    })),
  );
  const switchTo = (sessionId: string, body: object) =>
    app.request(`/api/agent-auth-router/sessions/${sessionId}/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const routed = async (sessionId: string) => {
    await f.connector.launch(
      sessionId,
      "codex",
      "fixture-model",
      undefined,
      POOL,
      "round-robin",
    );
    return f.metadata.getMetadata(sessionId)!.routerBinding!;
  };
  const cancelled = () =>
    f.requests
      .filter((r) => r.path === "/v1/bindings/cancel")
      .map((r) => r.body.id);
  return {
    f,
    abort,
    switchTo,
    routed,
    cancelled,
    noProcess: () => {
      process = undefined;
    },
  };
}

describe.skipIf(process.platform === "win32")("router account switch", () => {
  it("commits the new pin before killing the process, then cancels the old one", async () => {
    const { f, abort, switchTo, routed, cancelled } = await setup();
    const old = await routed("s");
    const response = await switchTo("s", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { routerBinding } = (await response.json()) as {
      routerBinding: { id: string };
    };
    expect(routerBinding.id).not.toBe(old.id);
    expect(f.metadata.getMetadata("s")?.routerBinding).toMatchObject({
      id: routerBinding.id,
      accountId: "account",
      poolId: POOL,
    });
    const paths = f.requests.map((r) => r.path);
    expect(paths.lastIndexOf("/v1/bindings/commit")).toBeLessThan(
      paths.lastIndexOf("/v1/bindings/cancel"),
    );
    expect(
      f.requests.filter((r) => r.path === "/v1/pools/prepare").at(-1)?.body,
    ).toMatchObject({ policy: "manual", accountId: "account" });
    expect(abort).toHaveBeenCalledWith("s");
    expect(cancelled()).toEqual([old.id]);
    // The next message resumes on the new pin.
    await expect(
      f.connector.launch("s", "codex", "fixture-model"),
    ).resolves.toMatchObject({ bindingId: routerBinding.id });
  });

  it("leaves the pin and process alone when the router refuses", async () => {
    const { f, abort, switchTo, routed, cancelled } = await setup();
    const old = await routed("s");
    f.rejectPoolPrepare("account exhausted");
    const response = await switchTo("s", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("account exhausted");
    expect(f.metadata.getMetadata("s")?.routerBinding?.id).toBe(old.id);
    expect(abort).not.toHaveBeenCalled();
    expect(cancelled()).not.toContain(old.id);
    f.acceptPoolPrepare();
    await expect(
      f.connector.launch("s", "codex", "fixture-model"),
    ).resolves.toMatchObject({ bindingId: old.id });
  });

  it("moves to Direct and back, saving the concrete model for the router", async () => {
    const { f, abort, switchTo, routed, cancelled } = await setup();
    const old = await routed("s");
    const direct = await switchTo("s", { direct: true });
    expect(await direct.json()).toEqual({ routerBinding: null });
    expect(f.metadata.getMetadata("s")?.routerBinding).toBeUndefined();
    expect(cancelled()).toEqual([old.id]);
    await expect(
      f.connector.launch("s", "codex", "fixture-model"),
    ).resolves.toBeUndefined();

    await f.metadata.setProvider("s", "codex");
    await f.metadata.setRequestedModel("s", "default");
    const back = await switchTo("s", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(f.metadata.getMetadata("s")?.routerBinding?.poolId).toBe(POOL);
    expect(f.metadata.getRequestedModel("s")).toBe("fixture-model");
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("refuses a process that started on the old pin and registers after the switch", async () => {
    const { f, switchTo, routed } = await setup();
    await routed("s");
    // A resume obtained the old pin's token before the switch ran.
    const late = await f.connector.launch("s", "codex", "fixture-model");
    expect(f.connector.switchedAway(late)).toBeUndefined();
    await switchTo("s", { routerPoolId: POOL, routerAccountId: "account" });
    expect(f.connector.switchedAway(late)?.message).toContain(
      "switched router accounts while it was starting",
    );
    // That start's failure cleanup must not cancel the switched-in pin.
    const current = f.metadata.getMetadata("s")!.routerBinding!;
    await f.connector.cancel("s");
    expect(
      f.requests.some(
        (r) => r.path === "/v1/bindings/cancel" && r.body.id === current.id,
      ),
    ).toBe(false);
  });

  it("cancels the new allocation when a reply is lost, keeping the old pin", async () => {
    const { f, abort, switchTo, routed, cancelled } = await setup();
    const old = await routed("s");
    f.loseCommit();
    const response = await switchTo("s", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(response.status).toBe(409);
    expect(f.metadata.getMetadata("s")?.routerBinding?.id).toBe(old.id);
    expect(abort).not.toHaveBeenCalled();
    const ids = cancelled();
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(old.id);
  });

  it("uses the current pin's model when no process reports one", async () => {
    const { f, switchTo, routed, noProcess } = await setup();
    await routed("s");
    noProcess();
    await f.metadata.setRequestedModel("s", "default");
    const response = await switchTo("s", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.metadata.getRequestedModel("s")).toBe("fixture-model");
  });

  it("refuses malformed targets and sessions that cannot be routed", async () => {
    const { f, switchTo } = await setup();
    expect((await switchTo("s", { routerPoolId: POOL })).status).toBe(400);
    expect(
      (await switchTo("s", { direct: true, routerPoolId: POOL })).status,
    ).toBe(400);
    expect((await switchTo("missing", { direct: true })).status).toBe(404);
    await f.metadata.setProvider("x", "codex");
    await f.metadata.setExecutor("x", "remote");
    const refused = await switchTo("x", {
      routerPoolId: POOL,
      routerAccountId: "account",
    });
    expect(refused.status).toBe(409);
  });
});
