import { createServer } from "node:http";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

/**
 * A right-pane file viewer running its interactive preview, then minimized,
 * must leave the composer chip that restores it. Reported 2026-09-23: after
 * play the minimize left no chip at all.
 */
test("play in the right pane, then minimize, leaves a restore chip", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  await page.goto(`/projects/${projectId}/sessions/play-report-001`);
  // Give the running e2e server an artifact origin on its own port, the way
  // the artifact suites do for their private instances.
  const reservation = createServer();
  await new Promise<void>((ready) => reservation.listen(0, "127.0.0.1", ready));
  const artifactAddress = reservation.address();
  if (!artifactAddress || typeof artifactAddress === "string")
    throw new Error("Missing artifact port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const yaPort = new URL(page.url()).port;
  const configured = await page.request.put("/api/artifacts/config", {
    headers: { "X-Yep-Anywhere": "true", "Content-Type": "application/json" },
    data: {
      port: artifactAddress.port,
      localOrigin: `http://artifacts.localhost:${yaPort}`,
    },
  });
  expect(configured.ok()).toBe(true);
  await page.reload();

  const link = page.getByRole("link", { name: "report.html", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  const pane = page.getByRole("complementary", { name: "Session pane" });
  const viewer = pane.locator("[data-file-viewer]");
  await expect(viewer).toBeVisible();
  await viewer
    .getByRole("button", { name: "Run full HTML/CSS/JavaScript preview" })
    .click();
  await expect(
    viewer.getByRole("button", { name: "Stop interactive preview" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(pane.frameLocator("iframe").getByRole("status")).toHaveText(
    "ready",
  );

  await viewer
    .getByRole("button", { name: "Minimize file viewer", exact: true })
    .click();
  await expect(pane).toHaveCount(0);
  const chip = page.getByRole("group", { name: /File viewer:/ });
  await expect(chip).toBeVisible();
  await chip.getByRole("button", { name: /^Restore file viewer:/ }).click();
  await expect(viewer).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Stop interactive preview" }),
  ).toHaveAttribute("aria-pressed", "true");
});
