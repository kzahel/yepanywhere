// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { IssueSettings } from "../IssueSettings";

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  githubControls: false,
}));
const runtime = { sourceKey: "localhost", transport: { fetch: state.fetch } };
vi.mock("../../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => runtime,
}));
vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      current: "0.9.0",
      capabilities: [
        "issue-session-associations-v1",
        ...(state.githubControls ? ["github-status-controls"] : []),
      ],
    },
  }),
}));
vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({ settings: {}, refetch: async () => {} }),
}));
vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: () => {},
}));

const CREDENTIALS = {
  credentials: [
    {
      provider: "github",
      sources: [
        { name: "Key stored in Settings", kind: "stored", present: false },
        { name: "YEP_GITHUB_TOKEN", kind: "env", present: false },
        { name: "GITHUB_TOKEN", kind: "env", present: true },
        { name: "GH_TOKEN", kind: "env", present: false },
        { name: "gh auth token", kind: "cli", present: true },
      ],
      active: "GITHUB_TOKEN",
    },
    {
      provider: "jira",
      sources: [
        { name: "Key stored in Settings", kind: "stored", present: false },
        { name: "JIRA_API_TOKEN", kind: "env", present: false },
      ],
      active: null,
    },
  ],
};

function coverage(settings: Record<string, unknown>) {
  return {
    settings: {
      enabled: true,
      scope: "viewed",
      recentDays: 7,
      ...settings,
    },
    active: false,
    error: null,
    counts: [],
    knownJiraProjects: [{ prefix: "TF", site: "https://tomfit.atlassian.net" }],
  };
}

async function renderPane(settings: Record<string, unknown> = {}) {
  state.fetch.mockImplementation(async (path: unknown) =>
    String(path).startsWith("/issues/credentials")
      ? CREDENTIALS
      : coverage(settings),
  );
  render(
    <I18nProvider>
      <MemoryRouter>
        <IssueSettings />
      </MemoryRouter>
    </I18nProvider>,
  );
  // The scope select renders before the settings fetch resolves, disabled;
  // the confirmation and blocklist controls appear only once it has. Wait
  // for the load itself so a slow runner cannot query ahead of it.
  const scope =
    await screen.findByLabelText<HTMLSelectElement>("Indexing scope");
  await waitFor(() => expect(scope.disabled).toBe(false));
}

