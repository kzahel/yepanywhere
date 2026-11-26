import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage, ToolApprovalResult } from "../../src/sdk/types.js";
import type { Exchange } from "./model-server.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

/**
 * YA's permission modes against real `agy` and a scripted model. `agy`
 * sends `session/request_permission` with a string JSON-RPC ID; YA must
 * answer it through `onToolApproval`, echoing that ID.
 */
let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function writeFile(request: Exchange, path: string) {
  request.tool("write_file", {
    Path: path,
    Content: "WRITTEN_BY_AGY\n",
    Overwrite: true,
  });
}

/** A command with an observable effect: it creates `<marker>.txt`. */
function command(request: Exchange, marker: string) {
  request.tool("run_command", {
    CommandLine: `echo ${marker} > ${marker}.txt`,
    WaitMsBeforeAsync: 5000,
    toolSummary: "permission probe",
  });
}

/** Tool results YA published for a tool call, by its input path or command. */
function resultsFor(events: SDKMessage[], needle: string) {
  const ids = new Set(
    events
      .flatMap((event) =>
        Array.isArray(event.message?.content) ? event.message.content : [],
      )
      .filter(
        (block) =>
          block.type === "tool_use" && JSON.stringify(block).includes(needle),
      )
      .map((block) => (block as { id: string }).id),
  );
  return events
    .flatMap((event) =>
      Array.isArray(event.message?.content) ? event.message.content : [],
    )
    .filter(
      (block) =>
        block.type === "tool_result" &&
        ids.has((block as { tool_use_id: string }).tool_use_id),
    ) as Array<{ is_error?: boolean }>;
}

