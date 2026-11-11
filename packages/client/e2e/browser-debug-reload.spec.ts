import { mkdirSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";
const otherSessionId = "user-turn-presentation-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

async function captureMenu(page: Page, testInfo: TestInfo, name: string) {
  const captureDir =
    process.env.YEP_BROWSER_DEBUG_CAPTURE_DIR ??
    join(e2ePaths.tempDir, "browser-debug-reload-captures");
  mkdirSync(captureDir, { recursive: true });
  const path = join(captureDir, `${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

async function clickSidebarSession(page: Page, sessionPath: string) {
  const sidebar = page.locator("[data-sidebar]");
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(sidebar).toBeVisible();
  }
  const sessionLink = sidebar.locator(`a[href="${sessionPath}"]`).first();
  await expect(sessionLink).toBeVisible({ timeout: 15_000 });
  await sessionLink.click();
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`keeps browser debugging active across reload at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(45_000);
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-session-toolbar-presence",
        JSON.stringify({ browserDebug: "pin", thinkingToggle: "first" }),
      );
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const inactiveControl = page.getByRole("button", {
      name: /Enable full JavaScript debugging/,
    });
    await expect(inactiveControl).toBeVisible();
    await inactiveControl.click();

    const activeControl = page.getByRole("button", {
      name: /Disable full JavaScript debugging/,
    });
    await expect(activeControl).toBeVisible();
    const readout = activeControl
      .locator("span[aria-hidden='true']")
      .filter({ hasText: /max .*long/ });
    await expect(readout).toBeVisible();
    const readoutWidths = await readout.evaluate((element) => {
      const original = element.textContent;
      const widths = [
        "max 9ms · long 1",
        "max 1000ms · long 1000",
        "max 10ms · long 10",
      ].map((text) => {
        element.textContent = text;
        return element.getBoundingClientRect().width;
      });
      element.textContent = original;
      return widths;
    });
    expect(new Set(readoutWidths).size).toBe(1);
    const composer = page.locator("textarea[data-composer-input]");
    await composer.fill("Checking toolbar geometry");
    await composer.press("End");
    for (const key of [".", "a", "Backspace"]) {
      await composer.press(key);
      await expect(activeControl).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator("[data-message-input-toolbar]")
            .last()
            .evaluate((toolbar) => {
              const left = toolbar.querySelector("[data-message-input-left]");
              const actions = toolbar.querySelector(
                "[data-message-input-actions]",
              );
              if (!left || !actions) throw new Error("Missing toolbar groups");
              const right = actions.getBoundingClientRect().left;
              return [...left.children].every((child) => {
                const rect = child.getBoundingClientRect();
                const style = getComputedStyle(child);
                return (
                  style.display === "none" ||
                  style.position === "absolute" ||
                  rect.width === 0 ||
                  rect.right <= right + 1
                );
              });
            }),
        )
        .toBe(true);
    }
    if (viewport.name === "desktop") {
      let splitPriority = false;
      for (let width = 400; width <= 640; width += 8) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const controls = await page
          .locator(
            "[data-session-toolbar-control].composer-bottom-overflow-early:not([data-composer-bottom-overflow-menu] *)",
          )
          .evaluateAll((elements) =>
            elements.map((element) => ({
              key: (element as HTMLElement).dataset.sessionToolbarControl,
              visible: element.getBoundingClientRect().width > 0,
            })),
          );
        if (
          controls.some((control) => control.visible) &&
          controls.some((control) => !control.visible)
        ) {
          splitPriority = true;
          await page
            .getByRole("button", { name: "More toolbar controls" })
            .click();
          for (const control of controls) {
            const menuCopy = page.locator(
              `[data-composer-bottom-overflow-menu-group] [data-session-toolbar-control="${control.key}"]`,
            );
            if (control.visible) await expect(menuCopy).toBeHidden();
            else await expect(menuCopy).toBeVisible();
          }
          await captureMenu(page, testInfo, "desktop-partial-priority");
          await page
            .getByRole("button", { name: "More toolbar controls" })
            .click();
          break;
        }
      }
      expect(splitPriority).toBe(true);
      await page.setViewportSize(viewport);
    }
    await captureMenu(page, testInfo, `${viewport.name}-debug-composing`);
    await composer.fill("");
    const expiryBeforeReload = (
      await activeControl.getAttribute("aria-label")
    )?.split("\n")[0];

    const otherSessionPath = `/projects/${projectId}/sessions/${otherSessionId}`;
    await clickSidebarSession(page, otherSessionPath);
    await expect(page).toHaveURL(`${baseURL}${otherSessionPath}`);
    await expect(activeControl).toBeVisible();
    expect(
      (await activeControl.getAttribute("aria-label"))?.split("\n")[0],
    ).toBe(expiryBeforeReload);

    const originalSessionPath = `/projects/${projectId}/sessions/${sessionId}`;
    await clickSidebarSession(page, originalSessionPath);
    await expect(page).toHaveURL(`${baseURL}${originalSessionPath}`);
    await expect(activeControl).toBeVisible();
    expect(
      (await activeControl.getAttribute("aria-label"))?.split("\n")[0],
    ).toBe(expiryBeforeReload);

    await activeControl.click({ button: "right" });

    await expect(
      page.getByRole("menuitem", {
        name: "Reload app code (keep debugging)",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "Reconnect existing debug link",
      }),
    ).toBeDisabled({ timeout: 25_000 });
    await captureMenu(page, testInfo, `${viewport.name}-debug-menu`);

    await Promise.all([
      page.waitForEvent("load"),
      page
        .getByRole("menuitem", {
          name: "Reload app code (keep debugging)",
        })
        .click(),
    ]);

    const resumedControl = page.getByRole("button", {
      name: /Disable full JavaScript debugging/,
    });
    await expect(resumedControl).toBeVisible();
    expect(
      (await resumedControl.getAttribute("aria-label"))?.split("\n")[0],
    ).toBe(expiryBeforeReload);
    await resumedControl.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", {
        name: "Reconnect existing debug link",
      }),
    ).toBeDisabled({ timeout: 25_000 });
    await page.keyboard.press("Escape");
    await resumedControl.click();
    await expect(inactiveControl).toBeVisible();
  });
}
