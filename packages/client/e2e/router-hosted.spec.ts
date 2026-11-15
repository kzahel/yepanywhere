import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";

let vite: Awaited<ReturnType<typeof createTestViteServer>>;
let origin: string;
test.beforeAll(async () => {
  vite = await createTestViteServer({
    root: resolve(import.meta.dirname, ".."),
    server: { port: 0, host: "127.0.0.1" },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  try {
    await presentUiCaptures();
  } finally {
    await vite?.close();
  }
});

test("hosted pairing keeps URL/name typing responsive and presents the owner code on desktop and phone", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  await page.goto(`${origin}/e2e/fixtures/router-hosted.html`);
  await page.getByRole("radio", { name: "Hosted", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Yep Anywhere on test-host");
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [label, text] of [
      ["HTTPS router URL", "https://aar.example.com"],
      ["Name", "Yep Anywhere on laptop"],
    ] as const) {
      const input = page.getByRole("textbox", { name: label, exact: true });
      await input.fill("");
      await input.focus();
      await input.evaluate((element) => {
        const field = element as HTMLInputElement;
        const samples: {
          latency: number;
          retained: boolean;
          identity: boolean;
        }[] = [];
        let started = 0;
        field.addEventListener("keydown", (event) => {
          started = event.timeStamp;
        });
        field.addEventListener("input", () => {
          const expected = field.value,
            inputStarted = started;
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              samples.push({
                latency: performance.now() - inputStarted,
                retained: field.value.startsWith(expected),
                identity: document.activeElement === field && field.isConnected,
              }),
            ),
          );
        });
        (window as unknown as { hostedTyping: typeof samples }).hostedTyping =
          samples;
      });
      await page
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await input.focus();
      await page.keyboard.type(text, { delay: 35 });
      await expect(input).toHaveValue(text);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const samples = await page.evaluate(
        () =>
          (
            window as unknown as {
              hostedTyping: {
                latency: number;
                retained: boolean;
                identity: boolean;
              }[];
            }
          ).hostedTyping,
      );
      expect(samples).toHaveLength(text.length);
      expect(
        samples.every(
          (sample) =>
            sample.retained && sample.identity && sample.latency < 100,
        ),
      ).toBe(true);
      console.log(
        `Hosted ${label} ${viewport.width}: ${samples.length} keys; max ${Math.max(...samples.map((s) => s.latency)).toFixed(1)} ms`,
      );
    }
    await recordUiCapture(
      page,
      `router-hosted-form-${viewport.width}`,
      viewport,
    );
  }
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open router dashboard" }),
  ).toHaveAttribute("href", "https://aar.example.com/#pair");
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(
      page,
      `router-hosted-code-${viewport.width}`,
      viewport,
    );
  }
  await page.evaluate(() =>
    (
      window as unknown as { approveHostedRouter: () => void }
    ).approveHostedRouter(),
  );
  await expect(
    page.getByText("Connected to aar.example.com", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
