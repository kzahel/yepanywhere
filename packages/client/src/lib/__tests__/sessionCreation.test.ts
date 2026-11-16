import { beforeEach, expect, it, vi } from "vitest";
import {
  acceptSessionCreation,
  forgetSessionCreation,
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
  ).rejects.toThrow("earlier request is still unconfirmed");
  expect(calls).toHaveLength(count);
});

type Transport = Parameters<typeof acceptSessionCreation>[0];
const receipt = (requestId: unknown) => ({
  requestId,
  sessionId: `session-${requestId}`,
  projectId: "project",
});

it.each([
  ["a transport outage", () => new Error("Failed to fetch")],
  [
    "an untagged refusal",
    () => Object.assign(new Error("no"), { status: 403 }),
  ],
  [
    "a deleted operation",
    () => Object.assign(new Error("gone"), { status: 410 }),
  ],
])(
  "starts fresh after %s without replaying the unconfirmed request",
  async (_name, failure) => {
    let down = true;
    const posts: Array<{ requestId: string; message: string }> = [];
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => {
      if (down)
        throw options?.method === "POST"
          ? failure()
          : Object.assign(new Error("Not found"), { status: 404 });
      const body = JSON.parse(options!.body as string);
      posts.push(body);
      return receipt(body.requestId);
    });
    const transport = { fetch } as unknown as Transport;
    const send = (message: string) =>
      acceptSessionCreation(transport, "owned-key", "project", message, {}, 1);
    await expect(send("first")).rejects.toThrow();
    const stuck = pendingSessionCreation("owned-key")!;
    down = false;
    await expect(send("corrected")).rejects.toThrow("Start fresh");
    expect(posts).toHaveLength(0);

    forgetSessionCreation("owned-key");
    expect(pendingSessionCreation("owned-key")).toBeNull();
    await expect(send("corrected")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(posts.map((body) => body.message)).toEqual(["corrected"]);
    expect(posts[0]!.requestId).not.toBe(stuck.requestId);
  },
);

it("retries the frozen original after a client update changes only build provenance", async () => {
  const bodies: string[] = [];
  const fetch = vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method !== "POST" || bodies.push(String(options.body)) === 1)
      throw new Error("Failed to fetch");
    return receipt(JSON.parse(String(options.body)).requestId);
  });
  const transport = { fetch } as unknown as Transport;
  const send = (clientVersion: string) =>
    acceptSessionCreation(
      transport,
      "owned-key",
      "project",
      "same input",
      {
        provider: "codex",
        creationProvenance: { surface: "web", clientVersion },
      },
      1,
    );
  await expect(send("95ce327")).rejects.toThrow("Failed to fetch");
  await send("e46f01a");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});

it("sends when the saved record is unreadable or storage refuses the write", async () => {
  const fetch = vi.fn(async (_path: string, options?: RequestInit) =>
    receipt(JSON.parse(String(options!.body)).requestId),
  );
  const transport = { fetch } as unknown as Transport;
  for (const damaged of [
    "{not json",
    JSON.stringify({ requestId: "old", payload: "{", clientTimestamp: 1 }),
    JSON.stringify({ requestId: "old", payload: "null", clientTimestamp: 1 }),
  ]) {
    localStorage.setItem("owned-key", damaged);
    expect(pendingSessionCreation("owned-key")).toBeNull();
    await acceptSessionCreation(transport, "owned-key", "p", "new", {}, 1);
    forgetSessionCreation("owned-key");
  }
  const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  try {
    await expect(
      acceptSessionCreation(transport, "owned-key", "p", "new", {}, 1),
    ).resolves.toMatchObject({ projectId: "project" });
  } finally {
    full.mockRestore();
  }
  expect(fetch).toHaveBeenCalledTimes(4);
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
