/** Fixture-only cross-host controller; never load a configured user peer credential. */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { PeerAccessManager } from "../../packages/server/src/peer-api/manager.js";
import { CoreApi } from "../../packages/server/src/core-api/service.js";
import { ApiReceiptStore } from "../../packages/server/src/core-api/receipt-store.js";
import { openSqliteOrThrow } from "../../packages/server/src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../packages/server/src/storage/discovery-sqlite.js";
import { operationIds } from "../../packages/server/src/core-api/contracts.js";
import { createAgentApiRuntime } from "../../packages/server/src/agent-api/runtime.js";
import { SUPERUSER } from "../../packages/server/src/auth/principal.js";
import { randomUUID } from "node:crypto";
import type {
  ApiReceipt,
  ApiOutbound,
} from "../../packages/server/src/core-api/command-contracts.js";
import type { PendingRequests } from "../../packages/server/src/core-api/session-control-contracts.js";
interface ProbeSession {
  state: string;
  nativeProbeActive?: boolean;
}
const [readyPath, url] = process.argv.slice(2);
if (!readyPath || !url)
  throw Error(
    "Usage: native-peer-control.ts READY_JSON ws://TARGET:PORT/peer/ws",
  );
const peer = JSON.parse(await readFile(readyPath, "utf8"));
const sourceId: string = peer.invitation.sourceServerId;
if (!sourceId || !peer.serverId)
  throw Error("Missing owned fixture identities");
const root = await mkdtemp(join(tmpdir(), "ya-cross-source-"));
const database = openSqliteOrThrow(":memory:");
migrateDiscoveryDatabase(database);
const receipts = new ApiReceiptStore(database),
  manager = new PeerAccessManager(sourceId, root);
