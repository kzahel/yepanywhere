import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexCyberAccessProgram,
  type CodexPlanToolMode,
  type CodexReasoningSummary,
  codexCyberAccessProgramWireValue,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import {
  claudeProvider,
  codexProvider,
  configureProviderRuntime,
} from "../src/sdk/providers/index.js";
import {
  buildThreadConfigOverrides,
  type CodexConfigSource,
  createTurnStartParams,
} from "../src/sdk/providers/codex-session-config.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../src/services/ServerSettingsService.js";
import { ScriptedClaudeProvider } from "./support/scripted-provider.js";
import { createApp } from "./setup/create-app.js";

function getClaudeLaunchEnvironment(): Record<string, string | undefined> {
  return (
    claudeProvider as unknown as {
      getEnv(): Record<string, string | undefined>;
    }
  ).getEnv();
}

/** The config source the provider hands its thread and turn builders. */
function getCodexConfigSource(): CodexConfigSource {
  return (codexProvider as unknown as { configSource: CodexConfigSource })
    .configSource;
}

function getCodexThreadConfig(): Record<string, unknown> {
  return buildThreadConfigOverrides(getCodexConfigSource(), {});
}

/** Build a user turn's params as the session loop does, with no denials. */
function getCodexTurnStartParams(): Record<string, unknown> {
  const provider = codexProvider as unknown as {
    getConfiguredCyberAccessProgram(): CodexCyberAccessProgram;
  };
  return createTurnStartParams(
    getCodexConfigSource(),
    "thread-1",
    [],
    { cwd: "/tmp" },
    null,
    null,
    null,
    undefined,
    undefined,
    codexCyberAccessProgramWireValue(
      provider.getConfiguredCyberAccessProgram(),
    ),
  );
}

describe("provider runtime settings", () => {
  const previousOperatorDepth =
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;

  afterEach(() => {
    if (previousOperatorDepth === undefined) {
      delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    } else {
      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = previousOperatorDepth;
    }
    configureProviderRuntime({});
  });

  it("reads the current subagent depth for each provider launch", () => {
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    let subagentMaxDepth: SubagentMaxDepth = 1;
    const getSetting = vi.fn((key: keyof ServerSettings) =>
      key === "subagentMaxDepth" ? subagentMaxDepth : undefined,
    );
    const serverSettingsService = {
      getSetting,
      onSettingsChanged: vi.fn(() => () => {}),
    } as unknown as ServerSettingsService;

    createApp({
      provider: new ScriptedClaudeProvider(),
      serverSettingsService,
    });

    expect(getClaudeLaunchEnvironment()).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
    });

    subagentMaxDepth = 4;
    expect(getClaudeLaunchEnvironment()).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "4",
    });

    subagentMaxDepth = null;
    expect(getClaudeLaunchEnvironment()).not.toHaveProperty(
      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
    );
    expect(
      getSetting.mock.calls.filter(([key]) => key === "subagentMaxDepth"),
    ).toHaveLength(3);

    subagentMaxDepth = 1;
    expect(getCodexThreadConfig()).toMatchObject({ agents: { max_depth: 1 } });
    subagentMaxDepth = 4;
    expect(getCodexThreadConfig()).toMatchObject({ agents: { max_depth: 4 } });
    subagentMaxDepth = null;
    expect(getCodexThreadConfig()).not.toHaveProperty("agents");
  });

  it("reads the current Codex reasoning-summary mode for each thread launch", () => {
    let codexReasoningSummary: CodexReasoningSummary = "auto";
    const getSetting = vi.fn((key: keyof ServerSettings) =>
      key === "codexReasoningSummary" ? codexReasoningSummary : undefined,
    );
    const serverSettingsService = {
      getSetting,
      onSettingsChanged: vi.fn(() => () => {}),
    } as unknown as ServerSettingsService;

    createApp({
      provider: new ScriptedClaudeProvider(),
      serverSettingsService,
    });

    expect(getCodexThreadConfig()).toMatchObject({
      model_reasoning_summary: "auto",
    });

    codexReasoningSummary = "none";
    expect(getCodexThreadConfig()).toMatchObject({
      model_reasoning_summary: "none",
    });
    expect(getSetting).toHaveBeenCalledWith("codexReasoningSummary");
  });

  it.each([
    ["provider-default", undefined],
    ["disabled", false],
    ["enabled", true],
  ] as const)("applies the %s Codex plan-tool mode", (mode, enabled) => {
    createApp({
      provider: new ScriptedClaudeProvider(),
      codexPlanToolMode: mode,
    });

    const config = getCodexThreadConfig();
    if (enabled === undefined) {
      expect(config).not.toHaveProperty("tools.update_plan");
    } else {
      expect(config).toMatchObject({
        tools: { update_plan: { enabled } },
      });
    }
  });

  it.each([
    ["provider-default", undefined],
    ["standard", "standard"],
    ["daybreak-blue", "daybreakBlue"],
    ["daybreak-red", "daybreakRed"],
  ] as const)(
    "sends the %s Codex cyber access program on a turn",
    (program, wireValue) => {
      createApp({
        provider: new ScriptedClaudeProvider(),
        codexCyberAccessProgram: program,
      });

      const params = getCodexTurnStartParams();
      if (wireValue === undefined) {
        expect(params).not.toHaveProperty("cyberAccessProgram");
      } else {
        expect(params).toMatchObject({ cyberAccessProgram: wireValue });
      }
    },
  );

  it("prefers the saved Codex cyber access program over the startup fallback", () => {
    let codexCyberAccessProgram: CodexCyberAccessProgram | undefined;
    const getSetting = vi.fn((key: keyof ServerSettings) =>
      key === "codexCyberAccessProgram" ? codexCyberAccessProgram : undefined,
    );
    const serverSettingsService = {
      getSetting,
      onSettingsChanged: vi.fn(() => () => {}),
    } as unknown as ServerSettingsService;

    createApp({
      provider: new ScriptedClaudeProvider(),
      serverSettingsService,
      codexCyberAccessProgram: "standard",
    });
    expect(getCodexTurnStartParams()).toMatchObject({
      cyberAccessProgram: "standard",
    });

    codexCyberAccessProgram = "daybreak-blue";
    expect(getCodexTurnStartParams()).toMatchObject({
      cyberAccessProgram: "daybreakBlue",
    });

    codexCyberAccessProgram = "provider-default";
    expect(getCodexTurnStartParams()).not.toHaveProperty("cyberAccessProgram");
  });

  it("prefers the saved Codex plan-tool mode over the startup fallback", () => {
    let codexPlanToolMode: CodexPlanToolMode | undefined;
    const getSetting = vi.fn((key: keyof ServerSettings) =>
      key === "codexPlanToolMode" ? codexPlanToolMode : undefined,
    );
    const serverSettingsService = {
      getSetting,
      onSettingsChanged: vi.fn(() => () => {}),
    } as unknown as ServerSettingsService;

    createApp({
      provider: new ScriptedClaudeProvider(),
      serverSettingsService,
      codexPlanToolMode: "enabled",
    });
    expect(getCodexThreadConfig()).toMatchObject({
      tools: { update_plan: { enabled: true } },
    });

    codexPlanToolMode = "disabled";
    expect(getCodexThreadConfig()).toMatchObject({
      tools: { update_plan: { enabled: false } },
    });

    codexPlanToolMode = "provider-default";
    expect(getCodexThreadConfig()).not.toHaveProperty("tools.update_plan");
  });
});
