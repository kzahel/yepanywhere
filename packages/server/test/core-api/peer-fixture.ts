import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERUSER } from "../../src/auth/principal.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { PeerAccessManager } from "../../src/peer-api/manager.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import type { Operation, ApiSession } from "../../src/core-api/contracts.js";
import type { AgentApiRuntime } from "../../src/agent-api/runtime.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import {
  createConversationRead,
  createConversationFollow,
} from "../../src/core-api/conversation.js";
export async function protectedProfile(
  cleanup: (() => void | Promise<void>)[],
  fleetOptions: {
    allowInsecureLoopback?: boolean;
    fetch?: typeof fetch;
    runtimeControl?: { envOverride?: boolean };
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ya-protected-peer-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID(),
    database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  cleanup.push(() => database.close());
  const receipts = new ApiReceiptStore(database);
  cleanup.push(() => receipts.close());
  const sessions: ApiSession[] = [
    {
      id: "parent",
      projectId: "p",
      provider: "codex",
      title: "Parent",
      state: "idle",
      updatedAt: "",
    },
  ];
  let starts = 0,
    sends = 0;
  let onStart: (() => void) | undefined;
  const commands = new SessionCommands(
    id,
    receipts,
    {
      async start(_p, _r, _receipt, _settled, _failed, consumed) {
        starts++;
        const sessionId = `created-${starts}`;
        sessions.push({ ...sessions[0]!, id: sessionId });
        consumed?.();
        onStart?.();
        return { sessionId };
      },
      canSend: (sid) => sessions.some((s) => s.id === sid),
      send(_sid, _r, _receipt, consumed) {
        sends++;
        consumed();
        return { accepted: true };
      },
    },
    () => true,
  );
  cleanup.push(async () => {
    commands.close();
    await commands.idle();
  });
  const subscriptions = new ConversationSubscriptions(async (sessionId) => ({
    close() {},
    async read() {
      return {
        sessionId,
        activity: "idle",
        pendingRequests: [],
        sourceCoverage: { complete: true, earlierOutsideScope: "no" },
        messages: [
          {
            type: "assistant",
            uuid: "answer",
            content: [
              { type: "text", text: "Protected fleet workflow completed." },
            ],
          },
        ],
      };
    },
  }));
  const projectItems = [{ id: "p", name: "Project", path: "/fixture/project" }];
  const sources: CoreApiSources = {
    peerAuthentication: () => true,
    conversation: createConversationRead(subscriptions),
    followConversation: createConversationFollow(subscriptions, id),
    commands,
    projects: async () => ({
      items: projectItems,
    }),
    sessions: async () => ({ items: sessions }),
    providers: async () => [
      {
        id: "codex",
        name: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
  };
  const manager = new PeerAccessManager(id, directory, undefined, fleetOptions);
  await manager.initialize();
  cleanup.push(() => manager.close());
  const router = manager.bind(
    new CoreApi(id, sources),
    database,
    receipts,
    sources.projects,
  );
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    await manager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address()!;
  if (typeof address === "string") throw new Error("Expected TCP address");
  const route = {
    kind: "direct" as const,
    url: `ws://127.0.0.1:${address.port}/peer/ws`,
  };
  const read = (
    operation: Operation,
    input: Parameters<typeof router.read>[2] = {},
  ) =>
    router.read(operation, SUPERUSER, { ownerAuthenticated: true, ...input });
  return {
    id,
    directory,
    manager,
    router,
    route,
    read,
    starts: () => starts,
    sends: () => sends,
    receipts,
    sources,
    addProject: (id: string) =>
      projectItems.push({ id, name: id, path: `/fixture/${id}` }),
    onStart: (callback: () => void) => {
      onStart = callback;
    },
  };
}

export function nativeRequest(
  runtime: AgentApiRuntime,
  token: string,
  path: string,
  body?: unknown,
) {
  return new Promise<{ status: number; body: ReturnType<typeof JSON.parse> }>(
    (resolve, reject) => {
      const request = httpRequest(
        new URL(path, runtime.baseUrl),
        {
          socketPath: runtime.socketPath,
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body: JSON.parse(text) }),
          );
        },
      );
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
}
