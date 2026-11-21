import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext, vi } from "vitest";
import { receiptSchema } from "../../src/core-api/command-contracts.js";
import { nativeAppTestFixture } from "./fixture.js";

async function verifyMemoryAdmission(context: TestContext) {
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
      signal: context.signal,
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
  async function receipt(id: string, state: "accepted" | "failed") {
    const result = await vi.waitFor(
      async () => {
        const response = await fetch(`${base}/receipts/${id}`, {
          signal: context.signal,
        });
        expect(response.status).toBe(200);
        const current = receiptSchema.parse(await response.json());
        expect(current.state, `Receipt ${id}`).toMatch(
          /^(accepted|failed|uncertain)$/,
        );
        return current;
      },
      { timeout: 12_000 },
    );
    expect(result.state, JSON.stringify(result)).toBe(state);
    return result;
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
  expect(refused.failure?.code).toBe("capacity_unavailable");
  expect((await command("/sessions", request, key)).id).toBe(second.id);
  const firstWorkers = await fixture.inventory();
  expect(firstWorkers).toHaveLength(1);
  const [worker] = firstWorkers;
  expect(fixture.model.requests).toHaveLength(1);

  firstTurn.finish("First response");
  const stop = await command(`/sessions/${accepted.sessionId}/stop`, {});
  const stopped = await receipt(stop.id, "accepted");
  expect(stopped.result?.verifiedStopped).toBe(true);
  // Inventory hides closing workers while the host still charges their groups.
  const descriptorPath = join(fixture.root, "host", "host.json");
  const workerGroups = new Set([
    worker!.pid,
    ...worker!.providerProcessGroupIds,
  ]);
  await expect
    .poll(
      async () => {
        const { processGroups } = JSON.parse(
          await readFile(descriptorPath, "utf8"),
        );
        return processGroups.filter(
          ({ processGroupId }: { processGroupId: number }) =>
            workerGroups.has(processGroupId),
        );
      },
      { timeout: 8_000 },
    )
    .toEqual([]);
  expect(await fixture.inventory()).toHaveLength(0);

  const third = await command("/sessions", request);
  const [thirdTurn] = await Promise.all([
    fixture.model.next(),
    receipt(third.id, "accepted"),
  ]);
  thirdTurn.finish("Third response");
}

it.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "refuses a second Claude runtime before it can reach the model and admits a new launch after verified exit",
  verifyMemoryAdmission,
  // Hosted CI reached 20s during cold startup and verified teardown.
  45_000,
);
