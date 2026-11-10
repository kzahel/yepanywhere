/**
 * E2E test for ChromeOS WebRTC streaming.
 *
 * Requires:
 *   - CHROMEOS_HOST to be set (script defaults to "chromeroot")
 *   - SSH connectivity to CHROMEOS_HOST
 *   - daemon.py present at /mnt/stateful_partition/c2/daemon.py
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");
const CHROMEOS_DAEMON_PATH = "/mnt/stateful_partition/c2/daemon.py";

function canSSH(host: string): boolean {
  try {
    execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"],
      { timeout: 8000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function hasDaemon(host: string): boolean {
  try {
    execFileSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        host,
        "test",
        "-f",
        CHROMEOS_DAEMON_PATH,
      ],
      { timeout: 8000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

test("streams ChromeOS video over WebRTC when host is configured", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const host = process.env.CHROMEOS_HOST?.trim();
  if (!host) {
    test.skip(
      true,
      "CHROMEOS_HOST not set — run with CHROMEOS_HOST=chromeroot",
    );
    return;
  }

  test.skip(!canSSH(host), `Cannot SSH to ${host}`);
  test.skip(
    !hasDaemon(host),
    `ChromeOS daemon missing at ${CHROMEOS_DAEMON_PATH} on ${host}`,
  );

  await page.goto(`${baseURL}/devices`);

  // Fresh E2E temp dirs can show onboarding modal which blocks clicks.
  const closeOnboarding = page.getByRole("button", { name: "Close" }).first();
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click({ force: true });
  }

  const skipAll = page.getByRole("button", { name: "Skip all" });
  if (await skipAll.isVisible().catch(() => false)) {
    await skipAll.click({ force: true });
  }

  const deviceLabel = `ChromeOS (${host})`;
  const row = page.locator('[data-testid="device-row"]', {
    hasText: deviceLabel,
  });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.evaluate((label) => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="device-row"]'),
    );
    const rowEl = rows.find((r) => r.textContent?.includes(label));
    if (!rowEl) {
      throw new Error(`device row not found for ${label}`);
    }
    const btns = Array.from(rowEl.querySelectorAll("button"));
    const connectBtn = btns.find((b) => b.textContent?.trim() === "Connect");
    if (!connectBtn) {
      throw new Error(`connect button not found for ${label}`);
    }
    (connectBtn as HTMLButtonElement).click();
  }, deviceLabel);

  await expect(
    page.locator('[data-testid="device-connection-state"]'),
  ).toHaveText("connected", { timeout: 30_000 });

  const video = page.locator('video[aria-label="Device stream"]');
  await expect(video).toBeVisible();

  await expect(async () => {
    const readyState = await page.evaluate(
      () =>
        (
          document.querySelector(
            'video[aria-label="Device stream"]',
          ) as HTMLVideoElement | null
        )?.readyState ?? 0,
    );
    expect(readyState).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});
