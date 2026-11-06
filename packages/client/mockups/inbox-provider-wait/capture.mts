import { expect } from "@playwright/test";
import {
  captureArtifact,
  emitCapturePreview,
} from "../../scripts/artifact-capture";

const layout = process.argv[2] ?? "inline";
const lower = process.argv.includes("lower");
const shipped = process.argv.includes("shipped");
if (!["inline", "grouped"].includes(layout))
  throw new Error("Expected inline or grouped");
const result = await captureArtifact({
  input: ".artifacts/mockups/inbox-provider-wait/index.html",
  yaUrl: process.env.AGENT_SERVER_URL,
  artifactOrigin: process.env.AGENT_ARTIFACT_VIEWER_ORIGIN,
  ownArtifact: false,
  commentary: true,
  interact: async ({ page }) => {
    if (shipped) {
      await page.goto(new URL("?mode=shipped", page.url()).href);
    }
    await page.getByRole("button", { name: layout, exact: true }).click();
    await expect(page.getByText("Serve the review VM's AAR")).toBeVisible();
    const width = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate(
      (limit) =>
        [...document.querySelectorAll(".inbox-item-badge, span[data-phase]")]
          .filter((badge) => badge.getBoundingClientRect().right > limit)
          .map((badge) => badge.textContent),
      width,
    );
    expect(overflow).toEqual([]);
    if (lower) {
      await page
        .getByText("Serve the review VM's AAR")
        .evaluate((node) => node.scrollIntoView({ block: "center" }));
    }
  },
});
emitCapturePreview(result);
