import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

test("Gateway drafts wait for metadata and survive concurrent settings updates while typing", async ({
  page,
  baseURL,
}) => {
  let releaseVersion = () => {};
  const versionReady = new Promise<void>((resolve) => {
    releaseVersion = resolve;
  });
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const version = await response.json();
    await versionReady;
    await route.fulfill({
      response,
      json: {
        ...version,
        // CI uses an opaque source SHA. Model the stable single-Gateway editor,
        // while leaving the newer services editor outside this fixture.
        current: "0.8.0",
        capabilities: ["claude-gateway"],
        capabilityEncoding: undefined,
        capabilityBits: undefined,
        deniedCapabilityBits: undefined,
      },
    });
  });

  let releaseSettings = () => {};
  const settingsReady = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  // Keep the mutation browser-owned: exercise the real settings response and
  // retained store without changing the shared fixture's server settings.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          settings: { ...body.settings, claudeGatewayDisablePlanMode: false },
        },
      });
      return;
    }
    if (route.request().method() !== "PUT") return route.continue();
    const response = await page.request.get(route.request().url());
    const body = await response.json();
    await settingsReady;
    await route.fulfill({
      response,
      json: {
        ...body,
        settings: { ...body.settings, ...route.request().postDataJSON() },
      },
    });
  });

  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${baseURL}/settings/providers`);
    await expect(
      page.locator('[data-settings-item="providers-idle-reap-hours"]'),
    ).toBeVisible();
    // This differs from the loading default, proving settings have reached
    // React while version metadata is still held.
    await expect(
      page.getByRole("switch", { name: "Disable plan mode", exact: true }),
    ).not.toBeChecked();
    const url = page.getByRole("textbox", {
      name: "Claude gateway endpoint URL",
      exact: true,
    });
    await expect(url).toHaveCount(0);
    releaseVersion();
    await expect(url).toBeVisible();
    const command = page.getByRole("textbox", {
      name: "Claude gateway start command",
      exact: true,
    });
    await expect(command).toBeVisible();
    await url.click();
    await url.press("ControlOrMeta+A");
    await url.press("Backspace");
    await url.evaluate((element) => {
      const input = element as HTMLInputElement;
      (window as unknown as { gatewayTyping: number[] }).gatewayTyping = [];
      input.addEventListener("keydown", () => {
        const start = performance.now();
        input.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() => {
              (
                window as unknown as { gatewayTyping: number[] }
              ).gatewayTyping.push(performance.now() - start);
            }),
          { once: true },
        );
      });
    });
    let typed = "";
    for (const character of "http://gateway.example.test:4141") {
      typed += character;
      if (typed.length === 4) {
        await page
          .locator("#provider-claude-gateway-disable-agent input")
          .evaluate((element) => (element as HTMLInputElement).click());
      }
      if (typed.length === 8) releaseSettings();
      await url.pressSequentially(character);
      await expect(url).toHaveValue(typed, { timeout: 100 });
    }
    await expect(
      page.getByRole("switch", { name: "Disable Agent tool", exact: true }),
    ).not.toBeChecked();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { gatewayTyping: number[] }).gatewayTyping
              .length,
        ),
      )
      .toBe(typed.length);
    const samples = await page.evaluate(
      () => (window as unknown as { gatewayTyping: number[] }).gatewayTyping,
    );
    expect(Math.max(...samples), JSON.stringify(samples)).toBeLessThanOrEqual(
      100,
    );
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);
    await recordUiCapture(page, "gateway-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    // The responsive Settings shell remounts its pane across this breakpoint.
    // Click retries against the mounted input before capturing the phone layout.
    await url.click();
    await recordUiCapture(page, "gateway-phone");
  } finally {
    releaseVersion();
    releaseSettings();
  }
});

for (const width of [375, 1000, 1100, 1200, 1400]) {
  test(`provider limits keep readable text at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({
      width,
      height: width === 375 ? 812 : 600,
    });
    await page.goto(`${baseURL}/settings/providers`);
    const firstRow = page.locator(
      '[data-settings-item="providers-subagent-max-depth"]',
    );
    await expect(firstRow).toBeVisible();

    for (const fontSize of [16, 20]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      for (const id of [
        "providers-subagent-max-depth",
        "providers-idle-reap-hours",
      ]) {
        const row = page.locator(`[data-settings-item="${id}"]`);
        await expect
          .poll(() =>
            row.evaluate((element) => {
              const info = element.querySelector("[data-settings-info]");
              if (!info) throw new Error("Missing setting explanation");
              return (
                info.getBoundingClientRect().width /
                element.getBoundingClientRect().width
              );
            }),
          )
          .toBeGreaterThan(0.4);
        expect(
          await row.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      }
    }

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await firstRow.scrollIntoViewIfNeeded();
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-settings-item="providers-post-compact-replay"]'),
    ).toHaveCount(0);
    await recordUiCapture(page, `providers-${width}`);
  });
}
