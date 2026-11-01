import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import type { PeerConnectionsResponse } from "@yep-anywhere/shared";
const ownId = "00000000-0000-4000-8000-000000000001",
  peerId = "00000000-0000-4000-8000-000000000002";
function fixture(): PeerConnectionsResponse {
  return {
    identity: {
      serverId: ownId,
      hostname: "studio-mac",
      os: "darwin",
      architecture: "arm64",
      icon: "💻",
    },
    enabled: true,
    environmentOverride: null,
    agentAccess: { enabled: false },
    peers: [
      {
        serverId: peerId,
        identity: {
          serverId: peerId,
          hostname: "build-linux",
          os: "linux",
          architecture: "x64",
          icon: "🛠️",
        },
        label: "Build server",
        verifiedAt: "2026-10-31T12:00:00Z",
        incoming: [],
        outgoing: [
          {
            credentialId: "00000000-0000-4000-8000-000000000003",
            generation: 1,
            expiresAt: Date.now() + 90 * 86400000 - 3600000,
            active: true,
            selected: true,
            origin: "manual",
            allProjects: true,
            authentication: {
              mode: "automatic",
              status: "ready",
              lastRefreshedAt: Date.now() - 3600000,
            },
            route: {
              kind: "relay",
              url: "wss://relay.yepanywhere.com/ws",
              username: "peer-test-build",
            },
          },
        ],
        setupRoute: {
          kind: "relay",
          url: "wss://relay.yepanywhere.com/ws",
          username: "build-owner",
        },
        setupUsername: "build-owner",
      },
    ],
    audit: [
      {
        id: "audit1",
        at: "2026-10-31T12:00:00Z",
        serverId: peerId,
        action: "outgoing-imported",
        actor: "owner",
      },
    ],
    nextCursor: null,
    total: 1,
    relay: null,
  };
}
async function support(page: import("@playwright/test").Page) {
  await page.route("**/api/version**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        capabilities: [
          ...(body.capabilities ?? []),
          "peer-connections",
          "peer-authentication-refresh",
        ],
      },
    });
  });
}
test("server connections keeps drafts responsive during populated-list updates and uses independent direction requests", async ({
  page,
  baseURL,
}) => {
  await support(page);
  const data = fixture();
  // Fifty visible rows is the maximum supported page; 64 total peers.
  for (let n = 3; n <= 51; n++)
    data.peers.push({
      ...data.peers[0]!,
      serverId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      identity: { ...data.peers[0]!.identity!, hostname: `worker-${n}` },
      label: `Worker ${n}`,
    });
  data.total = 64;
  let release = () => {},
    hold = false,
    setup: unknown;
  await page.route("**/api/peers/connections**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/connect")) {
      setup = route.request().postDataJSON();
      return route.fulfill({
        json: {
          serverId: peerId,
          outcome: "connected",
          outgoing: "confirmed",
          incoming: "not-requested",
          ownerSessionCleanup: "confirmed",
          operationId: "op1",
        },
      });
    }
    if (url.pathname.endsWith("/activity"))
      return route.fulfill({ json: { incoming: [], outgoing: [] } });
    if (hold) {
      hold = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(page.getByText("studio-mac", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Let agent sessions use connected servers",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect a server", exact: true })
    .click();
  const label = page
    .getByLabel("Friendly name (optional)", { exact: true })
    .first();
  hold = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await label.focus();
  await label.evaluate((element) => {
    const input = element as HTMLInputElement;
    const times: number[] = [];
    (window as unknown as { connectionTyping: number[] }).connectionTyping =
      times;
    input.addEventListener("keydown", () => {
      const start = performance.now();
      input.addEventListener(
        "input",
        () =>
          requestAnimationFrame(() => times.push(performance.now() - start)),
        { once: true },
      );
    });
  });
  let text = "";
  for (const character of "Review worker for my projects") {
    text += character;
    if (text.length === 8) release();
    await label.pressSequentially(character);
    await expect(label).toHaveValue(text, { timeout: 100 });
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { connectionTyping: number[] }).connectionTyping
            .length,
      ),
    )
    .toBe(text.length);
  const times = await page.evaluate(
    () =>
      (window as unknown as { connectionTyping: number[] }).connectionTyping,
  );
  expect(Math.max(...times), JSON.stringify(times)).toBeLessThanOrEqual(100);
  await page
    .getByRole("heading", { name: "Connect a server", exact: true })
    .scrollIntoViewIfNeeded();
  await recordUiCapture(page, "server-connections-desktop-form");
  await page
    .getByLabel("Remote Access username", { exact: true })
    .pressSequentially("build-owner");
  await page
    .getByLabel("Remote Access password", { exact: true })
    .pressSequentially("test-owner-password");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText("Connection verified and saved.", { exact: true }),
  ).toBeVisible();
  expect(setup).toMatchObject({
    username: "build-owner",
    label: text,
    bidirectional: false,
    automaticSignIn: true,
  });
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Add / renew peer → this server",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Remote Access username", { exact: true }),
  ).toHaveValue("build-owner");
  await page
    .getByLabel("Remote Access password", { exact: true })
    .pressSequentially("test-owner-password");
  await page
    .getByRole("button", {
      name: "Add / renew peer → this server",
      exact: true,
    })
    .first()
    .click();
  expect(setup).toMatchObject({
    direction: "incoming",
    expectedServerId: peerId,
  });
  // A concise one-peer fixture is the actual list at both required sizes.
  data.peers = data.peers.slice(0, 1);
  data.total = 1;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByText("This server", { exact: true }).scrollIntoViewIfNeeded();
  await recordUiCapture(page, "server-connections-desktop");
  await page.getByRole("article").scrollIntoViewIfNeeded();
  await recordUiCapture(page, "server-connections-desktop-automatic");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(page.getByText("studio-mac", { exact: true })).toBeVisible();
  await recordUiCapture(page, "server-connections-phone");
  await page
    .getByRole("button", { name: "Connect a server", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Connect a server", exact: true })
    .scrollIntoViewIfNeeded();
  await recordUiCapture(page, "server-connections-phone-form");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("an older server hides the category and receives no unsupported peer request", async ({
  page,
  baseURL,
}) => {
  await page.route("**/api/version**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        capabilities: (body.capabilities ?? []).filter(
          (c: string) => c !== "peer-connections",
        ),
        capabilityEncoding: undefined,
        capabilityBits: undefined,
      },
    });
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/peers")) requests.push(request.url());
  });
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(
    page.getByText("Update this server to use Server Connections.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test("refresh status keeps the saved host visible and an older source cannot create a silent temporary pair", async ({
  page,
  baseURL,
}) => {
  await support(page);
  const data = fixture();
  await page.route("**/api/peers/connections**", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(
    page.getByText("Automatic sign-in", { exact: true }),
  ).toBeVisible();
  const direction = data.peers[0]!.outgoing[0]!;
  direction.authentication = {
    mode: "automatic",
    status: "unavailable",
    nextAttemptAt: Date.now() + 120000,
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Sign-in refresh delayed; retrying automatically.", {
      exact: true,
    }),
  ).toBeVisible();
  direction.active = false;
  direction.expiresAt = Date.now() - 1;
  direction.authentication = { mode: "automatic", status: "sign-in-required" };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Build server", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  await page.getByRole("article").scrollIntoViewIfNeeded();
  await recordUiCapture(page, "server-connections-phone-sign-in");
  await page
    .getByRole("button", { name: "Sign in again", exact: true })
    .click();
  await expect(
    page.getByLabel("Remote Access password", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Automatic sign-in", { exact: true }),
  ).toBeChecked();
  await page.route("**/api/version**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        capabilities: [
          ...(body.capabilities ?? []).filter(
            (c: string) => c !== "peer-authentication-refresh",
          ),
          "peer-connections",
        ],
        capabilityEncoding: undefined,
        capabilityBits: undefined,
      },
    });
  });
  await page.reload();
  await expect(
    page.getByText(
      "Update this server to connect with automatic sign-in. Existing connections remain available.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect a server", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Build server", { exact: true })).toBeVisible();
});
