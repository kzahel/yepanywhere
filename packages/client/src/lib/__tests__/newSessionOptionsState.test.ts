import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { LaunchLock } from "../limitedLaunchLock";
import {
  INITIAL_NEW_SESSION_OPTIONS,
  type NewSessionOptionsState,
  chooseNewSessionThinking,
  fillCatalogModel,
  fillGatewayModel,
  newSessionDefaultsToSave,
  newSessionOptionsReducer,
  seedNewSessionOptions,
  switchNewSessionProvider,
} from "../newSessionOptionsState";

const provider = (
  name: string,
  models: string[],
  installed = true,
): ProviderInfo =>
  ({
    name,
    displayName: name,
    installed,
    authenticated: true,
    enabled: true,
    supportsRecaps: true,
    models: models.map((id) => ({ id, name: id })),
  }) as unknown as ProviderInfo;

const claude = provider("claude", ["default", "opus"]);
const codex = provider("codex", ["gpt-6", "gpt-5"]);
const noLegacySeed = () => ({});
const unlocked: LaunchLock = {
  limited: false,
  provider: null,
  model: null,
  effort: null,
};
const state = (
  patch: Partial<NewSessionOptionsState> = {},
): NewSessionOptionsState => ({ ...INITIAL_NEW_SESSION_OPTIONS, ...patch });
const seed = (
  input: Partial<Parameters<typeof seedNewSessionOptions>[0]> = {},
) =>
  seedNewSessionOptions({
    providerRows: [claude, codex],
    savedDefaults: undefined,
    supportsSessionSandboxing: true,
    sourceKey: "host:a",
    legacySeed: noLegacySeed,
    ...input,
  });

describe("newSessionOptionsReducer", () => {
  it("returns the same state when an action changes nothing", () => {
    const initial = state();
    // Source change on mount, a lock that settles nothing, an equal choice
    // and an unmatched thinking row: returning the same state lets React
    // skip the children and effects.
    expect(
      newSessionOptionsReducer(initial, {
        type: "sourceChanged",
        sourceKey: "host:a",
      }),
    ).toBe(initial);
    expect(
      newSessionOptionsReducer(initial, { type: "lock", lock: unlocked }),
    ).toBe(initial);
    expect(
      newSessionOptionsReducer(initial, {
        type: "choose",
        field: "mode",
        value: "default",
      }),
    ).toBe(initial);
    expect(
      newSessionOptionsReducer(initial, {
        type: "chooseThinking",
        selection: "on:max",
        effortOptions: [{ value: "low" }],
      }),
    ).toBe(initial);

    const locked: LaunchLock = {
      limited: true,
      provider: "codex",
      model: "gpt-6",
      effort: "medium",
    };
    const once = newSessionOptionsReducer(initial, {
      type: "lock",
      lock: locked,
    });
    expect(once).not.toBe(initial);
    expect(newSessionOptionsReducer(once, { type: "lock", lock: locked })).toBe(
      once,
    );
  });

  it("keeps a router preference only for its own source (T1)", () => {
    const preference = { sourceKey: "host:a", poolId: "work", accountId: "" };
    const chosen = state({
      routerPreference: preference,
      routerSelectionCustomized: true,
      routerConnectorsChoice: true,
    });
    expect(
      newSessionOptionsReducer(chosen, {
        type: "sourceChanged",
        sourceKey: "host:a",
      }),
    ).toMatchObject({
      routerPreference: preference,
      routerSelectionCustomized: false,
      routerConnectorsChoice: null,
    });
    expect(
      newSessionOptionsReducer(chosen, {
        type: "sourceChanged",
        sourceKey: "host:b",
      }).routerPreference,
    ).toBeNull();
  });

  it("settles a limited user's locked fields and forced sandbox (T3)", () => {
    const next = newSessionOptionsReducer(
      state({
        selectedRecapMode: "side-session",
        sandboxNetworkFirewall: false,
      }),
      {
        type: "lock",
        lock: {
          limited: true,
          provider: "newer-provider",
          model: "m",
          effort: "colossal",
        },
      },
    );
    // A provider or effort this client cannot name is left as it was, but
    // an effort lock still turns thinking on.
    expect(next).toMatchObject({
      selectedProvider: null,
      selectedModel: "m",
      selectedEffortLevel: "high",
      selectedThinkingMode: "on",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      selectedRecapMode: "off",
    });
  });

  it("turns the firewall on and a side-session recap off with the sandbox (T8)", () => {
    const sandboxed = newSessionOptionsReducer(
      state({
        selectedRecapMode: "side-session",
        sandboxNetworkFirewall: false,
      }),
      { type: "toggleSandbox", enabled: true },
    );
    expect(sandboxed).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      selectedRecapMode: "off",
    });
    const cleared = newSessionOptionsReducer(
      {
        ...sandboxed,
        sandboxNetworkFirewall: false,
        selectedRecapMode: "fork",
      },
      { type: "toggleSandbox", enabled: false },
    );
    expect(cleared).toMatchObject({
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      selectedRecapMode: "fork",
    });
  });

  it("marks a router choice as customized (T9)", () => {
    const selection = { sourceKey: "host:a", poolId: "work", accountId: "" };
    expect(
      newSessionOptionsReducer(state(), { type: "chooseRouter", selection }),
    ).toMatchObject({
      routerPreference: selection,
      routerSelectionCustomized: true,
    });
  });
});

