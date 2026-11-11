import type { Locator } from "@playwright/test";
import type { NetworkBindingState } from "../src/api/networkBindingClient.js";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

// The browser owns layout, form submission and actual sequential input. HTTP
// replies stay private to this page; no fixture listener or password is changed.
for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`Local Access scopes pending changes and retains typing at ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    let binding: NetworkBindingState = {
      localhost: { port: 3400, overriddenByCli: false },
      network: {
        enabled: false,
        host: null,
        port: 3400,
        overriddenByCli: false,
      },
      interfaces: [],
    };
    let allowedHosts = "";
    let agentEnabled = false;
    let rejectBinding = false;
    const writes: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/status", async (route) => {
      const response = await page.request.get(route.request().url());
      await route.fulfill({
        response,
        json: { ...(await response.json()), disabledByEnv: false },
      });
    });
    await page.route(/\/api\/settings(?:\?.*)?$/, async (route) => {
      const response = await page.request.get(route.request().url());
      const body = await response.json();
      if (route.request().method() === "PUT") {
        const updates = route.request().postDataJSON();
        if ("agentApiEnabled" in updates) {
          agentEnabled = updates.agentApiEnabled;
          await held;
        }
        if ("allowedHosts" in updates) {
          allowedHosts = updates.allowedHosts;
          writes.push("hosts");
        }
      }
      await route.fulfill({
        response,
        json: {
          ...body,
          settings: {
            ...body.settings,
            allowedHosts,
            agentApiEnabled: agentEnabled,
          },
        },
      });
    });
    await page.route("**/api/network-binding*", async (route) => {
      if (route.request().method() === "PUT") {
        writes.push("binding");
        if (rejectBinding) {
          await route.fulfill({
            status: 400,
            json: { error: "Address is unavailable" },
          });
          return;
        }
        const update = route.request().postDataJSON();
        if (update.localhostPort)
          binding = {
            ...binding,
            localhost: { ...binding.localhost, port: update.localhostPort },
          };
        if (update.network)
          binding = {
            ...binding,
            network: { ...binding.network, ...update.network },
          };
        await route.fulfill({ json: { success: true } });
      } else {
        await route.fulfill({ json: binding });
      }
    });
    await page.route("**/api/auth/enable", async (route) => {
      writes.push("password");
      await route.fulfill({ json: { success: true } });
    });
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${baseURL}/settings/local-access`);
      const port = page.getByRole("spinbutton", { name: "Listening Port" });
      const apply = page.getByRole("button", {
        name: "Apply connection changes",
        exact: true,
      });
      await expect(port).toHaveValue("3400");
      await expect(apply).toHaveCount(0);
      await page
        .getByRole("heading", { name: "Listening & hostnames" })
        .scrollIntoViewIfNeeded();
      await recordUiCapture(page, `local-access-clean-${viewport.name}`);

      // An independent save replies while keys arrive in the connection form.
      await page
        .getByRole("switch", { name: "Agent API discovery", exact: true })
        .locator("..")
        .click();
      const hosts = page.getByRole("textbox", {
        name: "Allowed Hostnames",
        exact: true,
      });
      await typeAndMeasure(hosts, "devbox.example,other.example", (index) => {
        if (index === 5) release();
      });
      await expect(apply).toBeVisible();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Unsaved connection changes" }),
      ).toContainText("Allowed Hostnames");
      await apply.scrollIntoViewIfNeeded();
      await recordUiCapture(page, `local-access-pending-${viewport.name}`);
      const connection = page.locator("form").filter({
        has: page.getByRole("heading", { name: "Listening & hostnames" }),
      });
      const passwordToggle = page.getByRole("switch", {
        name: "Require Password",
        exact: true,
      });
      await passwordToggle.locator("..").click();
      // Password inputs have no implicit textbox role.
      const passwordField = page.getByLabel("Password", { exact: true });
      await typeAndMeasure(passwordField, "unfinished");
      await apply.click();
      await expect(connection.getByRole("status")).toHaveCount(0);
      await expect(apply).toHaveCount(0);
      expect(writes).toEqual(["hosts"]);
      await expect(passwordField).toHaveValue("unfinished");
      await port.fill("3401");
      await connection
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(port).toHaveValue("3400");
      await expect(passwordField).toHaveValue("unfinished");
      await passwordField
        .locator("xpath=ancestor::form")
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(passwordToggle).not.toBeChecked();

      await page
        .getByRole("switch", { name: "Local Network Access", exact: true })
        .locator("..")
        .click();
      await page.getByRole("button", { name: "Filter by Interface" }).click();
      await page.getByRole("menuitemradio", { name: "Custom IP..." }).click();
      const ip = page.getByRole("textbox", { name: "Custom IP" });
      await typeAndMeasure(ip, "127.0.0.2");
      await ip.press("Enter");
      await expect(connection.getByRole("status")).toHaveCount(0);
      await expect(apply).toHaveCount(0);
      // Re-editing an already saved custom selection must reveal Apply again.
      await ip.fill("127.0.0.3");
      await expect(apply).toBeVisible();
      rejectBinding = true;
      await apply.click();
      await expect(page.getByRole("alert")).toContainText(
        "Address is unavailable",
      );
      await expect(apply).toBeEnabled();
      await expect(ip).toHaveValue("127.0.0.3");
      rejectBinding = false;
      await apply.click();
      await expect(connection.getByRole("status")).toHaveCount(0);
      await expect(apply).toHaveCount(0);
      await page
        .getByRole("heading", { name: "Agent access" })
        .scrollIntoViewIfNeeded();
      await recordUiCapture(page, `local-access-independent-${viewport.name}`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      release();
    }
  });
}

async function typeAndMeasure(
  field: Locator,
  text: string,
  between: (index: number) => void = () => {},
) {
  await field.focus();
  await field.evaluate((element) => {
    const input = element as HTMLInputElement & {
      samples: { ms: number; value: string }[];
    };
    input.samples = [];
    input.addEventListener("keydown", (event) => {
      const start = event.timeStamp;
      input.addEventListener(
        "input",
        () => {
          const expected = input.value;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              input.samples.push({
                ms: performance.now() - start,
                value: input.value === expected ? input.value : "lost",
              });
            }),
          );
        },
        { once: true },
      );
    });
  });
  for (let index = 0; index < text.length; index++) {
    between(index);
    await field.page().keyboard.type(text[index] ?? "");
    await expect
      .poll(() =>
        field.evaluate(
          (element) =>
            (element as HTMLInputElement & { samples: unknown[] }).samples
              .length,
        ),
      )
      .toBe(index + 1);
  }
  const samples = await field.evaluate(
    (element) =>
      (
        element as HTMLInputElement & {
          samples: { ms: number; value: string }[];
        }
      ).samples,
  );
  expect(samples.map((sample) => sample.value)).toEqual(
    [...text].map((_, index) => text.slice(0, index + 1)),
  );
  console.log(
    `Local Access ${text.length} keys: maximum acknowledgement ${Math.max(...samples.map((sample) => sample.ms)).toFixed(1)} ms`,
  );
  expect(
    Math.max(...samples.map((sample) => sample.ms)),
    JSON.stringify(samples),
  ).toBeLessThan(100);
}
