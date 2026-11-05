import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { mergeProviderChildAgentMappings } from "../../src/sessions/provider-child-sessions.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { historyReader, findNativeFile } from "./history.js";
import { providers } from "./selection.js";
import { isClaude, isCodex, type NativeProvider } from "./runtimes.js";

const fixtures: Awaited<ReturnType<typeof nativeFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.close();
});
interface NativeRow {
  type: string;
  isSidechain?: boolean;
  agentId?: string;
  toolUseResult?: { agentId?: string };
  payload?: {
    id?: string;
    parent_thread_id?: string;
    type?: string;
    item?: {
      type?: string;
      kind?: string;
      agent_thread_id?: string;
      id?: string;
    };
  };
}

// Real native spawn/persistence is the oracle. Reopening production readers
// must agree with native ids, not ids manufactured by the extractor under test.
function supportsNativeChildScenario(provider: NativeProvider) {
  return (
    isClaude(provider) ||
    isCodex(provider) ||
    provider === "grok" ||
    provider === "opencode"
  );
}

describe.each(providers.filter(supportsNativeChildScenario))(
  "real native children: %s",
  (provider) => {
    it("spawns a child on the owned endpoint and reopens its native transcript", async () => {
      const f = await nativeFixture(provider, "gentle", {
        gatewayAgentEnabled: provider === "claude-gateway",
      });
      fixtures.push(f);
      const first = await f.model.next();
      const callId = `call_${first.id}`;
      let nativeParentContinuation: string | undefined;
      if (isClaude(provider)) {
        expect(first.body.tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "Agent" })]),
        );
        first.tool("Agent", {
          description: "Owned native child",
          prompt: "CHILD_RELATIONSHIP_INPUT. Reply CHILD_RELATIONSHIP_REPLY.",
          subagent_type: "general-purpose",
          model: "haiku",
        });
        const child = await f.model.next();
        expect(JSON.stringify(child.body)).toContain(
          "CHILD_RELATIONSHIP_INPUT",
        );
        child.finish("CHILD_RELATIONSHIP_REPLY");
        const parent = await f.model.next();
        expect(JSON.stringify(parent.body)).toContain(
          "CHILD_RELATIONSHIP_REPLY",
        );
        parent.finish("PARENT_RELATIONSHIP_DONE");
      } else if (isCodex(provider)) {
        const thread = (body: Record<string, unknown>) =>
          (body.client_metadata as { thread_id: string }).thread_id;
        const rootKey = thread(first.body);
        first.tool(
          "spawn_agent",
          {
            task_name: "owned_child",
            message:
              "CHILD_RELATIONSHIP_INPUT. Reply CHILD_RELATIONSHIP_REPLY.",
            fork_turns: "none",
          },
          "collaboration",
        );
        // Parent continuation and child inference can arrive in either order.
        const a = await f.model.next(),
          b = await f.model.next();
        const parent = thread(a.body) === rootKey ? a : b;
        const child = thread(a.body) === rootKey ? b : a;
        expect(thread(parent.body)).toBe(rootKey);
        expect(thread(child.body)).not.toBe(rootKey);
        expect(JSON.stringify(child.body)).toContain(
          "CHILD_RELATIONSHIP_INPUT",
        );
        expect(JSON.stringify(parent.body)).toContain("/root/owned_child");
        child.finish("CHILD_RELATIONSHIP_REPLY");
        parent.tool("wait_agent", { timeout_ms: 10000 }, "collaboration");
        const afterWait = await f.model.next();
        expect(JSON.stringify(afterWait.body)).toContain(
          "CHILD_RELATIONSHIP_REPLY",
        );
        afterWait.finish("PARENT_RELATIONSHIP_DONE");
      } else if (provider === "opencode") {
        first.tool("task", {
          description: "Owned native child",
          prompt: "CHILD_RELATIONSHIP_INPUT. Reply CHILD_RELATIONSHIP_REPLY.",
          subagent_type: "general",
        });
        const child = await f.model.next();
        expect(JSON.stringify(child.body)).toContain(
          "CHILD_RELATIONSHIP_INPUT",
        );
        child.finish("CHILD_RELATIONSHIP_REPLY");
        const parent = await f.model.next();
        nativeParentContinuation = JSON.stringify(parent.body);
        expect(nativeParentContinuation).toContain("CHILD_RELATIONSHIP_REPLY");
        parent.finish("PARENT_RELATIONSHIP_DONE");
      } else {
        first.tool("spawn_subagent", {
          description: "Owned native child",
          prompt: "CHILD_RELATIONSHIP_INPUT. Reply CHILD_RELATIONSHIP_REPLY.",
          background: false,
          isolation: "none",
        });
        const child = await f.model.next();
        expect(JSON.stringify(child.body)).toContain(
          "CHILD_RELATIONSHIP_INPUT",
        );
        child.finish("CHILD_RELATIONSHIP_REPLY");
        const parent = await f.model.next();
        nativeParentContinuation = JSON.stringify(parent.body);
        expect(nativeParentContinuation).toContain("CHILD_RELATIONSHIP_REPLY");
        parent.finish("PARENT_RELATIONSHIP_DONE");
      }
      await f.idle();
      await f.stop();
      const rows =
        provider === "grok" || provider === "opencode"
          ? []
          : ((await f.nativeRows()) as NativeRow[]);
      let childId: string;
      if (isClaude(provider)) {
        childId =
          rows.find((r) => !r.isSidechain && r.toolUseResult?.agentId)
            ?.toolUseResult?.agentId ?? "";
        expect(childId).not.toBe("");
        expect(rows.some((r) => r.isSidechain && r.agentId === childId)).toBe(
          true,
        );
      } else if (isCodex(provider)) {
        childId =
          rows.find(
            (r) =>
              r.type === "session_meta" &&
              r.payload?.parent_thread_id === f.nativeId(),
          )?.payload?.id ?? "";
        expect(childId).not.toBe("");
        const started = rows.find(
          (r) =>
            r.type === "event_msg" &&
            r.payload?.item?.type === "SubAgentActivity" &&
            r.payload.item.kind === "started",
        );
        expect(started?.payload?.item).toMatchObject({
          agent_thread_id: childId,
          id: callId,
        });
      } else if (provider === "opencode") {
        const db = loadSqliteDriver()!.open(
          join(f.environment.XDG_DATA_HOME!, "opencode", "opencode.db"),
          { readOnly: true },
        );
        try {
          const query = db.prepare(
            "SELECT id, parent_id, directory FROM session WHERE parent_id = ?",
          );
          try {
            const children = query.all<{
              id: string;
              parent_id: string;
              directory: string;
            }>(f.nativeId());
            expect(children).toHaveLength(1);
            childId = children[0]!.id;
            expect(children[0]!.directory).toBe(f.project);
            expect(nativeParentContinuation).toContain(childId);
          } finally {
            query.finalize();
          }
        } finally {
          db.close();
        }
      } else {
        const path = await findNativeFile(
          f.environment.GROK_SESSIONS_DIR!,
          (name) => name === "meta.json",
        );
        expect(path).toBeTruthy();
        const meta = JSON.parse(await readFile(path!, "utf8"));
        expect(meta.parent_session_id).toBe(f.nativeId());
        expect(meta.child_session_id).toBe(meta.subagent_id);
        childId = meta.child_session_id;
        expect(childId).toBeTruthy();
        expect(nativeParentContinuation).toContain(childId);
        const ownSummary = JSON.parse(
          await readFile(
            join(
              f.environment.GROK_SESSIONS_DIR!,
              encodeURIComponent(f.project),
              childId,
              "summary.json",
            ),
            "utf8",
          ),
        );
        expect(ownSummary.info.id).toBe(childId);
      }
      const reader = await historyReader(
        provider,
        f.project,
        f.environment,
        f.nativeId(),
        f.executable,
      );
      try {
        const children = await reader.listProviderChildSessions!(f.nativeId());
        expect(children).toHaveLength(1);
        expect(children[0]).toMatchObject({
          id: childId,
          parentSessionId: f.nativeId(),
          ...(["grok", "opencode"].includes(provider)
            ? {}
            : { toolUseId: callId }),
        });
        if (isClaude(provider) || isCodex(provider)) {
          expect(await reader.getAgentMappings(f.nativeId())).toEqual([
            expect.objectContaining({ agentId: childId, toolUseId: callId }),
          ]);
        }
        expect(await reader.listProviderChildSessions!(childId)).toEqual([]);
        expect(
          (await reader.listSessions(toUrlProjectId(f.project))).some(
            (s) => s.id === childId,
          ),
        ).toBe(false);
        expect(
          JSON.stringify(await reader.getAgentSession(childId, f.nativeId())),
        ).toContain("CHILD_RELATIONSHIP_REPLY");
        {
          const parent = nativeSessionRef(
            isClaude(provider)
              ? "claude"
              : isCodex(provider)
                ? "codex"
                : provider === "opencode"
                  ? "opencode"
                  : "grok",
            isCodex(provider)
              ? await realpath(f.environment.CODEX_SESSIONS_DIR!)
              : provider === "grok"
                ? await realpath(f.environment.GROK_SESSIONS_DIR!)
                : provider === "opencode"
                  ? await realpath(
                      join(f.environment.XDG_DATA_HOME!, "opencode"),
                    )
                  : await realpath(
                      dirname(
                        (await findNativeFile(
                          join(f.environment.CLAUDE_CONFIG_DIR!, "projects"),
                          (name) => name === `${f.nativeId()}.jsonl`,
                        ))!,
                      ),
                    ),
            parseNativeSessionId(f.nativeId()),
          );
          const source = reader.getProviderChildSource!(parent)!;
          const dataDir = join(f.root, "relationship-reopen");
          let db = new DiscoverySqliteService({
            dataDir,
            probeNetworkFilesystem: () => undefined,
          });
          let done!: () => void;
          const committed = new Promise<void>((resolve) => {
            done = resolve;
          });
          let index = new ProviderChildRelationshipService(
            db.getDatabase(),
            "native-test",
            () => done(),
          );
          try {
            index.demand(parent, { sessionId: "canonical-parent" }, source);
            await committed;
            expect(index.accepted(parent, "canonical-parent")).toMatchObject([
              { id: childId, parentSessionId: "canonical-parent" },
            ]);
            if (isClaude(provider) || isCodex(provider)) {
              const fresh = await reader.getAgentMappings(f.nativeId());
              const merged = mergeProviderChildAgentMappings(
                fresh,
                index.accepted(parent, "canonical-parent"),
              );
              expect(merged).toEqual(fresh);
              expect(merged).toContainEqual(
                expect.objectContaining({
                  agentId: childId,
                  toolUseId: callId,
                }),
              );
            }
            await index.close();
            db.close();
            db = new DiscoverySqliteService({
              dataDir,
              probeNetworkFilesystem: () => undefined,
            });
            index = new ProviderChildRelationshipService(
              db.getDatabase(),
              "native-test",
              () => {},
            );
            expect(index.accepted(parent, "canonical-parent")).toMatchObject([
              {
                id: childId,
                parentSessionId: "canonical-parent",
                ...(isClaude(provider) || isCodex(provider)
                  ? { toolUseId: callId }
                  : {}),
              },
            ]);
          } finally {
            await index.close();
            db.close();
          }
        }
      } finally {
        await reader.close?.();
      }
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
      // Actual OpenCode spawn/persistence took 3.15 s standalone and exceeded
      // the default 5 s under concurrent root checks on 2026-11-05. Keep three
      // times that observed lower bound for native startup plus SQL reopen.
    }, 15_000);
  },
);