describe.skipIf(!providers.includes("antigravity"))(
  "native Antigravity permissions",
  () => {
    it("default mode asks for a write; Allow writes, Deny does not, and the session continues", async () => {
      const decisions: Array<ToolApprovalResult["behavior"]> = [
        "allow",
        "deny",
      ];
      const asked: Array<{ tool: string; input: string }> = [];
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "default",
        onToolApproval: async (tool, input) => {
          asked.push({ tool, input: JSON.stringify(input) });
          const behavior = decisions.shift() ?? "deny";
          return behavior === "allow"
            ? { behavior, updatedInput: input }
            : { behavior, message: "Denied by the test" };
        },
      });
      fixture = f;
      const allowed = join(f.project, "allowed.txt");
      const denied = join(f.project, "denied.txt");

      writeFile(await f.model.next(), allowed);
      const afterAllow = await f.model.next();
      expect(JSON.stringify(afterAllow.body.contents)).toContain(
        "Created file",
      );
      afterAllow.finish("ALLOWED_DONE");
      await f.output("ALLOWED_DONE");
      await f.idle();
      expect(existsSync(allowed)).toBe(true);

      expect(f.proc.queueMessage({ text: "DENY_TURN" }).success).toBe(true);
      writeFile(await f.model.next(), denied);
      // agy ends the turn after a denial without asking the model again.
      await f.idle();
      expect(existsSync(denied)).toBe(false);
      expect(resultsFor(f.events, "denied.txt")).toEqual([
        expect.objectContaining({ is_error: true }),
      ]);

      expect(f.proc.queueMessage({ text: "AFTER_DENY_TURN" }).success).toBe(
        true,
      );
      const after = await f.model.next();
      expect(JSON.stringify(after.body.contents)).toContain("AFTER_DENY_TURN");
      after.finish("AFTER_DENY_DONE");
      await f.output("AFTER_DENY_DONE");
      await f.idle();

      expect(asked.map((entry) => entry.tool)).toEqual([
        "File allowed.txt",
        "File denied.txt",
      ]);
      expect(asked[0]!.input).toContain(allowed);
      expect(f.model.requests).toHaveLength(4);
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 30_000);

    it("Stop while a write waits withdraws it, writes nothing, and input sent right after is delivered", async () => {
      let withdrawn = false;
      let asked!: () => void;
      const waiting = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "default",
        onToolApproval: (_tool, input, { signal }) =>
          new Promise((resolve) => {
            asked();
            signal.addEventListener("abort", () => {
              withdrawn = true;
              resolve({ behavior: "allow", updatedInput: input });
            });
          }),
      });
      fixture = f;
      const held = join(f.project, "held.txt");
      writeFile(await f.model.next(), held);
      await waiting;
      await f.proc.interrupt();
      // Sent before the cancelled prompt has returned: queued, not steered,
      // because agy refuses a prompt while it cancels the current one.
      expect(f.proc.queueMessage({ text: "AFTER_STOP_TURN" }).success).toBe(
        true,
      );
      const after = await f.model.next();
      expect(withdrawn).toBe(true);
      expect(existsSync(held)).toBe(false);
      expect(JSON.stringify(after.body.contents)).toContain("AFTER_STOP_TURN");
      after.finish("AFTER_STOP_DONE");
      await f.output("AFTER_STOP_DONE");
      await f.idle();
      expect(existsSync(held)).toBe(false);
      expect(f.errors).toEqual([]);
    }, 30_000);

    it("accept-edits writes without asking and asks for a command", async () => {
      const asked: string[] = [];
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "acceptEdits",
        onToolApproval: async (tool, input) => {
          asked.push(tool);
          return { behavior: "allow", updatedInput: input };
        },
      });
      fixture = f;
      const written = join(f.project, "edit.txt");
      writeFile(await f.model.next(), written);
      command(await f.model.next(), "ACCEPT_EDITS_COMMAND");
      const last = await f.model.next();
      last.finish("ACCEPT_EDITS_DONE");
      await f.output("ACCEPT_EDITS_DONE");
      await f.idle();
      expect(existsSync(written)).toBe(true);
      expect(existsSync(join(f.project, "ACCEPT_EDITS_COMMAND.txt"))).toBe(
        true,
      );
      expect(asked).toEqual([
        "echo ACCEPT_EDITS_COMMAND > ACCEPT_EDITS_COMMAND.txt",
      ]);
      expect(f.errors).toEqual([]);
    }, 30_000);

    it("bypass runs writes and commands without asking", async () => {
      const asked: string[] = [];
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "bypassPermissions",
        onToolApproval: async (tool, input) => {
          asked.push(tool);
          return { behavior: "allow", updatedInput: input };
        },
      });
      fixture = f;
      const written = join(f.project, "bypass.txt");
      writeFile(await f.model.next(), written);
      command(await f.model.next(), "BYPASS_COMMAND");
      const last = await f.model.next();
      last.finish("BYPASS_DONE");
      await f.output("BYPASS_DONE");
      await f.idle();
      expect(existsSync(written)).toBe(true);
      expect(existsSync(join(f.project, "BYPASS_COMMAND.txt"))).toBe(true);
      expect(asked).toEqual([]);
      expect(f.errors).toEqual([]);
    }, 30_000);

    it("a mode tightened mid-session applies from the next prompt", async () => {
      const asked: string[] = [];
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "acceptEdits",
        onToolApproval: async (tool, input) => {
          asked.push(tool);
          return { behavior: "allow", updatedInput: input };
        },
      });
      fixture = f;
      writeFile(await f.model.next(), join(f.project, "loose.txt"));
      (await f.model.next()).finish("LOOSE_DONE");
      await f.output("LOOSE_DONE");
      await f.idle();
      expect(asked).toEqual([]);

      f.proc.setPermissionMode("default");
      expect(f.proc.queueMessage({ text: "TIGHT_TURN" }).success).toBe(true);
      writeFile(await f.model.next(), join(f.project, "tight.txt"));
      (await f.model.next()).finish("TIGHT_DONE");
      await f.output("TIGHT_DONE");
      await f.idle();
      expect(asked).toEqual(["File tight.txt"]);
      expect(f.errors).toEqual([]);
    }, 30_000);

    it("runs YA's Plan mode as agy's native plan mode", async () => {
      const f = await nativeFixture("antigravity", "gentle", {
        permissionMode: "plan",
      });
      fixture = f;
      (await f.model.next()).finish("PLAN_DONE");
      await f.output("PLAN_DONE");
      await f.idle();
      expect(f.errors).toEqual([]);
    }, 30_000);
  },
);
