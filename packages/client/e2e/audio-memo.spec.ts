import type { StagedAttachmentRef } from "@yep-anywhere/shared";
import { AttachmentStagingService } from "../../server/src/uploads/AttachmentStagingService";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures";
import { recordUiCapture } from "./support/ui-capture";
import { routeWithDrain } from "./support/managed-routes";

test.use({
  serviceWorkers: "block",
  launchOptions: {
    chromiumSandbox: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
});

test("new-session attachment panel records a memo, preserves cancellation and sends readable first-turn audio", async ({
  page,
  baseURL,
}) => {
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  // Default capture must use the AudioWorklet tap, loaded under the app's
  // real CSP, rather than silently falling back to ScriptProcessor.
  await page.addInitScript(() => {
    const scope = window as unknown as { yaWorkletNodes: number };
    scope.yaWorkletNodes = 0;
    const Native = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        scope.yaWorkletNodes += 1;
      }
    };
  });
  await page.route("**/api/providers", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            name: "claude",
            displayName: "Claude",
            installed: true,
            authenticated: true,
            enabled: true,
            models: [{ id: "opus", name: "Opus" }],
          },
        ],
      },
    }),
  );
  await page.addInitScript(() =>
    sessionStorage.setItem("yep-anywhere-audio-memo-transcript", "false"),
  );
  let submitted:
    | { message: string; stagedAttachments: StagedAttachmentRef[] }
    | undefined;
  await page.route(
    `**/api/projects/${projectId}/session-creations`,
    (route) => {
      const body = route.request().postDataJSON();
      submitted = body;
      return route.fulfill({
        status: 202,
        json: {
          requestId: body.requestId,
          sessionId: "019a0000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
          projectId,
          provider: "claude",
          creation: {
            state: "saved",
            attemptId: "memo-attempt",
            delivery: "not-admitted",
            updatedAt: new Date().toISOString(),
          },
          serverTimestamp: Date.now(),
        },
      });
    },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/new-session?projectId=${projectId}`);
  const input = page.locator("textarea[data-new-session-form-textarea]");
  await input.pressSequentially("Listen to this memo.", { delay: 20 });
  const attach = page.getByRole("button", {
    name: "Attach files",
    exact: true,
  });
  await attach.click({ button: "right" });
  const panel = page.getByRole("region", {
    name: "Attach to new session",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /Recent uploads/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await recordUiCapture(page, "new-session-attachments-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await panel.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "new-session-attachments-phone");
  await panel.getByRole("button", { name: /Record audio memo/ }).click();
  const stop = page.getByRole("button", {
    name: /Tap here to stop & start session/,
  });
  await expect(stop).toBeEnabled();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(stop).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("Listen to this memo.");
  expect(submitted).toBeUndefined();
  await attach.click({ modifiers: ["Shift"] });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted!.message).toBe("Listen to this memo.");
  expect(submitted!.stagedAttachments).toHaveLength(1);
  const attachment = submitted!.stagedAttachments[0]!;
  expect(attachment.mimeType).toBe("audio/wav");
  // Creation submits staged bytes atomically with the prompt. Destination
  // materialization is owned by the server, covered in creation attachment tests.
  const staging = new AttachmentStagingService({ dataDir: e2ePaths.dataDir });
  await staging.initialize();
  const staged = staging.getRecord(attachment.id);
  expect(staged).toMatchObject({ id: attachment.id, mimeType: "audio/wav" });
  const wav = await readFile(staged!.path);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.length).toBeGreaterThan(44);
  expect(
    await page.evaluate(
      () => (window as unknown as { yaWorkletNodes: number }).yaWorkletNodes,
    ),
  ).toBeGreaterThan(0);
});

test("desktop attachment panel shows recent upload origins and a readable hover preview", async ({
  page,
  baseURL,
}) => {
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  await page.setViewportSize({ width: 1200, height: 600 });
  let blockUpload = false;
  let failUpload: (() => void) | undefined;
  await page.routeWebSocket("**/upload/ws", (socket) => {
    if (!blockUpload) {
      socket.connectToServer();
      return;
    }
    failUpload = () =>
      socket.close({ code: 1011, reason: "Test pending upload failure" });
  });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/mock-session-001`);
  const attach = page.getByRole("button", {
    name: "Attach files",
    exact: true,
  });
  await expect(attach).toBeVisible();
  await expect(
    page.getByText("Loading session...", { exact: true }),
  ).toBeHidden();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1000;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e8effa";
    context.fillRect(0, 0, 1000, 400);
    context.fillStyle = "#182840";
    context.font = "32px sans-serif";
    context.fillText("Attachment preview: text remains readable", 40, 100);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(
    page.getByRole("button", { name: "Open image.png", exact: true }),
  ).toBeVisible();
  await attach.click({ button: "right" });
  const panel = page.getByRole("region", {
    name: "Share to session",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("menu", { name: "Share to session" }),
  ).toHaveCount(0);
  await recordUiCapture(page, "session-attachments-desktop-1200");
  await page.setViewportSize({ width: 1000, height: 600 });
  await recordUiCapture(page, "session-attachments-desktop");
  await panel.getByRole("button", { name: /Recent uploads/ }).click();
  const tile = panel
    .getByRole("button")
    .filter({ has: page.locator("time") })
    .first();
  await expect(tile).toContainText("mockproject");
  await expect(tile).toContainText("ago");
  await expect(tile).not.toContainText("image.png");
  await tile.hover();
  const preview = page
    .getByRole("tooltip")
    .filter({ has: page.locator("img") });
  await expect(preview).toBeVisible();
  expect((await preview.boundingBox())!.width).toBeGreaterThan(500);
  await recordUiCapture(page, "session-attachments-preview");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(preview).toBeHidden();

  // A failed upload racing Send must not deliver only the successful image.
  blockUpload = true;
  let sent = false;
  await page.route("**/sessions/mock-session-001/resume", (route) => {
    sent = true;
    return route.fulfill({
      json: {
        processId: "unexpected-partial-send",
        permissionMode: "default",
        modeVersion: 1,
      },
    });
  });
  const composer = page.locator("[data-composer-input]");
  await composer.fill("Keep both attachments");
  await page.locator('input[type="file"]').setInputFiles({
    name: "failed.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("must not silently omit"),
  });
  await expect.poll(() => !!failUpload).toBe(true);
  await page.locator(".send-button-with-help").click();
  failUpload!();
  await expect(
    page.getByText(
      /An attachment failed to upload\. Attach it again before sending/,
    ),
  ).toBeVisible();
  await expect(composer).toHaveValue("Keep both attachments");
  await expect(
    page.getByText("image.png", { exact: true }).first(),
  ).toBeVisible();
  expect(sent).toBe(false);
});

