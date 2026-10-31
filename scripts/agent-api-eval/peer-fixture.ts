import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayServer } from "../../packages/relay/src/server.js";
import { CoreApi } from "../../packages/server/src/core-api/service.js";
import {
  operations,
  type ApiProject,
} from "../../packages/server/src/core-api/contracts.js";
import type { ApiReceiptStore } from "../../packages/server/src/core-api/receipt-store.js";
import { PeerAccessManager } from "../../packages/server/src/peer-api/manager.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../packages/server/src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../packages/server/src/storage/discovery-sqlite.js";
import { ApiReceiptStore as ReceiptStore } from "../../packages/server/src/core-api/receipt-store.js";
import { SERVER_ID, OWN_SESSION_ID } from "./cases.js";

export const PEER_SERVER_ID = "00000000-0000-4000-8000-000000000002";

/** Real private profiles and encrypted owned relay, with scripted native work. */
export async function createPeerEvalRouter(
  target: CoreApi,
  database: SqliteDatabase,
  receipts: ApiReceiptStore,
  projects: ApiProject[],
) {
  const root = await mkdtemp(join(tmpdir(), "ya-peer-eval-"));
  const sourceDb = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(sourceDb);
  const sourceReceipts = new ReceiptStore(sourceDb);
  const a = new PeerAccessManager(SERVER_ID, join(root, "source")),
    b = new PeerAccessManager(PEER_SERVER_ID, join(root, "target"));
  let relay: Awaited<ReturnType<typeof createRelayServer>> | undefined;
  const close = async () => {
    await a.close();
    await b.close();
    await relay?.close();
    sourceReceipts.close();
    sourceDb.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    await a.initialize();
    await b.initialize();
    b.bind(target, database, receipts, async () => ({ items: projects }));
    const sources = {
      projects: async () => ({ items: [] }),
      sessions: async () => ({
        items: [
          {
            id: OWN_SESSION_ID,
            projectId: "source",
            title: "Eval owner",
            provider: "codex",
            state: "in-turn",
            updatedAt: "",
          },
        ],
      }),
      providers: async () => [],
    };
    const router = a.bind(
      new CoreApi(SERVER_ID, sources),
      sourceDb,
      sourceReceipts,
      sources.projects,
    );
    relay = await createRelayServer({
      inMemoryDb: true,
      disableTelemetry: true,
      logLevel: "silent",
      disablePrettyPrint: true,
      webSocketMaxMessageBytes: 384 * 1024,
    });
    const url = `ws://127.0.0.1:${relay.port}/ws`,
      username = "peer-eval-target";
    await b.store.configureRelay({ url, username });
    const deadline = performance.now() + 5000;
    while (b.publicState().relay?.status !== "waiting") {
      if (performance.now() >= deadline)
        throw new Error("Owned peer eval relay did not register");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const granted = operations
      .filter((operation) => operation.path.includes(":serverId"))
      .map((operation) => operation.id);
    const invitation = await b.issue({
      sourceServerId: SERVER_ID,
      projects: projects.map((p) => p.id),
      operations: granted,
      expiresAt: Date.now() + 10 * 60_000,
      acknowledgeExecutionAuthority: "server-account",
    });
    await a.setAgentAccess({ enabled: true });
    await a.importOutgoing({
      invitation,
      route: { kind: "relay", url, username },
      operations: granted,
      allowAgentSessions: true,
      replace: false,
    });
    return { router, grantId: a.agentAccess().grantId!, close };
  } catch (error) {
    await close();
    throw error;
  }
}
