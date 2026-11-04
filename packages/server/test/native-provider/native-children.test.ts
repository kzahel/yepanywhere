import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { historyReader } from "./history.js";
import { providers } from "./selection.js";

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
describe.each(providers.filter((p) => p === "claude" || p === "codex"))(
  "real native children: %s",
  (provider) => {
    it("spawns a child on the owned endpoint and reopens its native transcript", async () => {
      const f = await nativeFixture(provider);
      fixtures.push(f);
      const first = await f.model.next();
      const callId = `call_${first.id}`;
      if (provider === "claude") {
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
      } else {
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
      }
      await f.idle();
      await f.stop();
      const rows = (await f.nativeRows()) as NativeRow[];
      let childId: string;
      if (provider === "claude") {
        childId =
          rows.find((r) => !r.isSidechain && r.toolUseResult?.agentId)
            ?.toolUseResult?.agentId ?? "";
        expect(childId).not.toBe("");
        expect(rows.some((r) => r.isSidechain && r.agentId === childId)).toBe(
          true,
        );
      } else {
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
          toolUseId: callId,
        });
        expect(await reader.listProviderChildSessions!(childId)).toEqual([]);
        expect(
          (await reader.listSessions(toUrlProjectId(f.project))).some(
            (s) => s.id === childId,
          ),
        ).toBe(false);
        expect(
          JSON.stringify(await reader.getAgentSession(childId, f.nativeId())),
        ).toContain("CHILD_RELATIONSHIP_REPLY");
      } finally {
        await reader.close?.();
      }
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
    });
  },
);
