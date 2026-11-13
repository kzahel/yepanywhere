import { it, expect } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeFixture } from "./fixture.js";
import { CoreApi } from "../../src/core-api/service.js";
import { operationIds } from "../../src/core-api/contracts.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { nativeSessionCommandOwner } from "../../src/core-api/native-session-commands.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { PeerAccessManager } from "../../src/peer-api/manager.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import { createConversationRead } from "../../src/core-api/conversation.js";

const readyPath = process.env.YEP_NATIVE_PEER_TARGET_READY;
// Explicit opt-in manual cross-host window; no listener or native process in normal CI.
it.skipIf(!readyPath)(
  "serves an owned native Codex peer to an external controller",
  { timeout: 180000 },
  async () => {
    const sourceId = process.env.YEP_NATIVE_PEER_SOURCE_ID;
    if (!sourceId || !readyPath)
      throw Error("External controller source identity is required");
    const root = dirname(readyPath);
    await mkdir(root, { recursive: true });
    const database = openSqliteOrThrow(":memory:");
    migrateDiscoveryDatabase(database);
    const receipts = new ApiReceiptStore(database);
    const id = randomUUID();
    const manager = new PeerAccessManager(id, join(root, `peer-profile-${id}`));
    await manager.initialize();
    let native: Awaited<ReturnType<typeof nativeFixture>> | undefined;
    let modelWork: Promise<void> | undefined;
    let nativeProbeActive = false;
    const nativeOwner = nativeSessionCommandOwner({
      supervisor: {
        getProcessForSession: (sid) =>
          native?.proc.sessionId === sid ? native.proc : undefined,
        getAllProcesses: () => (native ? [native.proc] : []),
        startSession: async () => {
          throw Error("Unexpected native owner launch");
        },
        interruptProcess: async () => ({
          success: await native!.proc.interrupt(),
          supported: native!.proc.supportsInterrupt,
        }),
        abortProcessWithVerification: async () =>
          native!.proc.terminateAndWait("external peer stop"),
      },
      globalInstructions: () => undefined,
    });
    const commands = new SessionCommands(
      id,
      receipts,
      {
        ...nativeOwner,
        async start(_project, request, _receipt, _settled, _failed, consumed) {
          expect(native).toBeUndefined();
          native = await nativeFixture("codex", "gentle", {
            gitProject: false,
            permissionMode: request.permissionMode,
            onToolApproval: (tool, input, options) =>
              native!.proc.handleToolApproval(tool, input, options),
            launch: { initialMessage: { text: request.prompt } },
          });
          modelWork = (async () => {
            const initial = await native!.model.next();
            consumed?.();
            initial.tool(
              "exec",
              'const r=await tools.exec_command({cmd:"echo OWNED_WINDOWS_PEER_TOOL",sandbox_permissions:"require_escalated",justification:"Owned cross-host approval check"});text(r.output);',
            );
            const resumed = await native!.model.next();
            expect(JSON.stringify(resumed.body)).toContain(
              "OWNED_WINDOWS_PEER_TOOL",
            );
            resumed.finish("OWNED_WINDOWS_PEER_RESULT");
            await native!.output("OWNED_WINDOWS_PEER_RESULT");
            await native!.idle();
            const active = await native!.model.next();
            nativeProbeActive = true;
            await active.cancelled;
            nativeProbeActive = false;
          })();
          // Retain any native failure until the controller signals final observation.
          void modelWork.catch(() => {});
          return { sessionId: native.proc.sessionId };
        },
      },
      () => true,
    );
    const conversations = new ConversationSubscriptions(async (sessionId) => ({
      close() {},
      async read() {
        const messages = (native?.events ?? [])
          .filter((message) => message.type === "assistant")
          .flatMap((message, index) => {
            const content = (message as { message?: { content?: unknown } })
              .message?.content;
            const text =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .flatMap((block) =>
                        block?.type === "text" && typeof block.text === "string"
                          ? [block.text]
                          : [],
                      )
                      .join("")
                  : "";
            return text
              ? [
                  {
                    type: "assistant" as const,
                    uuid: `native-${index}`,
                    content: text,
                  },
                ]
              : [];
          });
        return {
          sessionId,
          messages,
          pendingRequests: [],
          activity:
            native?.proc.state.type === "waiting-input"
              ? ("waiting" as const)
              : native?.proc.state.type === "in-turn"
                ? ("working" as const)
                : ("idle" as const),
          sourceCoverage: {
            complete: true,
            earlierOutsideScope: "no" as const,
          },
        };
      },
    }));
    const projects = async () => ({
      items: [
        {
          id: "p",
          name: "Owned native project",
          path: native?.project ?? root,
        },
      ],
    });
    manager.bind(
      new CoreApi(id, {
        commands,
        projects,
        providers: async () => [
          {
            id: "codex",
            name: "Codex",
            supportsSteering: true,
            supportsPermissionMode: true,
          },
        ],
        sessions: async () => ({
          items: native
            ? [
                {
                  id: native.proc.sessionId,
                  projectId: "p",
                  provider: "codex",
                  title: "Owned native worker",
                  state: native.proc.state.type,
                  nativeProbeActive,
                  updatedAt: new Date().toISOString(),
                },
              ]
            : [],
        }),
        conversation: createConversationRead(conversations),
      }),
      database,
      receipts,
      projects,
    );
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const donePath = readyPath + ".done";
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Error(
              "External controller did not finish its declared 120-second window",
            ),
          ),
        120000,
      );
      const watcher = watch(root, () => {
        if (existsSync(donePath)) {
          watcher.close();
          resolve();
        }
      });
      server.once("close", () => watcher.close());
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "0.0.0.0", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing peer listener");
      const invitation = await manager.issue({
        sourceServerId: sourceId,
        projects: ["p"],
        operations: operationIds,
        expiresAt: Date.now() + 180000,
        acknowledgeExecutionAuthority: "server-account",
      });
      await writeFile(
        readyPath,
        JSON.stringify({ serverId: id, port: address.port, invitation }),
        { mode: 0o600 },
      );
      await done;
      await modelWork;
      expect(native?.proc.isTerminated).toBe(true);
      expect(native?.errors).toEqual([]);
      expect(native?.model.failures).toEqual([]);
    } finally {
      if (timer) clearTimeout(timer);
      await manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      conversations.close();
      commands.close();
      await commands.idle();
      await native?.close();
      receipts.close();
      database.close();
    }
  },
);
