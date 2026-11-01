import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import type { PeerConnectionsResponse } from "@yep-anywhere/shared";
const ownId = "00000000-0000-4000-8000-000000000001",
  peerId = "00000000-0000-4000-8000-000000000002";
function fixture(): PeerConnectionsResponse {
  const result: PeerConnectionsResponse = {
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
        incoming: [
          {
            credentialId: "00000000-0000-4000-8000-000000000004",
            generation: 1,
            expiresAt: Date.now() + 90 * 86400000,
            active: true,
            origin: "manual",
            allProjects: true,
          },
        ],
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
  const build = result.peers[0]!;
  result.peers.push(
    {
      ...build,
      serverId: "00000000-0000-4000-8000-000000000005",
      identity: {
        ...build.identity!,
        serverId: "00000000-0000-4000-8000-000000000005",
        hostname: "windows-workstation",
        os: "win32",
        icon: "🖥️",
      },
      label: "Windows workstation",
      incoming: [],
      outgoing: structuredClone(build.outgoing),
    },
    {
      ...build,
      serverId: "00000000-0000-4000-8000-000000000006",
      identity: {
        ...build.identity!,
        serverId: "00000000-0000-4000-8000-000000000006",
        hostname: "travel-laptop",
        icon: "💻",
      },
      label: "Travel laptop",
      outgoing: [],
      incoming: structuredClone(build.incoming),
    },
  );
  result.total = 3;
  return result;
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
  for (let n = 7; n <= 53; n++)
    data.peers.push({
      ...data.peers[0]!,
      serverId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      identity: { ...data.peers[0]!.identity!, hostname: `worker-${n}` },
      label: `Worker ${n}`,
      incoming: [],
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
    if (route.request().method() === "PATCH")
      return route.fulfill({
        status: 503,
        json: { error: "Could not save this name." },
      });
    if (url.pathname.endsWith("/test")) return route.fulfill({ json: {} });
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
  await page.getByText("Connection settings", { exact: true }).click();
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
    .getByRole("button", { name: "View Build server details", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save name", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Could not save this name.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "The peer authenticated successfully.",
  );
  await page
    .getByRole("button", {
      name: "Set up access from this device",
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
      name: "Set up access from this device",
      exact: true,
    })
    .first()
    .click();
  expect(setup).toMatchObject({
    direction: "incoming",
    expectedServerId: peerId,
  });
  // Bidirectional peers appear once in each independent list.
  data.peers = data.peers.slice(0, 3);
  data.total = 3;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Devices you can access", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await page.reload();
  await expect(page.getByText("studio-mac", { exact: true })).toBeVisible();
  await recordUiCapture(page, "server-connections-desktop");
  await page
    .getByRole("button", { name: "View Build server details", exact: true })
    .first()
    .click();
  await recordUiCapture(page, "server-connections-desktop-details");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
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
    page
      .getByRole("region", { name: "Devices you can access", exact: true })
      .getByText("Build server", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Automatic sign-in", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Connection settings", { exact: true }).click();
  data.peers[1]!.outgoing = data.peers[1]!.outgoing.map((c) => ({
    ...c,
    authentication: { ...c.authentication!, status: "ready" },
  }));
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
  await expect(
    page.getByText("Build server", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/settings/server-connections`);
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Devices you can access", exact: true })
    .scrollIntoViewIfNeeded();
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
  await expect(
    page.getByText("Build server", { exact: true }).first(),
  ).toBeVisible();
});

test("removal confirms one direction, preserves the reverse, and refuses a stale credential", async ({
  page,
  baseURL,
}) => {
  await support(page);
  const data = fixture();
  const build = data.peers[0]!;
  // A manually paired route cannot claim to revoke access also supplied by a fleet.
  data.peers[1]!.outgoing.push({
    ...data.peers[1]!.outgoing[0]!,
    credentialId: "fleet-credential",
    origin: "fleet",
    selected: false,
    active: false,
    expiresAt: Date.now() - 1,
    authentication: { mode: "automatic", status: "sign-in-required" },
  });
  const deletes: string[] = [];
  await page.route("**/api/peers/connections**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      deletes.push(path);
      const [serverId, direction, credentialId, generation] = path
        .slice("/api/peers/connections/".length)
        .split("/");
      const key = direction as "incoming" | "outgoing";
      const peer = data.peers.find((p) => p.serverId === serverId)!;
      const match = peer[key].find(
        (c) =>
          c.credentialId === credentialId &&
          c.generation === Number(generation),
      );
      if (!match)
        return route.fulfill({
          status: 409,
          json: { error: "Connection changed. Refresh and try again." },
        });
      peer[key] = peer[key].filter((c) => c !== match);
      if (key === "outgoing" && match.selected)
        peer.outgoing.forEach((c) => {
          c.selected = false;
          c.active = false;
        });
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/activity"))
      return route.fulfill({
        status: 503,
        json: { error: "Activity unavailable" },
      });
    return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/settings/server-connections`);
  const outgoing = page.getByRole("region", {
    name: "Devices you can access",
    exact: true,
  });
  const incoming = page.getByRole("region", {
    name: "Devices with access to this server",
    exact: true,
  });
  await expect(
    outgoing.getByRole("button", {
      name: "Remove Windows workstation",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(outgoing.getByText("Managed", { exact: true })).toBeVisible();
  await incoming
    .getByRole("button", {
      name: "Revoke access for Build server",
      exact: true,
    })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Remove access?",
    exact: true,
  });
  await expect(
    dialog.getByText("Your access to Build server stays in place.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Remove access", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    incoming.getByRole("button", {
      name: "Revoke access for Build server",
      exact: true,
    }),
  ).toBeFocused();
  await incoming
    .getByRole("button", {
      name: "Revoke access for Build server",
      exact: true,
    })
    .click();
  await recordUiCapture(page, "server-connections-desktop-confirm");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await incoming
    .getByRole("button", {
      name: "Revoke access for Build server",
      exact: true,
    })
    .click();
  await expect(dialog).toBeVisible();
  await recordUiCapture(page, "server-connections-phone-confirm");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(deletes).toEqual([]);
  await incoming
    .getByRole("button", {
      name: "Revoke access for Build server",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(incoming.getByText("Build server", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    outgoing.getByText("Build server", { exact: true }),
  ).toBeVisible();
  expect(deletes).toEqual([
    `/api/peers/connections/${peerId}/incoming/00000000-0000-4000-8000-000000000004/1`,
  ]);

  await outgoing
    .getByRole("button", { name: "Remove Build server", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Remove connection?",
    exact: true,
  });
  await expect(
    dialog.getByText(/the other server keeps its grant/),
  ).toBeVisible();
  // Rotation on another owner connection must not remove a newer credential.
  build.outgoing[0]!.generation = 2;
  await dialog
    .getByRole("button", { name: "Remove connection", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Connection changed");
  await expect(
    outgoing.getByText("Build server", { exact: true }),
  ).toBeVisible();
  expect(deletes.at(-1)).toBe(
    `/api/peers/connections/${peerId}/outgoing/00000000-0000-4000-8000-000000000003/1`,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Restore a reverse leg to establish that outgoing removal leaves it intact.
  build.incoming = fixture().peers[0]!.incoming;
  await page.getByText("Connection settings", { exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    incoming.getByText("Build server", { exact: true }),
  ).toBeVisible();
  await outgoing
    .getByRole("button", { name: "Remove Build server", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(outgoing.getByText("Build server", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    incoming.getByText("Build server", { exact: true }),
  ).toBeVisible();
  expect(deletes.at(-1)).toBe(
    `/api/peers/connections/${peerId}/outgoing/00000000-0000-4000-8000-000000000003/2`,
  );
  await expect(
    page.getByRole("button", { name: "Connect a server", exact: true }),
  ).toBeFocused();
  await outgoing
    .getByRole("button", {
      name: "View Windows workstation details",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
    "Could not load recent session activity.",
  );
  await expect(
    page.getByRole("dialog").getByText("Loading…", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop local use", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Fleet-managed access is separate and will remain.", {
        exact: true,
      }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "Manual connection removed. Fleet-managed access remains.",
  );
  await expect(
    outgoing.getByText("Windows workstation", { exact: true }),
  ).toBeVisible();
  expect(data.peers[1]!.outgoing.map((c) => c.origin)).toEqual(["fleet"]);
  await expect(
    outgoing.getByText("No connection selected.", { exact: true }),
  ).toBeVisible();
  await expect(
    outgoing.getByRole("button", { name: "Sign in again", exact: true }),
  ).toHaveCount(0);
  await expect(
    outgoing.getByRole("button", {
      name: "View Windows workstation details",
      exact: true,
    }),
  ).toBeFocused();
});