describe("IssueSettings tracker confirmation", () => {
  beforeEach(() => {
    state.fetch.mockReset();
    state.githubControls = false;
  });
  afterEach(cleanup);

  it("gates new credential policy controls and sends no unsupported fields to an old server", async () => {
    await renderPane();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen.queryByLabelText("Check GitHub issue and PR status"),
    ).toBeNull();
    expect(screen.queryByLabelText("Allow GitHub CLI credentials")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear cached status" }),
    ).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByLabelText("Match unknown ticket keys")),
    );
    const body = JSON.parse(
      state.fetch.mock.calls.find((call) => call[1]?.method === "PUT")![1].body,
    );
    expect(body).not.toHaveProperty("githubCli");
    expect(body).not.toHaveProperty("githubStatusEnabled");
  });

  it("shows independent lifetime defaults and saves only after a slider gesture commits", async () => {
    await renderPane({
      contentTtlSeconds: 1209600,
      statusCommentTtlSeconds: 300,
    });
    state.fetch.mockImplementation(async (_path, init) =>
      coverage(JSON.parse(init.body)),
    );
    const content = screen.getByRole<HTMLInputElement>("slider", {
      name: "Subject & body cache lifetime",
    });
    const activity = screen.getByRole<HTMLInputElement>("slider", {
      name: "Status & comments cache lifetime",
    });
    expect(content.getAttribute("aria-valuetext")).toBe("2 weeks");
    expect(activity.getAttribute("aria-valuetext")).toBe("5 minutes");
    fireEvent.change(content, { target: { value: "0" } });
    expect(content.getAttribute("aria-valuetext")).toBe("1 second");
    expect(
      state.fetch.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toHaveLength(0);
    await act(async () => fireEvent.pointerUp(content));
    expect(JSON.parse(state.fetch.mock.lastCall![1].body)).toMatchObject({
      contentTtlSeconds: 1,
      statusCommentTtlSeconds: 300,
    });
    fireEvent.change(activity, { target: { value: activity.max } });
    await act(async () => fireEvent.keyUp(activity, { key: "End" }));
    expect(JSON.parse(state.fetch.mock.lastCall![1].body)).toMatchObject({
      contentTtlSeconds: 1,
      statusCommentTtlSeconds: null,
    });
    expect(activity.getAttribute("aria-valuetext")).toBe("Never expire (∞)");
  });

  it("lets GitHub status use credentials independently of tracker confirmation", async () => {
    state.githubControls = true;
    await renderPane({
      githubStatusEnabled: true,
      githubCli: { enabled: false, account: "" },
    });
    const toggle = await screen.findByLabelText<HTMLInputElement>(
      "Allow GitHub CLI credentials",
    );
    expect(toggle.checked).toBe(false);
    await screen.findByText("Using GITHUB_TOKEN.");
    expect(
      screen.getByRole<HTMLInputElement>("switch", {
        name: /Confirm new references/,
      }).checked,
    ).toBe(false);
    await act(async () => fireEvent.click(toggle));
    expect(state.fetch).toHaveBeenCalledWith(
      "/issues/settings",
      expect.objectContaining({
        body: expect.stringContaining(
          '"githubCli":{"enabled":true,"account":""}',
        ),
      }),
    );
  });

  it("requires known projects by default and exposes aggressive matching as an explicit setting", async () => {
    await renderPane();
    const toggle = await screen.findByLabelText<HTMLInputElement>(
      "Match unknown ticket keys",
    );
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("TF")).toBeTruthy();
    expect(screen.getByText(/tomfit.atlassian.net/)).toBeTruthy();
    await act(async () => fireEvent.click(toggle));
    expect(state.fetch).toHaveBeenCalledWith(
      "/issues/settings",
      expect.objectContaining({
        body: expect.stringContaining('"aggressiveMatching":true'),
      }),
    );
  });

  it("keeps confirmation off and its credentials hidden until opted in", async () => {
    await renderPane();
    const toggle = screen.getByRole<HTMLInputElement>("switch", {
      name: /Confirm new references with the tracker/,
    });
    expect(toggle.checked).toBe(false);
    expect(screen.queryByText("GITHUB_TOKEN")).toBeNull();
    expect(
      state.fetch.mock.calls.some((call) =>
        String(call[0]).includes("/issues/credentials"),
      ),
    ).toBe(false);

    await act(async () => fireEvent.click(toggle));
    expect(state.fetch).toHaveBeenCalledWith(
      "/issues/settings",
      expect.objectContaining({
        body: expect.stringContaining('"confirmation":{"enabled":true'),
      }),
    );
  });

  it("names every credential source and whether it is present, never a key", async () => {
    await renderPane({
      confirmation: {
        enabled: true,
        jiraSite: "https://example.atlassian.net",
        jiraEmail: "someone@example.com",
      },
    });
    const github = await screen.findByRole("group", {
      name: "GitHub credential",
    });
    expect(github.textContent).toContain("Using GITHUB_TOKEN.");
    expect(github.textContent).toContain("YEP_GITHUB_TOKEN: not set");
    expect(github.textContent).toContain("GITHUB_TOKEN: present");
    expect(github.textContent).toContain("gh auth token: present");
    const jira = screen.getByRole("group", { name: "Jira credential" });
    expect(jira.textContent).toContain(
      "No credential found. Tracker lookups are unavailable.",
    );
  });

  it("stores an override key through a password field and never echoes it", async () => {
    await renderPane({
      confirmation: {
        enabled: true,
        jiraSite: "https://example.atlassian.net",
        jiraEmail: "someone@example.com",
      },
    });
    const input = await screen.findByLabelText<HTMLInputElement>(
      "Jira credential: Key (overrides the environment)",
    );
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    expect(input.getAttribute("data-lpignore")).toBe("true");
    fireEvent.change(input, { target: { value: " secret-token " } });
    await act(async () =>
      fireEvent.click(
        screen.getAllByRole("button", { name: "Save key" })[1] as HTMLElement,
      ),
    );
    expect(state.fetch).toHaveBeenCalledWith("/issues/credentials", {
      method: "PUT",
      body: JSON.stringify({ provider: "jira", key: "secret-token" }),
    });
    // The field clears once the save answers, not when it is sent.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("edits the blocked project names and rejects an unusable entry", async () => {
    await renderPane();
    const input = await screen.findByLabelText<HTMLInputElement>(
      "Ignore these Jira project names without a URL",
    );
    expect(input.value).toContain("UTF");
    expect(input.value).toContain("COVID");

    await act(async () =>
      fireEvent.blur(input, { target: { value: "utf iso, gpt" } }),
    );
    expect(state.fetch).toHaveBeenCalledWith(
      "/issues/settings",
      expect.objectContaining({
        body: expect.stringContaining('"jiraKeyBlocklist":["UTF","ISO","GPT"]'),
      }),
    );

    state.fetch.mockClear();
    await act(async () =>
      fireEvent.blur(input, { target: { value: "not a key!" } }),
    );
    expect(
      state.fetch.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toEqual([]);
  });
});
