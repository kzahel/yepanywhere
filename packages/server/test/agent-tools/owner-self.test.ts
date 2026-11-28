import { expect, it, vi } from "vitest";
import { startAgentSelfSession } from "../../src/sdk/providers/agent-self.js";
import { ProviderSessionOwner } from "../../src/sdk/providers/provider-session-owner.js";
import {
  createControllableIterator,
  MessageQueue,
  Process,
  toUrlProjectId,
  waitFor,
} from "../process.test-support.js";

async function fixture() {
  const controller = createControllableIterator();
  let environment: Record<string, string> = {};
  const setEffort = vi.fn(async () => {});
  const session = await startAgentSelfSession(
    "claude",
    {
      cwd: ".",
      agentSelf: true,
      resumeSessionId: "canonical-id",
      effort: "low",
    },
    async (options) => {
      environment = options.agentEnvironment ?? {};
      return {
        sessionId: "canonical-id",
        queue: new MessageQueue(),
        iterator: {
          ...controller.iterator,
          [Symbol.asyncIterator]() {
            return this;
          },
        },
        abort: () => controller.finish(),
        setEffort,
      };
    },
  );
  const report = async () => {
    const response = await fetch(`${environment.AGENT_YA_API_URL}/v1/self`, {
      headers: { Authorization: `Bearer ${environment.AGENT_YA_API_TOKEN}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const view = async () => {
    const response = await fetch(`${environment.AGENT_YA_API_URL}/v1/view`, {
      headers: { Authorization: `Bearer ${environment.AGENT_YA_API_TOKEN}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { controller, session, report, view, setEffort };
}

const tabView = {
  clientId: "tab-one",
  device: "Linux",
  focused: true,
  viewers: [],
  publishedAt: "2026-10-06T10:00:00.000Z",
  focusedAt: "2026-10-06T10:00:00.000Z",
};

it("Process and a retained owner hand client views to ya-agent view", async () => {
  const { session, view } = await fixture();
  const process = new Process(session.iterator, {
    projectPath: "/test",
    projectId: toUrlProjectId("/test"),
    sessionId: "canonical-id",
    provider: "claude",
    queue: session.queue,
    publishAgentSessionViewsFn: session.publishAgentSessionViews,
    idleTimeoutMs: 10_000,
  });
  const owner = new ProviderSessionOwner({ runtimeId: "view-test-owner" });
  const ready = await owner.start(async () => ({ session }));
  expect(ready.capabilities.publishAgentSessionViews).toBe(true);
  owner.begin();
  try {
    process.publishAgentSessionViews([tabView]);
    await vi.waitFor(async () =>
      expect(await view()).toMatchObject({
        selectedClientId: "tab-one",
        clients: [{ clientId: "tab-one" }],
      }),
    );
    owner.attach("first", "generation-one", () => {});
    await owner.handleControllerRequest("first", {
      type: "rpc",
      id: 1,
      method: "publishAgentSessionViews",
      args: [[]],
    });
    expect(await view()).toMatchObject({ selection: "none", clients: [] });
  } finally {
    await owner.shutdown("test complete");
  }
});

it("Process publishes pending effort and clears it only after the provider boundary", async () => {
  const { controller, session, report, setEffort } = await fixture();
  const process = new Process(session.iterator, {
    projectPath: "/test",
    projectId: toUrlProjectId("/test"),
    sessionId: "canonical-id",
    provider: "claude",
    effort: "low",
    queue: session.queue,
    setEffortFn: session.setEffort,
    publishAgentSelfSelectionFn: session.publishAgentSelfSelection,
    idleTimeoutMs: 10_000,
  });
  try {
    controller.push({
      type: "system",
      subtype: "init",
      session_id: "canonical-id",
    });
    await waitFor(() => expect(process.state.type).toBe("in-turn"));
    await process.setEffort("high");
    expect(setEffort).not.toHaveBeenCalled();
    expect(await report()).toMatchObject({
      selected: { effort: { value: "high" } },
      pending: { effort: true },
      providerEvidence: { effort: { status: "unknown" } },
    });
    controller.push({ type: "result", session_id: "canonical-id" });
    await waitFor(() => expect(process.appliedEffort).toBe("high"));
    expect(await report()).toMatchObject({
      pending: { effort: false },
      providerEvidence: {
        effort: { value: "high", source: "adapter-control" },
      },
    });
  } finally {
    await session.abort();
  }
});

it("retained provider owner keeps the grant and projection across controller generations", async () => {
  const { controller, session, report } = await fixture();
  const owner = new ProviderSessionOwner({ runtimeId: "self-test-owner" });
  const ready = await owner.start(async () => ({ session }));
  expect(ready.capabilities.publishAgentSelfSelection).toBe(true);
  owner.begin();
  try {
    owner.attach("first", "generation-one", () => {});
    await owner.handleControllerRequest("first", {
      type: "rpc",
      id: 1,
      method: "publishAgentSelfSelection",
      args: [{ effort: "high", pendingEffort: true }],
    });
    const before = await report();
    owner.detach("first");
    controller.push({
      type: "assistant",
      message: { content: "", model: "resolved-while-detached" },
    });
    await vi.waitFor(async () =>
      expect(await report()).toMatchObject({
        providerEvidence: { model: { value: "resolved-while-detached" } },
      }),
    );
    owner.attach("second", "generation-two", () => {});
    expect(await report()).toMatchObject({
      launchId: before.launchId,
      sessionId: "canonical-id",
      selected: { effort: { value: "high" } },
      pending: { effort: true },
    });
    await expect(
      owner.handleControllerRequest("first", {
        type: "rpc",
        id: 2,
        method: "publishAgentSelfSelection",
        args: [{ effort: "low" }],
      }),
    ).rejects.toThrow("Stale");
    await owner.handleControllerRequest("second", {
      type: "rpc",
      id: 3,
      method: "publishAgentctlSessionId",
      args: ["remapped-canonical-id"],
    });
    expect(await report()).toMatchObject({
      sessionId: "remapped-canonical-id",
    });
  } finally {
    await owner.shutdown("test complete");
  }
});
