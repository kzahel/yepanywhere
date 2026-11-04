import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import type { Client } from "@agentclientprotocol/sdk";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import { getLogger } from "../../../src/logging/logger.js";

describe("ACPClient owned process teardown", () => {
  it("rejects a real spawn failure and retains truthful process evidence", async () => {
    const errorLog = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);
    const client = new ACPClient();
    try {
      await client.connect({
        command: process.execPath + "-missing-acp-fixture",
        cwd: tmpdir(),
      });
      await expect(client.initialize({})).rejects.toBeDefined();
      await client.close();
      expect(client.isProcessAlive).toBe(false);
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        { err: expect.objectContaining({ code: "ENOENT" }) },
        "ACP agent process error",
      );
    } finally {
      await client.close();
      errorLog.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "closes a real broken pipe and waits for its peer to exit",
    async () => {
      const client = new ACPClient();
      let ready!: () => void;
      const readiness = new Promise<void>((resolve) => {
        ready = resolve;
      });
      client.setSessionUpdateCallback(() => ready());
      try {
        await client.connect({
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').closeSync(0);console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'ready',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'READY'}}}}));setInterval(()=>{},1000)`,
          ],
          cwd: tmpdir(),
        });
        await readiness;
        const pid = client.pid;
        expect(pid).toBeGreaterThan(0);
        await expect(client.initialize({})).rejects.toBeDefined();
        await client.close();
        expect(client.pid).toBe(pid);
        expect(client.isProcessAlive).toBe(false);
      } finally {
        await client.close();
      }
    },
  );
});

function handlersFor(client: ACPClient): Client {
  return (
    client as unknown as {
      createClientHandlers(): Client;
    }
  ).createClientHandlers();
}

describe("ACPClient extension methods", () => {
  it("forwards extension requests to the registered callback", async () => {
    const client = new ACPClient();
    const callback = vi.fn().mockResolvedValue({ outcome: "accepted" });
    client.setExtensionMethodCallback(callback);

    const handlers = handlersFor(client);
    await expect(
      handlers.extMethod?.("x.ai/ask_user_question", {
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(callback).toHaveBeenCalledWith("x.ai/ask_user_question", {
      sessionId: "session-1",
    });
  });

  it("does not claim extension support without a callback", () => {
    const client = new ACPClient();
    expect(handlersFor(client).extMethod).toBeUndefined();
  });
});

describe("ACPClient.loadSession", () => {
  function withFakeConnection(client: ACPClient) {
    const loadSession = vi.fn().mockResolvedValue({});
    (client as unknown as { connection: unknown }).connection = { loadSession };
    return loadSession;
  }

  it("sends the id, cwd and an empty MCP list", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo");

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/repo",
      mcpServers: [],
    });
  });

  it("forwards caller metadata as the request's _meta", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo", { noReplay: true });

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/repo",
      mcpServers: [],
      _meta: { noReplay: true },
    });
  });

  it("omits _meta entirely when the caller passes none", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo");

    expect(loadSession.mock.calls[0]?.[0]).not.toHaveProperty("_meta");
  });

  it("refuses to load before connect", async () => {
    await expect(new ACPClient().loadSession("s", "/repo")).rejects.toThrow(
      /not connected/i,
    );
  });
});
