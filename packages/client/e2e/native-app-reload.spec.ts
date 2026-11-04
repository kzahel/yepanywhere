import { expect, test } from "@playwright/test";
import {
  nativeAppFixture,
  appBarrier,
} from "../../server/test/native-provider/app-fixture.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.afterAll(() => presentUiCaptures());
for (const provider of ["claude", "codex"] as const)
  test(`${provider} browser reconnect preserves draft, input identity and final history`, async ({
    page,
  }) => {
    const f = await nativeAppFixture(provider);
    const errors: string[] = [];
    const frames: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", (event) => {
        frames.push(String(event.payload));
      }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await f.ready();
      const created = await f.create("BROWSER_INITIAL_INPUT");
      const priming = await f.model.next();
      priming.finish("BROWSER_PRIMED");
      await page.goto(
        `${f.baseUrl}/projects/${created.projectId}/sessions/${created.sessionId}`,
      );
      const input = page.locator("textarea[data-composer-input]").first();
      await expect(input).toBeEditable();
      await expect
        .poll(() =>
          frames.some(
            (frame) =>
              frame.includes('"eventType":"connected"') &&
              frame.includes(created.sessionId),
          ),
        )
        .toBe(true);
      await input.pressSequentially("BROWSER_ACTIVE_WORK");
      const admission = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/sessions/${created.sessionId}/messages`),
      );
      await input.press("Enter");
      expect((await admission).ok()).toBe(true);
      const held = await f.model.next();
      held.partial("BROWSER_ACTIVE_STREAM");
      await expect(
        page.getByText("BROWSER_ACTIVE_STREAM", { exact: true }),
      ).toBeVisible();
      await input.evaluate((element) => {
        const field = element as HTMLTextAreaElement & {
          acks: { value: string; latency: number }[];
        };
        field.acks = [];
        field.addEventListener("keydown", (event) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              field.acks.push({
                value: field.value,
                latency: performance.now() - event.timeStamp,
              }),
            ),
          ),
        );
      });
      let text = "";
      for (const char of "BROWSER_FOLLOW_UP") {
        held.partial(" live");
        await input.pressSequentially(char);
        text += char;
        await expect(input).toHaveValue(text);
        await expect
          .poll(() =>
            input.evaluate(
              (element) =>
                (
                  element as HTMLTextAreaElement & { acks: { value: string }[] }
                ).acks.at(-1)?.value,
            ),
          )
          .toBe(text);
      }
      const acks = await input.evaluate(
        (element) =>
          (element as HTMLTextAreaElement & { acks: { latency: number }[] })
            .acks,
      );
      expect(acks).toHaveLength(text.length);
      expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThan(100);
      const before = (await f.inventory())[0]!;
      expect((await f.api("/dev/safe-restart")).canRestartNow).toBe(true);
      await page.request
        .post(`${f.baseUrl}/api/server/restart`, {
          data: {},
          headers: { "X-Yep-Anywhere": "true" },
        })
        .then((r) => expect(r.ok()).toBe(true));
      const after = await appBarrier(async () => {
        const worker = (await f.inventory()).find(
          (w) => w.runtimeId === before.runtimeId,
        );
        return worker?.attachedServerGeneration &&
          worker.attachedServerGeneration !== before.attachedServerGeneration
          ? worker
          : false;
      }, "browser API replacement");
      expect(after.pid).toBe(before.pid);
      expect(after.providerProcessGroupIds).toEqual(
        before.providerProcessGroupIds,
      );
      await expect(input).toHaveValue(text);
      held.finish(" BROWSER_STREAM_COMPLETE");
      await expect(
        page.getByText(/BROWSER_STREAM_COMPLETE/).first(),
      ).toBeVisible();
      await input.press("Enter");
      const follow = await f.model.next();
      expect(JSON.stringify(follow.body)).toContain(text);
      follow.finish("BROWSER_FOLLOW_UP_DONE");
      await expect(
        page.getByText("BROWSER_FOLLOW_UP_DONE", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(text, { exact: true })).toHaveCount(1);
      await page.reload();
      await expect(
        page.getByText("BROWSER_FOLLOW_UP_DONE", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(text, { exact: true })).toHaveCount(1);
      await expect(input).toBeEditable();
      await input.pressSequentially("BROWSER_AFTER_REFRESH");
      await input.press("Enter");
      const refreshed = await f.model.next();
      expect(JSON.stringify(refreshed.body)).toContain("BROWSER_AFTER_REFRESH");
      refreshed.finish("BROWSER_REFRESH_REPLY");
      await expect(
        page.getByText("BROWSER_REFRESH_REPLY", { exact: true }),
      ).toBeVisible();
      expect(
        (await f.inventory()).find(
          (worker) => worker.runtimeId === before.runtimeId,
        )?.pid,
      ).toBe(before.pid);
      expect(f.model.requests).toHaveLength(4);
      expect(page.url()).toContain(created.sessionId);
      expect(errors).toEqual([]);
      for (const [name, viewport] of [
        ["desktop", { width: 1000, height: 600 }],
        ["phone", { width: 375, height: 812 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await expect(
          page.getByText("Server changed", { exact: true }),
        ).toHaveCount(0);
        await recordUiCapture(page, `native-app-${provider}-${name}`);
      }
    } catch (error) {
      console.info(await f.diagnostics());
      console.info(
        "Native browser stream frames",
        frames
          .filter((frame) => frame.includes("BROWSER_ACTIVE_STREAM"))
          .map((frame) => frame.slice(0, 1200)),
      );
      throw error;
    } finally {
      try {
        await page.close();
      } finally {
        await f.close();
      }
    }
    expect(f.model.failures).toEqual([]);
  });
