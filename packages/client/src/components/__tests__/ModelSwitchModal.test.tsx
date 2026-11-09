// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSwitchModal } from "../ModelSwitchModal";

const {
  mockGetProcessInfo,
  mockGetProcessModels,
  mockSetProcessConfig,
  mockTranslate,
  mockVersion,
} = vi.hoisted(() => ({
  mockGetProcessInfo: vi.fn(),
  mockGetProcessModels: vi.fn(),
  mockSetProcessConfig: vi.fn(),
  mockTranslate: vi.fn((key: string) => key),
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
    usage: null,
    loading: false,
    supported: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: mockVersion.current, loading: false }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: mockTranslate }),
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

    const modalContent = document.querySelector(".modal-content");
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
});
