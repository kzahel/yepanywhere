import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
} from "@yep-anywhere/shared";
import { nativeAppTestFixture } from "./fixture.js";
import { appBarrier } from "../native-provider/app-fixture.js";
import { nativeExecutable } from "../native-provider/runtimes.js";
import { quoteShellWord } from "../../src/utils/posixShell.js";
import { claudeCwdProjectDirectory } from "../../src/projects/claude-project-directory.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import { SessionRelationshipStore } from "../../src/sessions/SessionRelationshipStore.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import type { Exchange } from "../native-provider/model-server.js";

it
  .runIf(process.env.YEP_NATIVE_APP_TESTS === "1")
  .for(["claude", "codex"] as const)(
  "%s retains an explicit Claude destination through pending reload and rejects failed reuse",
  {
    // The existing hosted M1 app path exhausted 40s; 80s is 2x that lower
    // bound. The owned listener/readiness barriers keep their existing limits.
    timeout: 80_000,
  },
  async (provider, context) => {
    const f = await nativeAppTestFixture(provider, context, {
      additionalProviders: ["claude"],
    });
    try {
      await f.ready();
      const parent = await f.create("EXPLICIT_HARNESS_PARENT_INPUT");
      const first = await f.model.next();
      const connection = await f.connect(parent.sessionId);
      const targetId = randomUUID(),
        config = join(f.root, "explicit-claude");
      const targetScope = join(
        config,
        "projects",
        claudeCwdProjectDirectory(f.project),
      );
      const inheritedScope = join(
        f.env.CLAUDE_CONFIG_DIR!,
        "projects",
        claudeCwdProjectDirectory(f.project),
      );
      await mkdir(config, { recursive: true });
      await mkdir(inheritedScope, { recursive: true });
      // A same-id transcript in the inherited profile must never steal the
      // command's explicit destination. Its header is deliberately plausible.
      const incumbent =
        JSON.stringify({
          sessionId: targetId,
          cwd: f.project,
          isSidechain: false,
        }) + "\n";
      await writeFile(join(inheritedScope, targetId + ".jsonl"), incumbent);
      const command = `cd ${quoteShellWord(f.project)} && /usr/bin/env CLAUDE_CONFIG_DIR=${quoteShellWord(config)} CLAUDECODE= ${quoteShellWord(nativeExecutable("claude"))} --session-id ${targetId} --print --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-haiku-5-5 EXPLICIT_HARNESS_CHILD_INPUT`;
      const invoke = (request: Exchange) =>
        provider === "claude"
          ? request.tool("Bash", { command, timeout: 30000 })
          : request.tool(
              "exec",
              `let r=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(f.project)},yield_time_ms:1000,max_output_tokens:5000});text(JSON.stringify(r));while(r.session_id){r=await tools.write_stdin({session_id:r.session_id,chars:"",yield_time_ms:1000,max_output_tokens:5000});text(JSON.stringify(r));}`,
            );
      const inspect = async () => {
        await f.api("/version");
        const db = loadSqliteDriver()!.open(
          join(f.root, "home", "ya", "discovery.sqlite"),
          { readOnly: true },
        );
        const identities = new SessionIdentityStore(db),
          graph = new SessionRelationshipStore(db);
        const statement = db.prepare(
          "SELECT server_id FROM public_server_identity WHERE singleton=1",
        );
        try {
          db.exec("BEGIN");
          const identity = identities.resolveYa(
            parseYaSessionId(parent.sessionId),
          );
          const serverId = statement.get<{ server_id: string }>()?.server_id;
          if (!identity?.native || !serverId) {
            db.exec("ROLLBACK");
            return undefined;
          }
          const target = (scope: string) => ({
            kind: "native" as const,
            serverId,
            native: nativeSessionRef(
              "claude",
              scope,
              parseNativeSessionId(targetId),
            ),
          });
          const edges = graph.list({
            resource: { kind: "native", serverId, native: identity.native },
            type: "launched_harness",
            direction: "outgoing",
          }).edges;
          const result = {
            identity,
            edges,
            pending: graph.checkpoint(
              "nested-harness-pending-v1",
              parent.sessionId,
            ),
            incoming: graph.list({
              resource: target(targetScope),
              direction: "incoming",
              type: "launched_harness",
            }).edges,
            wrongIncoming: graph.list({
              resource: target(inheritedScope),
              direction: "incoming",
              type: "launched_harness",
            }).edges,
            providerChildren: graph.list({
              resource: target(targetScope),
              type: "provider_child",
            }).edges,
            creation: graph.list({
              resource: target(targetScope),
              type: "created_session",
            }).edges,
            evidence: edges.flatMap((edge) => graph.evidence(edge.id)),
          };
          db.exec("COMMIT");
          return result;
        } finally {
          statement.finalize();
          identities.close();
          graph.dispose();
          db.close();
        }
      };
      invoke(first);
      const child = await f.model.next();
      expect(child.wire).toBe("anthropic");
      expect(JSON.stringify(child.body)).toContain(
        "EXPLICIT_HARNESS_CHILD_INPUT",
      );
      expect(JSON.stringify(child.body)).not.toContain(
        "EXPLICIT_HARNESS_PARENT_INPUT",
      );
      await appBarrier(
        async () =>
          (
            await readFile(join(targetScope, targetId + ".jsonl"), "utf8")
          ).includes("EXPLICIT_HARNESS_CHILD_INPUT"),
        "explicit native child input committed",
      );
      if (provider === "codex")
        await appBarrier(
          async () =>
            connection.events.some((event) => {
              const data = event.data as Record<string, unknown> | undefined;
              return data?.type === "user" && data._isStreaming === true;
            }),
          "actual Codex streaming tool output before completion",
        );
      const pending = await appBarrier(async () => {
        const view = await inspect();
        return view?.pending?.state === "partial" ? view : false;
      }, "explicit destination pending SQL");
      expect(pending.edges).toEqual([]);
      const cursor = JSON.parse(pending.pending!.cursor);
      expect(cursor.v).toBe(2);
      expect(cursor.native).toEqual(pending.identity.native);
      expect(cursor.hints).toEqual([
        expect.objectContaining({
          ready: false,
          targetId,
          target: { family: "claude", storageScope: targetScope, id: targetId },
        }),
      ]);
      expect(pending.identity.native!.family).toBe(provider);
      const owner = (await f.inventory()).find(
        (worker) => worker.providerSessionId === pending.identity.native!.id,
      );
      if (!owner) throw Error("Native explicit-launch owner missing");
      await f.api("/server/restart", {});
      const attached = await appBarrier(async () => {
        const next = (await f.inventory()).find(
          (worker) => worker.runtimeId === owner.runtimeId,
        );
        return next?.attachedServerGeneration &&
          next.attachedServerGeneration !== owner.attachedServerGeneration
          ? next
          : false;
      }, "explicit destination replacement generation");
      expect(attached.pid).toBe(owner.pid);
      expect(attached.providerProcessGroupIds).toEqual(
        owner.providerProcessGroupIds,
      );
      const reconnected = await appBarrier(
        async () => await f.connect(parent.sessionId),
        "explicit destination HTTP listener",
      );
      child.finish("EXPLICIT_HARNESS_CHILD_DONE");
      const continued = await f.model.next();
      expect(continued.wire).toBe(
        provider === "claude" ? "anthropic" : "responses",
      );
      expect(JSON.stringify(continued.body)).toContain(
        "EXPLICIT_HARNESS_CHILD_DONE",
      );
      // Actual native non-zero reuse must not become a second observation,
      // including when Codex previously streamed a success-shaped user row.
      invoke(continued);
      const rejected = await f.model.next();
      expect(JSON.stringify(rejected.body)).toContain("already in use");
      rejected.finish("EXPLICIT_HARNESS_PARENT_DONE");
      await reconnected.wait("EXPLICIT_HARNESS_PARENT_DONE");
      await reconnected.wait('"type":"result"');
      const accepted = await appBarrier(async () => {
        const view = await inspect();
        return view?.pending?.state === "complete" && view.edges.length
          ? view
          : false;
      }, "explicit destination accepted after terminal result");
      expect(accepted.edges).toHaveLength(1);
      expect(accepted.edges[0]).toMatchObject({
        source: { native: pending.identity.native },
        target: {
          native: { family: "claude", storageScope: targetScope, id: targetId },
        },
      });
      expect(accepted.incoming).toEqual(accepted.edges);
      expect(accepted.wrongIncoming).toEqual([]);
      expect(accepted.providerChildren).toEqual([]);
      expect(accepted.creation).toEqual([]);
      expect(accepted.evidence).toEqual([
        expect.objectContaining({
          producer: "nested-harness-command-v1",
          trust: "command-observed",
          metadata: { toolUseId: cursor.hints[0].id },
        }),
      ]);
      expect(
        await readFile(join(inheritedScope, targetId + ".jsonl"), "utf8"),
      ).toBe(incumbent);
      expect(
        await readFile(join(targetScope, targetId + ".jsonl"), "utf8"),
      ).toContain("EXPLICIT_HARNESS_CHILD_DONE");
      await f.close();
      expect(f.model.failures).toEqual([]);
      expect(f.model.requests).toHaveLength(4);
    } catch (error) {
      console.info(await f.diagnostics());
      throw error;
    } finally {
      await f.close();
    }
  },
);