let runtime: Awaited<ReturnType<typeof createAgentApiRuntime>> | undefined;
let calls = 0;
try {
  await manager.initialize();
  await manager.setAgentAccess({ enabled: true });
  const parentId = randomUUID();
  const sources = {
    projects: async () => ({ items: [] }),
    sessions: async () => ({
      items: [
        {
          id: parentId,
          projectId: "source",
          provider: "codex",
          title: "Owned controller",
          state: "in-turn",
          updatedAt: "",
        },
      ],
    }),
    providers: async () => [],
  };
  const router = manager.bind(
    new CoreApi(sourceId, sources),
    database,
    receipts,
    sources.projects,
  );
  await manager.importOutgoing({
    invitation: peer.invitation,
    route: { kind: "direct", url },
    operations: operationIds,
    allowAgentSessions: true,
    replace: false,
  });
  runtime = await createAgentApiRuntime({ serverId: sourceId });
  runtime.attachController(router);
  const lease = runtime.issue({
    principal: SUPERUSER,
    sessionId: () => parentId,
    management: true,
    peerAccess: true,
    peerGrantId: manager.agentAccess().grantId,
  });
  const env = lease.environment;
  const api = <T = unknown>(path: string, body?: object, key?: string) =>
    new Promise<T>((resolve, reject) => {
      calls++;
      const req = request(
        new URL(path, env.AGENT_YA_V0_URL),
        {
          socketPath: env.AGENT_YA_V0_SOCKET,
          method: body ? "POST" : "GET",
          headers: {
            Authorization: env.AGENT_YA_V0_AUTHORIZATION,
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            let value: unknown;
            try {
              value = JSON.parse(text);
            } catch {
              value = text;
            }
            if (res.statusCode! >= 400)
              reject(
                Error(
                  `HTTP ${res.statusCode}: ${(value as { error?: { code?: string } })?.error?.code ?? "target rejected"}`,
                ),
              );
            else resolve(value as T);
          });
        },
      );
      req.setTimeout(15000, () => req.destroy(Error("Fixture HTTP deadline")));
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const until = async <T>(
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ) => {
    for (let i = 0; i < 120; i++) {
      const value = await read();
      if (ok(value)) return value;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error("Expected native observation unavailable");
  };
  const base = `/v0/servers/${peer.serverId}`;
  await api(base + "/help");
  await api(base + "/schema?operation=createSession");
  const input = {
    projectId: "p",
    provider: "codex",
    prompt: "Run the owned native peer approval check",
    permissionMode: "default",
  };
  const created = await api<ApiReceipt>(
    base + "/sessions",
    input,
    "cross-create-001",
  );
  const receipt = await until(
    () => api<ApiReceipt>(base + "/receipts/" + created.id),
    (r) => Boolean(r.sessionId),
  );
  const sid = receipt.sessionId;
  const requests = await until(
    () => api<PendingRequests>(`${base}/sessions/${sid}/requests`),
    (r) => r.items.some((item) => item.canRespond),
  );
  const response = await api<ApiReceipt>(
    `${base}/sessions/${sid}/requests/${requests.items[0]!.id}/response`,
    { response: "approve" },
    "cross-approve-001",
  );
  await until(
    () => api<ApiReceipt>(base + "/receipts/" + response.id),
    (r) => r.state === "accepted",
  );
  const output = await until(
    () => api(`${base}/sessions/${sid}/conversation`),
    (r) => JSON.stringify(r).includes("OWNED_WINDOWS_PEER_RESULT"),
  );
  if (!JSON.stringify(output).includes("OWNED_WINDOWS_PEER_RESULT"))
    throw Error("Native output missing");
  const prompt = { prompt: "WAIT_FOR_CROSS_HOST_CANCEL" };
  const sent = await api<ApiReceipt>(
    `${base}/sessions/${sid}/prompts`,
    prompt,
    "cross-prompt-001",
  );
  const retry = await api<ApiReceipt>(
    `${base}/sessions/${sid}/prompts`,
    prompt,
    "cross-prompt-001",
  );
  if (sent.id !== retry.id) throw Error("Prompt retry duplicated receipt");
  await until(
    () => api<ProbeSession>(`${base}/sessions/${sid}`),
    (r) => r.nativeProbeActive === true,
  );
  const cancelled = await api<ApiReceipt>(
    `${base}/sessions/${sid}/cancel`,
    {},
    "cross-cancel-001",
  );
  const cancelledResult = await until(
    () => api<ApiReceipt>(base + "/receipts/" + cancelled.id),
    (r) => r.state === "accepted",
  );
  if (!cancelledResult.result?.interrupted)
    throw Error("Native interruption failed");
  const stopped = await api<ApiReceipt>(
    `${base}/sessions/${sid}/stop`,
    {},
    "cross-stop-001",
  );
  const stoppedResult = await until(
    () => api<ApiReceipt>(base + "/receipts/" + stopped.id),
    (r) => r.state === "accepted",
  );
  if (!stoppedResult.result?.verifiedStopped)
    throw Error("Stop was not verified");
  const retained = await api<ProbeSession>(`${base}/sessions/${sid}`);
  if (retained.state !== "terminated")
    throw Error("Stopped session state unavailable");
  const provenance = await api<{ outbound: { items: ApiOutbound[] } }>(
    `/v0/servers/self/sessions/${parentId}/relationships`,
  );
  if (
    !provenance.outbound.items.some(
      (r) =>
        r.destinationSessionId === sid &&
        r.operation === "createSession" &&
        r.state === "confirmed",
    )
  )
    throw Error("Delayed creation binding missing");
  console.log(
    JSON.stringify({
      success: true,
      provider: "codex",
      calls,
      approval: true,
      actualNativeOutput: true,
      promptRetry: true,
      interrupt: true,
      verifiedStop: true,
      retainedSession: true,
      delayedProvenance: true,
      unknownSessionField: true,
    }),
  );
} finally {
  await runtime?.close();
  await manager.close();
  receipts.close();
  database.close();
  await rm(root, { recursive: true, force: true });
}
