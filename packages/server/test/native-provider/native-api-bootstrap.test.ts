import { afterEach, describe, expect, it } from "vitest";
import { agentApiBootstrapInstructions } from "@yep-anywhere/shared";
import { AGENT_API_BOOTSTRAP_NOTICE } from "@yep-anywhere/shared/agent-api-bootstrap";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";
import type { StartSessionOptions } from "../../src/sdk/providers/types.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe.each(providers.filter((p) => p.startsWith("claude") || p === "codex"))(
  "native API instructions: %s",
  (provider) => {
    it("keeps user input/title clean through compaction and grants-changing cold resume", {
      timeout: 20_000,
    }, async () => {
      const launch: Partial<StartSessionOptions> = {
        agentSelf: false,
        agentApi: { serverId: "native-api-bootstrap", management: true },
        ...(provider.startsWith("claude")
          ? { globalInstructions: "OPERATOR_INITIAL" }
          : {}),
      };
      const f = await nativeFixture(provider, "gentle", {
        launch,
        codexDeveloperInstructions: "OPERATOR_CODEX_INSTRUCTIONS",
      });
      fixture = f;
      const instructions = agentApiBootstrapInstructions(
        process.platform === "win32",
      );
      const bodyText = (body: Record<string, unknown>) =>
        JSON.stringify(
          provider.startsWith("claude") ? body.system : body.input,
        );
      const userText = (body: Record<string, unknown>) =>
        JSON.stringify(
          (provider.startsWith("claude")
            ? body.messages
            : (body.input as unknown[])) as unknown[],
        );
      const initial = await f.model.next();
      expect(bodyText(initial.body)).toContain("[Yep Anywhere API]");
      expect(bodyText(initial.body)).toContain(
        provider.startsWith("claude")
          ? "OPERATOR_INITIAL"
          : "OPERATOR_CODEX_INSTRUCTIONS",
      );
      if (provider.startsWith("claude"))
        expect(userText(initial.body)).not.toContain("[Yep Anywhere API]");
      else {
        const userItems = (
          initial.body.input as Array<{ role?: string }>
        ).filter((item) => item.role === "user");
        expect(JSON.stringify(userItems)).not.toContain("[Yep Anywhere API]");
      }
      f.proc.deferMessage({
        text: "/compact",
        tempId: "compact",
        queuedCompact: { command: "compact", argument: "" },
      });
      f.proc.deferMessage({
        text: "AFTER_API_COMPACT",
        tempId: "after-compact",
      });
      initial.finish("INITIAL_DONE " + "Owned context. ".repeat(200));
      const compact = await f.model.next();
      compact.finish(
        provider.startsWith("claude")
          ? "<analysis>Preserve instructions.</analysis><summary>OWNED_SUMMARY</summary>"
          : "OWNED_SUMMARY",
      );
      const afterCompact = await f.model.next();
      expect(bodyText(afterCompact.body)).toContain("[Yep Anywhere API]");
      afterCompact.finish("COMPACT_DONE");
      await f.idle();
      const nativeId = f.nativeId();
      await f.stop();
      const history = await f.history();
      expect(history?.summary.title).toBe("INITIAL_NATIVE_INPUT");
      const messages = normalizeSession(history!).messages;
      const prose = messages
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => m.message?.content);
      expect(JSON.stringify(prose)).not.toContain("[Yep Anywhere API]");
      if (provider === "codex") {
        expect(
          messages.find((m) => m.content === AGENT_API_BOOTSTRAP_NOTICE),
        ).toMatchObject({
          type: "system",
          subtype: "informational",
          details: [instructions],
        });
      }
      await f.restart({
        ...launch,
        resumeSessionId: nativeId,
        agentApi: { serverId: "native-api-bootstrap", management: false },
        ...(provider.startsWith("claude")
          ? { globalInstructions: "OPERATOR_CHANGED" }
          : {}),
        initialMessage: {
          text: "RESUMED_API_USER_REQUEST",
          uuid: "22222222-2222-4222-8222-222222222222",
        },
      });
      const resumed = await f.model.next();
      expect(bodyText(resumed.body)).toContain("[Yep Anywhere API]");
      expect(bodyText(resumed.body)).not.toContain(
        "This launch has explicit session-command authority",
      );
      if (provider.startsWith("claude")) {
        expect(bodyText(resumed.body)).toContain("OPERATOR_CHANGED");
        expect(bodyText(resumed.body)).not.toContain("OPERATOR_INITIAL");
      }
      resumed.finish("RESUMED_DONE");
      await f.idle();
      await f.stop();
      expect((await f.history())?.summary.title).toBe("INITIAL_NATIVE_INPUT");
      expect(
        JSON.stringify(f.events.filter((m) => m.type === "user")),
      ).not.toContain("[Yep Anywhere API]");
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
      expect(f.diagnostics).toEqual([]);
    });
  },
);
