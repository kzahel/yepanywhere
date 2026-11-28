// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ContextBreakdown } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ContextThresholdQuickEdit } from "../ContextThresholdQuickEdit";

const refresh = vi.fn();
const updateSetting = vi.fn(async () => undefined);
const serverVersion = vi.hoisted(() => ({ current: "0.9.2" }));
const getSessionContextBreakdown = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: { current: serverVersion.current } }),
}));

vi.mock("../../api/client", () => ({
  api: { getSessionContextBreakdown },
}));

const BREAKDOWN: ContextBreakdown = {
  model: "claude-sonnet-5",
  totalTokens: 69_700,
  maxTokens: 1_000_000,
  autoCompactAtTokens: 967_000,
  categories: [
    { key: "systemTools", name: "System tools", tokens: 24_100, kind: "used" },
    {
      key: "memoryFiles",
      name: "Memory files",
      tokens: 25_300,
      kind: "used",
      items: [
        { label: "~/.claude/CLAUDE.md", detail: "User", tokens: 24_700 },
        { label: "~/agents/CLAUDE.local.md", detail: "Local", tokens: 600 },
      ],
    },
    {
      key: "messages",
      name: "Messages",
      tokens: 9_500,
      kind: "used",
      messageParts: {
        toolCallTokens: 2_000,
        toolResultTokens: 5_200,
        assistantTextTokens: 1_500,
        userTextTokens: 300,
      },
    },
    { key: "other", name: "Brand new row", tokens: 800, kind: "used" },
    { key: "free", name: "Free space", tokens: 930_300, kind: "free" },
  ],
};

function renderClaudeSession() {
  render(
    <I18nProvider>
      <ContextThresholdQuickEdit
        provider="claude"
        model="fable"
        sessionId="session-1"
        usage={{
          inputTokens: 69_700,
          contextWindow: 1_000_000,
          percentage: 7,
          cacheReadTokens: 68_900,
        }}
      />
    </I18nProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Subscription usage 100% used/ }),
  );
}

const subscriptionUsageMock = vi.hoisted(() => ({
  current: {
    provider: "claude" as const,
    fetchedAt: "2026-07-29T00:00:00.000Z",
    windows: [
      {
        id: "weekly",
        usedPercent: 72,
        windowDurationMinutes: 10_080,
        scope: { type: "provider" as const },
      },
      {
        id: "fable",
        usedPercent: 100,
        windowDurationMinutes: 10_080,
        scope: {
          type: "models" as const,
          modelIds: ["fable"],
          label: "Fable",
        },
      },
    ],
  } as {
    provider: "claude";
    fetchedAt: string;
    windows: Array<{
      id: string;
      usedPercent: number;
      windowDurationMinutes: number;
      scope:
        | { type: "provider" }
        | { type: "models"; modelIds: string[]; label: string };
    }>;
  } | null,
}));
const defaultSubscriptionUsage = subscriptionUsageMock.current;

vi.mock("../../hooks/useProviderSubscriptionUsage", () => ({
  useProviderSubscriptionUsage: () => ({
    usage: subscriptionUsageMock.current,
    loading: false,
    supported: true,
    refresh,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { clientDefaults: { compactAtContextPercent: {} } },
    updateSetting,
  }),
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({
    providers: [
      { name: "claude", supportsNativeCompactThreshold: false },
      { name: "codex", supportsNativeCompactThreshold: true },
    ],
  }),
}));

