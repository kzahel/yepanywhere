// @vitest-environment node

import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

let browser: Browser;
let page: Page;

async function measureSteerAtWidth(width: number): Promise<{
  primaryWidth: number;
  labelDisplay: string;
}> {
  await page.locator("#actions").evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`;
  }, width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
  return page.evaluate(() => {
    const primary = document.querySelector("#primary");
    const label = document.querySelector("#label");
    if (!(primary instanceof HTMLElement) || !(label instanceof HTMLElement)) {
      throw new Error("Missing mobile keyboard Steer fixture");
    }
    return {
      primaryWidth: primary.getBoundingClientRect().width,
      labelDisplay: getComputedStyle(label).display,
    };
  });
}

describe("mobile keyboard Steer sizing", () => {
  beforeAll(async () => {
    const css = await readClientStyles("tokens", "base", "index");
    browser = await chromium.launch({ chromiumSandbox: true });
    page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <style>${css}</style>
      <div
        id="actions"
        class="message-input-keyboard-actions"
        style="--space-2: 8px; --space-4: 16px; --app-yep-green: green"
      >
        <button class="message-input-keyboard-more">...</button>
        <div class="message-input-keyboard-secondary-slot"></div>
        <div class="message-input-keyboard-secondary-slot">
          <button
            class="message-input-keyboard-action message-input-keyboard-secondary queue-mode"
          >
            →
          </button>
        </div>
        <button
          id="primary"
          class="message-input-keyboard-action message-input-keyboard-primary steer-mode"
          aria-label="Steer current turn"
        >
          <span id="label" class="message-input-keyboard-primary-label">
            Steer
          </span>
          <span class="message-input-keyboard-primary-icon" aria-hidden="true">
            ↗
          </span>
        </button>
      </div>`);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("uses spare row width and keeps the Steer label visible", async () => {
    await expect(measureSteerAtWidth(452)).resolves.toEqual({
      primaryWidth: 284,
      labelDisplay: "block",
    });
  });

  it("folds only the visible label at the minimum touch target", async () => {
    await expect(measureSteerAtWidth(216)).resolves.toEqual({
      primaryWidth: 48,
      labelDisplay: "none",
    });
  });
});
