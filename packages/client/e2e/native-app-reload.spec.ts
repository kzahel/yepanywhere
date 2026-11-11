import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureLeaderStartTime } from "./support/process-lifecycle.js";
import { quoteShellWord } from "../../server/src/utils/posixShell.js";
import { expect, test } from "@playwright/test";
import {
  TransportChunkReassembler,
  decodeJsonFrame,
} from "@yep-anywhere/shared";
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
    const f = await nativeAppFixture(provider, { agentApiManagement: true });
    const errors: string[] = [];
    const frames: string[] = [];
    let typing = false;
    let toolFramesWhileTyping = 0;
    const recordFrame = (frame: string) => {
      frames.push(frame);
      const event = JSON.parse(frame);
      if (
        typing &&
        event.type === "event" &&
        event.eventType === "message" &&
        event.data?.type === "user" &&
        /TOOL_FRAME_(B|done)/.test(JSON.stringify(event.data.message?.content))
      )
        toolFramesWhileTyping++;
    };
    page.on("websocket", (socket) => {
      const chunks = new TransportChunkReassembler();
      socket.on("framereceived", (event) => {
        if (typeof event.payload === "string") recordFrame(event.payload);
        else {
          const complete = chunks.acceptFrame(event.payload);
          if (complete) recordFrame(JSON.stringify(decodeJsonFrame(complete)));
        }
      });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    let stopProgress: (() => Promise<void>) | undefined;
    const assertCompletedTool = async () => {
      const activity = page.locator("[data-conversation-activity-summary]");
      if ((await activity.getAttribute("aria-expanded")) !== "true")
        await activity.click();
      await expect(page.locator("[data-tool-row]")).toHaveCount(1);
      await expect(
        page.locator('[data-tool-row][data-tool-status="complete"]'),
      ).toHaveCount(1);
    };
    try {
      await f.ready();
      const created = await f.create("BROWSER_INITIAL_INPUT");
      const priming = await f.model.next();
      priming.finish("BROWSER_PRIMED");
      await page.goto(
        `${f.baseUrl}/projects/${created.projectId}/sessions/${created.sessionId}`,
      );
      const input = page.locator("textarea[data-composer-input]").first();
      // Hosted M1 a71daaa9d still loaded cold Vite modules at the 15s mount
      // guard (885 requests, no detail GET yet). 45s is 3x that lower bound;
      // this is initial fixture readiness, never the 100ms typing contract.
      await expect(input).toBeEditable({ timeout: 45_000 });
      if (provider === "codex") {
        const notice = page
          .locator("details[data-system-message]")
          .filter({ hasText: "Agent API instructions added" });
        await expect(notice).toHaveCount(1);
        await expect(
          page.locator('[data-render-type="user_prompt"]').first(),
        ).toContainText("BROWSER_INITIAL_INPUT");
        await expect(
          page.locator('[data-render-type="user_prompt"]'),
        ).not.toContainText("[Yep Anywhere API]");
        for (const [name, viewport] of [
          ["desktop", { width: 1000, height: 600 }],
          ["phone", { width: 375, height: 812 }],
        ] as const) {
          await page.setViewportSize(viewport);
          await expect(notice).not.toHaveAttribute("open", "");
          await recordUiCapture(page, `api-instructions-${name}`);
          await notice.locator("summary").click();
          await expect(notice).toHaveAttribute("open", "");
          await expect(notice).toContainText(
            "Determine current launch authority from /v0/me",
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          if (name === "phone")
            await recordUiCapture(page, "api-instructions-phone-expanded");
          await notice.locator("summary").click();
        }
        await page.setViewportSize({ width: 1000, height: 600 });
      }
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
      let held = await f.model.next();
      const progress = join(f.project, "tool-progress"),
        ready = join(f.project, "tool-progress-ready");
      const publishProgress = async (value: string) => {
        const staging = `${progress}.next`;
        await writeFile(staging, value);
        await rename(staging, progress);
      };
      if (provider === "codex") {
        const script = join(f.project, "progress-writer.cjs");
        await publishProgress("start");
        await writeFile(
          script,
          `const fs=require('node:fs'),path=require('node:path');const gate=process.argv[2],ready=process.argv[3];let seen;
import(${JSON.stringify(new URL("../../../scripts/provider-process-identity.mjs", import.meta.url).href)}).then(({captureProcessIdentity})=>{
function update(){const value=fs.readFileSync(gate,'utf8');if(value===seen)return;seen=value;console.log('TOOL_FRAME_'+value+' '+('x'.repeat(4096)));if(value==='done')watch.close()}
const watch=fs.watch(path.dirname(gate),(_event,name)=>{if(String(name)===path.basename(gate))update()});fs.writeFileSync(ready,JSON.stringify(captureProcessIdentity()));update();});`,
        );
        const command = `${quoteShellWord(process.execPath)} ${quoteShellWord(script)} ${quoteShellWord(progress)} ${quoteShellWord(ready)}`;
        stopProgress = async () => {
          // A command starting late also reads this terminal gate and exits.
          await publishProgress("done");
          const raw = await readFile(ready, "utf8").catch(() => undefined);
          if (!raw) return;
          const { pid, startTime } = JSON.parse(raw) as {
            pid: number;
            startTime: string;
          };
          if (!Number.isInteger(pid) || pid <= 1 || !startTime)
            throw Error("Invalid owned progress-writer identity");
          if ((await captureLeaderStartTime(pid)) !== startTime) return;
          try {
            process.kill(pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await appBarrier(
            async () => (await captureLeaderStartTime(pid)) !== startTime,
            "owned output writer reaped",
          );
        };
        held.tool(
          "exec",
          `const r=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(f.project)},yield_time_ms:10000,max_output_tokens:20000});text(r.output);`,
        );
        await appBarrier(
          async () => Boolean(await readFile(ready, "utf8").catch(() => "")),
          "owned output watcher ready",
        );
      } else {
        held.partial("BROWSER_ACTIVE_STREAM");
        await expect(
          page.getByText("BROWSER_ACTIVE_STREAM", { exact: true }),
        ).toBeVisible();
      }
      if (provider === "codex") {
        await page.locator("[data-conversation-activity-summary]").click();
      }
      // Focus once; per-key locator checks can hide a busy renderer before dispatch.
      await input.focus();
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
      typing = true;
      for (const char of "BROWSER_FOLLOW_UP") {
        if (provider === "claude") held.partial(" live");
        const update =
          provider === "codex" && text.length <= 7
            ? publishProgress(text.length === 7 ? "done" : text + char)
            : Promise.resolve();
        await Promise.all([page.keyboard.type(char), update]);
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
      typing = false;
      if (provider === "codex")
        expect(toolFramesWhileTyping).toBeGreaterThan(0);
      const acks = await input.evaluate(
        (element) =>
          (element as HTMLTextAreaElement & { acks: { latency: number }[] })
            .acks,
      );
      expect(acks).toHaveLength(text.length);
      expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThan(100);
      if (provider === "codex") {
        held = await f.model.next();
        expect(JSON.stringify(held.body)).toContain("TOOL_FRAME_done");
        await expect
          .poll(() =>
            frames.some((frame) => {
              const event = JSON.parse(frame),
                message = event.data;
              return (
                event.type === "event" &&
                event.eventType === "message" &&
                message?.type === "user" &&
                message._isStreaming !== true &&
                message.isReplay !== true &&
                message.toolUseResult?.exitCode === 0 &&
                JSON.stringify(message.message?.content).includes(
                  "TOOL_FRAME_done",
                )
              );
            }),
          )
          .toBe(true);
        await assertCompletedTool();
      }
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
      if (provider === "codex") await assertCompletedTool();
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
      if (provider === "codex") await assertCompletedTool();
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
      expect(f.model.requests).toHaveLength(provider === "codex" ? 5 : 4);
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
        "Native browser tool rows",
        await page.locator("[data-tool-row]").evaluateAll((rows) =>
          rows.map((row) => ({
            classes: row.className,
            text: row.textContent?.slice(0, 300),
          })),
        ),
      );
      await recordUiCapture(page, `native-app-${provider}-failure`);
      console.info(
        "Native browser stream frames",
        frames.slice(-15).map((frame) => frame.slice(0, 1200)),
      );
      throw error;
    } finally {
      try {
        await stopProgress?.();
      } finally {
        try {
          await page.close();
        } finally {
          await f.close();
        }
      }
    }
    expect(f.model.failures).toEqual([]);
  });
