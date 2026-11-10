import type { Page, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import {
  startMultiHostRelayHarness,
  type MultiHostRelayHarness,
} from "./support/multi-host-relay-harness.js";
import {
  restartYaServerProcess,
  terminateYaServerProcess,
} from "./support/ya-server-process.js";

interface ProvisionInput {
  displayName: string;
  password: string;
  relayUrl: string;
  username: string;
}

interface MonitorResult {
  connectedCount: number;
  hosts: Array<{
    displayName: string;
    state: string;
    summary?: {
      sessions: Array<{ id: string; title: string }>;
    };
  }>;
  selectedCount: number;
}

interface SourceDisposalResult {
  connectedCount: number;
  selectedCount: number;
  titles: string[];
}

type MonitorTransportMode = "legacy" | "mux";

function relaySiblingUrl(relayUrl: string, leaf: "health" | "mux"): string {
  const url = new URL(relayUrl);
  url.protocol =
    leaf === "health"
      ? url.protocol === "wss:"
        ? "https:"
        : "http:"
      : url.protocol;
  url.pathname = url.pathname.replace(/\/ws$/, `/${leaf}`);
  return url.toString();
}

async function configureMonitorTransport(
  page: Page,
  relayUrl: string,
  mode: MonitorTransportMode,
): Promise<void> {
  if (mode === "mux") return;
  await page.route(relaySiblingUrl(relayUrl, "health"), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        status: "ok",
        uptime: 1,
        waiting: 3,
        pairs: 0,
      }),
    });
  });
}

function observeMonitorRelaySockets(
  page: Page,
  relayUrl: string,
): PlaywrightWebSocket[] {
  const sockets: PlaywrightWebSocket[] = [];
  const muxUrl = relaySiblingUrl(relayUrl, "mux");
  page.on("websocket", (socket) => {
    if (socket.url() === relayUrl || socket.url() === muxUrl) {
      sockets.push(socket);
    }
  });
  return sockets;
}

async function provisionHosts(
  page: Page,
  inputs: ProvisionInput[],
): Promise<void> {
  await page.evaluate(async (provisionInputs) => {
    localStorage.clear();
    sessionStorage.clear();
    const modulePath = "/src/lib/e2e/multiHostSessionProvisioning.ts";
    const { provisionRelayHostSession } = await import(
      /* @vite-ignore */ modulePath
    );
    // Saved-host order is part of the monitor contract. Authenticate
    // sequentially so handshake completion timing cannot reorder localStorage.
    for (const input of provisionInputs) {
      await provisionRelayHostSession(input);
    }
  }, inputs);
}

async function provisionHarnessHosts(
  page: Page,
  remoteClientURL: string,
  harness: MultiHostRelayHarness,
): Promise<void> {
  await page.goto(remoteClientURL);
  await provisionHosts(
    page,
    harness.hosts.map((host) => ({
      displayName: host.displayName,
      password: host.password,
      relayUrl: harness.relayUrl,
      username: host.username,
    })),
  );
  await harness.waitForWaitingHosts();
}

async function enrollRelayHostThroughUi(
  page: Page,
  host: MultiHostRelayHarness["hosts"][number],
  relayUrl: string,
): Promise<void> {
  await page.getByTestId("relay-mode-button").click();
  await expect(page.getByTestId("relay-login-form")).toBeVisible();
  await page.getByTestId("relay-username-input").fill(host.username);
  await page.getByTestId("srp-password-input").fill(host.password);
  await page.getByRole("button", { name: /advanced/i }).click();
  await page.getByTestId("custom-relay-url-input").fill(relayUrl);
  await page.getByTestId("login-button").click();
  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15_000 });
}

async function makeLastHostOffline(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storageModulePath = "/src/lib/hostStorage.ts";
    const { loadSavedHosts, saveHost } = await import(
      /* @vite-ignore */ storageModulePath
    );
    const hosts = loadSavedHosts().hosts;
    const host = hosts.at(-1);
    if (!host) throw new Error("No saved host to make offline");
    saveHost({
      ...host,
      relayUsername: `${host.relayUsername ?? "host"}-offline`,
    });
  });
}

async function makeLastHostSessionStale(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storageModulePath = "/src/lib/hostStorage.ts";
    const { loadSavedHosts, saveHost } = await import(
      /* @vite-ignore */ storageModulePath
    );
    const hosts = loadSavedHosts().hosts;
    const host = hosts.at(-1);
    if (!host?.session) throw new Error("No saved host session to invalidate");
    saveHost({
      ...host,
      session: {
        ...host.session,
        sessionId: `${host.session.sessionId}-stale`,
      },
    });
  });
}

