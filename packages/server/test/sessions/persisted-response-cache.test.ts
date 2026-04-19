import { describe, expect, it, vi } from "vitest";
import {
  buildPersistedSessionResponseCacheKey,
  getOrLoadPersistedSessionResponse,
  getPersistedSessionResponse,
  primePersistedSessionResponse,
} from "../../src/sessions/persisted-response-cache.js";

describe("persisted session response cache", () => {
  it("dedupes concurrent loads for the same cache key", async () => {
    const cacheKey = buildPersistedSessionResponseCacheKey({
      projectId: "proj-1",
      sessionId: "sess-1",
      provider: "claude",
      updatedAt: "2026-04-19T00:00:00.000Z",
      messageCount: 2,
      tailCompactions: 1,
      maxMessages: 300,
    });
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        session: {
          id: "sess-1",
          projectId: "proj-1",
          title: "hello",
          fullTitle: "hello",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z",
          messageCount: 2,
          ownership: { owner: "none" },
          provider: "claude",
          messages: [],
        },
        messages: [],
      };
    });

    const [first, second] = await Promise.all([
      getOrLoadPersistedSessionResponse(cacheKey, loader),
      getOrLoadPersistedSessionResponse(cacheKey, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.session.id).toBe("sess-1");
    expect(second.session.id).toBe("sess-1");
  });

  it("returns cloned payloads so callers cannot mutate cache", () => {
    const cacheKey = buildPersistedSessionResponseCacheKey({
      projectId: "proj-2",
      sessionId: "sess-2",
      provider: "claude",
      updatedAt: "2026-04-19T00:00:00.000Z",
      messageCount: 1,
    });

    primePersistedSessionResponse(cacheKey, {
      session: {
        id: "sess-2",
        projectId: "proj-2",
        title: "world",
        fullTitle: "world",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z",
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "claude",
        messages: [],
      },
      messages: [],
    });

    const cached = getPersistedSessionResponse(cacheKey);
    if (!cached) {
      throw new Error("cache miss");
    }

    cached.session.title = "mutated";

    const again = getPersistedSessionResponse(cacheKey);
    expect(again?.session.title).toBe("world");
  });
});
