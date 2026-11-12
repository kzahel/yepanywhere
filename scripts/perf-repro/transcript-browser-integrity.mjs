import assert from "node:assert/strict";
import { installTranscriptProbe } from "./transcript-browser-probe.mjs";

/** Exercise the actual sampler in Chromium; do not mock layout geometry. */
export async function verifyTranscriptProbe(browser) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 800 },
  });
  try {
    for (const mode of [
      "wrong-marker",
      "wrong-row",
      "clipped",
      "hidden",
      "visibility-hidden",
      "transparent-parent",
      "ancestor-clip",
      "body-viewport",
      "visible",
    ]) {
      const page = await context.newPage();
      await page.setContent(
        '<textarea data-composer-input></textarea><div data-session-messages style="position:absolute;top:100px;left:100px;width:500px;height:100px;overflow:hidden;position:relative"><div data-render-id="reply-control-0" style="position:absolute"><div data-message-render-content></div></div></div>',
      );
      await page.evaluate((mode) => {
        const row = document.querySelector("[data-render-id]");
        const content = document.querySelector("[data-message-render-content]");
        content.textContent =
          mode === "wrong-marker" ? "probe-0-end-extra" : "probe-0-end";
        if (mode === "wrong-row") row.dataset.renderId = "reply-another-0";
        if (mode === "clipped") row.style.top = "300px";
        if (mode === "hidden") row.style.display = "none";
        if (mode === "visibility-hidden") row.style.visibility = "hidden";
        if (mode === "transparent-parent")
          row.parentElement.style.opacity = "0";
        if (mode === "body-viewport") {
          document.body.style.cssText = "height:0;overflow:auto";
          row.parentElement.style.position = "fixed";
        }
        if (mode === "ancestor-clip") {
          const parent = document.createElement("div");
          parent.style.cssText = "height:5px;overflow:hidden";
          row.parentElement.insertBefore(parent, row);
          parent.append(row);
          row.style.position = "relative";
          row.style.top = "20px";
        }
        window.__transcriptFixture = {
          prepare: () => [[{ uuid: "reply-control" }]],
          append: () => ({ at: performance.now() }),
          snapshot: () => ({ unexpected: [], loadedMessages: 4 }),
        };
      }, mode);
      await page.evaluate(installTranscriptProbe);
      await page.evaluate(() => {
        window.__transcriptProbe.prepare(1);
        window.__transcriptProbe.start({ count: 1, intervalMs: 1000 });
      });
      // Browser timer plus successive real layout opportunities, no wall-clock sleep.
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      });
      const result = await page.evaluate(() => {
        const result = window.__transcriptProbe.finish();
        window.__transcriptProbe.dispose();
        return result;
      });
      assert.equal(result.markers.length, 1, `${mode}: append offered`);
      assert.equal(
        result.pending,
        ["visible", "body-viewport"].includes(mode) ? 0 : 1,
        `${mode}: marker visibility`,
      );
      await page.close();
    }
  } finally {
    await context.close();
  }
  return { passed: true, cases: 9 };
}