async function runMonitorController(page: Page): Promise<MonitorResult> {
  return page.evaluate(async () => {
    const monitorModulePath = "/src/lib/multiHostMonitor.ts";
    const storageModulePath = "/src/lib/hostStorage.ts";
    const [{ MultiHostMonitorController }, { loadSavedHosts }] =
      await Promise.all([
        import(/* @vite-ignore */ monitorModulePath),
        import(/* @vite-ignore */ storageModulePath),
      ]);
    const controller = new MultiHostMonitorController(loadSavedHosts().hosts);
    controller.start();

    try {
      const snapshot = await new Promise<MonitorResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Multi-host controller did not reach 3/3 ready"));
        }, 30_000);
        const check = () => {
          const current = controller.getSnapshot() as MonitorResult;
          if (
            current.connectedCount === 3 ||
            current.hosts.some(
              (host) =>
                host.state === "offline" || host.state === "sign-in-required",
            )
          ) {
            clearTimeout(timeout);
            unsubscribe();
            resolve(current);
          }
        };
        const unsubscribe = controller.subscribe(check);
        check();
      });
      return snapshot;
    } finally {
      controller.dispose();
    }
  });
}

async function runSingleSourceDisposal(
  page: Page,
): Promise<SourceDisposalResult> {
  return page.evaluate(async () => {
    const monitorModulePath = "/src/lib/multiHostMonitor.ts";
    const runtimeModulePath = "/src/lib/sourceRuntime.ts";
    const sourceIdentityModulePath = "/src/lib/sourceIdentity.ts";
    const storageModulePath = "/src/lib/hostStorage.ts";
    const [
      { MultiHostMonitorController },
      { getSourceRuntimeRegistry },
      { resolveSourceKeyForSavedHost },
      { loadSavedHosts },
    ]: [
      typeof import("../src/lib/multiHostMonitor"),
      typeof import("../src/lib/sourceRuntime"),
      typeof import("../src/lib/sourceIdentity"),
      typeof import("../src/lib/hostStorage"),
    ] = await Promise.all([
      import(/* @vite-ignore */ monitorModulePath),
      import(/* @vite-ignore */ runtimeModulePath),
      import(/* @vite-ignore */ sourceIdentityModulePath),
      import(/* @vite-ignore */ storageModulePath),
    ]);
    const hosts = loadSavedHosts().hosts;
    const controller = new MultiHostMonitorController(hosts);
    controller.start();

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Multi-host controller did not reach 3/3 ready"));
        }, 30_000);
        const check = () => {
          if (controller.getSnapshot().connectedCount === 3) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = controller.subscribe(check);
        check();
      });

      const registry = getSourceRuntimeRegistry();
      const remainingRuntimes = hosts
        .slice(1)
        .map((host) =>
          registry.getOrCreateSourceRuntime(resolveSourceKeyForSavedHost(host)),
        );
      const removedHost = hosts[0];
      if (!removedHost) throw new Error("No source available to dispose");
      controller.deactivateHost(removedHost.id);

      const responses = await Promise.all(
        remainingRuntimes.map((runtime) =>
          runtime.transport.fetch<{
            sessions: Array<{
              customTitle?: string;
              fullTitle?: string;
              id: string;
              lastAgentText?: string;
              title?: string;
            }>;
          }>("/sessions?limit=1"),
        ),
      );
      const snapshot = controller.getSnapshot();
      return {
        connectedCount: snapshot.connectedCount,
        selectedCount: snapshot.selectedCount,
        titles: responses.map((response) => {
          const session = response.sessions[0];
          if (!session) return "";
          return (
            session.customTitle ??
            session.title ??
            session.fullTitle ??
            session.lastAgentText ??
            session.id
          );
        }),
      };
    } finally {
      controller.dispose();
    }
  });
}

let harness: MultiHostRelayHarness | null = null;

test.beforeAll(async ({ relayWsURL }) => {
  harness = await startMultiHostRelayHarness({
    relayUrl: relayWsURL,
    testRoot: e2ePaths.tempDir,
  });
});

test.afterAll(async () => {
  await harness?.stop();
});

