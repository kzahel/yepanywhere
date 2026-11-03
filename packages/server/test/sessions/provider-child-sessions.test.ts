import { describe, expect, it, vi } from "vitest";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import {
  attachProviderChildSessions,
  resolveProviderChildSessions,
} from "../../src/sessions/provider-child-sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";
import { toUrlProjectId } from "@yep-anywhere/shared";

const child = {
  id: "child-1",
  parentSessionId: "sess-1",
  title: "Explore the tree",
  updatedAt: "2026-08-16T12:00:00.000Z",
};

describe("resolveProviderChildSessions", () => {
  it("uses the accepted projection when list reads must stay cheap", async () => {
    const listAcceptedProviderChildSessions = vi.fn(() => [child]);
    const listProviderChildSessions = vi.fn(async () => {
      throw new Error("fresh listing should not run");
    });
    const reader = {
      listAcceptedProviderChildSessions,
      listProviderChildSessions,
    };

    await expect(
      resolveProviderChildSessions(reader, "sess-1", "accepted-or-cheap"),
    ).resolves.toEqual([child]);
    expect(listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("omits children when the accepted projection is still cold", async () => {
    const reader = {
      listAcceptedProviderChildSessions: vi.fn(() => undefined),
      listProviderChildSessions: vi.fn(async () => [child]),
    };

    await expect(
      resolveProviderChildSessions(reader, "sess-1", "accepted-or-cheap"),
    ).resolves.toBeUndefined();
    expect(reader.listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("returns a published empty projection without starting a fresh parse", async () => {
    const reader = {
      listAcceptedProviderChildSessions: vi.fn(() => []),
      listProviderChildSessions: vi.fn(async () => {
        throw new Error("fresh listing should not run");
      }),
    };

    await expect(
      resolveProviderChildSessions(reader, "sess-1", "accepted-or-cheap"),
    ).resolves.toEqual([]);
    expect(reader.listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("lists freshly for a single open session", async () => {
    const reader = {
      listAcceptedProviderChildSessions: vi.fn(() => []),
      listProviderChildSessions: vi.fn(async () => [child]),
    };

    await expect(
      resolveProviderChildSessions(reader, "sess-1", "fresh"),
    ).resolves.toEqual([child]);
    expect(reader.listAcceptedProviderChildSessions).not.toHaveBeenCalled();
  });
});

describe("attachProviderChildSessions", () => {
  it("attaches cheap Claude children and skips empty results", async () => {
    const project: Project = {
      id: toUrlProjectId("/tmp/project"),
      path: "/tmp/project",
      name: "project",
      sessionCount: 1,
      sessionDir: "/tmp/project/.claude-sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    const reader = {
      listProviderChildSessions: vi.fn(async (sessionId: string) =>
        sessionId === "sess-1" ? [child] : [],
      ),
    } as unknown as ISessionReader;

    const attached = await attachProviderChildSessions(
      [
        { id: "sess-1", provider: "claude" },
        { id: "sess-2", provider: "claude" },
      ],
      project,
      { readerFactory: () => reader },
      "accepted-or-cheap",
    );

    expect(attached[0]?.providerChildren).toEqual([child]);
    expect(attached[1]?.providerChildren).toBeUndefined();
  });

  it("does not read a different provider when the recorded provider is unavailable", async () => {
    const project: Project = {
      id: toUrlProjectId("/tmp/project"),
      path: "/tmp/project",
      name: "project",
      sessionCount: 1,
      sessionDir: "/tmp/claude",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    const readChildren = vi.fn(async () => [child]);
    const attached = await attachProviderChildSessions(
      [{ id: "sess-1", provider: "codex" as const }],
      project,
      {
        readerFactory: () =>
          ({
            listProviderChildSessions: readChildren,
          }) as unknown as ISessionReader,
      },
      "fresh",
      { codexPaths: new Set(), geminiPaths: new Set() },
    );
    expect(attached[0]?.providerChildren).toBeUndefined();
    expect(readChildren).not.toHaveBeenCalled();
  });

  it("attaches Codex children after the accepted projection publishes", async () => {
    const project: Project = {
      id: toUrlProjectId("/tmp/project"),
      path: "/tmp/project",
      name: "project",
      sessionCount: 1,
      sessionDir: "/tmp/codex-sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };
    let accepted: (typeof child)[] | undefined;
    const reader = {
      listAcceptedProviderChildSessions: vi.fn(() => accepted),
      listProviderChildSessions: vi.fn(async () => {
        throw new Error("list attach must not cold-parse Codex children");
      }),
    } as unknown as ISessionReader;
    const deps = {
      readerFactory: () => reader,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: () => reader as unknown as CodexSessionReader,
    };
    const sessions = [{ id: "sess-1", provider: "codex" as const }];

    const cold = await attachProviderChildSessions(
      sessions,
      project,
      deps,
      "accepted-or-cheap",
    );
    expect(cold[0]?.providerChildren).toBeUndefined();

    accepted = [child];
    const published = await attachProviderChildSessions(
      sessions,
      project,
      deps,
      "accepted-or-cheap",
    );
    expect(published[0]?.providerChildren).toEqual([child]);
    expect(reader.listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("does not overlap cold child scans for sessions from one provider", async () => {
    const project: Project = {
      id: toUrlProjectId("/tmp/project"),
      path: "/tmp/project",
      name: "project",
      sessionCount: 2,
      sessionDir: "/tmp/grok-sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "grok",
    };
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const reader = {
      listProviderChildSessions: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return [];
      }),
    } as unknown as ISessionReader;

    const attached = attachProviderChildSessions(
      [
        { id: "grok-1", provider: "grok" as const },
        { id: "grok-2", provider: "grok" as const },
      ],
      project,
      {
        readerFactory: () => reader,
        grokReaderFactory: () => reader as unknown as GrokSessionReader,
      },
      "accepted-or-cheap",
    );

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await expect(attached).resolves.toHaveLength(2);
    expect(maxActive).toBe(1);
  });
});
