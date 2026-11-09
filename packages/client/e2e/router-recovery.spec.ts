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

test("router recovery preserves sequential typing during status updates and fits desktop and phone", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${origin}/e2e/fixtures/router-recovery.html`);
  const panel = page.getByRole("region", {
    name: "Agent Auth Router",
    exact: true,
  });
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByText("Failed-launch cleanup pending: 2"),
  ).toBeVisible();
  // A healthy pairing shows which socket it uses and hides the socket choice.
  await expect(
    page.getByText("Uses AAR’s default socket", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `router-healthy-${viewport.width}`, viewport);
  }
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.getByRole("button", { name: "Change socket" }).click();
  const input = page.getByRole("textbox", { name: "Socket path (optional)" });
  const measurements = await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    const samples: { latency: number; retained: boolean }[] = [];
    field.addEventListener("input", () => {
      const started = performance.now(),
        expected = field.value;
      requestAnimationFrame(() =>
        samples.push({
          latency: performance.now() - started,
          retained: field.value.startsWith(expected),
        }),
      );
    });
    (window as unknown as { routerTyping: typeof samples }).routerTyping =
      samples;
    return field.value;
  });
  expect(measurements).toBe("");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await input.pressSequentially("/tmp/isolated-router/control.sock", {
    delay: 20,
  });
  await expect(input).toHaveValue("/tmp/isolated-router/control.sock");
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          routerTyping: { latency: number; retained: boolean }[];
        }
      ).routerTyping,
  );
  expect(samples).toHaveLength("/tmp/isolated-router/control.sock".length);
  expect(
    samples.every((sample) => sample.retained && sample.latency < 100),
  ).toBe(true);
  console.log(
    `Router socket typing: ${samples.length} keys, maximum ${Math.max(...samples.map((sample) => sample.latency)).toFixed(1)} ms`,
  );
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `router-cleanup-${viewport.width}`, viewport);
  }
  await page
    .getByRole("button", { name: "Retry failed-launch cleanup" })
    .click();
  await expect(page.getByText("Failed-launch cleanup pending: 2")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Disconnect router" }).click();
  await expect(
    page.getByRole("button", { name: "Finish disconnecting" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Disconnect pending", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toHaveCount(0);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(panel).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const finish = await page
      .getByRole("button", { name: "Finish disconnecting" })
      .boundingBox();
    expect(finish!.height).toBeGreaterThanOrEqual(32);
    await recordUiCapture(page, `router-recovery-${viewport.width}`, viewport);
  }
  await page.getByRole("button", { name: "Finish disconnecting" }).click();
  await expect(
    page.getByRole("button", { name: "Connect local router" }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
