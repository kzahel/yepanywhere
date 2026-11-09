import type { ProviderInfo } from "@yep-anywhere/shared";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block", draftSessionIds: [] });

// Plan 180 slice 0: the real form's saved defaults and durable start request
// with the options changed, pinned before the option state, options panel
// and start path move out of NewSessionForm. Real settings HTTP and disk;
// the catalogs and the creation reply are routed. Sandbox support reaches
// this page over the socket, so the sandbox transition is pinned by the
// component tests instead.
test("saves a provider switch and starts with the options off their defaults", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(45_000);
  const headers = { "X-Yep-Anywhere": "true" };
  const original = await (
    await page.request.get(`${baseURL}/api/settings`, { headers })
  ).json();
  const model = (id: string, name: string) => ({
    id,
    name,
    supportsEffort: true,
    supportsAdaptiveThinking: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster processing" },
    ],
  });
  const providers = [
    {
      name: "claude",
      displayName: "Claude",
      installed: true,
      authenticated: true,
      enabled: true,
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsRecaps: true,
      supportsNativeRecaps: true,
      supportsNativePromptSuggestions: true,
      models: [model("opus", "Opus")],
    },
    {
      name: "codex",
      displayName: "Codex",
      installed: true,
      authenticated: true,
      enabled: true,
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsRecaps: true,
      models: [model("gpt-6", "GPT-6")],
    },
  ] as unknown as ProviderInfo[];
  await page.route(
    /\/api\/providers(?:\/(?:claude|codex|descriptors))?(?:\?.*)?$/,
    (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();
      const row = providers.find((provider) => provider.name === name);
      return route.fulfill({
        json: row ? { provider: row } : { providers },
      });
    },
  );
  const starts: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(
    /\/api\/(?:projects\/[^/]+\/)?(?:session-creations|sessions)(?:\/create)?$/,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      starts.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      await route.fulfill({ status: 503, json: { error: "pinned start" } });
    },
  );
  const readDefaults = async () =>
    (
      await (
        await page.request.get(`${baseURL}/api/settings`, { headers })
      ).json()
    ).settings.newSessionDefaults;
  async function pick(label: string, value: RegExp) {
    await page
      .getByRole("button", { name: `Filter by ${label}`, exact: true })
      .click();
    await page
      .getByRole("menu", { name: `Filter by ${label}` })
      .getByRole("menuitemradio", { name: value })
      .click();
  }

  try {
    const seeded = await page.request.put(`${baseURL}/api/settings`, {
      headers,
      data: {
        newSessionDefaults: {
          provider: "claude",
          permissionMode: "default",
          recapMode: "side-session",
          providers: {
            claude: { model: "opus", thinkingMode: "off" },
            codex: { model: "gpt-6", thinkingMode: "auto" },
          },
        },
      },
    });
    expect(seeded.ok()).toBe(true);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`${baseURL}/new-session?detached=1`);
    await page
      .getByRole("button", { name: "Show advanced options", exact: true })
      .click();

    // A provider switch restores that provider's own defaults, leaves the
    // all-provider ones alone, and saves.
    await pick("AI Provider", /^Codex/);
    await expect
      .poll(async () => (await readDefaults()).provider)
      .toBe("codex");
    expect(await readDefaults()).toMatchObject({
      provider: "codex",
      permissionMode: "default",
      recapMode: "side-session",
      providers: {
        claude: { model: "opus", thinkingMode: "off" },
        codex: { model: "gpt-6", thinkingMode: "auto" },
      },
    });
    await expect(
      page.getByRole("button", { name: "Filter by Thinking", exact: true }),
    ).toContainText("Auto");
    await pick("AI Provider", /^Claude/);
    await expect
      .poll(async () => (await readDefaults()).provider)
      .toBe("claude");

    await pick("Permission Mode", /^Plan/);
    await pick("Thinking", /^Low/);
    await pick("Speed", /^Fast/);
    await pick("Recaps", /^Forked/);
    await pick("Suggestions", /^Native/);
    await expect
      .poll(async () => (await readDefaults()).promptSuggestionMode)
      .toBe("native");
    expect(await readDefaults()).toMatchObject({
      provider: "claude",
      permissionMode: "plan",
      recapMode: "fork",
      promptSuggestionMode: "native",
      providers: {
        claude: {
          model: "opus",
          serviceTier: "priority",
          thinkingMode: "on",
          effortLevel: "low",
        },
        codex: { model: "gpt-6", thinkingMode: "auto" },
      },
    });

    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially("Pinned option start");
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect.poll(() => starts.length).toBe(1);
    const { path, body } = starts[0]!;
    expect(path).toBe("/api/session-creations");
    expect({
      message: body.message,
      provider: body.provider,
      model: body.model,
      mode: body.mode,
      thinking: body.thinking,
      serviceTier: body.serviceTier,
      recapMode: body.recapMode,
      recapAfterSeconds: body.recapAfterSeconds,
      promptSuggestionMode: body.promptSuggestionMode,
      helperSideModel: body.helperSideModel,
    }).toEqual({
      message: "Pinned option start",
      provider: "claude",
      model: "opus",
      mode: "plan",
      thinking: "on:low",
      serviceTier: "priority",
      recapMode: "fork",
      recapAfterSeconds: 300,
      promptSuggestionMode: "native",
      helperSideModel: "cheapest",
    });
    // The durable path's transport error carries the server's message, so
    // the start failure toast shows it as sent.
    await expect(page.getByRole("alert")).toHaveText("pinned start");
  } finally {
    const restored = await page.request.put(`${baseURL}/api/settings`, {
      headers,
      data: {
        newSessionDefaults: original.settings.newSessionDefaults ?? null,
      },
    });
    expect(restored.ok()).toBe(true);
  }
});
