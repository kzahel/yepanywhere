import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const systemChromePath = "/opt/google/chrome/chrome";

function hasAppArmorUserNamespaceRestriction(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return (
      readFileSync(
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "utf8",
      ).trim() === "1"
    );
  } catch {
    return false;
  }
}

export async function launchTestChromium() {
  const override = process.env.YEP_TEST_USE_SYSTEM_CHROME;
  const restrictedLocalHost =
    override === undefined &&
    !process.env.CI &&
    hasAppArmorUserNamespaceRestriction();
  const useSystemChrome =
    override === "1" || (restrictedLocalHost && existsSync(systemChromePath));

  try {
    return await chromium.launch({
      channel: useSystemChrome ? "chrome" : undefined,
      chromiumSandbox: true,
    });
  } catch (error) {
    if (
      restrictedLocalHost &&
      error instanceof Error &&
      /No usable sandbox|Executable doesn't exist/.test(error.message)
    ) {
      const hint = useSystemChrome
        ? "Check the Chrome Stable installation and its AppArmor profile."
        : `Install Google Chrome Stable at ${systemChromePath} to run the client tests with sandboxing enabled.`;
      throw new Error(`Could not start a sandboxed browser. ${hint}`, {
        cause: error,
      });
    }
    throw error;
  }
}