describe("seedNewSessionOptions (T2)", () => {
  it("seeds the saved provider's own defaults and the all-provider ones", () => {
    expect(
      seed({
        savedDefaults: {
          provider: "codex",
          permissionMode: "plan",
          recapAfterSeconds: 120,
          promptSuggestionMode: "native",
          providers: {
            codex: {
              model: "gpt-5",
              serviceTier: "priority",
              thinkingMode: "auto",
              effortLevel: "low",
              routerPoolId: "work",
            },
          },
        },
      }),
    ).toEqual({
      selectedProvider: "codex",
      selectedServiceTier: "priority",
      routerPreference: { sourceKey: "host:a", poolId: "work", accountId: "" },
      routerSelectionCustomized: false,
      selectedModel: "gpt-5",
      selectedThinkingMode: "auto",
      selectedEffortLevel: "low",
      selectedRecapMode: "off",
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      recapAfterSeconds: 120,
      selectedPromptSuggestionMode: "native",
      helperSideModel: "cheapest",
      mode: "plan",
    });
  });

  it("lets a caller's preference outrank the saved provider and model", () => {
    expect(
      seed({
        savedDefaults: { provider: "codex" },
        preferredProvider: "claude",
        preferredModel: "opus",
        preferredThinking: "on:max",
        preferredPermissionMode: "acceptEdits",
      }),
    ).toMatchObject({
      selectedProvider: "claude",
      selectedModel: "opus",
      selectedThinkingMode: "on",
      selectedEffortLevel: "max",
      mode: "acceptEdits",
    });
    // A preferred model the catalog does not list is not taken.
    expect(
      seed({ preferredProvider: "claude", preferredModel: "missing" })
        ?.selectedModel,
    ).toBe("default");
    // Before the catalog answers, the preferred model is taken, except for
    // Gateway, whose models exist only in its catalog.
    expect(
      seed({
        providerRows: [],
        preferredProvider: "claude",
        preferredModel: "opus",
      })?.selectedModel,
    ).toBe("opus");
    expect(
      seed({
        providerRows: [],
        preferredProvider: "claude-gateway",
        preferredModel: "opus",
      }),
    ).toMatchObject({
      selectedProvider: "claude-gateway",
      selectedModel: null,
    });
  });

  it("seeds the saved provider before its catalog is known, and nothing when none is launchable", () => {
    expect(
      seed({ providerRows: [], savedDefaults: { provider: "codex" } }),
    ).toMatchObject({ selectedProvider: "codex" });
    expect(
      seed({ providerRows: [provider("claude", ["opus"], false)] }),
    ).toBeNull();
  });

  it("restores a saved sandbox only where the server supports it", () => {
    const savedDefaults = {
      provider: "claude" as const,
      sandboxLevel: "project-write" as const,
      recapMode: "side-session" as const,
    };
    expect(seed({ savedDefaults })).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      selectedRecapMode: "off",
    });
    expect(
      seed({
        savedDefaults: { ...savedDefaults, sandboxNetworkFirewall: false },
      })?.sandboxNetworkFirewall,
    ).toBe(false);
    expect(
      seed({ savedDefaults, supportsSessionSandboxing: false }),
    ).toMatchObject({
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      selectedRecapMode: "side-session",
    });
  });
});

describe("switchNewSessionProvider (T4)", () => {
  it("restores the switched provider's own saved choices", () => {
    expect(
      switchNewSessionProvider({
        providerName: "codex",
        providers: [claude, codex],
        savedDefaults: {
          provider: "claude",
          providers: {
            codex: {
              model: "gpt-5",
              thinkingMode: "auto",
              helperSideModel: "gpt-6",
            },
          },
        },
        sourceKey: "host:a",
        legacySeed: noLegacySeed,
      }),
    ).toEqual({
      selectedProvider: "codex",
      selectedServiceTier: null,
      routerPreference: null,
      routerSelectionCustomized: false,
      selectedModel: "gpt-5",
      selectedThinkingMode: "auto",
      selectedEffortLevel: "high",
      helperSideModel: "gpt-6",
    });
  });

  it("leaves the model empty until a catalog arrives", () => {
    expect(
      switchNewSessionProvider({
        providerName: "codex",
        providers: [claude, provider("codex", [])],
        savedDefaults: undefined,
        sourceKey: "host:a",
        legacySeed: noLegacySeed,
      }).selectedModel,
    ).toBeNull();
  });
});

