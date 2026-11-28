import type { GitWorktreeSubscriptionEvent } from "@yep-anywhere/shared";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectWorktreeSubscriptionManager } from "../../src/projects/projectWorktreeSubscriptionManager.js";
import {
  cleanupSubscriptions,
  handleUnsubscribe,
  handleWorktreeSubscribe,
  type SendFn,
} from "../../src/routes/ws-relay-handlers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const projectId = toUrlProjectId("/project");
const coverage = { tracked: true, untracked: true, ignored: false };
const snapshot: GitWorktreeSubscriptionEvent = {
  type: "git-worktree-snapshot",
  generation: { epoch: "epoch-a", sequence: 0 },
  coverage,
  headSha: "head-a",
  baseSha: "base-a",
  files: [],
  truncated: false,
  timestamp: "2026-08-19T00:00:00.000Z",
};

function message() {
  return {
    type: "subscribe" as const,
    subscriptionId: "worktree-1",
    channel: "worktree" as const,
    projectId,
    coverage,
  };
}

describe("WebSocket worktree subscriptions", () => {
  it("rejects subscriptions while live monitoring is disabled", () => {
    const manager = {
      isEnabled: vi.fn(() => false),
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    handleWorktreeSubscribe(subscriptions, message(), send, manager);

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(subscriptions.size).toBe(0);
    expect(send).toHaveBeenCalledWith({
      type: "response",
      id: "worktree-1",
      status: 503,
      body: { error: "Live worktree monitoring is disabled" },
    });
  });

  it("validates coverage before acquiring a manager lease", () => {
    const manager = {
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    handleWorktreeSubscribe(
      subscriptions,
      { ...message(), coverage: { tracked: true } as typeof coverage },
      send,
      manager,
    );

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(subscriptions.size).toBe(0);
    expect(send).toHaveBeenCalledWith({
      type: "response",
      id: "worktree-1",
      status: 400,
      body: { error: "Valid coverage required for worktree channel" },
    });
  });

  it("normalizes expanded prefixes and adds their ancestors", async () => {
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: Promise.resolve(), release })),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();

    handleWorktreeSubscribe(
      subscriptions,
      {
        ...message(),
        coverage: {
          ...coverage,
          expandedPrefixes: ["src/nested", "notes"],
          filesystemScan: "complete",
        },
      },
      vi.fn<SendFn>(),
      manager,
    );
    await Promise.resolve();

    expect(manager.subscribe).toHaveBeenCalledWith(
      projectId,
      {
        ...coverage,
        expandedPrefixes: ["notes", "src", "src/nested"],
        filesystemScan: "complete",
      },
      expect.any(Function),
    );
    cleanupSubscriptions(subscriptions);
  });

  it.each([
    ["absolute", ["/src"]],
    ["escaping", ["src/../secret"]],
    ["Git metadata", ["src/.GIT/objects"]],
    ["backslash", ["src\\nested"]],
    ["empty segment", ["src//nested"]],
    ["Windows drive", ["C:/src"]],
    ["non-string", [42]],
  ])("rejects %s expanded prefixes", (_label, expandedPrefixes) => {
    const manager = {
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    handleWorktreeSubscribe(
      subscriptions,
      {
        ...message(),
        coverage: {
          ...coverage,
          expandedPrefixes: expandedPrefixes as unknown as string[],
        },
      },
      send,
      manager,
    );

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "response",
      id: "worktree-1",
      status: 400,
      body: { error: "Valid coverage required for worktree channel" },
    });
  });

  it("rejects expanded-prefix lists above the protocol bound", () => {
    const manager = {
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const send = vi.fn();

    handleWorktreeSubscribe(
      new Map(),
      {
        ...message(),
        coverage: {
          ...coverage,
          expandedPrefixes: Array.from(
            { length: 257 },
            (_, index) => `directory-${index}`,
          ),
        },
      },
      send,
      manager,
    );

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("rejects an unknown filesystem scan policy", () => {
    const manager = {
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const send = vi.fn();

    handleWorktreeSubscribe(
      new Map(),
      {
        ...message(),
        coverage: {
          ...coverage,
          filesystemScan: "everything",
        } as typeof coverage,
      },
      send,
      manager,
    );

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("rejects a filesystem scan policy without expanded prefixes", () => {
    const manager = {
      subscribe: vi.fn(),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const send = vi.fn();

    handleWorktreeSubscribe(
      new Map(),
      {
        ...message(),
        coverage: { ...coverage, filesystemScan: "complete" },
      },
      send,
      manager,
    );

    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("sends connected before a buffered initial snapshot", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(
        (
          _projectId: typeof projectId,
          _requestedCoverage: typeof coverage,
          listener: (event: GitWorktreeSubscriptionEvent) => void,
        ) => {
          listener(snapshot);
          return { ready: pending.promise, release };
        },
      ),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const sent: unknown[] = [];

    handleWorktreeSubscribe(
      subscriptions,
      message(),
      (event) => sent.push(event),
      manager,
    );
    expect(sent).toEqual([]);
    pending.resolve(undefined);
    await pending.promise;
    await Promise.resolve();

    expect(manager.subscribe).toHaveBeenCalledWith(
      projectId,
      coverage,
      expect.any(Function),
    );
    expect(sent).toMatchObject([
      { type: "event", eventType: "connected", eventId: "0" },
      {
        type: "event",
        eventType: "git-worktree-snapshot",
        eventId: "1",
        data: snapshot,
      },
    ]);

    handleUnsubscribe(subscriptions, {
      type: "unsubscribe",
      subscriptionId: "worktree-1",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a pending subscription when its socket closes", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: pending.promise, release })),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    handleWorktreeSubscribe(subscriptions, message(), send, manager);
    cleanupSubscriptions(subscriptions);
    expect(release).toHaveBeenCalledOnce();

    pending.resolve(undefined);
    await pending.promise;
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("maps a missing project readiness failure to 404 and releases", async () => {
    const pending = deferred<void>();
    const release = vi.fn();
    const manager = {
      subscribe: vi.fn(() => ({ ready: pending.promise, release })),
    } as unknown as ProjectWorktreeSubscriptionManager;
    const subscriptions = new Map<string, () => void>();
    const send = vi.fn();

    handleWorktreeSubscribe(subscriptions, message(), send, manager);
    pending.reject(new Error("Project not found"));
    await expect(pending.promise).rejects.toThrow("Project not found");
    await Promise.resolve();

    expect(release).toHaveBeenCalledOnce();
    expect(subscriptions.has("worktree-1")).toBe(false);
    expect(send).toHaveBeenCalledWith({
      type: "response",
      id: "worktree-1",
      status: 404,
      body: { error: "Project not found" },
    });
  });
});
