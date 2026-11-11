import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";
import { recordUiCapture } from "./support/ui-capture";

test.use({ serviceWorkers: "block" });

test("composer beacon acknowledges real sends and leaves typing and title options intact", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const clientPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({ label: "composer beacon" });
  const source = await createTestViteServer({
    configFile: join(clientPath, "vite.config.ts"),
    define: { __VITE_DEV_PORT__: "-1" },
    server: {
      port: 0,
      host: "127.0.0.1",
      proxy: { "/api": { target: backend.baseUrl, ws: true } },
    },
  });
  const projectId = Buffer.from(clientPath).toString("base64url");
  const row = {
    id: "beacon-session",
    projectId,
    title: "Hotkey composer",
    fullTitle: "Hotkey composer",
    projectName: "YA",
    provider: "claude",
    activity: "idle",
    ownership: { owner: "none" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 160,
  };
  const errors: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-voice-input-enabled", "true");
    localStorage.setItem("yep-anywhere-speech-method", "browser-native");
    class Recognition {
      onstart?: (event: Event) => void;
      onaudiostart?: (event: Event) => void;
      onend?: (event: Event) => void;
      onresult?: (event: Event) => void;
      constructor() {
        Object.assign(window, { testRecognition: this });
      }
      start() {
        queueMicrotask(() => {
          this.onstart?.(new Event("start"));
          this.onaudiostart?.(new Event("audiostart"));
        });
      }
      stop() {}
      abort() {}
      emit(transcript: string, isFinal: boolean) {
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal, 0: { transcript } }],
        } as unknown as Event);
        if (isFinal) this.onend?.(new Event("end"));
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
    route.fulfill({ json: { sessions: [row], hasMore: false, total: 1 } }),
  );
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/beacon-session(?:\?|$)/,
    (route) =>
      route.fulfill({
        json: {
          session: row,
          ownership: { owner: "none" },
          messages: Array.from({ length: 160 }, (_, i) => ({
            uuid: `message-${i}`,
            type: i % 2 ? "assistant" : "user",
            content: `Transcript turn ${i}. Keep the composer responsive while this history is mounted.`,
          })),
        },
      }),
  );
  await page.route(/\/api\/sessions\/beacon-session\/process$/, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  const responseGate: { release?: () => void } = {};
  const releaseResponse = () => {
    const release = responseGate.release;
    if (!release) throw new Error("No pending response to release");
    responseGate.release = undefined;
    release();
  };
  let succeed = false;
  let received = "";
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/beacon-session\/resume$/,
    async (route) => {
      received = route.request().postData() ?? "";
      await new Promise<void>((resolve) => {
        responseGate.release = resolve;
      });
      await route.fulfill(
        succeed
          ? { json: { processId: "beacon-process", permissionMode: "default" } }
          : { status: 503, json: { error: "Controlled send failure" } },
      );
    },
  );
  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.goto(`${origin}/projects/${projectId}/sessions/beacon-session`);
    const composer = page.locator("[data-composer-input]:visible");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.focus();
    await composer.fill("mid draft");
    await composer.evaluate((element) =>
      (element as HTMLTextAreaElement).setSelectionRange(3, 3),
    );
    await page
      .getByText(
        "Transcript turn 159. Keep the composer responsive while this history is mounted.",
        { exact: true },
      )
      .click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty("selectionStart", 3);
    await page.keyboard.press("Control+s");
    const search = page.getByRole("search");
    await expect(search).toBeVisible();
    await search.getByRole("textbox").click();
    await expect(composer).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();
    await composer.fill("");
    await composer.focus();
    await expect(page).toHaveTitle(/\[YA1 f=[1-9]\d* r=0 a=0 s=idle\] w=1/);
    await page.keyboard.press("Control+Alt+Shift+F8");
    await expect(composer).toBeFocused();
    await expect(page).toHaveTitle(/r=[1-9]\d* a=0 s=idle/);
    const request = / r=(\d+)/.exec(await page.title())?.[1];

    await composer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      const timings: number[] = [];
      let keyAt = 0;
      field.addEventListener("keydown", () => {
        keyAt = performance.now();
      });
      field.addEventListener("input", () =>
        timings.push(performance.now() - keyAt),
      );
      Object.assign(window, { beaconTypingTimings: timings });
    });
    let text = "";
    for (const character of "Keep this window visible on monitor two.") {
      await page.evaluate(() => {
        document.title = "YA:Background update";
      });
      await page.keyboard.type(character);
      text += character;
      await expect(composer).toHaveValue(text, { timeout: 100 });
    }
    const timings = await page.evaluate(
      () =>
        (window as unknown as { beaconTypingTimings: number[] })
          .beaconTypingTimings,
    );
    expect(timings).toHaveLength(text.length);
    expect(Math.max(...timings)).toBeLessThan(100);
    await composer.press("Enter");
    await expect(page).toHaveTitle(/↥ \[YA1 .*a=0 s=sending\]/);
    await expect.poll(() => received).toContain(text);
    await expect.poll(() => typeof responseGate.release).toBe("function");
    releaseResponse();
    await expect(page).toHaveTitle(/! \[YA1 .*a=0 s=error\]/);
    await expect(composer).toHaveValue(text);

    succeed = true;
    await composer.press("Enter");
    await expect(page).toHaveTitle(/s=sending\]/);
    await expect.poll(() => typeof responseGate.release).toBe("function");
    releaseResponse();
    await expect(page).toHaveTitle(
      new RegExp(`✓ \\[YA1 .*r=${request} a=${request} s=delivered\\]`),
    );
    await expect(composer).toHaveValue("");

    await page.keyboard.press("Control+Alt+Shift+F8");
    const speechRequest = / r=(\d+)/.exec(await page.title())?.[1];
    await page.keyboard.press("Control+Space");
    await expect(page).toHaveTitle(/^🎙 /);
    await page.evaluate(() => {
      (
        window as unknown as {
          testRecognition: { emit(text: string, final: boolean): void };
        }
      ).testRecognition.emit("provisional words", false);
    });
    await expect(page.locator("[data-speech-interim-inline]")).toHaveText(
      "provisional words",
    );
    received = "";
    await composer.press("Enter");
    await expect(page).not.toHaveTitle(/^🎙 /);
    await composer.pressSequentially("next draft");
    expect(received).toBe("");
    await page.evaluate(() => {
      (
        window as unknown as {
          testRecognition: { emit(text: string, final: boolean): void };
        }
      ).testRecognition.emit("final wording", true);
    });
    await expect.poll(() => received).toContain("🎤 final wording");
    await expect.poll(() => typeof responseGate.release).toBe("function");
    releaseResponse();
    await expect(page).toHaveTitle(
      new RegExp(`a=${speechRequest} s=delivered`),
    );
    await expect(composer).toHaveValue("next draft");

    await page.goto(`${origin}/settings/appearance`);
    const setting = page.getByRole("switch", {
      name: "Composer Hotkey Beacon",
      exact: true,
    });
    await expect(setting).toBeChecked();
    for (const viewport of [
      { name: "desktop", width: 1200, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      // Crossing the phone breakpoint swaps the settings layout and remounts
      // the pane, which can detach the row mid-scroll; retry on the new row.
      await expect(async () => {
        await setting.locator("..").scrollIntoViewIfNeeded({ timeout: 2000 });
      }).toPass();
      await recordUiCapture(page, `composer-beacon-${viewport.name}`);
    }
    await setting.locator("..").click();
    await expect(setting).not.toBeChecked();
    await page.goto(`${origin}/projects/${projectId}/sessions/beacon-session`);
    await expect(composer).toBeVisible();
    await composer.focus();
    await page.keyboard.press("Control+Alt+Shift+F8");
    await expect(page).not.toHaveTitle(/\[YA1/);
    expect(errors).toEqual([]);
  } finally {
    responseGate.release?.();
    await source.close();
    await disposeYaServerProcess(backend);
  }
});
