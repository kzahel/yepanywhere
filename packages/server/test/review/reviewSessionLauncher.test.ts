import { describe, expect, it, vi } from "vitest";
import { createSupervisorReviewLauncher } from "../../src/review/reviewSessionLauncher.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import {
  RouterRefusedBeforeProvider,
  RouterUnavailable,
} from "../../src/services/AgentAuthRouter.js";

describe("createSupervisorReviewLauncher.startReviewSession", () => {
  it("starts with the origin session's provider, model, thinking, and effort", async () => {
    const startSession = vi.fn(async () => ({ sessionId: "new-session" }));
    const supervisor = { startSession } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).startReviewSession("/repo", "turn", {
      provider: "codex",
      model: "gpt-5.4",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });

    expect(result).toEqual({ status: "started", sessionId: "new-session" });
    expect(startSession).toHaveBeenCalledWith(
      "/repo",
      { text: "turn" },
      undefined,
      {
        providerName: "codex",
        model: "gpt-5.4",
        requestedModel: "gpt-5.4",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
      expect.objectContaining({
        creation: expect.objectContaining({
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "api" } },
          },
        }),
      }),
    );
  });

  it("keeps the opening session's router selection, sandbox and tier, with server instructions and compaction", async () => {
    const startSession = vi.fn(async () => ({ sessionId: "new-session" }));
    const supervisor = { startSession } as unknown as Supervisor;
    const sources: Record<string, object> = {
      routed: {
        provider: "claude",
        routerBinding: {
          id: "pin",
          routerId: "router",
          accountId: "acct",
          provider: "claude",
          poolId: "pool",
          policy: "round-robin",
        },
        serviceTier: "priority",
      },
      sandboxed: {
        provider: "codex",
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
      },
    };
    const launcher = createSupervisorReviewLauncher(
      supervisor,
      undefined,
      undefined,
      {
        globalInstructions: () => "be kind",
        compactSettings: () => ({ compactAtContextPercent: 80 }),
        sourceLaunch: (id) => sources[id],
      },
    );
    const settings = async (
      options: Parameters<typeof launcher.startReviewSession>[2],
    ) => {
      startSession.mockClear();
      await launcher.startReviewSession("/repo", "turn", options);
      return (startSession.mock.calls[0] as unknown[])[3];
    };

    // A fresh pick from the pool, never the opening session's pin.
    expect(
      await settings({
        provider: "claude",
        model: "claude-opus-4-8",
        sourceSessionId: "routed",
      }),
    ).toEqual({
      providerName: "claude",
      model: "claude-opus-4-8",
      requestedModel: "claude-opus-4-8",
      thinking: undefined,
      effort: undefined,
      serviceTier: "priority",
      routerPoolId: "pool",
      routerPolicy: "round-robin",
      globalInstructions: "be kind",
      compactAtContextPercent: 80,
    });
    expect(
      await settings({ provider: "codex", sourceSessionId: "sandboxed" }),
    ).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
    await expect(
      launcher.startReviewSession("/repo", "turn", {
        provider: "codex",
        sourceSessionId: "routed",
      }),
    ).rejects.toThrow("its review must use claude");
  });

  it("reports a router refusal after acceptance instead of a queued delivery", async () => {
    const startSession = vi.fn(async (...args: unknown[]) => {
      const launch = args[4] as {
        creation: { onAccepted: (saved: unknown) => Promise<void> };
      };
      await launch.creation.onAccepted({ sessionId: "admitted" });
      throw new RouterRefusedBeforeProvider(
        new RouterUnavailable(409, "no eligible pool account"),
      );
    });
    const supervisor = { startSession } as unknown as Supervisor;
    await expect(
      createSupervisorReviewLauncher(supervisor, vi.fn()).startReviewSession(
        "/repo",
        "turn",
        undefined,
        "submission-1",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "no eligible pool account",
    });
  });

  it("records queue acceptance before returning a keyed queued launch", async () => {
    const startSession = vi.fn(async () => ({
      queued: true as const,
      queueId: "queue-1",
      position: 1,
    }));
    const accepted = vi.fn();
    const supervisor = { startSession } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
      accepted,
    ).startReviewSession("/repo", "turn", undefined, "submission-1");

    expect(result).toEqual({ status: "queued" });
    expect(accepted).toHaveBeenCalledWith("/repo", "submission-1", {
      deliveryStatus: "queued",
    });
  });
});

describe("createSupervisorReviewLauncher.deliverFollowUp", () => {
  it("queues the turn to a live process without resuming", async () => {
    const queueMessage = vi.fn();
    const resumeSession = vi.fn();
    const supervisor = {
      getProcessForSession: () => ({ queueMessage }),
      resumeSession,
    } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).deliverFollowUp("/repo", "sess", "turn");

    expect(result).toEqual({ status: "delivered" });
    expect(queueMessage).toHaveBeenCalledWith({ text: "turn" });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("records keyed live follow-up acceptance after queueing", async () => {
    const queueMessage = vi.fn();
    const accepted = vi.fn();
    const supervisor = {
      getProcessForSession: () => ({ queueMessage }),
      resumeSession: vi.fn(),
    } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
      accepted,
    ).deliverFollowUp("/repo", "sess", "turn", "submission-1");

    expect(result).toEqual({ status: "delivered" });
    expect(accepted).toHaveBeenCalledWith("/repo", "submission-1", {
      deliveryStatus: "delivered",
      targetSessionId: "sess",
    });
  });

  it("resumes a reaped session (no live process) and delivers the turn", async () => {
    // resumeSession resolves to a Process-like value (no error/queued fields).
    const resumeSession = vi.fn(async () => ({}));
    const supervisor = {
      getProcessForSession: () => undefined,
      resumeSession,
    } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).deliverFollowUp("/repo", "dead-sess", "turn");

    expect(result).toEqual({ status: "delivered" });
    expect(resumeSession).toHaveBeenCalledWith("dead-sess", "/repo", {
      text: "turn",
    });
  });

  it("propagates queued and queue-full from a resume at capacity", async () => {
    const queued = {
      getProcessForSession: () => undefined,
      resumeSession: async () => ({ queued: true, queueId: "q", position: 1 }),
    } as unknown as Supervisor;
    expect(
      await createSupervisorReviewLauncher(queued).deliverFollowUp(
        "/r",
        "s",
        "t",
      ),
    ).toEqual({ status: "queued" });

    const full = {
      getProcessForSession: () => undefined,
      resumeSession: async () => ({ error: "queue_full", maxQueueSize: 5 }),
    } as unknown as Supervisor;
    expect(
      await createSupervisorReviewLauncher(full).deliverFollowUp(
        "/r",
        "s",
        "t",
      ),
    ).toEqual({ status: "queue-full", maxQueueSize: 5 });
  });
});
