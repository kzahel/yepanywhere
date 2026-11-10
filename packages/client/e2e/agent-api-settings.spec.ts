import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("agent API discovery previews its bootstrap and acknowledges typing during a settings reply", async ({
  page,
  baseURL,
}) => {
  let enabled = false;
  let management = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Browser-owned writes keep this case independent of other fixture settings.
  await page.route("**/api/settings", async (route) => {
    const response = await page.request.get(route.request().url());
    const body = await response.json();
    if (route.request().method() === "PUT") {
      const updates = route.request().postDataJSON();
      if (typeof updates.agentApiEnabled === "boolean")
        enabled = updates.agentApiEnabled;
      if (typeof updates.agentApiManagementEnabled === "boolean")
        management = updates.agentApiManagementEnabled;
      await held;
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        settings: {
          ...body.settings,
          agentApiEnabled: enabled,
          agentApiManagementEnabled: management,
        },
      },
    });
  });
  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${baseURL}/settings/local-access`);
    const skip = page.getByRole("button", { name: "Skip all", exact: true });
    if (await skip.isVisible()) await skip.click();
    const toggle = page.getByRole("switch", {
      name: "Agent API discovery",
      exact: true,
    });
    const toggleControl = toggle.locator("..");
    await expect(toggleControl).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggleControl.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-api-desktop");
    await toggleControl.click();
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.focus();
    await search.evaluate((element) => {
      const input = element as HTMLInputElement;
      (window as unknown as { apiTyping: number[] }).apiTyping = [];
      input.addEventListener("keydown", () => {
        const start = performance.now();
        input.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() => {
              (window as unknown as { apiTyping: number[] }).apiTyping.push(
                performance.now() - start,
              );
            }),
          { once: true },
        );
      });
    });
    let typed = "";
    for (const character of "Agent API discovery") {
      typed += character;
      if (typed.length === 4) release();
      await search.pressSequentially(character);
      await expect(search).toHaveValue(typed, { timeout: 100 });
    }
    await expect(toggle).toBeChecked();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { apiTyping: number[] }).apiTyping.length,
        ),
      )
      .toBe(typed.length);
    const times = await page.evaluate(
      () => (window as unknown as { apiTyping: number[] }).apiTyping,
    );
    expect(Math.max(...times), JSON.stringify(times)).toBeLessThanOrEqual(100);
    await search.clear();
    await page.goto(`${baseURL}/settings/local-access`);
    await expect(toggle).toBeChecked();
    const managementToggle = page.getByRole("switch", {
      name: "Agent session commands",
      exact: true,
    });
    const managementControl = managementToggle.locator("..");
    await expect(managementToggle).not.toBeChecked();
    await managementControl.click();
    await expect(managementToggle).toBeChecked();
    await managementControl.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-session-commands-desktop");
    const preview = page.getByText("Preview agent instructions", {
      exact: true,
    });
    const details = preview.locator("..");
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await preview.click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("AGENT_YA_V0_AUTHORIZATION");
    await expect(details).toContainText("explicit session-command authority");
    await details.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-api-desktop-preview");
    await page.setViewportSize({ width: 375, height: 812 });
    // Crossing this breakpoint remounts the pane. Wait for the phone detail
    // layout before reading/toggling the new native details element.
    await expect(
      page.getByRole("searchbox", { name: "Search settings" }),
    ).toHaveCount(0);
    if (await details.evaluate((node) => (node as HTMLDetailsElement).open)) {
      await preview.focus();
      await preview.press("Enter");
    }
    await expect(details).not.toHaveAttribute("open", "");
    await toggleControl.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-api-phone");
    await managementControl.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-session-commands-phone");
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await preview.click();
    await expect(details).toHaveAttribute("open", "");
    await preview.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "agent-api-phone-preview");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    release();
  }
});
