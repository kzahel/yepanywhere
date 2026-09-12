import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { InstallService } from "../../server/src/services/InstallService.js";
import { e2ePaths, expect, test, waitForRelayStatus } from "./fixtures.js";
import { startMultiHostRelayHarness } from "./support/multi-host-relay-harness.js";
import { stopYaServerProcess } from "./support/ya-server-process.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("experimental preview isolates real encrypted sources and groups without reopening sessions", async ({
  page,
  remoteClientURL,
  remotePreviewURL,
  relayWsURL,
}) => {
  test.setTimeout(120_000);
  const harness = await startMultiHostRelayHarness({
    relayUrl: relayWsURL,
    testRoot: e2ePaths.tempDir,
    setupProfile: async ({ dataDir }) => {
      // This profile represents prior Claude usage. Catalog eligibility is
      // intentionally not inferred just from a fixture file on disk.
      const install = new InstallService({ dataDir });
      await install.initialize();
      await install.recordSuccessfulProviders(["claude"]);
    },
  });
  try {
    await page.goto(remoteClientURL);
    await page.evaluate(
      async (inputs) => {
        localStorage.clear();
        sessionStorage.clear();
        const modulePath = "/src/lib/e2e/multiHostSessionProvisioning.ts";
        const { provisionRelayHostSession } = await import(
          /* @vite-ignore */ modulePath
        );
        for (const input of inputs) await provisionRelayHostSession(input);
      },
      harness.hosts.map((host) => ({
        displayName: host.displayName,
        password: host.password,
        relayUrl: harness.relayUrl,
        username: host.username,
      })),
    );
    await harness.waitForWaitingHosts();
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${remoteClientURL}/-/preview`);
    const source = (name: string) =>
      page.locator(
        `[data-testid="preview-source"][data-source-name="${name}"]`,
      );
    for (const name of ["Alpha", "Beta", "Gamma"])
      await source(name).getByRole("checkbox").check();
    for (const name of ["Alpha", "Beta", "Gamma"])
      await expect(source(name)).toHaveAttribute(
        "data-source-status",
        "ready",
        { timeout: 20_000 },
      );
    // Move the disposable saved sessions to the built remote bundle's origin.
    const storage = await page.evaluate(() => Object.entries(localStorage));
    await page.goto("about:blank");
    await harness.waitForWaitingHosts();
    await page.addInitScript(
      ({ origin, entries }) => {
        if (
          location.origin === origin &&
          !localStorage.getItem("yep-anywhere-saved-hosts")
        )
          for (const [key, value] of entries) localStorage.setItem(key, value);
      },
      { origin: new URL(remotePreviewURL).origin, entries: storage },
    );
    await page.goto(`${remotePreviewURL}/-/preview`);
    for (const name of ["Alpha", "Beta", "Gamma"])
      await expect(source(name)).toHaveAttribute(
        "data-source-status",
        "ready",
        { timeout: 20_000 },
      );
    const conversation = page.getByTestId("preview-conversation");
    await page.getByRole("button", { name: /Alpha previous message/ }).click();
    await expect(conversation).toContainText("Alpha previous message", {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /Beta previous message/ }).click();
    await expect(conversation).toContainText("Beta previous message");
    await expect(conversation).not.toContainText("Alpha previous message");
    const beta = harness.hosts[1];
    if (!beta) throw new Error("Missing Beta");
    const transcript = join(
      beta.server.claudeSessionsDir,
      hostname(),
      harness.projectPath.replace(/\//g, "-"),
      `${harness.sessionId}.jsonl`,
    );
    // A finalized native append must reach the existing selected binding.
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        uuid: "preview-finalized-response",
        parentUuid: "fixture-user-message",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The session overview is ready. Completed messages update here while you browse your machines.",
            },
          ],
        },
      })}\n`,
    );
    await expect(conversation).toContainText("The session overview is ready", {
      timeout: 15_000,
    });

    await page.getByLabel("Group by").selectOption("project");
    await expect(conversation).toContainText("Beta previous message");
    await page.getByLabel("Group by").selectOption("issue");
    await expect(source("Beta")).toContainText(
      /Issue discovery is disabled|does not support issue links/,
    );
    await expect(
      page.getByRole("button", { name: /Beta previous message/ }),
    ).toHaveAttribute("aria-current", "true");
    await page.getByLabel("Group by").selectOption("machine");
    const gamma = harness.hosts[2];
    if (!gamma) throw new Error("Missing Gamma");
    stopYaServerProcess(gamma.server);
    await expect(source("Gamma")).toHaveAttribute(
      "data-source-status",
      "offline",
      { timeout: 20_000 },
    );
    await expect(conversation).toContainText("Beta previous message");
    await page.locator("#preview-sidebar").evaluate((element) => {
      element.scrollTop = 0;
    });
    await recordUiCapture(page, "conversation-preview-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(conversation).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 375);
    await recordUiCapture(page, "conversation-preview-phone");
    await page.getByRole("button", { name: "Machines & sessions" }).click();
    await recordUiCapture(page, "conversation-preview-phone-sources");
    await source("Gamma").getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: /Alpha previous message/ }).click();
    await expect(conversation).toContainText("Alpha previous message");
    await page.reload();
    await expect(conversation).toContainText("Alpha previous message", {
      timeout: 20_000,
    });
    await page.goto("about:blank");
    await Promise.all(
      harness.hosts
        .slice(0, 2)
        .map((host) => waitForRelayStatus(host.server.baseUrl, "waiting")),
    );
  } catch (error) {
    throw new Error(`${String(error)}\n${harness.formatOutput()}`);
  } finally {
    harness.stop();
  }
});
