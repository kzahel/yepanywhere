import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  const skipAll = page.getByRole("button", { name: "Skip all" });
  await skipAll.click({ force: true });
  await expect(dialog).not.toBeVisible();
}

function projectCardForCurrentRun(page: import("@playwright/test").Page) {
  return page.locator(
    `[data-project-card-link][href*="project=${projectId}&source=projects"]`,
  );
}

test.describe("Project-scoped new session CTA", () => {
  test("shows the CTA when entering sessions from Projects", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/projects`);
    await dismissOnboardingIfVisible(page);

    const projectCard = projectCardForCurrentRun(page);
    await expect(projectCard).toBeVisible();

    await projectCard.click();

    await expect(page).toHaveURL(
      new RegExp(`/sessions\\?project=${projectId}&source=projects`),
    );
    const cta = page.locator("[data-global-sessions-project-cta]");
    await expect(cta).toBeVisible();
    await expect(
      cta.locator("[data-global-sessions-project-cta__token]"),
    ).toHaveCount(2);
    await expect(cta.getByText("Open session for")).toBeVisible();
    await expect(
      cta.getByRole("button", { name: "New Session" }),
    ).toBeVisible();
  });

  test("prefills the new session prompt from project search text", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/projects`);
    await dismissOnboardingIfVisible(page);

    const projectCard = projectCardForCurrentRun(page);
    await expect(projectCard).toBeVisible();
    await projectCard.click();

    const query = "summarize the current mock session";
    const searchInput = page.getByPlaceholder("Search sessions...");
    await searchInput.fill(query);
    await searchInput.press("Enter");

    await expect(page).toHaveURL(
      new RegExp(
        `/sessions\\?project=${projectId}&source=projects&q=${encodeURIComponent(query).replace(/%20/g, "\\+")}`,
      ),
    );
    await expect(page.getByText("First prompt")).toBeVisible();
    await expect(page.getByText(query)).toBeVisible();

    await page
      .locator("[data-global-sessions-project-cta]")
      .getByRole("button", { name: "New Session" })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/new-session\\?projectId=${projectId}`),
    );
    await expect(
      page.getByPlaceholder("Describe what you'd like help with..."),
    ).toHaveValue(query);
  });
});
