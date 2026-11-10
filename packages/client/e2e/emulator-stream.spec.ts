/**
 * E2E test for Android emulator WebRTC streaming.
 *
 * Requires:
 *   - A running Android emulator (detected via `adb devices`)
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when either prerequisite is missing, so this is
 * safe to run in CI (where no emulator is available).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");
const DEFAULT_APK_PATH = resolve(
  __dirname,
  "../../android-device-server/app/build/outputs/apk/release/yep-device-server.apk",
);

/** Find adb binary — checks PATH then common Android SDK locations. */
function findAdb(): string | null {
  const candidates = [
    "adb",
    join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/android-sdk/platform-tools/adb",
  ];
  for (const candidate of candidates) {
    try {
      execSync(`${candidate} version`, { timeout: 3000, stdio: "ignore" });
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

function findRunningEmulator(): string | null {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const output = execSync(`${adb} devices`, { timeout: 5000 }).toString();
    const match = output.match(/^(emulator-\d+)\s+device$/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function apkOverrideEnabled(): boolean {
  return isTruthy(process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR);
}

function adaptiveProfileCycleEnabled(): boolean {
  return isTruthy(process.env.YEP_BRIDGE_TEST_ADAPTIVE_PROFILE_CYCLE);
}

async function adaptiveProfileTransitionsFromClient(
  page: import("@playwright/test").Page,
): Promise<Array<"downshift" | "upshift">> {
  return page.evaluate(() => {
    const events = (
      window as Window & {
        __YEP_DEVICE_STREAM_PROFILE_EVENTS__?: Array<{
          direction?: "downshift" | "upshift";
        }>;
      }
    ).__YEP_DEVICE_STREAM_PROFILE_EVENTS__;

    return (events ?? [])
      .map((event) => event.direction)
      .filter(
        (direction): direction is "downshift" | "upshift" =>
          direction === "downshift" || direction === "upshift",
      );
  });
}

async function assertAutoStreamConnects(
  page: import("@playwright/test").Page,
  baseURL: string,
) {
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const runningEmulator = findRunningEmulator();
  test.skip(
    !runningEmulator,
    "No running Android emulator — run: emulator -avd <name> -no-window &",
  );

  await page.goto(`${baseURL}/devices?auto`);

  // Wait for WebRTC to reach "connected" — generous timeout covers sidecar
  // cold start, ADB query, ICE gathering, and first frame.
  await expect(
    page.locator('[data-testid="device-connection-state"]'),
  ).toHaveText(/connected$/, { timeout: 30_000 });

  // Video element must be visible
  const video = page.locator('video[aria-label="Device stream"]');
  await expect(video).toBeVisible();

  // WebRTC media must be attached. In some headless environments, H264 decode can
  // lag or remain at readyState 0 even when a live remote track is attached.
  await expect(async () => {
    const media = await page.evaluate(() => {
      const video = document.querySelector(
        'video[aria-label="Device stream"]',
      ) as HTMLVideoElement | null;
      const readyState = video?.readyState ?? 0;
      const trackCount =
        (video?.srcObject as MediaStream | null)?.getVideoTracks().length ?? 0;
      return { readyState, trackCount };
    });
    expect(media.readyState >= 2 || media.trackCount > 0).toBeTruthy();
  }).toPass({ timeout: 20_000 });
}

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  // Fresh E2E temp dirs can show onboarding modal which blocks pointer clicks.
  const closeOnboarding = page.getByRole("button", { name: "Close" }).first();
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click({ force: true });
  }
  const skipAll = page.getByRole("button", { name: "Skip all" });
  if (await skipAll.isVisible().catch(() => false)) {
    await skipAll.click({ force: true });
  }
}

test("streams emulator video over WebRTC when ?auto is set", async ({
  page,
  baseURL,
}) => {
  await assertAutoStreamConnects(page, baseURL);
});

test("streams emulator video over WebRTC via APK transport override", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !apkOverrideEnabled(),
    "Set DEVICE_BRIDGE_USE_APK_FOR_EMULATOR=true to run APK transport override variant",
  );

  const apkPath = process.env.ANDROID_DEVICE_SERVER_APK ?? DEFAULT_APK_PATH;
  test.skip(
    !existsSync(apkPath),
    `APK not found at ${apkPath}; build it with: cd packages/android-device-server && ./build-apk.sh`,
  );

  await assertAutoStreamConnects(page, baseURL);
});

test("emits adaptive profile downshift/upshift events via APK transport override", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );
  const runningEmulator = findRunningEmulator();
  test.skip(
    !runningEmulator,
    "No running Android emulator — run: emulator -avd <name> -no-window &",
  );
  test.skip(
    !apkOverrideEnabled(),
    "Set DEVICE_BRIDGE_USE_APK_FOR_EMULATOR=true to run APK transport override variant",
  );
  test.skip(
    !adaptiveProfileCycleEnabled(),
    "Set YEP_BRIDGE_TEST_ADAPTIVE_PROFILE_CYCLE=true to run adaptive profile cycle assertions",
  );

  const apkPath = process.env.ANDROID_DEVICE_SERVER_APK ?? DEFAULT_APK_PATH;
  test.skip(
    !existsSync(apkPath),
    `APK not found at ${apkPath}; build it with: cd packages/android-device-server && ./build-apk.sh`,
  );

  await page.goto(`${baseURL}/devices`);
  await dismissOnboardingIfVisible(page);

  await expect(
    page.locator('[data-testid="device-group-title"]', {
      hasText: "Android Emulators",
    }),
  ).toBeVisible({ timeout: 15_000 });

  await page.evaluate((serial) => {
    const groups = Array.from(
      document.querySelectorAll('[data-testid="device-group"]'),
    );
    const groupEl = groups.find((g) =>
      g
        .querySelector('[data-testid="device-group-title"]')
        ?.textContent?.includes("Android Emulators"),
    );
    if (!groupEl) {
      throw new Error("Android Emulators group not found");
    }

    const rows = Array.from(
      groupEl.querySelectorAll('[data-testid="device-row"]'),
    );
    if (rows.length === 0) {
      throw new Error("No rows in Android Emulators group");
    }

    const connectButtonForRow = (row: Element): HTMLButtonElement | null => {
      const buttons = Array.from(row.querySelectorAll("button"));
      return (
        (buttons.find((b) => b.textContent?.trim() === "Connect") as
          | HTMLButtonElement
          | undefined) ?? null
      );
    };

    const exactRow =
      rows.find(
        (row) =>
          serial !== null &&
          row.textContent?.includes(serial) &&
          connectButtonForRow(row) !== null,
      ) ?? null;
    const fallbackRow =
      rows.find((row) => connectButtonForRow(row) !== null) ?? null;
    const targetRow = exactRow ?? fallbackRow;
    if (!targetRow) {
      throw new Error("No connectable emulator row found");
    }
    const connectBtn = connectButtonForRow(targetRow);
    if (!connectBtn) {
      throw new Error("Connect button not found for selected emulator row");
    }
    connectBtn.click();
  }, runningEmulator);

  await expect(
    page.locator('[data-testid="device-connection-state"]'),
  ).toHaveText(/connected$/, { timeout: 30_000 });

  await expect(async () => {
    const transitions = await adaptiveProfileTransitionsFromClient(page);
    const downIndex = transitions.indexOf("downshift");
    const upIndex =
      downIndex >= 0
        ? transitions.findIndex((d, idx) => idx > downIndex && d === "upshift")
        : -1;
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(downIndex);
  }).toPass({ timeout: 45_000, intervals: [500, 1000, 1500] });
});
