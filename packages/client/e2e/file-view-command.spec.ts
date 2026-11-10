import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("/v finds files by path parts, previews them, and opens one without a turn", async ({
  page,
  baseURL,
}) => {
  const project = join(e2ePaths.tempDir, "mockproject");
  await mkdir(join(project, "viewcmd", "notes"), { recursive: true });
  await writeFile(
    join(project, "viewcmd", "notes", "alpha-plan.md"),
    "# Alpha plan\n\nview command body\n",
  );
  await writeFile(join(project, "viewcmd", "alpha-other.txt"), "other");
  await writeFile(join(project, "viewcmd", ".gitignore"), "secret-*.log\n");
  await writeFile(join(project, "viewcmd", "secret-run.log"), "ignored run");
  const id = Buffer.from(project).toString("base64url");
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages\b/.test(request.url()))
      sent.push(request.url());
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${id}/sessions/mock-session-001`);
  const textarea = page.locator("textarea[data-composer-input]").first();
  await expect(textarea).toBeVisible();

  // Sequential keystrokes, as a person types them: every one must land.
  const typed = "/v viewcmd alp plan";
  await textarea.pressSequentially(typed, { delay: 15 });
  await expect(textarea).toHaveValue(typed);
  const menu = page.getByRole("listbox", {
    name: "Project files and directories",
  });
  const group = menu.getByRole("group", { name: "Untracked" });
  const option = group.getByRole("option", {
    name: "alpha-plan.md viewcmd/notes/",
  });
  await expect(option).toBeVisible();
  await expect(menu.getByText("alpha-other.txt")).toHaveCount(0);
  // Each part's match is marked where it hit (basename renders first).
  await expect(option.locator("mark")).toHaveText(["alp", "plan", "viewcmd"]);
  const preview = page
    .locator('[aria-live="polite"]')
    .filter({ hasText: "viewcmd/notes/alpha-plan.md" });
  await expect(preview).toContainText("view command body");
  // The whole three-line file fits, so no continuation mark.
  await expect(preview).not.toContainText("…");
  await recordUiCapture(page, "file-view-sheet-desktop");

  // Right at the end of the draft narrows the query to that directory.
  await textarea.press("ArrowRight");
  await expect(textarea).toHaveValue("/v viewcmd/notes/");
  await expect(option).toBeVisible();

  // Ctrl+Enter opens without spending the draft.
  await textarea.press("Control+Enter");
  const viewer = page.locator("[data-file-viewer]");
  await expect(viewer).toContainText("view command body");
  await expect(textarea).toHaveValue("/v viewcmd/notes/");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  await textarea.fill("");
  await textarea.pressSequentially("/v viewcmd alp plan", { delay: 15 });
  await expect(option).toBeVisible();
  await textarea.press("Enter");
  await expect(viewer).toContainText("view command body");
  await expect(textarea).toHaveValue("");
  expect(sent).toHaveLength(0);
  await recordUiCapture(page, "file-view-open-desktop");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // Ignored files are searched only when asked.
  await textarea.pressSequentially("/v secret-run", { delay: 15 });
  const searchIgnored = page.getByRole("button", {
    name: "Search ignored files",
  });
  await expect(searchIgnored).toBeVisible();
  await searchIgnored.click();
  await expect(
    menu
      .getByRole("group", { name: "Ignored" })
      .getByRole("option", { name: "secret-run.log viewcmd/" }),
  ).toBeVisible();

  // A miss keeps the typed command for correction and sends nothing.
  await textarea.fill("/v zzz-no-such-file");
  await textarea.press("Escape");
  await textarea.press("Enter");
  await expect(
    page.getByText("No file matches zzz-no-such-file."),
  ).toBeVisible();
  await expect(textarea).toHaveValue("/v zzz-no-such-file");
  expect(sent).toHaveLength(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await textarea.fill("");
  await textarea.pressSequentially("/v alp plan", { delay: 15 });
  await expect(option).toBeVisible();
  await expect(page.getByText("view command body")).toBeVisible();
  await recordUiCapture(page, "file-view-sheet-phone");
  await option.click();
  await expect(textarea).toHaveValue("/v viewcmd/notes/alpha-plan.md");
});
