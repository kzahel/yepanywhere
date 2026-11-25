import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import {
  emitCapturePreview,
  writeCapturePreview,
} from "../scripts/artifact-capture.js";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  startTypingDiagnostics,
  typingAckLimitMs,
} from "./support/typing-diagnostics.js";

type KeyAcknowledgement = {
  latency: number;
  value: string;
  focused: boolean;
};

type MeasuredComposer = HTMLTextAreaElement & {
  acknowledgements: KeyAcknowledgement[];
};

// Each viewport types into this session's synced draft on the worker's shared
// server; clear it so a later case's emptied composer is not refilled with
// an earlier case's text.
test.use({ draftSessionIds: ["transcript-specimen-001"] });

// One owned browser fixture bundle; the production UI retains its own CSP.
const nativeFixtureBundle = buildSync({
  entryPoints: [
    resolve("src/lib/transport/__tests__/nativeTransportFixture.ts"),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "yaNativeFixtureModule",
  conditions: ["source"],
}).outputFiles[0]!.text;

function installNativeBridge() {
  const queued: (string | ArrayBuffer)[] = [];
  const channel = {
    onmessage: null as ((event: { data: string | ArrayBuffer }) => void) | null,
    postMessage: (message: string | ArrayBuffer) => {
      queued.push(message);
    },
  };
  Object.assign(window, { yaNativeTransport: channel });
  const { NativeTransportFixture } = (
    window as unknown as {
      yaNativeFixtureModule: typeof import("../src/lib/transport/__tests__/nativeTransportFixture");
    }
  ).yaNativeFixtureModule;
  let available = !location.search.includes("nativeOffline");
  const host = new NativeTransportFixture(
    true,
    available ? "CONNECTED" : "FAILED",
  );
  Object.assign(window, {
    restoreNativeSource: () => {
      available = true;
      window.dispatchEvent(new Event("online"));
    },
  });
  host.channel.onmessage = (event: { data: string | ArrayBuffer }) =>
    channel.onmessage?.(event);
  channel.postMessage = (message) => host.channel.postMessage(message);
  host.handler = (command: Record<string, unknown>) => {
    if (!available) throw new Error("Native connection unavailable");
    if (command.method === "reconnect") {
      void host.emit({ type: "state", phase: "CONNECTED" });
      return {};
    }
    if (command.method === "request")
      return (
        window as unknown as {
          nativeRequest: (command: unknown) => Promise<unknown>;
        }
      ).nativeRequest(command);
    if (command.method === "subscribe") {
      void host.emit({
        type: "event",
        subscriptionId: (command.params as { subscriptionId: string })
          .subscriptionId,
        eventType: "connected",
        data: {},
      });
    }
    return {};
  };
  Object.assign(window, { nativeFixture: host });
  for (const message of queued) host.channel.postMessage(message);
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`native source opens the full app and acknowledges typing at ${viewport.name}`, async ({
    page,
    baseURL,
    remotePreviewURL,
  }, testInfo) => {
    // Cold Projects + session recovery, draft typing and captures measured
    // 9 s; asynchronous fixture compilation separately exceeded 5 s under load.
    // Allow 30 s (~3.3x the completed run) for this combined boundary proof.
    test.setTimeout(30_000);
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeBinding(
      "nativeRequest",
      async (
        _,
        command: {
          params: {
            path: string;
            method: string;
            headers?: Record<string, string>;
            body?: unknown;
          };
        },
      ) => {
        const params = command.params;
        const response = await fetch(`${baseURL}${params.path}`, {
          method: params.method,
          headers: params.headers,
          body: params.body == null ? undefined : JSON.stringify(params.body),
          redirect: "manual",
        });
        const headers = Object.fromEntries(response.headers);
        const bytes = Buffer.from(await response.arrayBuffer());
        const body = headers["content-type"]?.includes("json")
          ? JSON.parse(bytes.toString())
          : { _binary: true, data: bytes.toString("base64") };
        return { status: response.status, headers, body };
      },
    );
    await page.addInitScript({
      content: `${nativeFixtureBundle}
window.yaNativeFixtureModule = yaNativeFixtureModule;
(${installNativeBridge.toString()})();`,
    });

    // The document and navigation are available before its first native
    // connection. Recovery must revalidate failed initial reads without reload.
    // Exercise the shipped UI with the prebundled bridge fixture, without
    // cold Vite route transforms consuming application assertions.
    await page.goto(`${remotePreviewURL}/projects?nativeOffline`);
    // Native attachment is a prerequisite for application recovery.
    await page
      .waitForFunction(() => "nativeFixture" in window)
      .catch((error) => {
        throw new Error(`${error.message}\n${errors.join("\n")}`);
      });
    await expect(
      page.locator("header").getByText("Projects", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-connection-status="disconnected"]'),
    ).toBeVisible();
    const coldOut = mkdtempSync(join(tmpdir(), "ya-native-offline-captures-"));
    const coldPath = join(coldOut, `${viewport.name}.png`);
    await page.screenshot({ path: coldPath, animations: "disabled" });
    emitCapturePreview(
      await writeCapturePreview({
        input: page.url(),
        out: join(coldOut, viewport.name),
        screenshots: [{ ...viewport, path: coldPath }],
      }),
    );
    const coldDocument = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() =>
      (
        window as unknown as { restoreNativeSource: () => void }
      ).restoreNativeSource(),
    );
    await expect(page.locator("[data-connection-status]")).toHaveCount(0);
    await expect(page.locator("[data-project-list-cards]")).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      coldDocument,
    );

    const projectId = Buffer.from(
      join(e2ePaths.tempDir, "mockproject"),
    ).toString("base64url");
    await page.goto(
      `${remotePreviewURL}/projects/${projectId}/sessions/transcript-specimen-001?nativeOffline`,
    );
    // Each navigation imports and initializes the local bridge anew.
    await page
      .waitForFunction(() => "nativeFixture" in window)
      .catch((error) => {
        throw new Error(`${error.message}\n${errors.join("\n")}`);
      });
    const skip = page.getByRole("button", { name: "Skip all", exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    const composer = page.locator("textarea[data-composer-input]");
    await expect(composer).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.locator('[data-connection-status="disconnected"]'),
    ).toBeVisible();
    const sessionDocument = await page.evaluate(() => performance.timeOrigin);
    await composer.pressSequentially("Offline draft", { delay: 35 });
    await page.evaluate(() =>
      (
        window as unknown as { restoreNativeSource: () => void }
      ).restoreNativeSource(),
    );
    await expect(page.locator("[data-message-list]")).toBeVisible();
    await expect(
      page.locator("[data-session-messages]").getByRole("status"),
    ).toHaveCount(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(
      sessionDocument,
    );
    await expect(composer).toHaveValue("Offline draft");
    await composer.clear();

    await composer.click();
    await expect(composer).toBeFocused();
    const recordTyping = await startTypingDiagnostics(composer);
    await composer.evaluate((element) => {
      const field = element as MeasuredComposer;
      const host = (
        window as unknown as {
          nativeFixture: { emit: (event: unknown) => Promise<void> };
        }
      ).nativeFixture;
      const pad = "x".repeat(1024 * 1024);
      Object.assign(window, {
        nativeLoadTimer: setInterval(() => {
          void host.emit({ type: "state", phase: "CONNECTED", pad });
        }, 50),
      });
      field.acknowledgements = [];
      field.addEventListener("keydown", (event) => {
        field.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() =>
              field.acknowledgements.push({
                latency: performance.now() - event.timeStamp,
                value: field.value,
                focused: document.activeElement === field,
              }),
            ),
          { once: true },
        );
      });
    });
    const readAcknowledgements = () =>
      composer.evaluate(
        (element) => (element as MeasuredComposer).acknowledgements,
      );
    const text =
      "Native transport keeps every key responsive during incoming updates.";
    const prefixes: string[] = [];
    for (const character of text) {
      const prefix = (prefixes.at(-1) ?? "") + character;
      prefixes.push(prefix);
      await page.keyboard.type(character, { delay: 35 });
      await expect
        .poll(async () => (await readAcknowledgements())?.at(-1)?.value)
        .toBe(prefix);
    }
    await expect(composer).toHaveValue(text);
    await page.evaluate(() =>
      clearInterval(
        (window as unknown as { nativeLoadTimer: number }).nativeLoadTimer,
      ),
    );
    const acknowledgements = await readAcknowledgements();
    const slowest = Math.max(...acknowledgements.map(({ latency }) => latency));
    await recordTyping(
      testInfo,
      `native-webview-${viewport.name}`,
      acknowledgements,
      slowest,
    );
    expect(acknowledgements.map(({ value }) => value)).toEqual(prefixes);
    expect(acknowledgements.every(({ focused }) => focused)).toBe(true);
    expect(slowest).toBeLessThanOrEqual(typingAckLimitMs);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          /remote-credentials|remote-session/.test(key),
        ),
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
    const out = mkdtempSync(join(tmpdir(), "ya-native-webview-captures-"));
    const path = join(out, `${viewport.name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(viewport.name, { path, contentType: "image/png" });
    emitCapturePreview(
      await writeCapturePreview({
        input: page.url(),
        out: join(out, viewport.name),
        screenshots: [{ ...viewport, path }],
      }),
    );
    console.log(
      `Native typing ${viewport.name}: ${text.length} keys, maximum ${slowest.toFixed(1)} ms at 20 Hz / 1 MiB frames`,
    );
  });
}
