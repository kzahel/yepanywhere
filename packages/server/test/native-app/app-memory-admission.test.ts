import { expect, it } from "vitest";
import { appBarrier } from "../native-provider/app-fixture.js";
import { nativeAppTestFixture } from "./fixture.js";

it("refuses a second Claude runtime before it can reach the model and admits a new launch after verified exit", async (context) => {
  const fixture = await nativeAppTestFixture("claude", context, {
    agentApiManagement: true,
    providerMemoryLimitMiB: 896,
  });
  await fixture.ready();
  const { project } = await fixture.api("/projects", { path: fixture.project });
  const base = `${fixture.baseUrl}/v0/servers/self`;
  function command(path: string, body: unknown, key = crypto.randomUUID()) {
    return fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Yep-Anywhere": "true",
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      expect(response.status).toBe(202);
      return response.json();
    });
  }
  async function receipt(id: string, state: string) {
    return appBarrier(async () => {
      const response = await fetch(`${base}/receipts/${id}`);
      const result = await response.json();
      if (state !== "failed" && result.state === "failed")
        throw new Error(
          `Unexpected refusal: ${JSON.stringify(result.failure)}`,
        );
      return result.state === state ? result : false;
    }, `receipt state ${state}`);
  }
  const request = {
    projectId: project.id,
    provider: "claude",
    model: "claude-haiku-5-5",
    permissionMode: "bypassPermissions",
    prompt: "Scripted memory-admission test",
  };

  const first = await command("/sessions", request);
  const [firstTurn, accepted] = await Promise.all([
    fixture.model.next(),
    receipt(first.id, "accepted"),
  ]);

  const key = crypto.randomUUID();
  const second = await command("/sessions", request, key);
  const refused = await receipt(second.id, "failed");
  expect(refused.failure.code).toBe("capacity_unavailable");
  expect((await command("/sessions", request, key)).id).toBe(second.id);
  expect(await fixture.inventory()).toHaveLength(1);
  expect(fixture.model.requests).toHaveLength(1);

  firstTurn.finish("First response");
  const stop = await command(`/sessions/${accepted.sessionId}/stop`, {});
  expect((await receipt(stop.id, "accepted")).result.verifiedStopped).toBe(
    true,
  );
  expect(await fixture.inventory()).toHaveLength(0);

  const third = await command("/sessions", request);
  const [thirdTurn] = await Promise.all([
    fixture.model.next(),
    receipt(third.id, "accepted"),
  ]);
  thirdTurn.finish("Third response");
  // macOS reached the first model request at 4.4s and exhausted a 5s guard.
}, 20_000);
