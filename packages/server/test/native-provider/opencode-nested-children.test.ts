import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { nativeFixture } from "./fixture.js";
import { historyReader } from "./history.js";
import { providers } from "./selection.js";
import type { Exchange } from "./model-server.js";

function resultFor(request: Exchange, call: Exchange): string {
  const messages = request.body.messages as Array<{
    role?: string;
    tool_call_id?: string;
    content?: unknown;
  }>;
  const result = messages.find(
    (message) =>
      message.role === "tool" && message.tool_call_id === `call_${call.id}`,
  );
  expect(result).toBeDefined();
  return JSON.stringify(result!.content);
}

it.skipIf(!providers.includes("opencode"))(
  "retains immediate native parents through nested Tasks and refuses another depth",
  async () => {
    const f = await nativeFixture("opencode", "gentle", {
      openCodeNestedTasks: true,
    });
    let disposeProjection = async () => {};
    onTestFinished(async () => {
      try {
        await disposeProjection();
      } finally {
        await f.close();
      }
    });
    try {
      const root = await f.model.next();
      root.tool("task", {
        description: "Owned nested child",
        prompt: "CHILD_DEPTH_INPUT. Delegate then reply CHILD_DEPTH_REPLY.",
        subagent_type: "general",
      });
      const child = await f.model.next();
      expect(JSON.stringify(child.body)).toContain("CHILD_DEPTH_INPUT");
      expect(child.body.tools).toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: "task" }),
        }),
      );
      child.tool("task", {
        description: "Owned native grandchild",
        prompt: "GRANDCHILD_DEPTH_INPUT. Reply GRANDCHILD_DEPTH_REPLY.",
        subagent_type: "general",
      });
      const grandchild = await f.model.next();
      expect(JSON.stringify(grandchild.body)).toContain(
        "GRANDCHILD_DEPTH_INPUT",
      );
      grandchild.tool("task", {
        description: "Refused native depth",
        prompt: "REFUSED_DEPTH_INPUT must never reach another model request.",
        subagent_type: "general",
      });
      const refused = await f.model.next();
      expect(resultFor(refused, grandchild)).toContain(
        "Subagent depth limit reached (2)",
      );
      refused.finish("GRANDCHILD_DEPTH_REPLY");
      const childContinuation = await f.model.next();
      expect(resultFor(childContinuation, child)).toContain(
        "GRANDCHILD_DEPTH_REPLY",
      );
      childContinuation.finish("CHILD_DEPTH_REPLY");
      const rootContinuation = await f.model.next();
      expect(resultFor(rootContinuation, root)).toContain("CHILD_DEPTH_REPLY");
      rootContinuation.finish("ROOT_DEPTH_DONE");
      await f.idle();
      await f.stop();

      // Independent native rows establish both actual ids and immediate
      // parents. The refused Task must not allocate a fourth native session.
      const nativeRoot = await realpath(
        join(f.environment.XDG_DATA_HOME!, "opencode"),
      );
      const nativeDb = loadSqliteDriver()!.open(
        join(nativeRoot, "opencode.db"),
        {
          readOnly: true,
        },
      );
      let childId: string, grandchildId: string;
      try {
        const query = nativeDb.prepare(
          "SELECT id, parent_id, directory FROM session",
        );
        try {
          const rows = query.all<{
            id: string;
            parent_id: string | null;
            directory: string;
          }>();
          expect(rows).toHaveLength(3);
          const ownChild = rows.find((row) => row.parent_id === f.nativeId());
          expect(ownChild).toBeDefined();
          childId = ownChild!.id;
          const ownGrandchild = rows.find((row) => row.parent_id === childId);
          expect(ownGrandchild).toBeDefined();
          grandchildId = ownGrandchild!.id;
          expect(new Set([f.nativeId(), childId, grandchildId]).size).toBe(3);
          expect(rows.every((row) => row.directory === f.project)).toBe(true);
        } finally {
          query.finalize();
        }
      } finally {
        nativeDb.close();
      }
      expect(resultFor(rootContinuation, root)).toContain(childId);
      expect(resultFor(childContinuation, child)).toContain(grandchildId);
      const reader = await historyReader(
        "opencode",
        f.project,
        f.environment,
        f.nativeId(),
        f.executable,
      );
      const dataDir = join(f.root, "relationship-reopen");
      let db: DiscoverySqliteService | undefined;
      let index: ProviderChildRelationshipService | undefined;
      const errors: unknown[] = [];
      // Two finite publication waits, released on error or hook-driven cleanup.
      const waiting = new Map<
        string,
        { resolve(): void; reject(error: unknown): void }
      >();
      const publication = (sessionId: string) =>
        new Promise<void>((resolve, reject) =>
          waiting.set(sessionId, { resolve, reject }),
        );
      const failPublications = (error: unknown) => {
        for (const waiter of waiting.values()) waiter.reject(error);
        waiting.clear();
      };
      disposeProjection = async () => {
        failPublications(new Error("Native relationship fixture disposed"));
        try {
          await reader.close?.();
        } finally {
          try {
            await index?.close();
          } finally {
            db?.close();
          }
        }
      };
      try {
        db = new DiscoverySqliteService({
          dataDir,
          probeNetworkFilesystem: () => undefined,
        });
        index = new ProviderChildRelationshipService(
          db.getDatabase(),
          "native-test",
          (owner) => {
            waiting.get(owner.sessionId)?.resolve();
            waiting.delete(owner.sessionId);
          },
          (error) => {
            errors.push(error);
            failPublications(error);
          },
        );
        expect(
          (await reader.listSessions(toUrlProjectId(f.project))).map(
            (row) => row.id,
          ),
        ).toEqual([f.nativeId()]);
        expect(
          (await reader.listProviderChildSessions!(f.nativeId())).map(
            (row) => row.id,
          ),
        ).toEqual([childId]);
        expect(
          (await reader.listProviderChildSessions!(childId)).map(
            (row) => row.id,
          ),
        ).toEqual([grandchildId]);
        expect(await reader.getAgentMappings(f.nativeId())).toContainEqual({
          agentId: childId,
          toolUseId: `call_${root.id}`,
        });
        expect(await reader.getAgentMappings(childId)).toContainEqual({
          agentId: grandchildId,
          toolUseId: `call_${child.id}`,
        });
        expect(
          await reader.getAgentSession(grandchildId, f.nativeId()),
        ).toBeNull();
        const content = await reader.getAgentSession(grandchildId, childId);
        expect(
          content?.messages.some(
            (message) =>
              message.type === "assistant" &&
              JSON.stringify(message.message?.content ?? "").includes(
                "GRANDCHILD_DEPTH_REPLY",
              ),
          ),
        ).toBe(true);
        const parent = nativeSessionRef(
          "opencode",
          nativeRoot,
          parseNativeSessionId(f.nativeId()),
        );
        const nested = nativeSessionRef(
          "opencode",
          nativeRoot,
          parseNativeSessionId(childId),
        );
        const leaf = nativeSessionRef(
          "opencode",
          nativeRoot,
          parseNativeSessionId(grandchildId),
        );
        const rootCommitted = publication("canonical-root");
        index.demand(
          parent,
          { sessionId: "canonical-root" },
          reader.getProviderChildSource!(parent)!,
        );
        await rootCommitted;
        expect(
          index.accepted(parent, "canonical-root")?.map((row) => row.id),
        ).toEqual([childId]);
        expect(
          index.accepted(nested, "canonical-child")?.map((row) => row.id),
        ).toEqual([grandchildId]);
        const leafCommitted = publication("canonical-grandchild");
        index.demand(
          leaf,
          { sessionId: "canonical-grandchild" },
          reader.getProviderChildSource!(leaf)!,
        );
        await leafCommitted;
        expect(index.accepted(leaf, "canonical-grandchild")).toEqual([]);
        const evidence = db
          .getDatabase()
          .prepare("SELECT metadata FROM session_relationship_evidence");
        try {
          const saved = JSON.stringify(evidence.all());
          expect(saved).not.toContain("DEPTH_INPUT");
          expect(saved).not.toContain("DEPTH_REPLY");
        } finally {
          evidence.finalize();
        }
        await reader.close?.();
        await index.close();
        db.close();
        await rm(nativeRoot, { recursive: true });
        db = new DiscoverySqliteService({
          dataDir,
          probeNetworkFilesystem: () => undefined,
        });
        index = new ProviderChildRelationshipService(
          db.getDatabase(),
          "native-test",
          () => {},
        );
        expect(index.accepted(parent, "canonical-root")).toMatchObject([
          { id: childId, parentSessionId: "canonical-root" },
        ]);
        expect(index.accepted(nested, "canonical-child")).toMatchObject([
          { id: grandchildId, parentSessionId: "canonical-child" },
        ]);
        expect(index.accepted(leaf, "canonical-grandchild")).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await disposeProjection();
      }
    } finally {
      await f.close();
    }
    // Check after joined native teardown, including unexpected late requests.
    expect(f.model.requests).toHaveLength(6);
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
    expect(f.diagnostics).toEqual([]);
  },
  // Native startup, two Tasks, a refused Task and SQL reopen took 3.03–3.13 s
  // locally; the all-native 69-case run also passed (42.25 s total). Twelve
  // seconds is 3.8x that observed maximum; hosted slow-machine evidence pending.
  12000,
);