describe("ContextThresholdQuickEdit", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    serverVersion.current = "0.9.2";
    subscriptionUsageMock.current = defaultSubscriptionUsage;
  });

  it("asks an older server for no breakdown", () => {
    renderClaudeSession();

    expect(screen.getByRole("dialog").textContent).not.toContain(
      "Context window",
    );
    expect(getSessionContextBreakdown).not.toHaveBeenCalled();
  });

  it("shows what fills the window, with expandable rows", async () => {
    serverVersion.current = "0.9.4";
    getSessionContextBreakdown.mockResolvedValue({ breakdown: BREAKDOWN });
    renderClaudeSession();

    await screen.findByText("Instruction files");
    expect(getSessionContextBreakdown).toHaveBeenCalledWith("session-1");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Tool definitions");
    expect(dialog.textContent).toContain("Brand new row");
    expect(dialog.textContent).toContain("Autocompacts at 967.0K");
    expect(dialog.textContent).not.toContain("~/.claude/CLAUDE.md");

    fireEvent.click(screen.getByRole("button", { name: /Instruction files/ }));
    expect(dialog.textContent).toContain("~/.claude/CLAUDE.md");
    expect(dialog.textContent).toContain("24.7K");

    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    expect(dialog.textContent).toContain("Tool results");
    expect(dialog.textContent).toContain("5.2K");
    // The existing last-turn rows remain below the breakdown.
    expect(dialog.textContent).toContain("Read from cache");
  });

  it("renders nothing for a session without a live breakdown", async () => {
    serverVersion.current = "0.9.4";
    getSessionContextBreakdown.mockResolvedValue({ breakdown: null });
    renderClaudeSession();

    await waitFor(() =>
      expect(getSessionContextBreakdown).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).not.toContain(
        "Counting context",
      ),
    );
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "Context window",
    );
  });

  it("reports a provider failure inside the section", async () => {
    serverVersion.current = "0.9.4";
    getSessionContextBreakdown.mockRejectedValue(
      new Error("token count unavailable"),
    );
    renderClaudeSession();

    await screen.findByText("Breakdown unavailable: token count unavailable");
  });

  it("opens applicable subscription windows on left click", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Subscription usage 100% used/,
      }),
    );

    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.getByText("Fable · 7d window")).toBeTruthy();
  });

  it("shows provider-reported cache accounting for the last turn", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 104_966,
            contextWindow: 1_000_000,
            percentage: 10,
            outputTokens: 333,
            cacheReadTokens: 103_341,
            cacheCreationTokens: 1_623,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Context 10%/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Read from cache");
    expect(dialog.textContent).toContain("103,341");
    expect(dialog.textContent).toContain("Written to cache");
    expect(dialog.textContent).toContain("1,623");
    expect(dialog.textContent).toContain("104,966");
  });

  it("shows context total without cache rows or hint when only input tokens are reported", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Subscription usage 100% used/ }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("50,000 / 1,000,000 (5%)");
    expect(dialog.textContent).not.toContain("Read from cache");
    expect(dialog.textContent).not.toContain("Cached reads bill");
  });

  it("opens the context usage popover when quota and cache counts are both absent", () => {
    subscriptionUsageMock.current = null;
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="antigravity"
          model="gemini-4-neon"
          usage={{
            inputTokens: 429_270,
            contextWindow: 1_048_576,
            percentage: 41,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Context 41%/ }));

    const dialog = screen.getByRole("dialog", {
      name: "Token usage (last turn)",
    });
    expect(dialog.textContent).toContain("429,270 / 1,048,576 (41%)");
    expect(dialog.textContent).not.toContain("Read from cache");
    expect(dialog.textContent).not.toContain("Cached reads bill");
  });

  it("preserves right-click access to compact threshold editing", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", {
        name: /Subscription usage 100% used/,
      }),
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      "Compact context early",
    );
  });

  it("keeps subscription dialog controls keyboard-operable", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );
    const trigger = screen.getByRole("button", {
      name: /Subscription usage 100% used/,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const refreshButton = screen.getByRole("button", {
      name: "Refresh subscription usage",
    });
    fireEvent.keyDown(refreshButton, { key: "Enter" });
    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    fireEvent.click(refreshButton);
    expect(refresh).toHaveBeenCalledOnce();

    const editButton = screen.getByRole("button", {
      name: "Edit compact threshold",
    });
    fireEvent.keyDown(editButton, { key: " " });
    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    fireEvent.click(editButton);
    expect(screen.getByRole("dialog").textContent).toContain(
      "Compact context early",
    );
  });

  it("offers the global YA-orchestrated override for native providers", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="codex"
          model="gpt-5.6"
          usage={{
            inputTokens: 50_000,
            contextWindow: 272_000,
            percentage: 18,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Have YA trigger /compact" }),
    );

    expect(updateSetting).toHaveBeenCalledWith("clientDefaults", {
      forceYaOrchestratedCompaction: true,
    });
  });
});