test("audio memo captures WAV, preserves draft on cancel, and uploads before sending", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-speech-method", "ya-dummy");
    localStorage.setItem("yep-anywhere-attachment-action", "menu");
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const streams: MediaStream[] = [];
    Object.defineProperty(window, "__memoStreams", { value: streams });
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
  });
  await routeWithDrain(page, "**/api/version*", async (route) => {
    const response = await route.fetch();
    const version = await response.json();
    await route.fulfill({
      json: {
        ...version,
        capabilities: [...(version.capabilities ?? []), "voice-input"],
        voiceBackends: ["ya-dummy"],
        voiceBackendCapabilities: { "ya-dummy": { streaming: true } },
      },
    });
  });
  let speechFrames = 0;
  let speechClosed = 0;
  await page.routeWebSocket("**/api/speech/ws", (socket) => {
    socket.onClose(() => {
      speechClosed++;
    });
    socket.onMessage((data) => {
      if (typeof data !== "string") {
        speechFrames++;
        socket.send(
          JSON.stringify({ type: "interim", text: "Draft from live audio" }),
        );
      } else if (JSON.parse(data).type === "start") {
        socket.send(JSON.stringify({ type: "ready" }));
      }
    });
  });
  let failUpload = true;
  await page.routeWebSocket("**/upload/ws", (socket) => {
    if (failUpload) {
      failUpload = false;
      socket.close({ code: 1011, reason: "Test upload interruption" });
    } else socket.connectToServer();
  });
  let transcriptions = 0;
  await page.route("**/api/speech/transcribe", async (route) => {
    transcriptions++;
    const body = route.request().postDataJSON();
    expect(body.mimeType).toBe("audio/wav");
    expect(Buffer.from(body.audioBase64, "base64").readUInt32LE(24)).toBe(
      24000,
    );
    await route.fulfill({ json: { text: "Please keep the word send." } });
  });
  let submitted:
    | { message: string; attachments: { path: string; mimeType: string }[] }
    | undefined;
  await page.route("**/sessions/mock-session-001/resume", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      json: {
        processId: "audio-memo-test",
        permissionMode: "default",
        modeVersion: 1,
        serverTimestamp: Date.now(),
      },
    });
  });
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  await page.goto(`${baseURL}/projects/${projectId}/sessions/mock-session-001`);
  const input = page.locator("[data-composer-input]");
  await expect(input).toBeVisible();
  // Stored selection renders before asynchronous streaming capabilities.
  await expect(
    page.getByRole("button", { name: "Start voice input" }),
  ).toHaveAttribute("data-speech-streaming", "true");
  await input.focus();
  for (const character of "Listen to this.") {
    const before = await input.inputValue();
    await page.keyboard.type(character);
    expect(await input.inputValue()).toBe(before + character);
  }
  const attach = page.getByRole("button", {
    name: "Attach files",
    exact: true,
  });
  await attach.click();
  await expect(
    page.getByRole("menu", { name: "Share to session" }),
  ).toBeVisible();
  await recordUiCapture(page, "audio-memo-phone-menu");
  await page.getByRole("menuitem", { name: "Record audio memo" }).click();
  const stop = page.getByRole("button", {
    name: /Tap anywhere here to stop & send/,
  });
  await expect(stop).toBeEnabled();

  await expect(
    page.getByText("Draft from live audio", { exact: true }),
  ).toBeVisible();
  expect(speechFrames).toBeGreaterThan(0);
  await recordUiCapture(page, "audio-memo-phone-streaming");
  await expect(
    page.getByRole("checkbox", { name: "Include transcript" }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "Include transcript" }).uncheck();
  await expect(
    page.getByText("Draft from live audio", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => speechClosed).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __memoStreams: MediaStream[] }
        ).__memoStreams[0]!.getAudioTracks()[0]!.readyState,
    ),
  ).toBe("live");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(stop).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("Listen to this.");
  expect(submitted).toBeUndefined();
  expect(transcriptions).toBe(0);

  await attach.click({ modifiers: ["Shift"] });
  await expect(stop).toBeEnabled();
  await page.getByRole("checkbox", { name: "Include transcript" }).check();
  await recordUiCapture(page, "audio-memo-phone-recording");
  await page.setViewportSize({ width: 1000, height: 600 });
  await recordUiCapture(page, "audio-memo-desktop-recording");
  await page.keyboard.press("Control+Shift+Space");
  await expect(
    page.getByRole("alert").filter({ hasText: "Audio upload failed" }),
  ).toBeVisible();
  expect(submitted).toBeUndefined();
  await page.getByRole("button", { name: /Retry sending this take/ }).click();
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted!.message).toBe(
    "Listen to this.\n\n🎤 Audio transcript\nPlease keep the word send.",
  );
  expect(submitted!.attachments).toHaveLength(1);
  const attachment = submitted!.attachments[0]!;
  expect(attachment.mimeType).toBe("audio/wav");
  const wav = await readFile(attachment.path);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(wav.readUInt16LE(34)).toBe(16);
  expect(wav.length).toBeGreaterThan(44);
  expect(transcriptions).toBe(1);
});
