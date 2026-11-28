// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderSubscriptionUsage } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSwitchModal } from "../ModelSwitchModal";

const {
  mockGetProcessInfo,
  mockGetProcessModels,
  mockSetProcessConfig,
  mockRefreshSubscriptionUsage,
  mockSubscriptionUsage,
  mockTranslate,
  mockVersion,
} = vi.hoisted(() => ({
  mockGetProcessInfo: vi.fn(),
  mockGetProcessModels: vi.fn(),
  mockSetProcessConfig: vi.fn(),
  mockRefreshSubscriptionUsage: vi.fn(),
  mockSubscriptionUsage: {
    current: null as ProviderSubscriptionUsage | null,
    loading: false,
    supported: false,
  },
  mockTranslate: vi.fn(
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  ),
  mockVersion: { current: { capabilities: [] as string[] } },
}));

vi.mock("../../api/client", () => ({
  api: {
    getProcessInfo: mockGetProcessInfo,
    getProcessModels: mockGetProcessModels,
    setProcessConfig: mockSetProcessConfig,
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  getEffortLevel: () => "high",
  getShowThinkingSetting: () => true,
  getThinkingMode: () => "off",
  useModelSettings: () => ({
    setEffortLevel: vi.fn(),
    setThinkingMode: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProviderSubscriptionUsage", () => ({
  useProviderSubscriptionUsage: () => ({
    usage: mockSubscriptionUsage.current,
    loading: mockSubscriptionUsage.loading,
    supported: mockSubscriptionUsage.supported,
    refresh: mockRefreshSubscriptionUsage,
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: mockVersion.current, loading: false }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ locale: "en-US", t: mockTranslate }),
}));

describe("ModelSwitchModal", () => {
  beforeEach(() => {
    mockGetProcessModels.mockResolvedValue({ models: [] });
    mockGetProcessInfo.mockResolvedValue({
      process: {
        model: "latest",
        provider: "claude",
        thinking: undefined,
        effort: "high",
      },
    });
    mockSetProcessConfig.mockResolvedValue({
      success: true,
      processId: "process-1",
      model: "other",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockVersion.current = { capabilities: [] };
    mockSubscriptionUsage.current = null;
    mockSubscriptionUsage.loading = false;
    mockSubscriptionUsage.supported = false;
  });

  it("resets the shared modal scroller when switching tabs", () => {
    render(
      <ModelSwitchModal
        sessionId="session-1"
        currentModel="model-1"
        infoPane={<div>Session details</div>}
        initialTab="info"
        onModelChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const modalContent = document.querySelector("[data-modal-content]");
    expect(modalContent).toBeInstanceOf(HTMLElement);
    const scrollTo = vi.fn();
    Object.defineProperty(modalContent, "scrollTo", { value: scrollTo });

    fireEvent.click(screen.getByRole("tab", { name: "newSessionModelTitle" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(screen.queryByText("Session details")).toBeNull();
  });

  it("groups additional choices and preserves a missing current model", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        {
          id: "previous",
          name: "Previous",
          catalogGroup: "additional",
        },
      ],
    });
    mockGetProcessInfo.mockResolvedValue({
      process: {
        model: "removed-current",
        provider: "claude",
        thinking: undefined,
        effort: "high",
      },
    });

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="removed-current"
        onModelChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Previous")).toBeTruthy();
    });
    expect(screen.getAllByText("previousModelsGroup")).toHaveLength(1);
    expect(screen.getAllByText("removed-current").length).toBeGreaterThan(0);
    expect(screen.getByText("modelSelectionUnavailable")).toBeTruthy();
  });

  it("dismisses dirty changes without saving", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        { id: "other", name: "Other" },
      ],
    });
    const onClose = vi.fn();

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Other/ }));
    fireEvent.click(screen.getByRole("button", { name: "modalClose" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSetProcessConfig).not.toHaveBeenCalled();
  });

  it("asks the effort guard before applying and stops on skip", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [{ id: "latest", name: "Latest" }],
    });
    const guardEffortChange = vi.fn().mockResolvedValue("skip");

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={vi.fn()}
        guardEffortChange={guardEffortChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("radio", { name: /effortLevelMaxLabel/ }),
    );
    const saveButtons = await screen.findAllByRole("button", {
      name: /modelSwitchSaveAll/,
    });
    const saveButton = saveButtons[0];
    if (!saveButton) throw new Error("Expected a save button");
    fireEvent.click(saveButton);

    await waitFor(() => {
      // The mocked process has no thinking config, which the modal reads as
      // thinking off, so the guard sees off → on:max.
      expect(guardEffortChange).toHaveBeenCalledWith("on:max", "off", {
        changesModel: false,
      });
    });
    expect(mockSetProcessConfig).not.toHaveBeenCalled();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("tells the effort guard when the save also changes the model", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        { id: "other", name: "Other" },
      ],
    });
    const guardEffortChange = vi.fn().mockResolvedValue("apply");

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={vi.fn()}
        guardEffortChange={guardEffortChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Other/ }));
    fireEvent.click(screen.getByRole("radio", { name: /effortLevelMaxLabel/ }));
    const saveButtons = await screen.findAllByRole("button", {
      name: /modelSwitchSaveAll/,
    });
    const saveButton = saveButtons[0];
    if (!saveButton) throw new Error("Expected a save button");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
        model: "other",
        thinking: "on:max",
        showThinking: true,
      });
    });
    expect(guardEffortChange).toHaveBeenCalledWith("on:max", "off", {
      changesModel: true,
    });
  });

  it("dismisses while an explicit save remains pending", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        { id: "other", name: "Other" },
      ],
    });
    let resolveConfig!: (result: {
      success: boolean;
      processId: string;
      model: string;
    }) => void;
    mockSetProcessConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const onClose = vi.fn();
    const onModelChanged = vi.fn();

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={onModelChanged}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Other/ }));
    const saveButtons = await screen.findAllByRole("button", {
      name: /modelSwitchSaveAll/,
    });
    const saveButton = saveButtons[0];
    if (!saveButton) throw new Error("Expected a model save button");
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(mockSetProcessConfig).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "modalClose" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    resolveConfig({ success: true, processId: "process-1", model: "other" });
    await waitFor(() => {
      expect(onModelChanged).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("speed", () => {
    const codexModels = {
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6-Sol",
          serviceTiers: [
            { id: "priority", name: "Fast", description: "1.5x speed" },
          ],
        },
        { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
      ],
    };

    beforeEach(() => {
      mockGetProcessModels.mockResolvedValue(codexModels);
      mockGetProcessInfo.mockResolvedValue({
        process: {
          model: "gpt-5.6-sol",
          provider: "codex",
          thinking: undefined,
          effort: "high",
        },
      });
    });

    const renderModal = (onClose = vi.fn(), routed = false) =>
      render(
        <ModelSwitchModal
          processId="process-1"
          sessionId="session-1"
          currentModel="gpt-5.6-sol"
          routed={routed}
          onModelChanged={vi.fn()}
          onClose={onClose}
        />,
      );

    it("applies a tier on its own and keeps the modal open", async () => {
      mockVersion.current = { capabilities: ["process-service-tier-change"] };
      mockSetProcessConfig.mockResolvedValue({
        success: true,
        processId: "process-1",
        serviceTier: "priority",
      });
      const onClose = vi.fn();
      renderModal(onClose);

      await screen.findByRole("radio", {
        name: "serviceTierStandardLabel",
        checked: true,
      });
      fireEvent.click(screen.getByRole("radio", { name: "Fast" }));

      await screen.findByRole("radio", { name: "Fast", checked: true });
      expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
        serviceTier: "priority",
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("offers Standard for a live tier the catalog no longer lists", async () => {
      mockVersion.current = { capabilities: ["process-service-tier-change"] };
      mockGetProcessInfo.mockResolvedValue({
        process: {
          model: "gpt-5.6-luna",
          provider: "codex",
          effort: "high",
          serviceTier: "ultrafast",
        },
      });
      mockSetProcessConfig.mockResolvedValue({
        success: true,
        processId: "process-1",
        serviceTier: null,
      });
      renderModal();

      await screen.findByRole("radio", {
        name: "serviceTierUltraFastLabel",
        checked: true,
      });
      fireEvent.click(
        screen.getByRole("radio", { name: "serviceTierStandardLabel" }),
      );
      await waitFor(() => {
        expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
          serviceTier: null,
        });
      });
    });

    it.each([true, false, undefined])(
      "uses the routed response support signal %s without a global router tier bit",
      async (supported) => {
        mockVersion.current = { capabilities: ["process-service-tier-change"] };
        mockGetProcessModels.mockResolvedValue({
          ...codexModels,
          serviceTierSelection: supported,
        });
        renderModal(vi.fn(), true);
        await screen.findByText("GPT-5.6-Luna");
        if (supported) {
          fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
          await waitFor(() =>
            expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
              serviceTier: "priority",
            }),
          );
        } else {
          expect(screen.queryByText("modelSwitchSpeedLabel")).toBeNull();
          expect(mockSetProcessConfig).not.toHaveBeenCalled();
        }
      },
    );

    it("hides the control from servers without live tier changes", async () => {
      renderModal();

      await screen.findByText("GPT-5.6-Luna");
      expect(screen.queryByText("modelSwitchSpeedLabel")).toBeNull();
    });
  });

  describe("antigravity", () => {
    it("opens clean on Auto when thinking is omitted and hides thinking controls on fixed-effort models", async () => {
      mockGetProcessModels.mockResolvedValue({
        models: [
          {
            id: "gemini-4-neon",
            name: "Gemini 4 Neon",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          },
          {
            id: "gemini-pro-orchestrator-neon",
            name: "Orchestrator (Neon)",
            supportsEffort: false,
            supportsAdaptiveThinking: false,
          },
        ],
      });
      mockGetProcessInfo.mockResolvedValue({
        process: {
          model: "gemini-4-neon",
          provider: "antigravity",
          thinking: undefined,
          effort: undefined,
        },
      });

      render(
        <ModelSwitchModal
          processId="process-1"
          sessionId="session-1"
          currentModel="gemini-4-neon"
          sessionProvider="antigravity"
          onModelChanged={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      await screen.findByText("Orchestrator (Neon)");
      expect(
        screen.queryByRole("button", { name: /modelSwitchSaveAll/ }),
      ).toBeNull();
      expect(
        screen.queryByRole("radio", { name: /modelSettingsThinkingOffLabel/ }),
      ).toBeNull();
      expect(
        screen.getByRole("radio", { name: /effortLevelExtraHighLabel/ }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("radio", { name: /effortLevelMaxLabel/ }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: /Orchestrator \(Neon\)/ }),
      );
      expect(screen.queryByText("modelSwitchThinkingModeTitle")).toBeNull();
      expect(screen.queryByText("modelSettingsEffortTitle")).toBeNull();
      const saveButtons = await screen.findAllByRole("button", {
        name: /modelSwitchSaveAll/,
      });
      fireEvent.click(saveButtons[0]!);
      await waitFor(() => {
        expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
          model: "gemini-pro-orchestrator-neon",
          thinking: "auto",
          showThinking: true,
        });
      });
    });

    it("omits thinking controls and thinking payload against older servers without Antigravity effort metadata", async () => {
      mockGetProcessModels.mockResolvedValue({
        models: [
          { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
        ],
      });
      mockGetProcessInfo.mockResolvedValue({
        process: {
          model: "gemini-4-neon-high",
          provider: "antigravity",
          thinking: undefined,
          effort: undefined,
        },
      });

      render(
        <ModelSwitchModal
          processId="process-1"
          sessionId="session-1"
          currentModel="gemini-4-neon-high"
          sessionProvider="antigravity"
          onModelChanged={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      await screen.findByText("Gemini 4 Neon (Low)");
      expect(screen.queryByText("modelSwitchThinkingModeTitle")).toBeNull();
      expect(screen.queryByText("modelSettingsEffortTitle")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: /Gemini 4 Neon \(Low\)/ }),
      );
      const saveButtons = await screen.findAllByRole("button", {
        name: /modelSwitchSaveAll/,
      });
      fireEvent.click(saveButtons[0]!);
      await waitFor(() => {
        expect(mockSetProcessConfig).toHaveBeenCalledWith("process-1", {
          model: "gemini-4-neon-low",
        });
      });
    });
  });

  describe("usage tab", () => {
    it("shows current model windows shortest-first, other provider buckets below, and refreshes on click", () => {
      mockSubscriptionUsage.supported = true;
      mockSubscriptionUsage.current = {
        provider: "antigravity",
        fetchedAt: "2026-11-28T10:54:00.000Z",
        windows: [
          {
            id: "antigravity:gemini-weekly",
            usedPercent: 5,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-12-05T09:57:00.000Z",
            scope: {
              type: "models",
              label: "Gemini",
              modelIds: ["gemini-4-neon"],
            },
          },
          {
            id: "antigravity:gemini-5h",
            usedPercent: 20,
            windowDurationMinutes: 300,
            resetsAt: "2026-11-28T14:57:00.000Z",
            scope: {
              type: "models",
              label: "Gemini",
              modelIds: ["gemini-4-neon"],
            },
          },
          {
            id: "antigravity:3p-weekly",
            usedPercent: 0,
            windowDurationMinutes: 10_080,
            scope: {
              type: "models",
              label: "Claude & GPT",
              modelIds: ["claude-opus-5-5"],
            },
          },
          {
            id: "antigravity:3p-5h",
            usedPercent: 0,
            windowDurationMinutes: 300,
            scope: {
              type: "models",
              label: "Claude & GPT",
              modelIds: ["claude-opus-5-5"],
            },
          },
        ],
      };

      render(
        <ModelSwitchModal
          sessionId="session-1"
          currentModel="gemini-4-neon"
          sessionProvider="antigravity"
          infoPane={<div>Session details</div>}
          onModelChanged={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: "sessionUsageTab" }));

      const panel = screen.getByRole("tabpanel");
      const text = panel.textContent ?? "";
      const gemini5h = text.indexOf(
        'Gemini · subscriptionUsageWindow:{"duration":"5h"}',
      );
      const gemini7d = text.indexOf(
        'Gemini · subscriptionUsageWindow:{"duration":"7d"}',
      );
      const otherHeading = text.indexOf("subscriptionUsageOtherModels");
      const thirdParty5h = text.indexOf(
        'Claude & GPT · subscriptionUsageWindow:{"duration":"5h"}',
      );
      const thirdParty7d = text.indexOf(
        'Claude & GPT · subscriptionUsageWindow:{"duration":"7d"}',
      );

      expect(gemini5h).toBeGreaterThan(-1);
      expect(gemini7d).toBeGreaterThan(gemini5h);
      expect(otherHeading).toBeGreaterThan(gemini7d);
      expect(thirdParty5h).toBeGreaterThan(otherHeading);
      expect(thirdParty7d).toBeGreaterThan(thirdParty5h);

      fireEvent.click(
        screen.getByRole("button", { name: "subscriptionUsageRefresh" }),
      );
      expect(mockRefreshSubscriptionUsage).toHaveBeenCalledOnce();
    });

    it("omits the Usage tab when neither subscription usage nor token details exist", () => {
      render(
        <ModelSwitchModal
          sessionId="session-1"
          currentModel="model-1"
          infoPane={<div>Session details</div>}
          onModelChanged={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      expect(screen.queryByRole("tab", { name: "sessionUsageTab" })).toBeNull();
    });

    it("shows last-turn token details in the Usage tab even without subscription quota", () => {
      render(
        <ModelSwitchModal
          sessionId="session-1"
          currentModel="claude-opus"
          sessionProvider="claude"
          contextUsage={{
            inputTokens: 104_966,
            contextWindow: 1_000_000,
            percentage: 10,
            cacheReadTokens: 103_341,
            outputTokens: 333,
          }}
          infoPane={<div>Session details</div>}
          onModelChanged={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: "sessionUsageTab" }));

      const panel = screen.getByRole("tabpanel");
      expect(panel.textContent).toContain("contextTokenUsageTitle");
      expect(panel.textContent).toContain("103,341");
      expect(panel.textContent).toContain("333");
    });
  });
});
