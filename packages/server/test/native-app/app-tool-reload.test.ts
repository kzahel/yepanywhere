import { nativeAppTestFixture } from "./fixture.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appBarrier } from "../native-provider/app-fixture.js";
import { heldAppTool } from "../native-provider/app-tools.js";

let fixture: Awaited<ReturnType<typeof nativeAppTestFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(await fixture.diagnostics());
  await fixture?.close();
  fixture = undefined;
});

describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "real tool and approval reload",
  () => {
    it.for(["claude", "codex"] as const)(
      "%s preserves pending approval, dense tool output and queue blockers",
      {
        // Source wrapper/native startup plus two replacements took at most
        // 9.40s per case on macOS arm64; allow 3x that observed maximum.
        timeout: 30_000,
      },
      async (provider, context) => {
        const f = await nativeAppTestFixture(provider, context);
        fixture = f;
        await f.ready();
        const created = await f.create("APP_TOOL_INPUT", "default");
        const initial = await f.model.next();
        const connection = await f.connect(created.sessionId);
        await heldAppTool(provider, f.project, initial);
        const pending = () =>
          f.api(`/sessions/${created.sessionId}/pending-input`);
        const original = await appBarrier(
          async () => (await pending()).request || false,
          "native approval",
        );
        const before = (await f.inventory())[0]!;
        await f.api("/server/restart", {});
        await appBarrier(async () => {
          const worker = (await f.inventory()).find(
            (w) => w.runtimeId === before.runtimeId,
          );
          return worker?.attachedServerGeneration &&
            worker.attachedServerGeneration !== before.attachedServerGeneration
            ? worker
            : false;
        }, "pending approval reattachment");
        const restored = await appBarrier(
          async () => (await pending()).request || false,
          "restored native approval",
        );
        expect(restored.toolName).toBe(original.toolName);
        expect(restored.toolInput).toEqual(original.toolInput);
        await f.api(`/sessions/${created.sessionId}/input`, {
          requestId: restored.id,
          response: "approve",
        });
        await appBarrier(
          async () => await readFile(join(f.project, "tool-started"), "utf8"),
          "native tool execution",
        );
        const running = (await f.inventory())[0]!;
        const replacement = f.api("/server/restart", {});
        await writeFile(join(f.project, "tool-burst"), "burst");
        await replacement;
        const after = await appBarrier(async () => {
          const worker = (await f.inventory()).find(
            (w) => w.runtimeId === before.runtimeId,
          );
          return worker?.attachedServerGeneration &&
            worker.attachedServerGeneration !== running.attachedServerGeneration
            ? worker
            : false;
        }, "dense output reload");
        expect(after.pid).toBe(before.pid);
        expect(after.providerProcessGroupIds).toEqual(
          running.providerProcessGroupIds,
        );
        await appBarrier(
          async () =>
            await readFile(join(f.project, "tool-burst-done"), "utf8"),
          "dense output burst",
        );
        await appBarrier(async () => await f.api("/dev/status"), "new API");
        await f.api(`/sessions/${created.sessionId}/messages`, {
          message: "VOLATILE_APP_INPUT",
          tempId: "volatile",
          deferred: true,
        });
        const blocked = await f.api("/dev/safe-restart");
        expect(blocked.canRestartNow).toBe(false);
        expect(blocked.blockers.length).toBeGreaterThan(0);
        await f.api(
          `/sessions/${created.sessionId}/deferred/volatile`,
          undefined,
          "DELETE",
        );
        expect((await f.api("/dev/safe-restart")).canRestartNow).toBe(true);
        connection.ws.close();
        const attached = await f.connect(created.sessionId);
        await writeFile(join(f.project, "tool-release"), "release");
        const afterTool = await f.model.next();
        expect(
          JSON.stringify(afterTool.body).includes(
            provider === "claude"
              ? "OWNED_DENSE_OUTPUT"
              : "OWNED_DENSE_TOOL_DONE",
          ),
        ).toBe(true);
        expect(await readFile(join(f.project, "tool-finished"), "utf8")).toBe(
          "done",
        );
        expect(JSON.stringify(afterTool.body)).not.toContain(
          "VOLATILE_APP_INPUT",
        );
        expect(
          (await readFile(join(f.project, "tool-start-count"), "utf8"))
            .trim()
            .split("\n"),
        ).toHaveLength(1);
        afterTool.finish("APP_TOOL_COMPLETE");
        await attached.wait("APP_TOOL_COMPLETE");
        await attached.wait('"type":"result"');
        const detail = JSON.stringify(
          await f.api(
            `/projects/${created.projectId}/sessions/${created.sessionId}`,
          ),
        );
        expect(detail).toContain("APP_TOOL_COMPLETE");
        expect(f.model.requests).toHaveLength(2);
        await f.close();
        expect(f.model.failures).toEqual([]);
      },
    );
  },
);
