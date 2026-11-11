import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

let projectId: string;
let projectPath: string;

test.beforeAll(() => {
  projectPath = join(e2ePaths.tempDir, "file-browser-project");
  projectId = Buffer.from(projectPath).toString("base64url");
});

test.describe("File browser", () => {
  test("previews large HTML without an artifact service", async ({ page }) => {
    const filename =
      "research/pii/frontier/papers/multilingual-pii-redaction/_build/paper-canvas.html";
    await mkdir(dirname(join(projectPath, filename)), { recursive: true });
    await writeFile(
      join(projectPath, filename),
      `<!doctype html><html><body><h1>Large paper</h1><!--${"x".repeat(3 * 1024 * 1024)}--><p>End of complete document</p></body></html>`,
    );
    let artifactRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/artifacts") {
        artifactRequests += 1;
      }
    });
    await page.goto(`/projects/${projectId}/file?path=${filename}`);
    const frame = page.frameLocator('iframe[aria-label="paper-canvas.html"]');
    await expect(
      frame.getByRole("heading", { name: "Large paper" }),
    ).toBeVisible();
    await expect(frame.getByText("End of complete document")).toBeVisible();
    await expect(
      page.locator('iframe[aria-label="paper-canvas.html"]'),
    ).toHaveAttribute("sandbox", "allow-same-origin");
    expect(artifactRequests).toBe(0);
    await expect(
      page.getByRole("button", { name: "Edit mode", exact: true }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 865, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(frame.getByText("End of complete document")).toBeVisible();
      const header = page.locator("[data-file-viewer-header]");
      const path = header.locator("[data-file-viewer-path]");
      await expect(path).toHaveText(filename);
      if (viewport.width <= 865) {
        const [pathBox, controlsBox] = await Promise.all([
          path.boundingBox(),
          header.locator("[data-file-viewer-actions]").boundingBox(),
        ]);
        expect(pathBox).not.toBeNull();
        expect(controlsBox).not.toBeNull();
        expect(pathBox!.y + pathBox!.height).toBeLessThanOrEqual(
          controlsBox!.y,
        );
      }
      if (viewport.width === 375) {
        // The action row must stay compact beneath the wrapped path.
        const controlsBox = await header
          .locator("[data-file-viewer-actions]")
          .boundingBox();
        expect(controlsBox!.height).toBeLessThan(100);
      }
      await recordUiCapture(page, `large-html-${viewport.width}`, viewport);
    }
  });

  test("downloads active project documents instead of executing them", async ({
    baseURL,
    page,
    request,
  }) => {
    const activeDocuments = [
      {
        filename: "hostile.html",
        url: `/api/projects/${projectId}/files/raw?path=hostile.html`,
      },
      {
        filename: "hostile.svg",
        url: `/api/projects/${projectId}/files/raw?path=hostile.svg`,
      },
      {
        filename: "hostile.html",
        url: `/api/local-file?path=${encodeURIComponent(join(projectPath, "hostile.html"))}`,
      },
    ];

    for (const { filename, url } of activeDocuments) {
      const response = await request.get(url);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-disposition"]).toContain("attachment");
      expect(response.headers()["content-security-policy"]).toContain(
        "script-src 'none'",
      );

      await page.goto(baseURL);
      await page.setContent(
        `<a id="active-file" href="${baseURL}${url}">Open active file</a>`,
      );
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#active-file").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(filename);
      await expect(page).not.toHaveTitle("EXECUTED");
    }
  });
});
