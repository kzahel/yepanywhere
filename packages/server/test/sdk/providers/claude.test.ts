import { describe, expect, it, vi } from "vitest";
import {
  ClaudeProvider,
  claudeProvider,
  evaluateClaudeSessionOptionsUpdate,
  getClaudeAutoCompactOverrideEnv,
  getClaudeSessionLaunchOptions,
  probeClaudeControlLiveness,
} from "../../../src/sdk/providers/claude.js";
import {
  formatClaudeLoginCommand,
  resolveClaudeSdkNativeExecutable,
  resolvePathExecutable,
} from "../../../src/sdk/providers/claude-executable.js";
import {
  filterClaudeRemoteSlashCommands,
  mergeClaudeModels,
  normalizeClaudeLaunchModel,
  withClaudeGoalAlias,
} from "../../../src/sdk/providers/claude-model-catalog.js";
import { resolveProviderSessionOptions } from "../../../src/sdk/providers/types.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

class ExposedClaudeProvider extends ClaudeProvider {
  getLaunchEnvironment() {
    return this.getEnv();
  }

  getLaunchToolOptions() {
    return this.getDisallowedToolOptions();
  }
}

describe("Claude executable lookup", () => {
  it("applies directly spawnable Windows PATHEXT candidates in PATH order", () => {
    const inspected: string[] = [];
    const resolved = resolvePathExecutable("claude", {
      platform: "win32",
      env: {
        PATH: "C:\\npm;D:\\tools",
        PATHEXT: ".JS;.EXE;.CMD",
      },
      isExecutable: (candidate) => {
        inspected.push(candidate);
        return candidate === "D:\\tools\\claude.EXE";
      },
    });

    expect(resolved).toBe("D:\\tools\\claude.EXE");
    expect(inspected).toEqual(["C:\\npm\\claude.EXE", "D:\\tools\\claude.EXE"]);
  });

  it("applies PATHEXT to an explicit Windows path in a dotted directory", () => {
    expect(
      resolvePathExecutable("C:\\tools.v1\\claude", {
        platform: "win32",
        env: { PATHEXT: ".EXE" },
        isExecutable: (candidate) => candidate === "C:\\tools.v1\\claude.EXE",
      }),
    ).toBe("C:\\tools.v1\\claude.EXE");
  });

  it("rejects Windows batch shims that child_process cannot spawn directly", () => {
    expect(
      resolvePathExecutable("claude", {
        platform: "win32",
        env: { PATH: "C:\\npm", PATHEXT: ".CMD;.BAT" },
        isExecutable: () => true,
      }),
    ).toBeUndefined();
    expect(
      resolvePathExecutable("C:\\npm\\claude.CMD", {
        platform: "win32",
        isExecutable: () => true,
      }),
    ).toBeUndefined();
  });
});

describe("normalizeClaudeLaunchModel", () => {
  it("keeps Opus on the stable alias and retains Sonnet's extended spelling", () => {
    expect(normalizeClaudeLaunchModel("opus")).toBe("opus");
    expect(normalizeClaudeLaunchModel("opus[1m]")).toBe("opus[1m]");
    expect(normalizeClaudeLaunchModel("sonnet")).toBe("sonnet[1m]");
    expect(normalizeClaudeLaunchModel(undefined)).toBeUndefined();
  });
});

describe("ClaudeProvider.yaModelIdForReported", () => {
  it("maps reported ids to the canonical family alias", () => {
    expect(claudeProvider.yaModelIdForReported("claude-opus-4-8")).toBe("opus");
    expect(claudeProvider.yaModelIdForReported("claude-opus-5")).toBe("opus");
    expect(claudeProvider.yaModelIdForReported("claude-sonnet-4-6")).toBe(
      "sonnet",
    );
    expect(claudeProvider.yaModelIdForReported("claude-haiku-4-5")).toBe(
      "haiku",
    );
    expect(claudeProvider.yaModelIdForReported("claude-fable-5-1")).toBe(
      "fable",
    );
  });

  it("matches the family regardless of component order (version-first ids)", () => {
    expect(claudeProvider.yaModelIdForReported("claude-3-5-sonnet")).toBe(
      "sonnet",
    );
  });

  it("is idempotent on bare aliases", () => {
    expect(claudeProvider.yaModelIdForReported("opus")).toBe("opus");
    expect(claudeProvider.yaModelIdForReported("sonnet")).toBe("sonnet");
  });

  it("returns undefined for unknown ids and empty input", () => {
    expect(
      claudeProvider.yaModelIdForReported("claude-mythos-5"),
    ).toBeUndefined();
    expect(
      claudeProvider.yaModelIdForReported("gpt-5.3-codex"),
    ).toBeUndefined();
    expect(claudeProvider.yaModelIdForReported(undefined)).toBeUndefined();
    expect(claudeProvider.yaModelIdForReported("")).toBeUndefined();
  });
});

