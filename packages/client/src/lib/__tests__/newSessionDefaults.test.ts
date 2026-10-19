import { describe, expect, it } from "vitest";
import {
  getPreferredModelId,
  getPreferredProviderModelId,
  withProviderSessionDefaults,
} from "../newSessionDefaults";

describe("getPreferredModelId", () => {
  const models = [
    { id: "latest", name: "Latest" },
    { id: "previous", name: "Previous" },
  ];

  it("uses the first model when no preference is saved", () => {
    expect(getPreferredModelId(models)).toBe("latest");
  });

  it("uses the provider-marked default when it is not first", () => {
    expect(
      getPreferredModelId([
        { id: "preferred-order", name: "Preferred order" },
        { id: "provider-default", name: "Provider default", isDefault: true },
      ]),
    ).toBe("provider-default");
  });

  it("keeps a saved exact id when the current catalog omits it", () => {
    expect(getPreferredModelId(models, "unlisted")).toBe("unlisted");
  });

  it("uses only models advertised by Claude Gateway", () => {
    expect(
      getPreferredProviderModelId("claude-gateway", models, "gpt-5.5"),
    ).toBe("latest");
    expect(
      getPreferredProviderModelId("claude-gateway", [], "gpt-5.5"),
    ).toBeNull();
  });

  it("uses Claude Gateway's advertised default when a saved id is absent", () => {
    expect(
      getPreferredProviderModelId(
        "claude-gateway",
        [
          { id: "first", name: "First" },
          { id: "default", name: "Default", isDefault: true },
        ],
        "missing",
      ),
    ).toBe("default");
  });
});

describe("withProviderSessionDefaults model effort levels", () => {
  const saved = {
    providers: {
      claude: { model: "opus", modelEffortLevels: { opus: "low" } },
    },
  } as const;

  it("keeps per-model effort when another default changes", () => {
    expect(
      withProviderSessionDefaults(saved, "claude", { thinkingMode: "auto" })
        .providers?.claude?.modelEffortLevels,
    ).toEqual({ opus: "low" });
  });

  it("drops the map when every model returns to its default", () => {
    expect(
      withProviderSessionDefaults(saved, "claude", { modelEffortLevels: {} })
        .providers?.claude,
    ).toEqual({ model: "opus" });
  });
});
