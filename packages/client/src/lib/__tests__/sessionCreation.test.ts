import { beforeEach, expect, it, vi } from "vitest";
import {
  acceptSessionCreation,
  pendingSessionCreation,
} from "../sessionCreation";

beforeEach(() => localStorage.clear());
it("retries unchanged intent with the original key and exact wire metadata after pre-arrival failure", async () => {
  const calls: Array<{ path: string; body?: string }> = [];
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    calls.push({ path, body: options?.body as string | undefined });
    if (calls.length <= 2)
      throw new Error("owned request/recovery interruption");
    const body = JSON.parse(options!.body as string);
    return {
      requestId: body.requestId,
      sessionId: "saved-public",
      projectId: "project",
      provider: "codex",
      creation: {
        state: "saved",
        attemptId: "attempt",
        delivery: "not-admitted",
        updatedAt: "now",
      },
      serverTimestamp: 200,
    };
  });
  const transport = { fetch } as unknown as Parameters<
    typeof acceptSessionCreation
  >[0];
  await expect(
    acceptSessionCreation(
      transport,
      "owned-key",
      "project",
      "same input",
      { provider: "codex" },
      100,
      {
        clientTimestamp: 100,
        composition: { submittedAt: "2026-11-01T00:00:00Z" },
      },
    ),
  ).rejects.toThrow("interruption");
  const original = pendingSessionCreation("owned-key")!;
  await expect(
    acceptSessionCreation(
      transport,
      "owned-key",
      "project",
      "same input",
      { provider: "codex" },
      500,
      {
        clientTimestamp: 500,
        composition: { submittedAt: "2026-11-02T00:00:00Z" },
      },
    ),
  ).resolves.toMatchObject({ requestId: original.requestId });
  expect(calls[0]!.body).toBe(calls[2]!.body);
  const count = calls.length;
  await expect(
    acceptSessionCreation(
      transport,
      "owned-key",
      "project",
      "same input",
      { provider: "codex" },
      900,
      { turnEffort: "fast" },
    ),
  ).rejects.toThrow("earlier unconfirmed creation");
  expect(calls).toHaveLength(count);
});

it("recovers an accepted lost reply by read without issuing a second creation", async () => {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "POST") throw new Error("lost reply");
    return {
      requestId: path.split("/").pop(),
      sessionId: "saved-public",
      projectId: "project",
    };
  });
  const transport = { fetch } as unknown as Parameters<
    typeof acceptSessionCreation
  >[0];
  await expect(
    acceptSessionCreation(
      transport,
      "owned-key",
      "project",
      "same input",
      {},
      100,
    ),
  ).resolves.toMatchObject({ sessionId: "saved-public" });
  await acceptSessionCreation(
    transport,
    "owned-key",
    "project",
    "same input",
    {},
    300,
  );
  expect(
    fetch.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
});