describe("model fills (T5, T6)", () => {
  const models = [
    { id: "a", name: "a" },
    { id: "b", name: "b" },
  ];
  const input = {
    availableModels: models,
    savedDefaults: { providers: { "claude-gateway": { model: "b" } } },
    legacySeed: noLegacySeed,
  };

  it("keeps a Gateway model only while the catalog advertises it", () => {
    expect(
      fillGatewayModel({
        ...input,
        selectedProvider: "claude",
        selectedModel: "x",
      }),
    ).toBeNull();
    expect(
      fillGatewayModel({
        ...input,
        selectedProvider: "claude-gateway",
        selectedModel: "a",
      }),
    ).toBeNull();
    expect(
      fillGatewayModel({
        ...input,
        selectedProvider: "claude-gateway",
        selectedModel: "retired",
      }),
    ).toEqual({ selectedModel: "b", helperSideModel: "cheapest" });
    // An empty catalog leaves an empty model, and a chosen helper, alone.
    expect(
      fillGatewayModel({
        ...input,
        availableModels: [],
        selectedProvider: "claude-gateway",
        selectedModel: null,
      }),
    ).toBeNull();
  });

  it("fills a provider's model once its catalog arrives, keeping a pick", () => {
    expect(
      fillCatalogModel({
        ...input,
        selectedProvider: "claude-gateway",
        selectedModel: null,
      }),
    ).toEqual({ selectedModel: "b", helperSideModel: "cheapest" });
    expect(
      fillCatalogModel({
        ...input,
        selectedProvider: "claude-gateway",
        selectedModel: "a",
      }),
    ).toBeNull();
    expect(
      fillCatalogModel({
        ...input,
        availableModels: [],
        selectedProvider: "claude-gateway",
        selectedModel: null,
      }),
    ).toBeNull();
  });
});

describe("chooseNewSessionThinking (T7)", () => {
  it("sets Off and Auto alone and an effort row with thinking on", () => {
    const efforts = [{ value: "low" as const }, { value: "high" as const }];
    expect(chooseNewSessionThinking("auto", efforts)).toEqual({
      selectedThinkingMode: "auto",
    });
    expect(chooseNewSessionThinking("on:low", efforts)).toEqual({
      selectedEffortLevel: "low",
      selectedThinkingMode: "on",
    });
    expect(chooseNewSessionThinking("on:max", efforts)).toBeNull();
  });
});

describe("newSessionDefaultsToSave", () => {
  const choices = {
    mode: "auto" as const,
    selectedModel: "opus",
    selectedServiceTier: "priority",
    selectedThinkingMode: "on" as const,
    selectedEffortLevel: "low" as const,
    selectedRecapMode: "fork" as const,
    recapAfterSeconds: 120,
    selectedPromptSuggestionMode: "native" as const,
    sandboxLevel: "project-write" as const,
    sandboxNetworkFirewall: false,
    helperSideModel: "cheapest",
  };
  const save = (
    input: Partial<Parameters<typeof newSessionDefaultsToSave>[0]> = {},
  ) =>
    newSessionDefaultsToSave({
      saved: {
        provider: "codex",
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: true,
        serviceTier: "legacy",
        providers: { codex: { model: "gpt-6" } },
      } as Parameters<typeof newSessionDefaultsToSave>[0]["saved"],
      choices,
      provider: "claude",
      supportsSessionSandboxing: true,
      currentRouterPreference: {
        sourceKey: "host:a",
        poolId: "work",
        accountId: "",
        policy: "round-robin",
      },
      preferClaudeAiConnectors: true,
      legacySeed: noLegacySeed,
      ...input,
    });

  it("saves the raw choices under the provider and keeps other providers", () => {
    expect(save()).toEqual({
      provider: "claude",
      permissionMode: "auto",
      recapMode: "fork",
      recapAfterSeconds: 120,
      promptSuggestionMode: "native",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
      providers: {
        codex: { model: "gpt-6" },
        claude: {
          model: "opus",
          serviceTier: "priority",
          routerPoolId: "work",
          routerPolicy: "round-robin",
          routerClaudeAiConnectors: true,
          thinkingMode: "on",
          effortLevel: "low",
          helperSideModel: "cheapest",
        },
      },
    });
  });

  it("erases a saved sandbox on a host without sandboxing", () => {
    const saved = save({ supportsSessionSandboxing: false });
    expect(saved.sandboxLevel).toBeUndefined();
    expect(saved.sandboxNetworkFirewall).toBeUndefined();
  });

  it("saves the firewall only inside a sandbox and connectors only for Claude", () => {
    expect(
      save({ choices: { ...choices, sandboxLevel: "none" } })
        .sandboxNetworkFirewall,
    ).toBeUndefined();
    expect(
      save({ provider: "codex" }).providers?.codex?.routerClaudeAiConnectors,
    ).toBeUndefined();
  });
});
