import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeSnapshot } from "../../shared/src/experimental/simple-client.generated.js";
import { loadCapture, replayNative } from "./utils/captured-provider-replay.js";

// Independent expectations: the examples are hand-designed API proposals, not
// output from a new projection implementation. Replay verifies their provenance.
describe("simple-client examples against production captured-provider replay", () => {
  it.each(["claude", "codex"])(
    "%s retains prose, activity counts and visible failure",
    async (provider) => {
      const capture = await loadCapture(`${provider}-basic-2026-09-12`);
      const { renderItems } = await replayNative(capture);
      const snapshot = decodeSnapshot(
        await readFile(
          new URL(
            `../../shared/test/fixtures/simple-client/${provider}-conversation.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      if (snapshot.view.kind !== "conversation")
        throw new Error("Expected conversation example");
      const view = snapshot.view;
      expect(view.sessionId).toBe(capture.manifest.sessionId);
      const users = renderItems.filter((item) => item.type === "user_prompt");
      expect(
        view.messages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ).toEqual(users.map((user) => user.id));
      expect(
        view.messages
          .filter((message) => message.role === "user")
          .flatMap((message) =>
            message.content.filter((c) => c.kind === "text").map((c) => c.text),
          ),
      ).toEqual(capture.manifest.requests.map((request) => request.message));
      const agents = view.messages.filter(
        (message) => message.role === "agent",
      );
      expect(agents.map((message) => message.id)).toEqual(
        users.map((user) => `agent:${user.id}`),
      );
      expect(
        agents.flatMap((message) =>
          message.content.filter((c) => c.kind === "text").map((c) => c.text),
        ),
      ).toEqual(
        renderItems
          .filter((item) => item.type === "text")
          .map((item) => item.text),
      );
      const activities = agents.flatMap((message) =>
        message.content.filter((c) => c.kind === "activity"),
      );
      const tools = renderItems.filter((item) => item.type === "tool_call");
      expect(activities.map((activity) => activity.toolCount)).toEqual([4, 1]);
      expect(
        activities.reduce((count, activity) => count + activity.toolCount, 0),
      ).toBe(tools.length);
      const failures = agents.flatMap((message) =>
        message.content.filter((c) => c.kind === "failure"),
      );
      const failed = tools.filter((item) => item.status === "error");
      expect(failures).toHaveLength(failed.length);
      for (const [index, failure] of failures.entries()) {
        expect(failure.toolName).toBe(failed[index]?.toolName);
        expect(failed[index]?.toolResult?.content).toContain(failure.message);
        expect(failure.exitCode).toBe(7);
        expect(failed[index]?.toolResult?.structured).toMatchObject({
          exitCode: failure.exitCode,
        });
      }
    },
  );
});