test("separate host tabs retain scoped credentials through reconnect and restoration", async ({
  page,
  context,
  remoteClientURL,
  remotePreviewURL,
}) => {
  if (!harness) throw new Error("Multi-host harness did not start");
  const { projectId, sessionId, hosts } = harness;
  const [alpha, beta] = hosts;
  if (!alpha || !beta) throw new Error("Two hosts are required");
  await provisionHarnessHosts(page, remoteClientURL, harness);
  const fixtureCredentials = await page.evaluate(() =>
    localStorage.getItem("yep-anywhere-saved-hosts"),
  );
  await page.goto(remotePreviewURL);
  await page.evaluate((saved) => {
    localStorage.clear();
    sessionStorage.clear();
    if (saved) localStorage.setItem("yep-anywhere-saved-hosts", saved);
  }, fixtureCredentials);
  const routes = [alpha, beta].map(
    (host) =>
      `${remotePreviewURL}/-/relay/${host.username}/projects/${projectId}/sessions/${sessionId}`,
  );
  const sockets: import("@playwright/test").WebSocketRoute[] = [];
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  await page.routeWebSocket(harness.relayUrl, (socket) => {
    sockets.push(socket);
    socket.connectToServer();
  });
  const other = await context.newPage();
  try {
    await page.goto(routes[0]!);
    await expect(page.locator(".sidebar")).toBeVisible();
    const lifecycle =
      context.browser()?.browserType().name() === "chromium"
        ? await context.newCDPSession(page)
        : undefined;
    await lifecycle?.send("Page.setWebLifecycleState", { state: "frozen" });
    try {
      await other.goto(routes[1]!);
      await expect(other.locator(".sidebar")).toBeVisible();
    } finally {
      await lifecycle?.send("Page.setWebLifecycleState", { state: "active" });
      await lifecycle?.detach();
    }
    const composer = page.locator("textarea[data-composer-input]");
    const draft = "Draft for Alpha";
    await expect(composer).toBeVisible();
    await page.bringToFront();
    await composer.focus();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await composer.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      let started = 0;
      const samples: Array<{ ms: number; present: boolean }> = [];
      input.addEventListener("keydown", () => {
        started = performance.now();
      });
      input.addEventListener("input", () => {
        const expected = input.value;
        const begin = started;
        requestAnimationFrame(() => {
          samples.push({
            ms: performance.now() - begin,
            present: input.value.startsWith(expected),
          });
          input.dataset.typingSamples = JSON.stringify(samples);
        });
      });
    });
    const count = messages.filter((message) =>
      message.includes("Session resumed successfully"),
    ).length;
    await sockets
      .at(-1)!
      .close({ code: 1012, reason: "Cross-tab reconnect regression" });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await composer.pressSequentially(draft, { delay: 25 });
    await expect
      .poll(
        () =>
          messages.filter((message) =>
            message.includes("Session resumed successfully"),
          ).length,
      )
      .toBe(count + 1);
    await expect(composer).toHaveValue(draft);
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await composer.getAttribute("data-typing-samples")) ?? "[]",
          ).length,
      )
      .toBe(draft.length);
    const samples = JSON.parse(
      (await composer.getAttribute("data-typing-samples")) ?? "[]",
    ) as Array<{ ms: number; present: boolean }>;
    expect(
      samples.every((sample) => sample.present && sample.ms <= 100),
      JSON.stringify(samples),
    ).toBe(true);
    await expect(other.locator("textarea[data-composer-input]")).toBeEmpty();
    // This assertion fails on the original updater: Alpha's reconnect used
    // to attach its session to Beta's shared legacy connection record.
    const ownership = await other.evaluate(() => {
      const c = JSON.parse(
        localStorage.getItem("yep-anywhere-remote-credentials") ?? "{}",
      );
      return {
        destination: c.relayUsername,
        identity: c.username,
        sessionIdentity: c.session?.username,
      };
    });
    expect(ownership).toEqual({
      destination: beta.username,
      identity: beta.username,
      sessionIdentity: beta.username,
    });
    // Also exercise already-corrupted data left by an older cached client.
    await page.evaluate((alphaUsername) => {
      const hosts = JSON.parse(
        localStorage.getItem("yep-anywhere-saved-hosts") ?? "{}",
      ).hosts;
      const alphaHost = hosts.find(
        (h: { relayUsername: string }) => h.relayUsername === alphaUsername,
      );
      const legacy = JSON.parse(
        localStorage.getItem("yep-anywhere-remote-credentials") ?? "{}",
      );
      legacy.session = alphaHost.session;
      localStorage.setItem(
        "yep-anywhere-remote-credentials",
        JSON.stringify(legacy),
      );
    }, alpha.username);
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page).toHaveURL(routes[0]!);
    await other.reload();
    await expect(other.locator(".sidebar")).toBeVisible();
    await expect(other).toHaveURL(routes[1]!);
    for (const [tab, host] of [
      [page, alpha],
      [other, beta],
    ] as const) {
      await expect(tab.locator(".session-page")).toContainText(
        host.expectedFixtureText,
      );
      await expect(tab.getByTestId("relay-login-form")).toHaveCount(0);
    }
    await expect(composer).toHaveValue(draft);
    await expect(other.locator("textarea[data-composer-input]")).toBeEmpty();
    if (process.env.YEP_E2E_UI_CAPTURE_DIR) {
      for (const [name, viewport] of [
        ["desktop", { width: 1000, height: 600 }],
        ["phone", { width: 375, height: 812 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await expect(page.locator(".session-page")).toContainText(
          alpha.expectedFixtureText,
        );
        await recordUiCapture(page, `credential-restoration-${name}`, viewport);
      }
    }
  } finally {
    await other.close();
    await page.goto("about:blank");
  }
});

