// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { LATEX_MATH_RENDERING_CLIENT_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContextSettings } from "../AgentContextSettings";

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      globalInstructions: "",
      agentContextHints: { latexMathRendering: false },
    },
    isLoading: false,
    error: null,
    updateSettings: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("AgentContextSettings", () => {
  afterEach(cleanup);

  it("shows the exact LaTeX agent-context block before opt-in", () => {
    render(<AgentContextSettings />);

    const preview = screen
      .getByText("agentContextSuggestedLatexPreviewTitle")
      .closest("[data-settings-info]")
      ?.parentElement?.querySelector("pre");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe(
      `[Client capabilities]\n${LATEX_MATH_RENDERING_CLIENT_CAPABILITY}`,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "agentContextSuggestedLatexTitle",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
});
