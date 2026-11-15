import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import { startTypingDiagnostics } from "./support/typing-diagnostics.js";

test("installation selection preserves sequential path typing during probe results on desktop and phone", async ({
  page,
  baseURL,
}) => {
  let supported = false;
  let reads = 0;
  let releaseProbe = () => {};
  let probeReady = Promise.resolve();
  let selection: string | null = null;
  const candidates = Array.from({ length: 24 }, (_, index) => ({
    path: `/opt/provider-installations/node-${index}/bin/codex`,
    source: "npm / fnm",
    version: `0.${169 - index}.0`,
    launch: {
      command: `/opt/provider-installations/node-${index}/bin/codex`,
      args: [],
    },
    selected: index === 0,
    verification: index === 0 ? "verified" : "unverified",
  }));
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        current: "0.12.0",
        capabilities: supported ? ["cli-installations"] : [],
        capabilityEncoding: undefined,
        capabilityBits: undefined,
        deniedCapabilityBits: undefined,
      },
    });
  });
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider: { name: string }) =>
          provider.name === "codex"
            ? {
                ...provider,
                installed: true,
                authenticated: true,
                enabled: true,
              }
            : provider,
        ),
      },
    });
  });
  await page.route("**/api/settings/cli-installations/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") reads++;
    if (request.method() === "PUT") selection = request.postDataJSON().path;
    if (request.url().endsWith("/test")) await probeReady;
    await route.fulfill({
      json: {
        family: request.url().includes("antigravity") ? "antigravity" : "codex",
        selection,
        managed: false,
        candidates: selection
          ? [
              {
                ...candidates[0],
                path: selection,
                source: "Custom path",
                verification: "verified",
              },
              ...candidates.map((candidate) => ({
                ...candidate,
                selected: false,
              })),
            ]
          : candidates,
      },
    });
  });
  await page.goto(`${baseURL}/settings/providers`);
  await expect(
    page.locator('[data-settings-item="provider-codex"]'),
  ).toBeVisible();
  await expect(page.locator("[data-cli-installation]")).toHaveCount(0);
  expect(reads).toBe(0);
  supported = true;
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.reload();
    const panel = page.locator('[data-cli-installation="codex"]');
    await panel
      .getByRole("combobox", { name: "CLI installation", exact: true })
      .selectOption("custom");
    const field = panel.getByRole("textbox", {
      name: "Absolute executable path",
    });
    await field.click();
    await startTypingDiagnostics(field);
    const identity = await field.elementHandle();
    probeReady = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let expected = "";
    for (const character of "/opt/custom installation/bin/codex") {
      expected += character;
      if (expected.length === 4)
        await panel
          .getByRole("button", { name: "Test execution" })
          .evaluate((button) => (button as HTMLButtonElement).click());
      if (expected.length === 9) releaseProbe();
      await page.keyboard.type(character);
      await field.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(field).toHaveValue(expected);
      await expect(field).toBeFocused();
    }
    releaseProbe();
    expect(
      await field.evaluate(
        (element, original) => element === original,
        identity,
      ),
    ).toBe(true);
    const samples = await field.evaluate(
      (element) =>
        (
          element as HTMLInputElement & {
            typingDiagnostics: {
              keys: Array<{ secondFrameMs: number; retained: boolean }>;
            };
          }
        ).typingDiagnostics.keys,
    );
    console.log(
      `CLI path ${viewport.width}px: ${Math.max(...samples.map((sample) => sample.secondFrameMs)).toFixed(1)}ms maximum acknowledgement`,
    );
    expect(samples).toHaveLength(expected.length);
    expect(
      samples.every((sample) => sample.retained && sample.secondFrameMs < 100),
    ).toBe(true);
    await panel.getByRole("button", { name: "Save path" }).click();
    await expect.poll(() => selection).toBe(expected);
    await expect(
      panel.getByRole("button", { name: "Save path" }),
    ).toBeEnabled();
    await expect(
      panel
        .locator("li")
        .filter({ hasText: expected })
        .getByText("Selected", { exact: true }),
    ).toBeVisible();
    await panel.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await recordUiCapture(
      page,
      `cli-installations-${viewport.width}`,
      viewport,
    );
    selection = null;
  }
});
