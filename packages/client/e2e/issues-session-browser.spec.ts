import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

for (const viewport of [
  { width: 1000, height: 600 },
  { width: 375, height: 812 },
]) {
  test(`issue browser groups sessions and keeps corrections in menus at ${viewport.width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/settings", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          settings: {
            ...body.settings,
            issueAssociations: {
              enabled: true,
              scope: "viewed",
              recentDays: 7,
            },
          },
        },
      });
    });
    let title: string | null = null;
    await page.route("**/api/issues?*", (route) => {
      expect(new URL(route.request().url()).searchParams.has("sort")).toBe(
        false,
      );
      return route.fulfill({
        json: {
          items: [
            {
              id: "jira:tomfit.atlassian.net:TF-3996",
              key: "TF-3996",
              title,
              provider: "jira",
              kind: "issue",
              url: "https://tomfit.atlassian.net/browse/TF-3996",
              sessionCount: 2,
              unresolved: false,
            },
            {
              id: "github:a:b:12",
              key: "example/engine#12",
              title: "Improve connection recovery",
              provider: "github",
              kind: "pr",
              url: "https://github.com/example/engine/pull/12",
              sessionCount: 1,
              unresolved: false,
            },
          ],
          nextOffset: null,
          coverage: {
            settings: { enabled: true, scope: "recent", recentDays: 7 },
            active: false,
            error: null,
            counts: [
              { state: "indexed", count: 148 },
              { state: "partial", count: 28 },
            ],
          },
        },
      });
    });
    const mention = (id: number, sessionId = "recent") => ({
      id,
      sessionId,
      projectId: "fixture-project",
      messageId: `m${id}`,
      excerpt:
        id === 1
          ? "Investigate TF-3996: the mapping request uses an outdated field name. Check the request builder and update the affected tests."
          : "TF-3996 follow-up: the field mapping now handles the optional value correctly.",
      value: "TF-3996",
      kind: "ticket-key",
      observedAt: Date.now(),
      sourceTime: new Date(Date.now() - 86400_000).toISOString(),
      state: "discovered",
    });
    const sessions = [
      {
        sessionId: "recent",
        projectId: "fixture-project",
        title: "Fix the mapping request",
        provider: "claude",
        projectName: "api-service",
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
        createdAt: new Date(Date.now() - 86400_000).toISOString(),
        initialPrompt:
          "Investigate why the mapping request fails when an optional field is missing.",
        lastAgentText:
          "Updated the request builder and verified the regression tests.",
        sourceAvailable: true,
        state: "discovered",
        evidenceCount: 3,
        evidence: [mention(1)],
      },
      {
        sessionId: "older",
        projectId: "fixture-project",
        title: "Trace the mapping failure",
        provider: "codex",
        projectName: "web-client",
        updatedAt: new Date(Date.now() - 7200_000).toISOString(),
        createdAt: new Date(Date.now() - 172800_000).toISOString(),
        initialPrompt: "Find where the client constructs the mapping request.",
        lastAgentText:
          "The client sends the expected payload; the server mapping needs updating.",
        sourceAvailable: true,
        state: "discovered",
        evidenceCount: 1,
        evidence: [mention(4, "older")],
      },
    ];
    await page.route("**/api/issues/sessions?*", (route) => {
      const sort = new URL(route.request().url()).searchParams.get("sort");
      return route.fulfill({
        json: {
          sessions: sort === "oldest" ? [...sessions].reverse() : sessions,
          nextOffset: null,
        },
      });
    });
    await page.route("**/api/issues/evidence?*", (route) => {
      expect(new URL(route.request().url()).searchParams.get("sessionId")).toBe(
        "recent",
      );
      return route.fulfill({
        json: { evidence: [mention(2), mention(3)], nextOffset: null },
      });
    });
    await page.route("**/api/issues/item", async (route) => {
      title = route.request().postDataJSON().title;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${baseURL}/issues`);
    await expect(
      page.getByRole("combobox", { name: "Sort issues & PRs" }),
    ).toHaveCount(0);
    await expect(page.getByText("Reference key A–Z")).toBeVisible();
    await page.getByRole("button", { name: /^TF-3996 Jira/ }).click();
    const pane = page.getByRole("region", {
      name: "Associated sessions",
      exact: true,
    });
    await expect(pane.getByRole("article")).toHaveCount(2);
    await expect(pane.getByRole("article").first()).toHaveAttribute(
      "aria-label",
      "Fix the mapping request",
    );
    await expect(page.getByRole("button", { name: "Save title" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Confirm association" }),
    ).toHaveCount(0);
    await expect(pane.getByText(/follow-up:/)).toHaveCount(1); // older session's first excerpt
    await expect(
      page.getByRole("combobox", { name: "Sort associated sessions" }),
    ).toHaveValue("activity");
    await recordUiCapture(page, `issues-sessions-${viewport.width}`, viewport);
    await page.getByRole("button", { name: "Show 2 more mentions" }).click();
    await expect(pane.getByRole("article")).toHaveCount(2);
    await expect(pane.getByText(/follow-up:/)).toHaveCount(3);
    await page.getByRole("button", { name: "Show fewer mentions" }).click();
    await page
      .getByRole("combobox", { name: "Sort associated sessions" })
      .selectOption("oldest");
    await expect(pane.getByRole("article").first()).toHaveAttribute(
      "aria-label",
      "Trace the mapping failure",
    );
    await pane
      .getByRole("button", { name: "Association actions" })
      .first()
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Dismiss association" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    if (viewport.width === 1000) {
      await pane
        .getByRole("link", { name: /Fix the mapping request/ })
        .first()
        .hover();
      await expect(
        page.getByText(
          "Updated the request builder and verified the regression tests.",
          { exact: true },
        ),
      ).toBeVisible({ timeout: 10_000 });
      await recordUiCapture(page, "issues-session-hover", viewport);
      await page.getByRole("searchbox").hover();
    }
    await page.getByRole("button", { name: "Close evidence" }).click();
    await page.getByRole("button", { name: "Actions for TF-3996" }).click();
    await page.getByRole("menuitem", { name: "Set display title…" }).click();
    await page
      .getByRole("textbox", { name: "Display title in Yep Anywhere" })
      .fill("Repair mapping request");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(
      page.getByRole("button", {
        name: /^TF-3996 Jira Repair mapping request/,
      }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    let discovery = {
      enabled: true,
      scope: "viewed",
      recentDays: 7,
      aggressiveMatching: false,
    };
    await page.route("**/api/issues/settings", (route) => {
      if (route.request().method() === "PUT")
        discovery = route.request().postDataJSON();
      return route.fulfill({
        json: {
          settings: discovery,
          active: false,
          error: null,
          counts: [],
          knownJiraProjects: [
            { prefix: "TF", site: "https://tomfit.atlassian.net" },
            { prefix: "ACCESS", site: "https://tomfit.atlassian.net" },
          ],
        },
      });
    });
    await page.goto(`${baseURL}/settings/issues`);
    const aggressive = page.getByRole("switch", {
      name: "Match unknown ticket keys",
    });
    await expect(aggressive).not.toBeChecked();
    await page
      .locator('[data-settings-item="issue-known-projects"]')
      .scrollIntoViewIfNeeded();
    await expect(page.getByText("TF", { exact: true })).toBeVisible();
    await recordUiCapture(
      page,
      `issues-discovery-settings-${viewport.width}`,
      viewport,
    );
    await aggressive.check();
    await expect.poll(() => discovery.aggressiveMatching).toBe(true);
    await aggressive.uncheck();
    await expect.poll(() => discovery.aggressiveMatching).toBe(false);
  });
}
