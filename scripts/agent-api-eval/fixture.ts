import { selection, selectedInspection } from "./selection.js";
import type { ApiSessionInspection } from "../../packages/server/src/core-api/selection-contracts.js";
import { createPeerEvalRouter, PEER_SERVER_ID } from "./peer-fixture.js";
import { openSqliteOrThrow } from "../../packages/server/src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../packages/server/src/storage/discovery-sqlite.js";
import { ApiReceiptStore } from "../../packages/server/src/core-api/receipt-store.js";
import { SessionCommands } from "../../packages/server/src/core-api/session-commands.js";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERUSER } from "../../packages/server/src/auth/principal.js";
import { createAgentApiRuntime } from "../../packages/server/src/agent-api/runtime.js";
import {
  createConversationRead,
  createConversationFollow,
} from "../../packages/server/src/core-api/conversation.js";
import { ConversationSubscriptions } from "../../packages/server/src/experimental/conversation-subscriptions.js";
import type { Message } from "../../packages/shared/src/transcript/message.js";
import { CoreApi } from "../../packages/server/src/core-api/service.js";
import {
  OWN_SESSION_ID,
  projects,
  SERVER_ID,
  sessions,
  type CaseId,
  type Trace,
} from "./cases.js";

/** Real private adapter, deterministic source functions, no app/profile/scanners. */
export async function createFixture(
  caseId: CaseId,
  peerRelay = false,
  peerIdentityService = false,
) {
  if (peerRelay && caseId !== "workflow")
    throw new Error("Peer relay fixture supports only the workflow case");
  const localSessions = [...sessions];
  const apiServerId = peerRelay ? PEER_SERVER_ID : SERVER_ID;
  const management =
    caseId === "create" || caseId === "workflow" || caseId === "selection";
  const inspections = new Map<string, ApiSessionInspection>();
  const database = management ? openSqliteOrThrow(":memory:") : undefined;
  if (database) migrateDiscoveryDatabase(database);
  const receiptStore = database ? new ApiReceiptStore(database) : undefined;
  const workers = new Map<
    string,
    { prompt: string; followups: Array<{ id: string; text: string }> }
  >();
  let workerCount = 0;
  const commands = receiptStore
    ? new SessionCommands(
        apiServerId,
        receiptStore,
        {
          async start(project, request) {
            const id = `eval-worker-${++workerCount}`;
            inspections.set(id, selectedInspection(request));
            workers.set(id, { prompt: request.message, followups: [] });
            localSessions.push({
              id,
              projectId: project.id,
              provider: request.provider,
              title: "Release worker",
              updatedAt: new Date().toISOString(),
              state: "idle",
            });
            return { sessionId: id };
          },
          canSend: (id) => workers.has(id),
          send(id, request, receipt, consumed) {
            const worker = workers.get(id);
            if (!worker) return { accepted: false };
            worker.followups.push({ id: receipt.id, text: request.message });
            consumed();
            notifyWorker();
            return { accepted: true };
          },
        },
        () => management,
      )
    : undefined;
  const noise: Message[] = Array.from({ length: 40 }, (_, i) => [
    {
      type: "assistant" as const,
      uuid: `call-${i}`,
      content: [
        {
          type: "tool_use" as const,
          id: `tool-${i}`,
          name: "Bash",
          input: { command: "diagnostic" },
        },
      ],
    },
    {
      type: "user" as const,
      uuid: `result-${i}`,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: `tool-${i}`,
          content: `routine-noise-${i} `.repeat(500),
        },
      ],
    },
  ]).flat();
  let done = caseId === "reconnect";
  const worker = caseId === "follow" || caseId === "reconnect";
  let finishWorker!: () => void;
  const workerFinished = new Promise<void>(
    (resolve) => (finishWorker = resolve),
  );
  let notifyWorker = () => {};
  let workerTimer: ReturnType<typeof setTimeout> | undefined;
  const conversations = new ConversationSubscriptions(
    async (sessionId, invalidate) => {
      notifyWorker = invalidate;
      // The scripted worker owns progress independently of observer lifetime.
      // A finite timer starts on first observation and ends with this fixture.
      if (worker && !done && !workerTimer)
        workerTimer = setTimeout(() => {
          done = true;
          finishWorker();
          notifyWorker();
        }, 350);
      return {
        close() {},
        async read() {
          const managed = workers.get(sessionId);
          const workerMessages: Message[] | undefined = managed
            ? [
                {
                  type: "user",
                  uuid: "worker-initial",
                  content: managed.prompt,
                },
                {
                  type: "assistant",
                  uuid: "worker-first",
                  content: "The release artifact is created-5b7.",
                },
                ...managed.followups.flatMap((input, index): Message[] => [
                  { type: "user", uuid: input.id, content: input.text },
                  {
                    type: "assistant",
                    uuid: `worker-reply-${index}`,
                    content: "The follow-up artifact is followup-c82.",
                  },
                ]),
              ]
            : undefined;
          return {
            sessionId,
            messages: workerMessages ?? [
              {
                type: "user",
                uuid: "question",
                content: "Which release artifact is ready?",
              },
              ...noise,
              {
                type: "assistant",
                uuid: "answer",
                content:
                  management && sessionId.startsWith("eval-worker-")
                    ? "The release artifact is created-5b7."
                    : worker
                      ? done
                        ? "The release artifact is worker-9c4."
                        : "Working on the release."
                      : "The release artifact is orchid-7f2.",
              },
            ],
            activity:
              caseId === "evidence"
                ? "unknown"
                : worker && !done
                  ? "working"
                  : "idle",
            pendingRequests: [],
            sourceCoverage: {
              complete: caseId !== "evidence",
              earlierOutsideScope: caseId === "evidence" ? "unknown" : "no",
            },
          };
        },
      };
    },
  );
  const runtime = await createAgentApiRuntime({ serverId: SERVER_ID });
  const core = new CoreApi(apiServerId, {
    commands,
    selection: async () => selection,
    sessionInspection: (id) =>
      inspections.get(id) ?? {
        settings: {
          source: "unavailable",
          requestedModel: null,
          model: null,
          thinking: null,
          effort: null,
          permissionMode: null,
          serviceTier: null,
        },
        routing: { mode: "unknown" },
      },
    conversation: createConversationRead(conversations),
    followConversation: createConversationFollow(conversations, apiServerId),
    projects: async () => ({ items: projects }),
    sessions: async () => ({
      items: localSessions,
      catalog: {
        complete: caseId !== "incomplete",
        refreshing: caseId === "incomplete",
      },
    }),
    providers: async () => [
      {
        id: "codex",
        name: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
  });
  let peers: Awaited<ReturnType<typeof createPeerEvalRouter>> | undefined;
  try {
    if (peerRelay)
      peers = await createPeerEvalRouter(
        core,
        database!,
        receiptStore!,
        projects,
        peerIdentityService,
      );
    runtime.attachController(peers?.router ?? core);
  } catch (error) {
    conversations.close();
    commands?.close();
    await commands?.idle();
    receiptStore?.close();
    database?.close();
    await runtime.close();
    throw error;
  }
  const lease = runtime.issue({
    principal: SUPERUSER,
    sessionId: () => OWN_SESSION_ID,
    management,
    peerAccess: peerRelay,
    peerGrantId: peers?.grantId,
  });
  const trace: Trace[] = [];
  // A test-only transparent front records actual HTTP outcomes and repeated doc
  // bytes, including failed requests. It forwards authentication to production.
  const directory = await mkdtemp(join(tmpdir(), "ya-eval-"));
  await chmod(directory, 0o700);
  const socket =
    process.platform === "win32" ? undefined : join(directory, "trace.sock");
  const front = createServer((req, res) => {
    const start = performance.now();
    let bytes = 0;
    const routePath = req.url?.split("?")[0] ?? "";
    const capture =
      routePath.endsWith("/conversation/follow") ||
      /\/sessions\/[^/]+$/.test(routePath) ||
      routePath.includes("/receipts/") ||
      (req.method === "POST" && routePath.startsWith("/v0/"));
    let captured = "";
    const upstream = request(
      new URL(req.url ?? "/", runtime.baseUrl),
      {
        method: req.method,
        headers: req.headers,
        socketPath: runtime.socketPath,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (capture && bytes <= 512 * 1024) captured += String(chunk);
        });
        response.on("end", () => {
          let inspection: Trace["inspection"];
          let follow: Trace["follow"];
          let receipt: Trace["receipt"];
          if (capture && bytes <= 512 * 1024) {
            try {
              const data = JSON.parse(captured);
              if (data.settings && data.routing)
                inspection = { settings: data.settings, routing: data.routing };
              const value = data.receipt ?? data;
              if (
                typeof value?.id === "string" &&
                typeof value?.kind === "string" &&
                typeof value?.delivery === "string"
              )
                receipt = {
                  id: value.id,
                  kind: value.kind,
                  delivery: value.delivery,
                };
              if (
                typeof data.cursor === "string" &&
                typeof data.reset === "boolean" &&
                typeof data.changed === "boolean"
              )
                follow = {
                  cursor: data.cursor,
                  reset: data.reset,
                  changed: data.changed,
                };
            } catch {
              /* Not a successful follow response. */
            }
          }
          trace.push({
            method: req.method ?? "GET",
            path: req.url ?? "/",
            status: response.statusCode ?? 502,
            bytes,
            elapsedMs: performance.now() - start,
            atMs: start,
            ...(inspection ? { inspection } : {}),
            ...(follow ? { follow } : {}),
            ...(receipt ? { receipt } : {}),
          });
        });
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      trace.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        status: 502,
        bytes: 0,
        elapsedMs: performance.now() - start,
        atMs: start,
      });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      front.once("error", reject);
      if (socket) front.listen(socket, resolve);
      else front.listen(0, "127.0.0.1", resolve);
    });
    if (socket) await chmod(socket, 0o600);
  } catch (error) {
    if (workerTimer) clearTimeout(workerTimer);
    conversations.close();
    commands?.close();
    await commands?.idle();
    await peers?.close();
    receiptStore?.close();
    database?.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const address = front.address();
  const url = socket
    ? "http://127.0.0.1"
    : `http://127.0.0.1:${typeof address === "object" && address ? address.port : ""}`;
  return {
    apiServerId,
    management,
    workerFinished,
    trace,
    environment: {
      ...lease.environment,
      AGENT_YA_V0_URL: url,
      ...(socket ? { AGENT_YA_V0_SOCKET: socket } : {}),
    } as Record<string, string>,
    async close() {
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      if (workerTimer) clearTimeout(workerTimer);
      conversations.close();
      commands?.close();
      await commands?.idle();
      await peers?.close();
      receiptStore?.close();
      database?.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
