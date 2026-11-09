import type {
  AgentAuthRouterOverview,
  NewSessionDefaults,
  ProviderInfo,
} from "@yep-anywhere/shared";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block", draftSessionIds: [] });

// Real settings HTTP/disk and browser reloads; catalogs are bounded offline
// fixtures. Component tests own the restoration and eligibility variants.
test("remembers speed and router choices across clients while discovery preserves typing", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(30_000);
  const headers = { "X-Yep-Anywhere": "true" };
  const original = await (
    await page.request.get(`${baseURL}/api/settings`, { headers })
  ).json();
  const model = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    supportsEffort: true,
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster processing" },
    ],
  };
  const provider: ProviderInfo = {
    name: "codex",
    displayName: "Codex",
    installed: true,
    authenticated: true,
    enabled: true,
    models: [model],
  };
  const overview: AgentAuthRouterOverview = {
    serviceTierSelection: true,
    observedAt: new Date().toISOString(),
    quotaFreshSeconds: 120,
    supportedPolicies: ["manual", "round-robin", "weekly-pace"],
    policies: [
      { id: "manual", label: "Manual" },
      { id: "round-robin", label: "Round robin" },
      { id: "weekly-pace", label: "Weekly pace" },
    ],
    pools: [
      {
        id: "work",
        name: "Work",
        provider: "codex",
        accountIds: Array.from({ length: 48 }, (_, i) => `account-${i}`),
        policy: "round-robin",
        revision: 1,
        bindings: [],
      },
    ],
    accounts: Array.from({ length: 48 }, (_, i) => ({
      id: `account-${i}`,
      displayName: `Coding ${i}`,
      provider: "codex",
      enabled: true,
      renewal: "manual",
      freshness: "fresh",
      models: [model],
      catalogAt: new Date().toISOString(),
      attemptedAt: null,
      error: null,
      quota: null,
      windows: [],
    })),
  };
  let legacyParser = false;
  let discoveries = 0;
  async function configure(target: typeof context) {
    await target.route(
      /\/api\/providers(?:\/(?:codex|descriptors))?(?:\?.*)?$/,
      (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({
          json: path.endsWith("/codex")
            ? { provider }
            : { providers: [provider] },
        });
      },
    );
    await target.route("**/api/version", (route) =>
      route.fulfill({
        json: {
          current: "0.11.1",
          capabilities: ["agent-auth-router"],
        },
      }),
    );
    await target.route("**/api/agent-auth-router/selection", async (route) => {
      discoveries++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({ json: overview });
    });
    await target.route("**/api/settings", async (route) => {
      if (!legacyParser || route.request().method() !== "PUT")
        return route.continue();
      const body = route.request().postDataJSON();
      for (const defaults of Object.values(
        body.newSessionDefaults?.providers ?? {},
      ) as Record<string, unknown>[]) {
        delete defaults.routerPoolId;
        delete defaults.routerAccountId;
        delete defaults.routerPolicy;
      }
      const response = await route.fetch({ postData: JSON.stringify(body) });
      await route.fulfill({ response });
    });
  }
  const readDefaults = async (): Promise<NewSessionDefaults> =>
    (
      await (
        await page.request.get(`${baseURL}/api/settings`, { headers })
      ).json()
    ).settings.newSessionDefaults;
  const pool = () =>
    page.getByRole("button", { name: "Filter by Pool", exact: true });
  const account = () =>
    page.getByRole("button", { name: "Filter by Router account", exact: true });
  const speed = () =>
    page.getByRole("button", { name: "Filter by Speed", exact: true });
  async function pick(label: string, value: RegExp) {
    await page
      .getByRole("button", { name: `Filter by ${label}`, exact: true })
      .click();
    await page
      .getByRole("menu", { name: `Filter by ${label}` })
      .getByRole("menuitemradio", { name: value })
      .click();
  }
  const other = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 375, height: 812 },
  });
  try {
    await page.request.put(`${baseURL}/api/settings`, {
      headers,
      data: {
        newSessionDefaults: {
          provider: "codex",
          providers: { codex: { model: model.id } },
        },
      },
    });
    await configure(context);
    await configure(other);
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${baseURL}/new-session?detached=1`);
    await page
      .getByRole("button", { name: "Show advanced options", exact: true })
      .click();
    await expect(speed()).toContainText("Standard");
    await pick("Speed", /^Fast/);
    await expect
      .poll(async () => (await readDefaults()).providers?.codex?.serviceTier)
      .toBe("priority");
    await pick("Pool", /^Work/);
    await expect(speed()).toContainText("Fast");
    await pick("Router account", /^Weekly pace/);
    await expect
      .poll(async () => (await readDefaults()).providers?.codex?.routerPolicy)
      .toBe("weekly-pace");
    await page.reload();
    await expect(pool()).toContainText("Work");
    await expect(account()).toContainText("Weekly pace");

    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.clear();
    await composer.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      const samples: { latency: number; retained: boolean }[] = [];
      Object.assign(window, { defaultsTyping: samples });
      field.addEventListener("input", () => {
        const start = performance.now(),
          expected = field.value;
        requestAnimationFrame(() =>
          samples.push({
            latency: performance.now() - start,
            retained: field.value.startsWith(expected),
          }),
        );
      });
    });
    const pendingRefreshes = new Set<Promise<unknown>>();
    const initialDiscoveries = discoveries;
    const refreshes = setInterval(() => {
      const refresh = page.evaluate(() =>
        window.dispatchEvent(new Event("router-connection-changed")),
      );
      pendingRefreshes.add(refresh);
      void refresh.finally(() => pendingRefreshes.delete(refresh));
    }, 50);
    const prompt = "Remember these defaults while router catalogs refresh.";
    try {
      await composer.pressSequentially(prompt, { delay: 20 });
    } finally {
      clearInterval(refreshes);
      await Promise.all(pendingRefreshes);
    }
    await expect(composer).toHaveValue(prompt);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { defaultsTyping: unknown[] }).defaultsTyping
              .length,
        ),
      )
      .toBe(prompt.length);
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            defaultsTyping: { latency: number; retained: boolean }[];
          }
        ).defaultsTyping,
    );
    expect(
      samples.every((sample) => sample.retained && sample.latency < 100),
    ).toBe(true);
    expect(discoveries - initialDiscoveries).toBeGreaterThan(2);
    console.log(
      `New Session typing during 48-account discovery: ${samples.length} keys, maximum ${Math.max(...samples.map((sample) => sample.latency)).toFixed(1)} ms`,
    );
    await speed().scrollIntoViewIfNeeded();
    await recordUiCapture(page, "remembered-router-1000");

    const phone = await other.newPage();
    await phone.goto(`${baseURL}/new-session?detached=1`);
    await phone
      .getByRole("button", { name: "Show advanced options", exact: true })
      .click();
    await expect(
      phone.getByRole("button", { name: "Filter by Pool", exact: true }),
    ).toContainText("Work");
    await expect(
      phone.getByRole("button", {
        name: "Filter by Router account",
        exact: true,
      }),
    ).toContainText("Weekly pace");
    await phone
      .getByRole("button", { name: "Filter by Speed", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(phone, "remembered-router-375");

    await pick("Pool", /^Direct provider login/);
    await expect
      .poll(async () => (await readDefaults()).providers?.codex?.routerPoolId)
      .toBeUndefined();
    await expect(speed()).toContainText("Fast");
    await pick("Speed", /^Standard/);
    await expect
      .poll(async () => (await readDefaults()).providers?.codex?.serviceTier)
      .toBeUndefined();
    await page.reload();
    await expect(pool()).toContainText("Direct provider login");
    await expect(speed()).toContainText("Standard");

    // An older pool-capable source accepts the request but drops routing
    // defaults. Its accepted settings must not undo the current form pick.
    legacyParser = true;
    const acceptedLegacySave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/settings" &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await pick("Pool", /^Work/);
    await acceptedLegacySave;
    await expect
      .poll(async () => (await readDefaults()).providers?.codex?.routerPoolId)
      .toBeUndefined();
    await expect(pool()).toContainText("Work");
    await page.reload();
    await expect(pool()).toContainText("Direct provider login");
  } finally {
    await other.close();
    await page.request.put(`${baseURL}/api/settings`, {
      headers,
      data: {
        newSessionDefaults: original.settings.newSessionDefaults ?? null,
      },
    });
  }
});
