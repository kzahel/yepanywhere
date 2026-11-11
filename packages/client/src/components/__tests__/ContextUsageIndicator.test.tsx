import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ContextUsageIndicator } from "../ContextUsageIndicator";

describe("ContextUsageIndicator", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows used and window tokens in tooltip when contextWindow is available", () => {
    const { container } = render(
      <I18nProvider>
        <ContextUsageIndicator
          usage={{
            inputTokens: 50_000,
            percentage: 19.38,
            contextWindow: 258_000,
          }}
        />
      </I18nProvider>,
    );

    const indicator = container.querySelector("[data-context-usage-indicator]");
    expect(indicator?.getAttribute("title")).toBe(
      "Context: 19.4% (50.0K / 258.0K tokens)",
    );
    expect(
      container.querySelector("[data-context-usage-label]")?.textContent,
    ).toBe("19%");
  });

  it("falls back to input-only tooltip when contextWindow is missing", () => {
    const { container } = render(
      <I18nProvider>
        <ContextUsageIndicator
          usage={{ inputTokens: 50_000, percentage: 25 }}
        />
      </I18nProvider>,
    );

    const indicator = container.querySelector("[data-context-usage-indicator]");
    expect(indicator?.getAttribute("title")).toBe(
      "Context: 25% (50.0K tokens)",
    );
  });
});
