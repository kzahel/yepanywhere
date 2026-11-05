import { nativeAppTestFixture } from "./fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { appBarrier } from "../native-provider/app-fixture.js";
import { readOwnedFile } from "../native-provider/actions.js";

let fixture: Awaited<ReturnType<typeof nativeAppTestFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(await fixture.diagnostics());
  await fixture?.close();
  fixture = undefined;
});

describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "real application reload",
  () => {
    it.for(["claude", "codex"] as const)(
      "%s survives actual API replacement and delivers the next input once",
      {
        // Source wrapper/native startup plus two replacements took at most
        // 9.40s per case on macOS arm64; allow 3x that observed maximum.
        timeout: 30_000,
      },
      async (provider, context) => {
        const f = await nativeAppTestFixture(provider, context);
        fixture = f;
        await f.ready();
        const created = await f.create("APP_INITIAL_INPUT");
        const first = await f.model.next();
        const initialSocket = await f.connect(created.sessionId);
        readOwnedFile(provider, f.project, first);
        const held = await f.model.next();
        expect(JSON.stringify(held.body)).toContain("OWNED_TOOL_CONTENT");
        held.partial("APP_BEFORE_RELOAD");
        await initialSocket.wait("APP_BEFORE_RELOAD");
        const before =
          (await f.inventory()).find(
            (w) => w.providerSessionId === created.sessionId,
          ) ?? (await f.inventory())[0]!;
        expect(before.pid).toBeGreaterThan(1);
        const processesBefore = await f.processes();
        const safe = await f.api("/dev/safe-restart");
        expect(safe.canRestartNow).toBe(true);
        await f.api("/server/restart", {});
        const after = await appBarrier(async () => {
          const worker = (await f.inventory()).find(
            (w) => w.runtimeId === before.runtimeId,
          );
          return worker?.attachedServerGeneration &&
            worker.attachedServerGeneration !== before.attachedServerGeneration
            ? worker
            : false;
        }, "new Hono generation");
        expect(after.pid).toBe(before.pid);
        expect(after.providerSessionId).toBe(before.providerSessionId);
        expect(after.providerProcessGroupIds).toEqual(
          before.providerProcessGroupIds,
        );
        await appBarrier(
          async () => await f.api("/dev/status"),
          "replacement API",
        );
        const processesAfter = await f.processes();
        expect(processesAfter.wrapper).toBe(processesBefore.wrapper);
        expect(processesAfter.backend).not.toBe(processesBefore.backend);
        expect(processesAfter.frontend).not.toBe(processesBefore.frontend);
        await f.crashBackend();
        const recovered = await appBarrier(async () => {
          const worker = (await f.inventory()).find(
            (w) => w.runtimeId === before.runtimeId,
          );
          return worker?.attachedServerGeneration &&
            worker.attachedServerGeneration !== after.attachedServerGeneration
            ? worker
            : false;
        }, "abrupt Hono replacement");
        expect(recovered.pid).toBe(before.pid);
        expect(recovered.providerProcessGroupIds).toEqual(
          before.providerProcessGroupIds,
        );
        await appBarrier(
          async () => await f.api("/dev/status"),
          "recovered API",
        );
        initialSocket.ws.close();
        const reattached = await f.connect(created.sessionId);
        held.finish("_APP_AFTER_RELOAD");
        await reattached.wait("APP_AFTER_RELOAD");
        await reattached.wait('"type":"result"');
        const followStart = reattached.events.length;
        await f.api(`/sessions/${created.sessionId}/messages`, {
          message: "APP_FOLLOW_UP",
          mode: "bypassPermissions",
        });
        const follow = await f.model.next();
        expect(JSON.stringify(follow.body)).toContain("APP_FOLLOW_UP");
        follow.finish("APP_FOLLOW_UP_DONE");
        await reattached.wait("APP_FOLLOW_UP_DONE");
        await reattached.wait('"type":"result"', followStart);
        const history = await f.api(
          `/projects/${created.projectId}/sessions/${created.sessionId}`,
        );
        expect(JSON.stringify(history)).toContain("APP_AFTER_RELOAD");
        expect(JSON.stringify(history)).toContain("APP_FOLLOW_UP_DONE");
        expect(f.model.requests).toHaveLength(3);
        await f.close();
        expect(f.model.failures).toEqual([]);
      },
    );
  },
);
