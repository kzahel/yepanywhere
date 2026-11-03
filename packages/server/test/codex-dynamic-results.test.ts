import { describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../src/sdk/providers/codex.js";
import { TOOL_RESULT_MEDIA_CANDIDATES } from "../src/media/inlineImageData.js";
import { normalizeCodexToolOutputWithContext } from "../src/codex/normalization.js";
import {
  MessageQueue,
  Process,
  type SDKMessage,
  type UrlProjectId,
  getLogger,
} from "./process.test-support.js";

// Exercises the actual pinned adapter seams without provider credentials.
function adapter() {
  return new CodexProvider() as unknown as {
    convertItemToSDKMessages(
      item: unknown,
      sessionId: string,
      turnId: string,
      source: string,
    ): Array<Record<string | symbol, unknown>>;
  };
}
describe("Codex dynamic results and terminal startup", () => {
  it("marks a rejected thread/start terminal even while app-server is still alive", async () => {
    const provider = new CodexProvider() as unknown as {
      resolveCodexCommand(): Promise<string>;
      getCodexEnv(): NodeJS.ProcessEnv;
      refreshCodexSkills(): Promise<void>;
      runSession(...args: unknown[]): AsyncIterableIterator<SDKMessage>;
    };
    vi.spyOn(provider, "resolveCodexCommand").mockResolvedValue("unused-codex");
    vi.spyOn(provider, "getCodexEnv").mockReturnValue({});
    vi.spyOn(provider, "refreshCodexSkills").mockResolvedValue();
    const errorLog = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => {});
    const close = vi.fn(async () => {});
    const requested: string[] = [];
    const iterator = provider.runSession(
      { cwd: "." },
      new MessageQueue(),
      new AbortController().signal,
      { activeTurnId: null, activePermissionMode: "default" },
      (client: {
        isClosed: boolean;
        connect(): Promise<void>;
        close(): Promise<void>;
        notify(): void;
        request(method: string): Promise<unknown>;
      }) => {
        expect(client.isClosed).toBe(false);
        vi.spyOn(client, "connect").mockResolvedValue();
        vi.spyOn(client, "notify").mockImplementation(() => {});
        vi.spyOn(client, "close").mockImplementation(close);
        vi.spyOn(client, "request").mockImplementation(async (method) => {
          requested.push(method);
          if (method === "thread/start")
            throw new Error(
              "deferred dynamic tool must include a namespace: computer_control",
            );
          return {};
        });
      },
      () => {},
      { skills: [], stale: true },
    );
    const process = new Process(iterator, {
      queue: new MessageQueue(),
      projectPath: ".",
      projectId: "probe" as UrlProjectId,
      sessionId: "provisional",
      provider: "codex",
      initialState: "in-turn",
      idleTimeoutMs: 100,
    });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(requested).toContain("thread/start");
      expect(requested).not.toContain("turn/start");
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        scope: "provider_process",
        message: expect.stringContaining("must include a namespace"),
      });
      expect(process.getInfo().state).not.toBe("in-turn");
    } finally {
      await process.abort();
      errorLog.mockRestore();
      vi.restoreAllMocks();
    }
  });
  it("preserves image candidates in live dynamic results and persisted output", () => {
    const imageUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
    const text = JSON.stringify({
      actualRoute: "windows.user_session/native",
      fidelity: "exact_window",
      delivery: "confirmed",
      effect: "not_applicable",
      uncertainty: "none",
    });
    const messages = adapter().convertItemToSDKMessages(
      {
        id: "capture",
        type: "dynamic_tool_call",
        tool: "computer_control",
        arguments: { operation: "screenshot" },
        status: "completed",
        success: true,
        content_items: [
          { type: "inputText", text },
          { type: "inputImage", imageUrl },
        ],
      },
      "selected",
      "turn",
      "item/completed",
    );
    const result = messages[1]!;
    expect(result[TOOL_RESULT_MEDIA_CANDIDATES]).toEqual([
      { dataUrl: imageUrl, claimedMimeType: "image/png" },
    ]);
    expect(JSON.stringify(result)).not.toContain(imageUrl);
    const persisted = normalizeCodexToolOutputWithContext([
      { type: "input_text", text },
      { type: "input_image", image_url: imageUrl },
    ]);
    expect(persisted.mediaCandidates).toEqual([
      { dataUrl: imageUrl, claimedMimeType: "image/png" },
    ]);
    expect(persisted.content).toContain("exact_window");
  });
});
