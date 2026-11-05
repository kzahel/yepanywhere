import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";
import type {} from "./fixtures/diff-scrolling";

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let url: string;
test.beforeAll(async () => {
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}e2e/fixtures/diff-scrolling.html`;
});
test.afterAll(async () => {
  await server?.close();
  await presentUiCaptures();
});

test("hunks and long-line runs scroll independently without adding vertical scroll surfaces", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(
    "**/api/projects/diff-fixture/git/file-revision?**",
    (route) =>
      route.fulfill({
        json: {
          isGitRepo: true,
          dirty: false,
          path: "docs/events.md",
          commit: {
            hash: "e3e1c26",
            shortHash: "e3e1c26",
            authorName: "Jonathan Graehl",
            authorDate: "2026-10-25T12:00:00Z",
            message: "Record per-account cyber access HTTP outcomes",
          },
        },
      }),
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(url);
  await expect(page.getByText("Jonathan Graehl")).toBeVisible();
  const hunks = page.locator("[data-diff-hunk]");
  await expect(hunks.nth(0)).toHaveAttribute("data-diff-scroll-mode", "hunk");
  await expect(hunks.nth(1)).toHaveAttribute("data-diff-scroll-mode", "runs");
  const rowHeight = await hunks
    .nth(0)
    .locator("[data-diff-scroll-row]")
    .first()
    .evaluate((row) => ({
      actual: row.getBoundingClientRect().height,
      line: Number.parseFloat(
        getComputedStyle(row.querySelector(".line")!).lineHeight,
      ),
    }));
  expect(rowHeight.actual).toBeLessThanOrEqual(rowHeight.line + 1);
  await expect(
    page.getByRole("slider", { name: "Scroll hunk", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("slider", { name: "Scroll long lines", exact: true }),
  ).toHaveCount(3);
  await page.getByRole("slider", { name: "Scroll hunk", exact: true }).focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      hunks
        .nth(0)
        .locator("[data-diff-scroll-cell]")
        .evaluateAll((cells) => {
          const positions = cells.map((cell) => cell.scrollLeft);
          return (
            Math.min(...positions) > 100 &&
            Math.max(...positions) - Math.min(...positions) < 2
          );
        }),
    )
    .toBe(true);
  const runSlider = page
    .getByRole("slider", { name: "Scroll long lines", exact: true })
    .first();
  await runSlider.focus();
  await page.keyboard.press("End");
  const movedRun = hunks.nth(1).locator("[data-diff-scroll-group]").nth(1);
  await expect
    .poll(() =>
      movedRun
        .locator("[data-diff-scroll-cell]")
        .first()
        .evaluate((cell) => cell.scrollLeft),
    )
    .toBeGreaterThan(100);
  expect(
    await hunks
      .nth(1)
      .locator("[data-diff-scroll-group]")
      .nth(0)
      .locator("[data-diff-scroll-cell]")
      .first()
      .evaluate((cell) => cell.scrollLeft),
  ).toBe(0);
  expect(
    await page
      .getByRole("slider", { name: "Scroll long lines", exact: true })
      .nth(1)
      .inputValue(),
  ).toBe("0");

  // Native horizontal input also synchronizes the paired rows, not just the slider.
  await movedRun
    .locator("[data-diff-scroll-cell]")
    .first()
    .evaluate((cell) => {
      cell.scrollLeft = 120;
    });
  await expect
    .poll(() =>
      movedRun
        .locator("[data-diff-scroll-cell]")
        .evaluateAll((cells) =>
          cells.every((cell) => Math.abs(cell.scrollLeft - 120) < 2),
        ),
    )
    .toBe(true);
  await page.getByRole("slider", { name: "Scroll hunk", exact: true }).focus();
  await page.keyboard.press("Home");
  await runSlider.focus();
  await page.keyboard.press("Home");
  await page.locator("#diff-scrollport").evaluate((element) => {
    element.scrollTop = 0;
  });
  await recordUiCapture(page, "diff-scrolling-desktop");
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .getByRole("checkbox", { name: "Side by side" })
      .setChecked(viewport.width > 600);
    await expect(
      page.getByRole("slider", { name: "Scroll long lines", exact: true }),
    ).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `diff-scrolling-${viewport.width}`);
  }
  // Resize the real scrollport: the same long hunk must become one scroll group.
  await page.setViewportSize({ width: 1000, height: 2600 });
  await expect(hunks.nth(1)).toHaveAttribute("data-diff-scroll-mode", "hunk");
  await page.setViewportSize({ width: 1000, height: 600 });
  await expect(hunks.nth(1)).toHaveAttribute("data-diff-scroll-mode", "runs");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = page.getByRole("textbox", { name: "Review comment" });
  await comment.focus();
  await comment.evaluate((element) => {
    element.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key.length !== 1) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const samples = JSON.parse(
            element.getAttribute("data-samples") ?? "[]",
          ) as { milliseconds: number; value: string }[];
          samples.push({
            milliseconds: performance.now() - event.timeStamp,
            value: (element as HTMLTextAreaElement).value,
          });
          element.setAttribute("data-samples", JSON.stringify(samples));
        }),
      );
    });
  });
  let typed = "";
  for (const character of "Review long lines while the view refreshes") {
    typed += character;
    await page.keyboard.type(character);
    await expect
      .poll(
        async () =>
          JSON.parse((await comment.getAttribute("data-samples")) ?? "[]")
            .length,
      )
      .toBe(typed.length);
    const samples = JSON.parse(
      (await comment.getAttribute("data-samples")) ?? "[]",
    ) as { milliseconds: number; value: string }[];
    expect(samples.at(-1)?.value).toBe(typed);
    expect(samples.at(-1)?.milliseconds).toBeLessThan(100);
  }
  await expect(comment).toHaveValue(typed);
  expect(errors).toEqual([]);
});

test("sticky hunk controls clear the real file toolbar", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/projects/diff-fixture/git/diff", async (route) =>
    route.fulfill({
      json: await page.evaluate(() => window.diffScrollingFixture),
    }),
  );
  await page.route("**/api/projects/diff-fixture/review/comments", (route) =>
    route.fulfill({ json: { comments: [], batches: [], pendingCount: 0 } }),
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${url}?workbench`);
  const hunk = page.locator("[data-diff-hunk]").nth(1);
  await expect(hunk).toHaveAttribute("data-diff-scroll-mode", "runs");
  await page.locator(".git-diff-preview-body").evaluate((element) => {
    element.scrollTop = 240;
  });
  const toolbar = await page.locator(".git-diff-pane-toolbar").boundingBox();
  const header = await hunk.locator("[data-diff-hunk-header]").boundingBox();
  expect(toolbar).not.toBeNull();
  expect(header?.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height - 1);
  expect(header?.y).toBeLessThan(toolbar!.y + toolbar!.height + 2);
  await page.getByRole("button", { name: "Next hunk (N)" }).click();
  await expect(
    page.getByRole("slider", { name: "Scroll hunk", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
