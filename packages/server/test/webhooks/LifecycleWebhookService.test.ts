import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { LifecycleWebhookService } from "../../src/webhooks/LifecycleWebhookService.js";

describe("LifecycleWebhookService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a webhook when a live process transitions to idle", async () => {
    const eventBus = new EventBus();
    const process = {
      id: "proc-1",
      sessionId: "sess-1",
      projectPath: "/tmp/repo",
      provider: "claude",
      resolvedModel: "claude-sonnet-4-5",
      executor: undefined,
      permissionMode: "default",
      state: { type: "idle" as const },
      getMessageHistory: () => [
        { type: "user", message: { role: "user", content: "fix the tests" } },
        {
          type: "assistant",
          message: { role: "assistant", content: "Done with the first pass." },
        },
      ],
    };
    const supervisor = {
      getProcessForSession: vi.fn(() => process),
    } as unknown as Supervisor;
    const serverSettingsService = {
      getSettings: vi.fn(() => ({
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookToken: "secret",
        lifecycleWebhookDryRun: true,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === "lifecycleWebhookDryRun") return true;
        return undefined;
      }),
    } as unknown as ServerSettingsService;

    new LifecycleWebhookService({
      eventBus,
      supervisor,
      serverSettingsService,
    });

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: toUrlProjectId("/tmp/repo"),
      activity: "idle",
      timestamp: "2026-04-02T12:00:00.000Z",
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer secret",
    );

    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      type: "session-inactive",
      reason: "idle",
      dryRun: true,
      session: { id: "sess-1" },
      project: {
        path: "/tmp/repo",
        name: "repo",
      },
      process: {
        id: "proc-1",
        provider: "claude",
        model: "claude-sonnet-4-5",
        permissionMode: "default",
      },
      lastUserMessageText: "fix the tests",
      lastMessageText: "Done with the first pass.",
    });
  });

  it("ignores idle events after the process has already been unregistered", async () => {
    const eventBus = new EventBus();
    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const serverSettingsService = {
      getSettings: vi.fn(() => ({
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookDryRun: true,
      })),
      getSetting: vi.fn(() => true),
    } as unknown as ServerSettingsService;

    new LifecycleWebhookService({
      eventBus,
      supervisor,
      serverSettingsService,
    });

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: toUrlProjectId("/tmp/repo"),
      activity: "idle",
      timestamp: "2026-04-02T12:00:00.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a webhook when a process terminates unexpectedly", async () => {
    const eventBus = new EventBus();
    const process = {
      id: "proc-1",
      sessionId: "sess-1",
      projectPath: "/tmp/repo",
      provider: "claude",
      resolvedModel: "claude-sonnet-4-5",
      executor: "devbox",
      permissionMode: "default",
      getMessageHistory: () => [
        { type: "user", message: { role: "user", content: "fix the tests" } },
        {
          type: "assistant",
          message: { role: "assistant", content: "Running test suite." },
        },
      ],
    };
    const supervisor = {
      getProcessForSession: vi.fn(() => process),
    } as unknown as Supervisor;
    const serverSettingsService = {
      getSettings: vi.fn(() => ({
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookDryRun: false,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === "lifecycleWebhookDryRun") return false;
        return undefined;
      }),
    } as unknown as ServerSettingsService;

    new LifecycleWebhookService({
      eventBus,
      supervisor,
      serverSettingsService,
    });

    eventBus.emit({
      type: "process-terminated",
      sessionId: "sess-1",
      projectId: toUrlProjectId("/tmp/repo"),
      processId: "proc-1",
      provider: "claude",
      reason: "underlying process terminated",
      timestamp: "2026-04-02T12:00:00.000Z",
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      type: "session-inactive",
      reason: "error",
      summary: "underlying process terminated",
      dryRun: false,
      process: {
        id: "proc-1",
        provider: "claude",
        executor: "devbox",
      },
    });
  });
});