describe("Claude auto-compaction launch environment", () => {
  it("sets the exact documented environment variable when configured", () => {
    expect(getClaudeAutoCompactOverrideEnv(50)).toEqual({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
    });
  });

  it("omits the override when the global setting is off", () => {
    expect(getClaudeAutoCompactOverrideEnv(undefined)).toBeUndefined();
  });

  it.each([0, 101, 50.5])("rejects invalid percentage %p", (percent) => {
    expect(() => getClaudeAutoCompactOverrideEnv(percent)).toThrow(
      "integer from 1 to 100",
    );
  });
});

describe("Claude subagent nesting launch environment", () => {
  it("uses YA's default, supports unset, and preserves an operator value", () => {
    const previous = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    try {
      const provider = new ExposedClaudeProvider();
      expect(provider.getLaunchEnvironment()).toMatchObject({
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
      });

      provider.setSubagentMaxDepthGetter(() => 4);
      expect(provider.getLaunchEnvironment()).toMatchObject({
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "4",
      });

      provider.setSubagentMaxDepthGetter(() => null);
      expect(provider.getLaunchEnvironment()).not.toHaveProperty(
        "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
      );

      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "3";
      provider.setSubagentMaxDepthGetter(() => 0);
      expect(provider.getLaunchEnvironment()).toMatchObject({
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
      } else {
        process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = previous;
      }
    }
  });
});

describe("Claude tool availability", () => {
  it("leaves plan-mode tools available for regular Claude", () => {
    const provider = new ExposedClaudeProvider();

    expect(provider.getLaunchToolOptions()).toEqual({});
  });
});

describe("Claude provider-owned generation options", () => {
  it("explicitly disables generated titles, recaps, progress, and suggestions by default", () => {
    expect(getClaudeSessionLaunchOptions()).toEqual({
      resolved: {
        automaticTitle: false,
        automaticRecaps: false,
        agentProgressSummaries: false,
        promptSuggestions: false,
      },
      sdk: {
        title: "Yep Anywhere Session",
        promptSuggestions: false,
        agentProgressSummaries: false,
      },
    });
  });

  it("allows explicit launch-time opt-ins except unsupported native recaps", () => {
    expect(
      getClaudeSessionLaunchOptions({
        automaticTitle: true,
        agentProgressSummaries: true,
        promptSuggestions: true,
      }).sdk,
    ).toEqual({
      title: undefined,
      promptSuggestions: true,
      agentProgressSummaries: true,
    });
    expect(() =>
      getClaudeSessionLaunchOptions({ automaticRecaps: true }),
    ).toThrow("does not support provider-native automatic recaps");
  });

  it("reports launch-only changes and intrinsically absent recaps", () => {
    const launched = resolveProviderSessionOptions();
    expect(
      evaluateClaudeSessionOptionsUpdate(launched, {
        automaticTitle: false,
        automaticRecaps: false,
        agentProgressSummaries: true,
      }),
    ).toMatchObject({
      automaticTitle: { requested: false, status: "applied" },
      automaticRecaps: { requested: false, status: "inactive" },
      agentProgressSummaries: {
        requested: true,
        status: "restart-required",
      },
    });
  });
});

function control(
  mcpServerStatus: () => Promise<unknown>,
): Pick<Query, "mcpServerStatus"> {
  return {
    mcpServerStatus: mcpServerStatus as unknown as Query["mcpServerStatus"],
  };
}

describe("ClaudeProvider model list", () => {
  it("projects server-selected models without caching the setting value", async () => {
    const provider = new ClaudeProvider();
    let selected = false;
    provider.setAdditionalModelsGetter(() =>
      selected
        ? [
            {
              id: "claude-opus-4-6",
              label: "Opus 4.6",
              origin: "registry",
            },
          ]
        : [],
    );
    vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
      installed: true,
      authenticated: false,
      enabled: false,
    });

    expect(
      (await provider.getAvailableModels()).map((model) => model.id),
    ).not.toContain("claude-opus-4-6");
    selected = true;
    expect(
      (await provider.getAvailableModels()).find(
        (model) => model.id === "claude-opus-4-6",
      ),
    ).toMatchObject({
      name: "Opus 4.6",
      catalogGroup: "additional",
    });
  });

  describe("refresh and provenance", () => {
    const row = (id: string) => ({ id, name: id });
    const authenticated = (provider: ClaudeProvider) =>
      vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
        installed: true,
        authenticated: true,
        enabled: true,
      });
    const probe = (provider: ClaudeProvider) =>
      vi.spyOn(
        provider as unknown as { probeModels(): Promise<unknown[]> },
        "probeModels",
      );
    const ids = async (
      provider: ClaudeProvider,
      options?: { forceRefresh?: boolean },
    ) => (await provider.getAvailableModels(options)).map((model) => model.id);

    it("labels the built-in list as a fallback when signed out", async () => {
      const provider = new ClaudeProvider();
      vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
        installed: true,
        authenticated: false,
        enabled: false,
      });

      expect(await ids(provider)).toContain("default");
      expect(provider.getModelCatalogStatus()).toMatchObject({
        source: "fallback",
        error: "Claude is not signed in",
      });
    });

    it("caches a live probe, re-probes on force and after an hour", async () => {
      vi.useFakeTimers({ now: Date.parse("2026-10-06T10:00:00Z") });
      try {
        const provider = new ClaudeProvider();
        authenticated(provider);
        const probeModels = probe(provider)
          .mockResolvedValueOnce([row("first")])
          .mockResolvedValueOnce([row("forced")])
          .mockResolvedValueOnce([row("expired")]);

        expect(await ids(provider)).toContain("first");
        expect(provider.getModelCatalogStatus()).toEqual({
          source: "live",
          fetchedAt: "2026-10-06T10:00:00.000Z",
        });
        expect(await ids(provider)).toContain("first");
        expect(probeModels).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.parse("2026-10-06T10:05:00Z"));
        expect(await ids(provider, { forceRefresh: true })).toContain("forced");
        expect(provider.getModelCatalogStatus()?.fetchedAt).toBe(
          "2026-10-06T10:05:00.000Z",
        );

        vi.setSystemTime(Date.parse("2026-10-06T11:04:00Z"));
        expect(await ids(provider)).toContain("forced");
        vi.setSystemTime(Date.parse("2026-10-06T11:06:00Z"));
        expect(await ids(provider)).toContain("expired");
        expect(probeModels).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let an older probe overwrite a forced refresh", async () => {
      const provider = new ClaudeProvider();
      authenticated(provider);
      let finishOld: (models: unknown[]) => void = () => {};
      const probeModels = probe(provider)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishOld = resolve;
          }),
        )
        .mockResolvedValueOnce([row("new")]);

      const old = ids(provider);
      await vi.waitFor(() => expect(probeModels).toHaveBeenCalledTimes(1));
      expect(await ids(provider, { forceRefresh: true })).toContain("new");
      finishOld([row("old")]);
      expect(await old).toContain("old");

      expect(await ids(provider)).toContain("new");
      expect(await ids(provider)).not.toContain("old");
    });

    it("keeps the last live list when a refresh fails", async () => {
      const provider = new ClaudeProvider();
      authenticated(provider);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      probe(provider)
        .mockResolvedValueOnce([row("live")])
        .mockRejectedValueOnce(new Error("probe timed out"));

      await ids(provider);
      const fetchedAt = provider.getModelCatalogStatus()?.fetchedAt;
      expect(await ids(provider, { forceRefresh: true })).toContain("live");
      expect(provider.getModelCatalogStatus()).toEqual({
        source: "live",
        fetchedAt,
        error: "probe timed out",
      });
    });

    it("falls back when the first probe fails", async () => {
      const provider = new ClaudeProvider();
      authenticated(provider);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      probe(provider).mockRejectedValueOnce(new Error("no runtime"));

      expect(await ids(provider)).toContain("default");
      expect(provider.getModelCatalogStatus()).toMatchObject({
        source: "fallback",
        error: "no runtime",
      });
    });
  });

  it("resolves a launch alias to the concrete model the SDK reports", async () => {
    const provider = new ClaudeProvider();
    expect(provider.resolveLaunchModel("opus")).toBeUndefined();

    await (
      provider as unknown as {
        normalizeSupportedModels(models: unknown[]): Promise<unknown>;
      }
    ).normalizeSupportedModels([
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5-5[1m]",
        displayName: "Opus",
        description: "Opus 5.5",
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Sonnet 5",
      },
    ]);

    expect(provider.resolveLaunchModel("opus")).toBe("claude-opus-5-5");
    expect(provider.resolveLaunchModel("sonnet")).toBe("claude-sonnet-5");
    expect(provider.resolveLaunchModel("haiku")).toBeUndefined();
    expect(provider.resolveLaunchModel(undefined)).toBeUndefined();
  });

  it("keeps the default option generic when SDK returns a concrete-looking label", () => {
    const models = mergeClaudeModels([
      {
        id: "default",
        name: "Sonnet 4.6",
        description: "SDK-reported default",
      },
      {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        description: "Latest Sonnet",
      },
    ]);

    expect(models[0]).toMatchObject({
      id: "default",
      name: "Default",
      description: "Claude Code chooses the recommended model for your account",
    });
    expect(models.map((model) => model.id)).toContain("claude-sonnet-4-6");
  });

  it("exposes Fable from fallback metadata when the SDK omits it", () => {
    const models = mergeClaudeModels([
      {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        description: "Latest Sonnet",
      },
    ]);

    expect(models.map((model) => model.id).slice(0, 4)).toEqual([
      "default",
      "best",
      "fable",
      "sonnet",
    ]);
    expect(models.find((model) => model.id === "fable")).toMatchObject({
      name: "Fable",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportsEffort: true,
      supportsFastMode: false,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffortLevel: "high",
    });
  });

  it("merges the live Fable row into the stable fable alias", () => {
    const models = mergeClaudeModels([
      {
        id: "claude-fable-5-1[1m]",
        name: "Fable",
        description:
          "Fable 5.1 · Most capable for your hardest and longest-running tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
      },
    ]);

    expect(models.map((model) => model.id)).not.toContain(
      "claude-fable-5-1[1m]",
    );
    expect(models.find((model) => model.id === "fable")).toMatchObject({
      name: "Fable",
      description:
        "Fable 5.1 · Most capable for your hardest and longest-running tasks",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
      supportsAutoMode: true,
      supportedEffortLevels: ["low", "medium", "high"],
      defaultEffortLevel: "high",
    });
  });

  it("keeps the current Fable row and its version when older Fables follow", () => {
    // Claude Code 2.1.322: the `fable` alias is Fable 5.2, its description
    // no longer names the version, and previous Fables follow as concrete
    // rows.
    const models = mergeClaudeModels([
      {
        id: "fable",
        name: "Fable 5.2",
        description: "For your toughest challenges",
      },
      {
        id: "claude-fable-5-1",
        resolvedModel: "claude-fable-5-1",
        name: "Fable 5.1",
        description: "Most capable for your hardest and longest-running tasks",
      },
      {
        id: "claude-fable-5",
        resolvedModel: "claude-fable-5",
        name: "Fable 5",
        description: "Most capable for your hardest and longest-running tasks",
      },
    ]);

    expect(models.find((model) => model.id === "fable")).toMatchObject({
      name: "Fable 5.2",
      description: "For your toughest challenges",
    });
    for (const [id, name] of [
      ["claude-fable-5-1", "Fable 5.1"],
      ["claude-fable-5", "Fable 5"],
    ]) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        name,
        catalogGroup: "additional",
      });
    }
  });

  it("marks the concrete previous versions additional and lists them last", () => {
    // Claude Code 2.1.293's catalog, abridged: aliases, then concrete rows.
    const models = mergeClaudeModels([
      { id: "default", name: "Default", description: "Opus 5.5" },
      { id: "sonnet", name: "Sonnet 5.5", description: "Sonnet 5.5" },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Haiku 4.5",
        description: "Fastest for quick answers",
      },
      { id: "claude-sonnet-5", name: "Sonnet 5", description: "Sonnet 5" },
      { id: "haiku", name: "Haiku 5.5", description: "Haiku 5.5" },
    ]);

    const previous = models.filter(
      (model) => model.catalogGroup === "additional",
    );
    expect(previous.map((model) => model.id)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
    ]);
    expect(models.slice(-2)).toEqual(previous);
    expect(models.find((model) => model.id === "haiku")?.catalogGroup).toBe(
      undefined,
    );
  });

  it("merges the live Opus 5 extended row into the stable opus alias", () => {
    const models = mergeClaudeModels([
      {
        id: "default",
        name: "Default (recommended)",
        description: "Opus 5 with 1M context",
        contextWindow: 1_000_000,
        supportsAdaptiveThinking: true,
        supportsAutoMode: true,
        supportsEffort: true,
        supportsFastMode: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "opus[1m]",
        name: "Opus (1M context)",
        description: "Opus 5 with 1M context",
        contextWindow: 1_000_000,
        supportsAdaptiveThinking: true,
        supportsAutoMode: true,
        supportsEffort: true,
        supportsFastMode: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);

    expect(models.map((model) => model.id)).not.toContain("opus[1m]");
    expect(models.find((model) => model.id === "default")).toMatchObject({
      name: "Default",
      description: "Claude Code chooses the recommended model for your account",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportsFastMode: true,
    });
    expect(models.find((model) => model.id === "opus")).toMatchObject({
      name: "Opus",
      description: "Opus 5.5 with the full 1M-token context window",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportsEffort: true,
      supportsFastMode: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffortLevel: "high",
    });
  });

  it("keeps the live Opus 5.5 row on the stable opus alias", () => {
    const models = mergeClaudeModels([
      {
        id: "opus",
        name: "Opus",
        description:
          "Opus 5.5 · Best for everyday, complex tasks · ~2× usage vs Sonnet",
        contextWindow: 1_000_000,
        supportsAdaptiveThinking: true,
        supportsAutoMode: true,
        supportsEffort: true,
        supportsFastMode: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);

    expect(models.find((model) => model.id === "opus")).toMatchObject({
      name: "Opus",
      description: "Opus 5.5 with the full 1M-token context window",
      contextWindow: 1_000_000,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportsEffort: true,
      supportsFastMode: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffortLevel: "high",
    });
  });
});

describe("Claude provider liveness probe", () => {
  it("reports active when the SDK control channel responds", async () => {
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(
      control(async () => []),
      { checkedAt },
    );

    expect(result).toEqual({
      status: "active",
      source: "claude:control/mcp_status",
      checkedAt,
      detail:
        "Claude SDK control channel responded; direct turn status is not exposed",
    });
  });

  it("does not upgrade a dead CLI process through the control channel", async () => {
    const mcpServerStatus = vi.fn(async () => []);
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(control(mcpServerStatus), {
      checkedAt,
      isProcessAlive: () => false,
    });

    expect(result).toEqual({
      status: "unavailable",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "Claude CLI process is not alive",
    });
    expect(mcpServerStatus).not.toHaveBeenCalled();
  });

  it("reports an error when the control request fails", async () => {
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");

    const result = await probeClaudeControlLiveness(
      control(async () => {
        throw new Error("control request failed");
      }),
      { checkedAt },
    );

    expect(result).toEqual({
      status: "error",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "control request failed",
    });
  });

  it("times out control requests that do not answer", async () => {
    vi.useFakeTimers();
    const checkedAt = new Date("2026-04-25T00:00:20.000Z");
    const resultPromise = probeClaudeControlLiveness(
      control(() => new Promise(() => {})),
      { checkedAt, timeoutMs: 5 },
    );

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(result).toEqual({
      status: "error",
      source: "claude:control/mcp_status",
      checkedAt,
      detail: "Claude SDK control liveness probe timed out after 5ms",
    });
    vi.useRealTimers();
  });
});

describe("Claude provider slash commands", () => {
  it("hides terminal-only commands from remote command inventories", () => {
    expect(
      filterClaudeRemoteSlashCommands(
        ["compact", "exit", "statusline", "review"],
        ["/EXIT", "statusline"],
      ),
    ).toEqual(["compact", "review"]);
    expect(
      filterClaudeRemoteSlashCommands(["compact", "exit"], undefined),
    ).toEqual(["compact", "exit"]);
  });

  it("adds /goal as a /loop alias when /loop is advertised and /goal is not", () => {
    const commands = withClaudeGoalAlias([
      { name: "compact", description: "Compact conversation" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);

    expect(commands).toEqual([
      { name: "compact", description: "Compact conversation" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
      {
        name: "goal",
        description:
          "Keep working toward a verifiable end state until it is met",
        argumentHint: "<verifiable end state>",
        emulation: { providerText: "/loop wish {{argument}}" },
        invocation: { kind: "emulated", prefix: "/" },
      },
    ]);
  });

  it("does not add /goal when /loop is unavailable", () => {
    const commands = withClaudeGoalAlias([
      { name: "compact", description: "Compact conversation" },
    ]);

    expect(commands).toEqual([
      { name: "compact", description: "Compact conversation" },
    ]);
  });

  it("does not duplicate /goal when the SDK already reports it", () => {
    const commands = withClaudeGoalAlias([
      { name: "/GOAL", description: "Native goal alias" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);

    expect(commands).toEqual([
      { name: "/GOAL", description: "Native goal alias" },
      { name: "loop", description: "Run a prompt on a recurring interval" },
    ]);
  });
});

describe("Claude SDK executable resolution", () => {
  it.runIf(process.platform === "linux").each([false, true])(
    "does not inspect networking to choose libc and restores excludeNetwork=%s",
    (excludeNetwork) => {
      const report = process.report as typeof process.report & {
        excludeNetwork: boolean;
      };
      const previous = report.excludeNetwork;
      report.excludeNetwork = excludeNetwork;
      const getReport = vi.spyOn(report, "getReport").mockImplementation(() => {
        expect(report.excludeNetwork).toBe(true);
        return { header: { glibcVersionRuntime: "2.28" } };
      });
      try {
        expect(resolveClaudeSdkNativeExecutable()).toBeTruthy();
        expect(getReport).toHaveBeenCalledOnce();
        expect(report.excludeNetwork).toBe(excludeNetwork);
      } finally {
        getReport.mockRestore();
        report.excludeNetwork = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "restores report settings when libc detection fails",
    () => {
      const report = process.report as typeof process.report & {
        excludeNetwork: boolean;
      };
      const previous = report.excludeNetwork;
      report.excludeNetwork = false;
      const failure = new Error("report unavailable");
      const getReport = vi.spyOn(report, "getReport").mockImplementation(() => {
        throw failure;
      });
      try {
        expect(() => resolveClaudeSdkNativeExecutable()).toThrow(failure);
        expect(report.excludeNetwork).toBe(false);
      } finally {
        getReport.mockRestore();
        report.excludeNetwork = previous;
      }
    },
  );

  it("prefers the glibc native package on glibc Linux hosts", () => {
    const executable = resolveClaudeSdkNativeExecutable();

    expect(executable).toBeTruthy();
    if (
      process.platform === "linux" &&
      process.arch === "x64" &&
      (
        process.report.getReport() as {
          header?: { glibcVersionRuntime?: string };
        }
      ).header?.glibcVersionRuntime
    ) {
      expect(executable).toContain("claude-agent-sdk-linux-x64");
      expect(executable).not.toContain("claude-agent-sdk-linux-x64-musl");
    }
  });
});

describe("Claude login command", () => {
  it("uses the short shell command when no executable is preferred", () => {
    expect(formatClaudeLoginCommand(undefined, "win32")).toBe(
      "claude auth login --claudeai",
    );
  });

  it("leaves a shell-neutral Windows path bare so cmd.exe and PowerShell both run it", () => {
    expect(
      formatClaudeLoginCommand(
        "C:\\Users\\me\\AppData\\Local\\yep\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe",
        "win32",
      ),
    ).toBe(
      "C:\\Users\\me\\AppData\\Local\\yep\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe auth login --claudeai",
    );
  });

  it("formats a PowerShell command for Windows paths that need quoting", () => {
    expect(
      formatClaudeLoginCommand(
        "C:\\Users\\me\\AppData\\Local\\Claude App\\claude.exe",
        "win32",
      ),
    ).toBe(
      '& "C:\\Users\\me\\AppData\\Local\\Claude App\\claude.exe" auth login --claudeai',
    );
  });

  it("formats the bundled macOS runtime as a directly runnable login command", () => {
    expect(
      formatClaudeLoginCommand(
        "/Applications/Yep Anywhere.app/Contents/Resources/claude",
        "darwin",
      ),
    ).toBe(
      "'/Applications/Yep Anywhere.app/Contents/Resources/claude' auth login --claudeai",
    );
  });
});
