import { nativeAppTestFixture } from "./fixture.js";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectNestedHarnessLaunch,
  parseYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import { SessionRelationshipStore } from "../../src/sessions/SessionRelationshipStore.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteRunResult,
  type SqliteValue,
} from "../../src/storage/sqlite.js";
import { quoteShellWord } from "../../src/utils/posixShell.js";
import { appBarrier } from "../native-provider/app-fixture.js";
import { nativeExecutable } from "../native-provider/runtimes.js";

interface NativeRow {
  type?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    content?: string | { type: string; name?: string; input?: unknown }[];
  };
}

/** The app may be writing its profile while this test removes derived rows. */
async function removeDerivedIndex(
  database: SqliteDatabase,
  remove: (
    run: (sql: string, ...parameters: SqliteValue[]) => SqliteRunResult,
  ) => void,
  alive: () => Promise<unknown>,
) {
  const outcome = await appBarrier(async () => {
    await alive(); // Fence retries when the owning fixture closes.
    try {
      database.transaction(() =>
        remove((sql, ...parameters) => {
          const statement = database.prepare(sql);
          try {
            return statement.run(...parameters);
          } finally {
            statement.finalize();
          }
        }),
      );
      return { committed: true as const };
    } catch (error) {
      // Only SQLite's writer contention is retryable; schema/assertion and
      // other failures must surface directly rather than spend the barrier.
      if (
        error &&
        typeof error === "object" &&
        "errcode" in error &&
        error.errcode === 5
      )
        throw error; // appBarrier retains the actual contention diagnostic.
      return { committed: false as const, error };
    }
  }, "owned derived-index mutation after concurrent app writes");
  if (!outcome.committed) throw outcome.error;
}

let fixture: Awaited<ReturnType<typeof nativeAppTestFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(await fixture.diagnostics());
  await fixture?.close();
  fixture = undefined;
});

describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "native named nested harness evidence",
  () => {
    it.for(["admin-route", "wrapper-signal"] as const)(
      "preserves named launch evidence across %s replacement and indexes only new copy commands",
      {
        timeout: 40_000,
      },
      async (replacement, context) => {
        const f = await nativeAppTestFixture("claude", context);
        fixture = f;
        await f.ready();
        const parent = await f.create("NESTED_HARNESS_PARENT_INITIAL");
        const first = await f.model.next();
        const childId = randomUUID(),
          executable = nativeExecutable("claude");
        const inspect = async (sessionId = parent.sessionId) => {
          await f.api("/version"); // Teardown fence for every publication wait.
          const db = loadSqliteDriver()!.open(
            join(f.root, "home", "ya", "discovery.sqlite"),
            { readOnly: true },
          );
          const server = db.prepare(
            "SELECT server_id FROM public_server_identity WHERE singleton=1",
          );
          let identities: SessionIdentityStore | undefined,
            graph: SessionRelationshipStore | undefined;
          try {
            db.exec("BEGIN");
            identities = new SessionIdentityStore(db);
            graph = new SessionRelationshipStore(db);
            const identity = identities.resolveYa(parseYaSessionId(sessionId));
            const serverId = server.get<{ server_id: string }>()?.server_id;
            if (!identity?.native || !serverId) return undefined;
            const resource = {
              kind: "native" as const,
              serverId,
              native: identity.native,
            };
            const target = {
              kind: "native" as const,
              serverId,
              native: nativeSessionRef(
                "claude",
                identity.native.storageScope,
                parseNativeSessionId(childId),
              ),
            };
            const edges = graph.list({
              resource,
              direction: "outgoing",
              type: "launched_harness",
            }).edges;
            const view = {
              identity,
              edges,
              pending: graph.checkpoint("nested-harness-pending-v1", sessionId),
              historyScan: graph.checkpoint(
                "nested-harness-history-scan-v1",
                sessionId,
              ),
              incoming: graph.list({
                resource: target,
                direction: "incoming",
                type: "launched_harness",
              }).edges,
              evidence: edges[0] ? graph.evidence(edges[0].id) : [],
              providerChildren: graph.list({
                resource: target,
                type: "provider_child",
              }).edges,
              created: graph.list({
                resource: { kind: "session", serverId, sessionId: childId },
                type: "created_session",
              }).edges,
            };
            db.exec("COMMIT");
            return view;
          } finally {
            server.finalize();
            identities?.close();
            graph?.dispose();
            db.close();
          }
        };
        expect(basename(executable)).toBe("claude");
        const command = `unset CLAUDECODE; cd ${quoteShellWord(f.project)} && ${quoteShellWord(executable)} --session-id ${childId} --print --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-haiku-5-5 NESTED_HARNESS_CHILD_INITIAL`;
        expect(detectNestedHarnessLaunch(command)).toEqual({
          harness: "claude",
          sessionId: childId,
          workingDirectory: f.project,
        });
        first.tool("Bash", {
          command,
          timeout: 20000,
          description: "Run one owned named harness",
        });
        const child = await f.model.next();
        expect(JSON.stringify(child.body)).toContain(
          "NESTED_HARNESS_CHILD_INITIAL",
        );
        expect(JSON.stringify(child.body)).not.toContain(
          "NESTED_HARNESS_PARENT_INITIAL",
        );
        const pending = await appBarrier(async () => {
          const view = await inspect();
          return view?.pending ? view : false;
        }, "durable pending harness correlation");
        expect(pending.pending?.state).toBe("partial");
        expect(JSON.parse(pending.pending!.cursor).hints).toEqual([
          expect.objectContaining({ targetId: childId, ready: false }),
        ]);
        const parentWorker = (await f.inventory()).find(
          (w) => w.providerSessionId === pending.identity.native!.id,
        );
        expect(parentWorker).toBeDefined();
        if (!parentWorker) throw Error("Native parent owner missing");
        if (replacement === "admin-route") await f.api("/server/restart", {});
        else await f.reload();
        const attached = await appBarrier(async () => {
          const next = (await f.inventory()).find(
            (w) => w.runtimeId === parentWorker.runtimeId,
          );
          return next?.attachedServerGeneration &&
            next.attachedServerGeneration !==
              parentWorker.attachedServerGeneration
            ? next
            : false;
        }, "pending harness API replacement");
        expect(attached.pid).toBe(parentWorker.pid);
        expect(attached.providerProcessGroupIds).toEqual(
          parentWorker.providerProcessGroupIds,
        );
        await appBarrier(
          async () => await f.api("/version"),
          "replacement API ready",
        );
        const reconnected = await f.connect(parent.sessionId);
        child.finish("NESTED_HARNESS_CHILD_DONE");
        const continued = await f.model.next();
        expect(JSON.stringify(continued.body)).toContain(childId);
        expect(JSON.stringify(continued.body)).toContain(
          "NESTED_HARNESS_CHILD_DONE",
        );
        // A named fresh launch against an already persisted id must fail without
        // supporting another launch observation. This exercises native Bash's
        // actual is_error result, rather than a fabricated tool-result fixture.
        continued.tool("Bash", { command, timeout: 20000 });
        const rejected = await f.model.next();
        expect(JSON.stringify(rejected.body)).toContain("already in use");
        expect(JSON.stringify(rejected.body)).toContain('"is_error":true');
        rejected.finish("NESTED_HARNESS_PARENT_DONE");
        await reconnected.wait("NESTED_HARNESS_PARENT_DONE");
        await reconnected.wait('"type":"result"');
        let accepted = await appBarrier(async () => {
          const view = await inspect();
          return view?.edges.length ? view : false;
        }, "accepted named harness edge");
        expect(accepted.edges).toHaveLength(1);
        expect(accepted.incoming).toEqual(accepted.edges);
        expect(accepted.edges[0]?.target).toMatchObject({
          kind: "native",
          native: {
            id: childId,
            family: "claude",
            storageScope: accepted.identity.native!.storageScope,
          },
        });
        expect(accepted.evidence).toEqual([
          expect.objectContaining({
            producer: "nested-harness-command-v1",
            trust: "command-observed",
            metadata: { toolUseId: `call_${first.id}` },
          }),
        ]);
        expect(accepted.pending?.state).toBe("complete");
        expect(accepted.providerChildren).toEqual([]);
        expect(accepted.created).toEqual([]);
        // Fault injection in this owned profile models a session recorded before
        // the live relationship producer existed. Keep the actual native files
        // and admission unchanged; remove only this one launch's derived index.
        const oldIndex = loadSqliteDriver()!.open(
          join(f.root, "home", "ya", "discovery.sqlite"),
        );
        try {
          await removeDerivedIndex(
            oldIndex,
            (run) => {
              run(
                "DELETE FROM session_relationship_evidence WHERE edge_id = ?",
                accepted.edges[0]!.id,
              );
              expect(
                run(
                  "DELETE FROM session_relationship_edges WHERE id = ?",
                  accepted.edges[0]!.id,
                ).changes,
              ).toBe(1);
              run(
                "DELETE FROM session_relationship_checkpoints WHERE producer = 'nested-harness-complete-v1' AND source_key = ?",
                JSON.stringify([parent.sessionId, `call_${first.id}`]),
              );
            },
            () => f.api("/version"),
          );
        } finally {
          oldIndex.close();
        }
        await f.api(
          `/projects/${parent.projectId}/sessions/${parent.sessionId}?tailCompactions=2&tailTurns=20`,
        );
        accepted = await appBarrier(async () => {
          const view = await inspect();
          return view?.evidence.some(
            (e) => e.producer === "nested-harness-history-v1",
          )
            ? view
            : false;
        }, "historical command acquisition from actual native rows");
        expect(accepted.evidence).toEqual([
          expect.objectContaining({
            producer: "nested-harness-history-v1",
            trust: "command-observed",
            metadata: {
              toolUseId: `call_${first.id}`,
              sourceTimestamp: expect.any(String),
            },
          }),
        ]);
        expect(accepted.edges).toHaveLength(1);
        await f.api(
          `/projects/${parent.projectId}/sessions/${childId}/metadata`,
        );
        const identity = async (sessionId: string) =>
          appBarrier(async () => {
            await f.api("/version");
            const db = loadSqliteDriver()!.open(
              join(f.root, "home", "ya", "discovery.sqlite"),
              { readOnly: true },
            );
            let identities: SessionIdentityStore | undefined;
            try {
              identities = new SessionIdentityStore(db);
              const row = identities.resolveYa(parseYaSessionId(sessionId));
              return row?.native ? row : false;
            } finally {
              identities?.close();
              db.close();
            }
          }, "native source identity");
        const original = await identity(parent.sessionId);
        const rows = async (id: string, scope: string): Promise<NativeRow[]> =>
          (await readFile(join(scope, id + ".jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const commandRows = (entries: NativeRow[]) =>
          entries.filter(
            (row) =>
              row.type === "assistant" &&
              Array.isArray(row.message?.content) &&
              row.message.content.some(
                (block) =>
                  block.type === "tool_use" &&
                  block.name === "Bash" &&
                  block.input !== null &&
                  typeof block.input === "object" &&
                  "command" in block.input &&
                  block.input.command === command,
              ),
          );
        const originalCommands = commandRows(
          await rows(original.native!.id, original.native!.storageScope),
        );
        expect(originalCommands).toHaveLength(2);
        const childRows = await rows(childId, original.native!.storageScope);
        expect(childRows.some((row) => row.sessionId === childId)).toBe(true);
        expect(childRows.some((row) => row.isSidechain === true)).toBe(false);
        // Exercise both actual copy writers without another app/native startup.
        const fullClone = replacement === "wrapper-signal";
        const fork = await f.api(
          `/projects/${parent.projectId}/sessions/${parent.sessionId}/${fullClone ? "clone" : "fork"}`,
          fullClone ? {} : { forkKind: "clone-latest-complete" },
        );
        const copied = await identity(fork.sessionId);
        const copiedCommands = commandRows(
          await rows(copied.native!.id, copied.native!.storageScope),
        );
        expect(copiedCommands).toHaveLength(2);
        for (let index = 0; index < originalCommands.length; index++) {
          expect(originalCommands[index]!.sessionId).toBe(original.native!.id);
          expect(copiedCommands[index]!.sessionId).toBe(
            fullClone ? original.native!.id : copied.native!.id,
          );
          if (fullClone)
            expect(copiedCommands[index]!.uuid).toBe(
              originalCommands[index]!.uuid,
            );
          else
            expect(copiedCommands[index]!.uuid).not.toBe(
              originalCommands[index]!.uuid,
            );
          expect(copiedCommands[index]!.timestamp).toBe(
            originalCommands[index]!.timestamp,
          );
          expect(Date.parse(copiedCommands[index]!.timestamp!)).toBeLessThan(
            Date.parse(copied.createdAt),
          );
        }
        await f.api(
          `/projects/${parent.projectId}/sessions/${fork.sessionId}/resume`,
          {
            message: "NESTED_FORK_CONTINUE_ONLY",
            mode: "bypassPermissions",
          },
        );
        const forkConnection = await f.connect(fork.sessionId);
        const forkReply = await f.model.next();
        expect(JSON.stringify(forkReply.body)).toContain(
          "NESTED_FORK_CONTINUE_ONLY",
        );
        const freshChildId = randomUUID();
        const freshCommand = command
          .replaceAll(childId, freshChildId)
          .replace("NESTED_HARNESS_CHILD_INITIAL", "NESTED_FORK_CHILD_INITIAL");
        forkReply.tool("Bash", { command: freshCommand, timeout: 20000 });
        const freshChild = await f.model.next();
        expect(JSON.stringify(freshChild.body)).toContain(
          "NESTED_FORK_CHILD_INITIAL",
        );
        freshChild.finish("NESTED_FORK_CHILD_DONE");
        const freshContinuation = await f.model.next();
        expect(JSON.stringify(freshContinuation.body)).toContain(
          "NESTED_FORK_CHILD_DONE",
        );
        freshContinuation.finish("NESTED_FORK_DONE");
        await forkConnection.wait("NESTED_FORK_DONE");
        await forkConnection.wait('"type":"result"');
        await f.api(
          `/projects/${parent.projectId}/sessions/${fork.sessionId}?tailCompactions=2&tailTurns=20`,
        );
        // A positive control behind the fork's queued turn fences this negative
        // check. Re-acquire the original's actual history in the same two-worker
        // LRU coordinator, rather than assuming a /version round trip drained it.
        const control = loadSqliteDriver()!.open(
          join(f.root, "home", "ya", "discovery.sqlite"),
        );
        try {
          await removeDerivedIndex(
            control,
            (run) => {
              run(
                "DELETE FROM session_relationship_evidence WHERE edge_id = ?",
                accepted.edges[0]!.id,
              );
              expect(
                run(
                  "DELETE FROM session_relationship_edges WHERE id = ?",
                  accepted.edges[0]!.id,
                ).changes,
              ).toBe(1);
              run(
                "DELETE FROM session_relationship_checkpoints WHERE producer = ? AND source_key = ?",
                "nested-harness-history-scan-v1",
                parent.sessionId,
              );
              run(
                "DELETE FROM session_relationship_checkpoints WHERE producer = ? AND source_key = ?",
                "nested-harness-complete-v1",
                JSON.stringify([
                  parent.sessionId,
                  `call_${first.id}`,
                  "history",
                ]),
              );
            },
            () => f.api("/version"),
          );
        } finally {
          control.close();
        }
        await f.api(
          `/projects/${parent.projectId}/sessions/${parent.sessionId}?tailCompactions=2&tailTurns=20`,
        );
        accepted = await appBarrier(async () => {
          const view = await inspect();
          return view?.edges.length && view.historyScan?.state === "complete"
            ? view
            : false;
        }, "positive history control after copied-fork turn");
        const forkGraph = await inspect(fork.sessionId);
        expect(forkGraph).not.toBe(false);
        if (!forkGraph) throw Error("Fork identity unavailable");
        expect(forkGraph.edges).toHaveLength(1);
        expect(forkGraph.edges[0]!.target).toMatchObject({
          kind: "native",
          native: { id: freshChildId },
        });
        expect(forkGraph.incoming).toEqual(accepted.edges);
        // Keep the actual copy and new native command/result, but remove the
        // derived edge and scan progress. After API replacement, only the
        // ordinary historical read can restore this new launch in the copy.
        const copiedIndex = loadSqliteDriver()!.open(
          join(f.root, "home", "ya", "discovery.sqlite"),
        );
        try {
          await removeDerivedIndex(
            copiedIndex,
            (run) => {
              run(
                "DELETE FROM session_relationship_evidence WHERE edge_id = ?",
                forkGraph.edges[0]!.id,
              );
              expect(
                run(
                  "DELETE FROM session_relationship_edges WHERE id = ?",
                  forkGraph.edges[0]!.id,
                ).changes,
              ).toBe(1);
              run(
                "DELETE FROM session_relationship_checkpoints WHERE producer = 'nested-harness-history-scan-v1' AND source_key = ?",
                fork.sessionId,
              );
              for (const key of [
                [fork.sessionId, `call_${forkReply.id}`],
                [fork.sessionId, `call_${forkReply.id}`, "history"],
              ])
                run(
                  "DELETE FROM session_relationship_checkpoints WHERE producer = 'nested-harness-complete-v1' AND source_key = ?",
                  JSON.stringify(key),
                );
            },
            () => f.api("/version"),
          );
        } finally {
          copiedIndex.close();
        }
        const copyWorker = (await f.inventory()).find(
          (w) => w.providerSessionId === copied.native!.id,
        );
        if (!copyWorker) throw Error("Native copy owner missing");
        await f.api("/server/restart", {});
        await appBarrier(async () => {
          const next = (await f.inventory()).find(
            (w) => w.runtimeId === copyWorker.runtimeId,
          );
          return next?.attachedServerGeneration &&
            next.attachedServerGeneration !==
              copyWorker.attachedServerGeneration
            ? next
            : false;
        }, "copy history replacement generation");
        await appBarrier(
          async () =>
            await f.api(
              `/projects/${parent.projectId}/sessions/${fork.sessionId}?tailCompactions=2&tailTurns=20`,
            ),
          "copy historical detail after reattachment",
        );
        const restoredCopy = await appBarrier(async () => {
          const view = await inspect(fork.sessionId);
          return view?.historyScan?.state === "complete" &&
            view.evidence.some(
              (e) => e.producer === "nested-harness-history-v1",
            )
            ? view
            : false;
        }, "post-copy historical command acquisition");
        expect(restoredCopy.edges).toEqual(forkGraph.edges);
        expect(restoredCopy.evidence).toEqual([
          expect.objectContaining({
            producer: "nested-harness-history-v1",
            metadata: {
              toolUseId: `call_${forkReply.id}`,
              sourceTimestamp: expect.any(String),
            },
          }),
        ]);
        // Historical relationship facts survive native loss and another API.
        await unlink(join(original.native!.storageScope, childId + ".jsonl"));
        await f.api("/server/restart", {});
        await appBarrier(
          async () => await f.api("/version"),
          "historical harness API",
        );
        const historical = await inspect();
        expect(historical?.edges).toEqual(accepted.edges);
        await f.close();
        expect(f.model.failures).toEqual([]);
        expect(f.model.requests).toHaveLength(7);
      },
    );
  },
);
