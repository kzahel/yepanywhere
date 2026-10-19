import type { EffortLevel, ModelInfo } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../../../src/sdk/providers/claude.js";
import { applyClaudeModelEffortDefaults } from "../../../src/sdk/providers/claude-model-effort.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  query,
}));

type LaunchOptions = Pick<
  Parameters<ClaudeProvider["startSession"]>[0],
  "model" | "thinking" | "effort"
>;

/** The `effort` the provider hands the Agent SDK for one launch. */
async function launchedEffort(
  options: LaunchOptions,
  overrides?: Record<string, EffortLevel>,
): Promise<unknown> {
  let launched: Record<string, unknown> = {};
  query.mockImplementation(({ options: queryOptions }) =>
    (async function* () {
      launched = queryOptions;
      yield { type: "result", session_id: "sess", subtype: "success" };
    })(),
  );
  const provider = new ClaudeProvider();
  provider.setModelEffortLevelsGetter(() => overrides);
  const session = await provider.startSession({
    cwd: process.cwd(),
    ...options,
  });
  try {
    for await (const _message of session.iterator) {
      // drain the single result
    }
  } finally {
    await session.abort();
  }
  return launched.effort;
}

const auto = { type: "adaptive", display: "summarized" } as const;

describe("Claude per-model effort defaults", () => {
  afterEach(() => {
    query.mockReset();
  });

  it("passes the catalog default through when thinking is auto", async () => {
    // The built-in catalog lists Opus at High; the client shows that level.
    expect(await launchedEffort({ model: "opus", thinking: auto })).toBe(
      "high",
    );
  });

  it("uses the saved per-model effort when thinking is auto", async () => {
    expect(
      await launchedEffort(
        { model: "opus", thinking: auto },
        { opus: "low", haiku: "high" },
      ),
    ).toBe("low");
  });

  it("keeps an explicit effort over the saved per-model effort", async () => {
    expect(
      await launchedEffort(
        { model: "opus", thinking: auto, effort: "max" },
        { opus: "low" },
      ),
    ).toBe("max");
  });

  it("requests no effort when thinking is disabled", async () => {
    expect(
      await launchedEffort(
        { model: "opus", thinking: { type: "disabled" } },
        { opus: "low" },
      ),
    ).toBeUndefined();
  });

  it("leaves Claude Code's default for a model without a catalog default", async () => {
    expect(
      await launchedEffort({ model: "sonnet", thinking: auto }),
    ).toBeUndefined();
  });

  it("reports only supported overrides as the model default", () => {
    const models: ModelInfo[] = [
      {
        id: "opus",
        name: "Opus",
        supportedEffortLevels: ["low", "high"],
        defaultEffortLevel: "high",
      },
      { id: "plain", name: "Plain", supportsEffort: false },
    ];
    expect(
      applyClaudeModelEffortDefaults(models, {
        opus: "low",
        plain: "high",
      }).map((model) => model.defaultEffortLevel),
    ).toEqual(["low", undefined]);
    expect(
      applyClaudeModelEffortDefaults(models, { opus: "max" })[0]
        ?.defaultEffortLevel,
    ).toBe("high");
  });
});
