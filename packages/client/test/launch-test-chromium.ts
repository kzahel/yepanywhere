import { chromium } from "@playwright/test";

export function launchTestChromium() {
  return chromium.launch({
    channel:
      process.env.YEP_TEST_USE_SYSTEM_CHROME === "1" ? "chrome" : undefined,
    chromiumSandbox: true,
  });
}
