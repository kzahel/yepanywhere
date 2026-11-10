/**
 * E2E test for physical Android device WebRTC streaming.
 *
 * Requires:
 *   - A connected physical Android device (detected via `adb devices`)
 *   - The device-bridge binary built at packages/device-bridge/bridge
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_BINARY = resolve(__dirname, "../../device-bridge/bridge");
const LONG_STREAM_ENV = "YEP_E2E_ANDROID_LONG_STREAM";
const LONG_STREAM_DURATION_MS_ENV = "YEP_E2E_ANDROID_LONG_STREAM_MS";
const LONG_STREAM_POLL_MS_ENV = "YEP_E2E_ANDROID_LONG_STREAM_POLL_MS";
const LONG_STREAM_STALL_MS_ENV = "YEP_E2E_ANDROID_LONG_STREAM_STALL_MS";
const LONG_STREAM_STARTUP_MS_ENV = "YEP_E2E_ANDROID_LONG_STREAM_STARTUP_MS";
const LONG_STREAM_NUDGE_MS_ENV = "YEP_E2E_ANDROID_LONG_STREAM_NUDGE_MS";
const DEFAULT_LONG_STREAM_DURATION_MS = 120_000;
const DEFAULT_LONG_STREAM_POLL_MS = 1_000;
const DEFAULT_LONG_STREAM_STALL_MS = 15_000;
const DEFAULT_LONG_STREAM_STARTUP_MS = 45_000;
const DEFAULT_LONG_STREAM_NUDGE_MS = 4_000;

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
      execFileSync(candidate, ["version"], { timeout: 3000, stdio: "ignore" });
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

function findRunningPhysicalAndroidDevice(): string | null {
  const adb = findAdb();
  if (!adb) return null;

  try {
    const output = execFileSync(adb, ["devices"], { timeout: 5000 }).toString();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List of")) continue;

      const fields = trimmed.split(/\s+/);
      if (fields.length < 2 || fields[1] !== "device") continue;

      const serial = fields[0];
      if (serial && !serial.startsWith("emulator-")) {
        return serial;
      }
    }
  } catch {
    // adb query failed
  }

  return null;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isLongStreamEnabled(): boolean {
  const value = process.env[LONG_STREAM_ENV];
  return value === "1" || value === "true";
}

async function dismissOnboardingIfVisible(page: Page) {
  const closeOnboarding = page.getByRole("button", { name: "Close" }).first();
  if (await closeOnboarding.isVisible().catch(() => false)) {
    await closeOnboarding.click({ force: true });
  }

  const skipAll = page.getByRole("button", { name: "Skip all" });
  if (await skipAll.isVisible().catch(() => false)) {
    await skipAll.click({ force: true });
  }
}

async function connectToPhysicalDeviceStream(
  page: Page,
  baseURL: string,
  deviceSerial: string,
) {
  await page.goto(`${baseURL}/devices`);
  await dismissOnboardingIfVisible(page);

  const row = page.locator('[data-testid="device-row"]', {
    hasText: deviceSerial,
  });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await page.evaluate((serial) => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="device-row"]'),
    );
    const rowEl = rows.find((r) => r.textContent?.includes(serial));
    if (!rowEl) {
      throw new Error(`device row not found for ${serial}`);
    }

    const btns = Array.from(rowEl.querySelectorAll("button"));
    const connectBtn = btns.find((b) => b.textContent?.trim() === "Connect");
    if (!connectBtn) {
      throw new Error(`connect button not found for ${serial}`);
    }
    (connectBtn as HTMLButtonElement).click();
  }, deviceSerial);

  await expect(
    page.locator('[data-testid="device-connection-state"]'),
  ).toHaveText(/connected$/, { timeout: 30_000 });

  const video = page.locator('video[aria-label="Device stream"]');
  await expect(video).toBeVisible();

  await expect(async () => {
    const media = await page.evaluate(() => {
      const video = document.querySelector(
        'video[aria-label="Device stream"]',
      ) as HTMLVideoElement | null;
      const readyState = video?.readyState ?? 0;
      const paused = video?.paused ?? true;
      const trackCount =
        (video?.srcObject as MediaStream | null)?.getVideoTracks().length ?? 0;
      const liveTrackCount =
        (video?.srcObject as MediaStream | null)
          ?.getVideoTracks()
          .filter((track) => track.readyState === "live").length ?? 0;
      return { readyState, paused, trackCount, liveTrackCount };
    });
    expect(
      (media.readyState >= 2 && !media.paused) || media.liveTrackCount > 0,
    ).toBeTruthy();
  }).toPass({ timeout: 20_000 });
}

type StreamHealthSnapshot = {
  connectionText: string;
  videoPresent: boolean;
  readyState: number;
  paused: boolean;
  currentTime: number;
  totalVideoFrames: number;
  trackCount: number;
  liveTrackCount: number;
};

async function captureStreamHealth(page: Page): Promise<StreamHealthSnapshot> {
  return page.evaluate(() => {
    const connectionText =
      document.querySelector('[data-testid="device-connection-state"]')
        ?.textContent ?? "";
    const video = document.querySelector(
      'video[aria-label="Device stream"]',
    ) as HTMLVideoElement | null;
    if (!video) {
      return {
        connectionText,
        videoPresent: false,
        readyState: 0,
        paused: true,
        currentTime: 0,
        totalVideoFrames: 0,
        trackCount: 0,
        liveTrackCount: 0,
      };
    }

    const stream = video.srcObject as MediaStream | null;
    const tracks = stream?.getVideoTracks() ?? [];
    const quality =
      typeof video.getVideoPlaybackQuality === "function"
        ? video.getVideoPlaybackQuality()
        : null;
    const totalVideoFrames =
      quality?.totalVideoFrames ??
      (video as HTMLVideoElement & { webkitDecodedFrameCount?: number })
        .webkitDecodedFrameCount ??
      0;

    return {
      connectionText,
      videoPresent: true,
      readyState: video.readyState,
      paused: video.paused,
      currentTime: video.currentTime,
      totalVideoFrames,
      trackCount: tracks.length,
      liveTrackCount: tracks.filter((track) => track.readyState === "live")
        .length,
    };
  });
}

async function nudgeDeviceNavigation(page: Page, idx: number) {
  const navigation = page.getByRole("group", { name: "Device navigation" });
  const buttons = navigation.getByRole("button", {
    name: /^(Back|Home|Recents)$/,
  });
  const count = await buttons.count();
  if (count === 0) return;
  const target = buttons.nth(idx % count);
  const enabled = await target.isEnabled().catch(() => false);
  if (!enabled) return;
  await target.click({ force: true });
}

async function assertStreamStaysHealthyForDuration(
  page: Page,
  opts: {
    durationMs: number;
    pollMs: number;
    stallMs: number;
    startupMs: number;
    nudgeMs: number;
  },
) {
  const startupBeganAt = Date.now();
  let steadyWindowStartAt: number | null = null;
  let lastCurrentTime = -1;
  let lastFrameCount = -1;
  let lastProgressAt = Date.now();
  let nextNudgeAt = Date.now();
  let nudgeCount = 0;

  while (true) {
    const now = Date.now();
    if (now >= nextNudgeAt) {
      await nudgeDeviceNavigation(page, nudgeCount);
      nudgeCount++;
      nextNudgeAt = now + opts.nudgeMs;
    }

    const sample = await captureStreamHealth(page);
    expect(sample.connectionText).toMatch(/connected$/);

    const observedAt = Date.now();
    const progressed =
      sample.currentTime > lastCurrentTime + 0.02 ||
      sample.totalVideoFrames > lastFrameCount;

    if (progressed) {
      lastProgressAt = observedAt;
      if (steadyWindowStartAt === null) {
        steadyWindowStartAt = observedAt;
      }
    }

    if (steadyWindowStartAt === null) {
      if (observedAt - startupBeganAt > opts.startupMs) {
        throw new Error(
          `Physical stream did not start playback within ${opts.startupMs}ms. ` +
            `state=${sample.connectionText}, readyState=${sample.readyState}, paused=${sample.paused}, ` +
            `currentTime=${sample.currentTime.toFixed(3)}, frames=${sample.totalVideoFrames}, ` +
            `tracks=${sample.trackCount}, liveTracks=${sample.liveTrackCount}`,
        );
      }
    } else {
      expect(sample.videoPresent).toBeTruthy();
      expect(sample.trackCount).toBeGreaterThan(0);
      expect(sample.liveTrackCount).toBeGreaterThan(0);

      if (observedAt - lastProgressAt > opts.stallMs) {
        throw new Error(
          `Physical stream stalled for ${observedAt - lastProgressAt}ms (limit ${opts.stallMs}ms). ` +
            `state=${sample.connectionText}, readyState=${sample.readyState}, paused=${sample.paused}, ` +
            `currentTime=${sample.currentTime.toFixed(3)}, frames=${sample.totalVideoFrames}`,
        );
      }

      if (observedAt - steadyWindowStartAt >= opts.durationMs) {
        break;
      }
    }

    lastCurrentTime = Math.max(lastCurrentTime, sample.currentTime);
    lastFrameCount = Math.max(lastFrameCount, sample.totalVideoFrames);

    await page.waitForTimeout(opts.pollMs);
  }
}

test("streams physical Android device video over WebRTC when attached", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const deviceSerial = findRunningPhysicalAndroidDevice();
  if (!deviceSerial) {
    test.skip(
      true,
      "No physical Android device detected — attach a device with USB debugging enabled",
    );
    return;
  }

  await connectToPhysicalDeviceStream(page, baseURL, deviceSerial);
});

test("keeps physical Android device stream open for long duration (opt-in)", async ({
  page,
  baseURL,
}) => {
  test.slow();
  test.skip(
    !isLongStreamEnabled(),
    `Set ${LONG_STREAM_ENV}=true to enable long-duration stream validation`,
  );

  const durationMs = parsePositiveIntEnv(
    LONG_STREAM_DURATION_MS_ENV,
    DEFAULT_LONG_STREAM_DURATION_MS,
  );
  const pollMs = parsePositiveIntEnv(
    LONG_STREAM_POLL_MS_ENV,
    DEFAULT_LONG_STREAM_POLL_MS,
  );
  const stallMs = parsePositiveIntEnv(
    LONG_STREAM_STALL_MS_ENV,
    DEFAULT_LONG_STREAM_STALL_MS,
  );
  const startupMs = parsePositiveIntEnv(
    LONG_STREAM_STARTUP_MS_ENV,
    DEFAULT_LONG_STREAM_STARTUP_MS,
  );
  const nudgeMs = parsePositiveIntEnv(
    LONG_STREAM_NUDGE_MS_ENV,
    DEFAULT_LONG_STREAM_NUDGE_MS,
  );
  test.setTimeout(Math.max(120_000, startupMs + durationMs + 90_000));

  test.skip(
    !existsSync(BRIDGE_BINARY),
    "device-bridge binary not built — run: cd packages/device-bridge && go build -o bridge ./cmd/bridge/",
  );

  const deviceSerial = findRunningPhysicalAndroidDevice();
  if (!deviceSerial) {
    test.skip(
      true,
      "No physical Android device detected — attach a device with USB debugging enabled",
    );
    return;
  }

  await connectToPhysicalDeviceStream(page, baseURL, deviceSerial);
  await assertStreamStaysHealthyForDuration(page, {
    durationMs,
    pollMs,
    stallMs,
    startupMs,
    nudgeMs,
  });
});
