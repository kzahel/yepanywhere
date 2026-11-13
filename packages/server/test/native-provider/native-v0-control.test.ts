import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import { CoreApi } from "../../src/core-api/service.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { nativeSessionControl } from "../../src/core-api/native-session-control.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { apiCommand } from "../support/api-command-request.js";

const cleanup: Array<() => void | Promise<void>> = [];
let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(
      JSON.stringify({
        state: fixture.proc.state,
        errors: fixture.errors.map((e) => e.message),
        events: fixture.events.slice(-10),
        diagnostics: fixture.diagnostics,
      }),
    );
  for (const close of cleanup.splice(0).reverse()) await close();
  fixture = undefined;
});
describe.each(providers.filter((p) => p === "claude" || p === "codex"))(
  "native v0 control: %s",
  (provider) => {
    it("answers a real native permission request, interrupts, and stops through v0", {
      // Native Windows ARM64 reached its first model request but exhausted 20s;
      // allow 3x that observed lower bound. Local macOS completes below 5s.
      timeout: process.platform === "win32" ? 60000 : 20000,
    }, async () => {
      const mark = (phase: string) =>
        console.log(JSON.stringify({ nativeV0Control: provider, phase }));
      mark("native fixture starting");
      let f: Awaited<ReturnType<typeof nativeFixture>>;
      f = await nativeFixture(provider, "gentle", {
        gitProject: false,
        permissionMode: "default",
        onToolApproval: (tool, input, options) =>
          f.proc.handleToolApproval(tool, input, options),
      });
      fixture = f;
      mark("native fixture ready");
      cleanup.push(() => f.close());
      const database = openSqliteOrThrow(":memory:");
      migrateDiscoveryDatabase(database);
      const receipts = new ApiReceiptStore(database);
      const owner = nativeSessionControl({
        supervisor: {
          getProcessForSession: () => f.proc,
          interruptProcess: async () => ({
            success: await f.proc.interrupt(),
            supported: f.proc.supportsInterrupt,
          }),
          abortProcessWithVerification: async () =>
            f.proc.terminateAndWait("v0 fixture stop"),
        },
      });
      const commands = new SessionCommands(
        "native-v0",
        receipts,
        {
          ...owner,
          start: async () => {
            throw Error("Unexpected create");
          },
        },
        () => true,
      );
      cleanup.push(() => {
        commands.close();
        receipts.close();
        database.close();
      });
      const core = new CoreApi("native-v0", {
        commands,
        providers: async () => [],
        projects: async () => ({ items: [] }),
        sessions: async () => ({
          items: [
            {
              id: f.proc.sessionId,
              projectId: "p",
              provider,
              title: "Native worker",
              state: f.proc.state.type,
              updatedAt: "",
            },
          ],
        }),
      });
      const app = new Hono<{ Variables: { yaPrincipal: typeof SUPERUSER } }>();
      app.use("*", async (c, next) => {
        c.set("yaPrincipal", SUPERUSER);
        await next();
      });
      app.route("/v0", createV0Routes(core));
      const base = `/v0/servers/self/sessions/${f.proc.sessionId}`;
      const post = async (
        path: string,
        requestId: string,
        body: object = {},
      ) => {
        const response = await app.request(base + path, {
          method: "POST",
          ...apiCommand({ ...body, requestId }),
        });
        expect(response.status, await response.clone().text()).toBe(202);
        const receipt = await response.json();
        await commands.idle();
        return (
          await app.request(`/v0/servers/self/receipts/${receipt.id}`)
        ).json();
      };
      mark("awaiting first model request");
      const initial = await f.model.next();
      mark("first model request");
      const pending = new Promise<void>((resolve) => {
        const off = f.proc.subscribe((event) => {
          if (
            event.type === "state-change" &&
            event.state.type === "waiting-input"
          ) {
            off();
            resolve();
          }
        });
      });
      if (provider === "claude")
        initial.tool("Bash", {
          command:
            "printf OWNED_V0_PERMISSION > owned-v0-proof.txt; cat owned-v0-proof.txt",
          description: "Owned API approval check",
        });
      else
        initial.tool(
          "exec",
          'const result=await tools.exec_command({cmd:"echo OWNED_V0_PERMISSION",sandbox_permissions:"require_escalated",justification:"Owned API approval check"});text(result.output);',
        );
      const nextModel = f.model.next();
      const gate = await Promise.race([
        pending.then(() => "pending"),
        nextModel.then(() => "continued"),
      ]);
      expect(
        gate,
        `Native tool did not pause: ${JSON.stringify(f.events.slice(-3)).slice(0, 2000)}`,
      ).toBe("pending");
      mark("permission pending");
      const requests = await (await app.request(base + "/requests")).json();
      expect(requests.items[0]).toMatchObject({
        kind: "permission",
        canRespond: true,
      });
      const response = await post(
        `/requests/${requests.items[0].id}/response`,
        "native-approval-001",
        { response: "approve" },
      );
      expect(response).toMatchObject({
        state: "accepted",
        result: { accepted: true },
      });
      mark("approval accepted");
      const afterTool = await nextModel;
      expect(JSON.stringify(afterTool.body)).toContain("OWNED_V0_PERMISSION");
      afterTool.finish("NATIVE_APPROVAL_DONE");
      await f.output("NATIVE_APPROVAL_DONE");
      await f.idle();
      mark("native output observed");
      f.proc.queueMessage({ text: "WAIT_FOR_API_CANCEL" });
      const active = await f.model.next();
      expect(await post("/cancel", "native-cancel-001")).toMatchObject({
        state: "accepted",
        result: { interrupted: true },
      });
      await active.cancelled;
      mark("native turn cancelled");
      expect(await post("/stop", "native-stop-001")).toMatchObject({
        state: "accepted",
        result: { stopped: true, verifiedStopped: true },
      });
      mark("native stop verified");
      expect(f.proc.isTerminated).toBe(true);
      expect((await app.request(base)).status).toBe(200);
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    });
  },
);
