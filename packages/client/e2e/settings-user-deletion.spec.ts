import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1200, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`confirms user deletion on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    let deleted = false;
    let deletionRequests = 0;
    await page.route("**/api/users", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          users: deleted
            ? []
            : [
                {
                  username: "alice",
                  newSessionProjects: [],
                  joinProjects: [],
                  viewProjects: [],
                  joinStaleOffsetMinutes: 0,
                  lock: {},
                  createdAt: "2026-09-21T00:00:00.000Z",
                },
              ],
        },
      }),
    );
    await page.route("**/api/users/alice", (route) => {
      expect(route.request().method()).toBe("DELETE");
      deletionRequests++;
      deleted = true;
      return route.fulfill({ json: { success: true } });
    });

    await page.goto(`${baseURL}/settings/users`);
    await page.getByRole("button", { name: "alice", exact: true }).click();
    const remove = page.getByRole("button", { name: "Delete", exact: true });
    await expect(remove).toBeVisible();
    const confirm = page.getByRole("alertdialog", { name: "Delete user?" });
    await remove.click();
    await expect(confirm).toContainText(
      "Delete user alice? This removes their account, grants and usage history. Project directories and files are kept.",
    );
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(deletionRequests).toBe(0);
    await expect(page.getByText("alice", { exact: true })).toBeVisible();
    await recordUiCapture(page, `user-delete-canceled-${viewport.name}`);

    await remove.click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("alice", { exact: true })).toHaveCount(0);
    expect(deletionRequests).toBe(1);
  });
}
