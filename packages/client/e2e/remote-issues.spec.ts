import {
  configureRemoteAccess,
  disableRelay,
  disableRemoteAccess,
  expect,
  test,
  waitForRelayStatus,
} from "./fixtures.js";

const username = "e2e-issues-route";
const password = "issues-route-test-password";
const headers = { "X-Yep-Anywhere": "true" };

for (const mode of ["direct", "relay"] as const) {
  test(`Issues sidebar and deep links survive reload in ${mode} hosted client`, async ({
    page,
    baseURL,
    remotePreviewURL,
    wsURL,
    relayWsURL,
  }) => {
    test.setTimeout(60_000);
    const settingsResponse = await page.request.get(
      `${baseURL}/api/issues/settings`,
    );
    expect(settingsResponse.ok()).toBeTruthy();
    const { settings } = await settingsResponse.json();
    await configureRemoteAccess(baseURL, {
      username,
      password,
      ...(mode === "relay" ? { relayUrl: relayWsURL } : {}),
    });
    try {
      const enabled = await page.request.put(`${baseURL}/api/issues/settings`, {
        headers,
        data: { enabled: true, scope: "viewed", recentDays: 7 },
      });
      expect(enabled.ok()).toBeTruthy();
      if (mode === "relay")
        await waitForRelayStatus(baseURL, "waiting", 15_000);
      await page.setViewportSize(
        mode === "relay"
          ? { width: 375, height: 812 }
          : { width: 1000, height: 600 },
      );
      // Exercise the production remote bundle, not the local client entry.
      await page.goto(remotePreviewURL);
      await page.getByTestId(`${mode}-mode-button`).click();
      if (mode === "relay") {
        await page.getByTestId("relay-username-input").fill(username);
        await page.getByTestId("srp-password-input").fill(password);
        await page.getByText("Show Advanced Options").click();
        await page.getByTestId("custom-relay-url-input").fill(relayWsURL);
      } else {
        await page.getByTestId("ws-url-input").fill(wsURL);
        await page.getByTestId("username-input").fill(username);
        await page.getByTestId("password-input").fill(password);
      }
      await page.getByTestId("login-button").click();
      const prefix = mode === "relay" ? `/-/relay/${username}` : "";
      await expect(page).toHaveURL(`${remotePreviewURL}${prefix}/projects`);
      const openSidebar = page.getByRole("button", { name: "Open sidebar" });
      const issuesLink = page.locator(`a[href="${prefix}/issues"]`);
      if (!(await issuesLink.isVisible())) await openSidebar.click();
      await expect(issuesLink).toBeVisible();
      await issuesLink.click();
      const search = page.getByRole("searchbox", {
        name: "Search ticket keys, titles, or paste an issue/PR URL",
      });
      await expect(search).toBeVisible();
      await expect(page).toHaveURL(`${remotePreviewURL}${prefix}/issues`);
      await search.fill("ROUTETEST-987654");
      await expect(
        page.getByText("No references found in the indexed content.", {
          exact: false,
        }),
      ).toBeVisible();
      if (!(await issuesLink.isVisible())) await openSidebar.click();
      await expect(issuesLink).toHaveAttribute("data-sidebar-active");

      const deepLink = `${remotePreviewURL}${prefix}/issues?sessionId=route-test&projectId=route-project`;
      await page.goto(deepLink);
      await expect(search).toBeVisible();
      await page.reload();
      await expect(search).toBeVisible();
      await expect(page).toHaveURL(deepLink);
    } finally {
      const restored = await page.request.put(
        `${baseURL}/api/issues/settings`,
        {
          headers,
          data: settings,
        },
      );
      expect(restored.ok()).toBeTruthy();
      await disableRelay(baseURL);
      await disableRemoteAccess(baseURL);
    }
  });
}