for (const transportMode of ["legacy", "mux"] as const) {
  test.describe(`Secure multi-host coexistence (${transportMode})`, () => {
    test.describe.configure({ mode: "serial", timeout: 60_000 });

    test.beforeAll(async () => {
      if (transportMode !== "mux" || !harness) return;
      const lastHost = harness.hosts.at(-1);
      if (!lastHost) throw new Error("Multi-host harness has no last host");
      if (
        lastHost.server.process.exitCode !== null ||
        lastHost.server.process.signalCode !== null
      ) {
        lastHost.server = await restartYaServerProcess(lastHost.server);
        await harness.waitForWaitingHosts();
      }
    });

    test("keeps three relay-backed source runtimes independent", async ({
      page,
      remoteClientURL,
    }, testInfo) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);
      if (transportMode === "mux") {
        const capabilities = await page.evaluate(
          async (healthUrl) => {
            const response = await fetch(healthUrl);
            const body = (await response.json()) as {
              relayCapabilities?: string[];
            };
            return body.relayCapabilities ?? [];
          },
          relaySiblingUrl(harness.relayUrl, "health"),
        );
        expect(capabilities).toContain("client-mux-v1");
      }

      const relaySockets = observeMonitorRelaySockets(page, harness.relayUrl);

      const result = await runMonitorController(page);
      if (result.connectedCount !== 3) {
        await testInfo.attach("multi-host-server-output", {
          body: harness.formatOutput(),
          contentType: "text/plain",
        });
      }

      expect(result).toMatchObject({
        connectedCount: 3,
        selectedCount: 3,
      });
      const relayUrl = harness.relayUrl;
      expect(relaySockets.map((socket) => socket.url())).toEqual(
        transportMode === "mux"
          ? [relaySiblingUrl(harness.relayUrl, "mux")]
          : Array.from({ length: 3 }, () => relayUrl),
      );
      expect(relaySockets).toHaveLength(transportMode === "mux" ? 1 : 3);
      expect(result.hosts.map((host) => host.state)).toEqual([
        "connected",
        "connected",
        "connected",
      ]);
      expect(result.hosts.map((host) => host.summary?.sessions[0]?.id)).toEqual(
        [harness.sessionId, harness.sessionId, harness.sessionId],
      );
      expect(
        result.hosts.map((host) => host.summary?.sessions[0]?.title),
      ).toEqual(harness.hosts.map((host) => host.expectedFixtureText));
    });

    test("enrolls three saved hosts through the visible login flow", async ({
      page,
      remoteClientURL,
    }) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await page.goto(remoteClientURL);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.reload();

      for (const host of harness.hosts) {
        await enrollRelayHostThroughUi(page, host, harness.relayUrl);
        await page.locator(".sidebar-switch-host").click();
        await expect(page.getByTestId("saved-hosts-list")).toBeVisible();
        await harness.waitForWaitingHosts();
      }

      await expect(page.locator("[data-saved-host]")).toHaveCount(3);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);
      await page.goto(`${remoteClientURL}/-/monitor`);
      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 3 of 3",
        { timeout: 30_000 },
      );
      for (const host of harness.hosts) {
        await expect(page.getByTestId("multi-host-monitor")).toContainText(
          host.expectedFixtureText,
        );
      }
    });

    test("renders three hosts and closes every stream on navigation", async ({
      page,
      remoteClientURL,
    }, testInfo) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);

      const relaySockets = observeMonitorRelaySockets(page, harness.relayUrl);

      await page.goto(`${remoteClientURL}/-/monitor`);
      try {
        await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
          "Connected 3 of 3",
          { timeout: 30_000 },
        );
      } catch (error) {
        await testInfo.attach("multi-host-server-output", {
          body: harness.formatOutput(),
          contentType: "text/plain",
        });
        throw error;
      }

      await expect
        .poll(() => relaySockets.length, { timeout: 10_000 })
        .toBe(transportMode === "mux" ? 1 : 3);
      for (const host of harness.hosts) {
        const card = page.locator(`[data-host-name="${host.displayName}"]`);
        await expect(card).toHaveAttribute("data-host-state", "connected");
        await expect(card).toContainText(host.expectedFixtureText);
      }

      if (process.env.YEP_E2E_UI_CAPTURE_DIR && transportMode === "mux") {
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          for (const viewport of [
            { width: 1000, height: 600 },
            { width: 375, height: 812 },
          ]) {
            await page.setViewportSize(viewport);
            await recordUiCapture(
              page,
              `multi-host-monitor-${theme}-${viewport.width}`,
              viewport,
            );
          }
        }
      }

      const closedSockets = relaySockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.on("close", () => resolve());
          }),
      );
      await page.goto(`${remoteClientURL}/login`);
      await Promise.all(closedSockets);
      await harness.waitForWaitingHosts();
    });

    test("keeps healthy hosts visible when one relay target is offline", async ({
      page,
      remoteClientURL,
    }) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await makeLastHostOffline(page);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);

      await page.goto(`${remoteClientURL}/-/monitor`);
      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 2 of 3",
        { timeout: 30_000 },
      );

      const offlineCard = page.locator(
        `[data-host-name="${harness.hosts.at(-1)?.displayName ?? ""}"]`,
      );
      await expect(offlineCard).toHaveAttribute("data-host-state", "offline");
      await expect(
        offlineCard.getByRole("button", { name: "Retry" }),
      ).toBeVisible();
      for (const host of harness.hosts.slice(0, 2)) {
        const card = page.locator(`[data-host-name="${host.displayName}"]`);
        await expect(card).toHaveAttribute("data-host-state", "connected");
        await expect(card).toContainText(host.expectedFixtureText);
      }
    });

    test("disposes one runtime while the others keep serving requests", async ({
      page,
      remoteClientURL,
    }) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);

      const result = await runSingleSourceDisposal(page);

      expect(result).toEqual({
        connectedCount: 2,
        selectedCount: 2,
        titles: harness.hosts.slice(1).map((host) => host.expectedFixtureText),
      });
    });

    test("isolates a stale resume session as sign-in required", async ({
      page,
      remoteClientURL,
    }) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await makeLastHostSessionStale(page);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);

      await page.goto(`${remoteClientURL}/-/monitor`);
      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 2 of 3",
        { timeout: 30_000 },
      );

      const staleCard = page.locator(
        `[data-host-name="${harness.hosts.at(-1)?.displayName ?? ""}"]`,
      );
      await expect(staleCard).toHaveAttribute(
        "data-host-state",
        "sign-in-required",
      );
      await expect(
        staleCard.getByRole("link", { name: "Sign in" }),
      ).toBeVisible();
      for (const host of harness.hosts.slice(0, 2)) {
        await expect(
          page.locator(`[data-host-name="${host.displayName}"]`),
        ).toHaveAttribute("data-host-state", "connected");
      }
    });

    test("keeps healthy rows live when a connected server disconnects", async ({
      page,
      remoteClientURL,
    }) => {
      if (!harness) throw new Error("Multi-host harness did not start");
      await provisionHarnessHosts(page, remoteClientURL, harness);
      await configureMonitorTransport(page, harness.relayUrl, transportMode);
      await page.goto(`${remoteClientURL}/-/monitor`);
      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 3 of 3",
        { timeout: 30_000 },
      );

      const disconnectedHost = harness.hosts.at(-1);
      if (!disconnectedHost) throw new Error("No host available to disconnect");
      await terminateYaServerProcess(disconnectedHost.server);

      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 2 of 3",
        { timeout: 30_000 },
      );
      await expect(
        page.locator(`[data-host-name="${disconnectedHost.displayName}"]`),
      ).toHaveAttribute("data-host-state", /^(connecting|offline)$/);
      for (const host of harness.hosts.slice(0, 2)) {
        const card = page.locator(`[data-host-name="${host.displayName}"]`);
        await expect(card).toHaveAttribute("data-host-state", "connected");
        await expect(card).toContainText(host.expectedFixtureText);
      }
    });
  });
}
