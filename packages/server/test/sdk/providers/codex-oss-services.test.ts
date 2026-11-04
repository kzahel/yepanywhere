import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayService, ModelCatalogRoute } from "@yep-anywhere/shared";
import { CodexOSSProvider } from "../../../src/sdk/providers/codex-oss.js";
import type { ProviderInstallationCoordinator } from "../../../src/services/ProviderInstallationCoordinator.js";
import { gatewayEffortProbeCache } from "../../../src/services/GatewayEffortProbe.js";
import type { StartSessionOptions } from "../../../src/sdk/providers/types.js";

type TurnRoute = ModelCatalogRoute<string | undefined>;

interface CodexOSSInternals {
  buildFirstTurnArgs(options: StartSessionOptions, route: TurnRoute): string[];
  buildResumeTurnArgs(
    options: StartSessionOptions,
    route: TurnRoute,
    sessionId: string,
    prompt: string,
  ): string[];
  resolveModelRoute(model: string | undefined): TurnRoute;
  launchGatewayRoute(
    options: StartSessionOptions,
  ): Promise<ModelCatalogRoute | null>;
}

class ExposedCodexOSSProvider extends CodexOSSProvider {
  private get internals(): CodexOSSInternals {
    return this as unknown as CodexOSSInternals;
  }

  /**
   * The route a turn uses: the launch-bound one when given, as `runSession`
   * passes it, else what the current catalog says.
   */
  private turnRoute(
    model: string | undefined,
    launched: ModelCatalogRoute | null | undefined,
  ): TurnRoute {
    if (launched === undefined) return this.internals.resolveModelRoute(model);
    return launched ?? { serviceId: undefined, modelId: model ?? "" };
  }

  firstTurnArgs(
    model?: string,
    turn: Partial<StartSessionOptions> = {},
    launched?: ModelCatalogRoute | null,
  ): string[] {
    return this.internals.buildFirstTurnArgs(
      { model, ...turn } as StartSessionOptions,
      this.turnRoute(model, launched),
    );
  }

  resumeTurnArgs(
    model: string | undefined,
    sessionId: string,
    turn: Partial<StartSessionOptions> = {},
    launched?: ModelCatalogRoute | null,
  ): string[] {
    return this.internals.buildResumeTurnArgs(
      { model, ...turn } as StartSessionOptions,
      this.turnRoute(model, launched),
      sessionId,
      "go",
    );
  }

  launchRoute(
    options: Partial<StartSessionOptions>,
  ): Promise<ModelCatalogRoute | null> {
    return this.internals.launchGatewayRoute(options as StartSessionOptions);
  }
}

/** Lets a session start without touching the machine's Codex installation. */
const noInstallation = {
  acquireRuntimeLease: async () => ({ release: async () => {} }),
  getSourceVersion: () => "test",
} as unknown as ProviderInstallationCoordinator;

function service(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    id: "vllm",
    label: "DeepSeek V4 Flash",
    shortName: "vllm",
    url: "http://127.0.0.1:8001",
    enabled: true,
    autoStop: false,
    autoStopAfterSeconds: 0,
    codexEnabled: true,
    codexWireApi: "responses",
    ...overrides,
  };
}

/** The rows a live vLLM server returns, minus the fields Codex ignores. */
function vllmCatalog(ids: string[], maxModelLen = 252_000) {
  return new Response(
    JSON.stringify({
      data: ids.map((id) => ({
        id,
        object: "model",
        owned_by: "vllm",
        max_model_len: maxModelLen,
      })),
    }),
    { status: 200 },
  );
}

describe("CodexOSS gateway services", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // The probe cache is process-wide and keyed by endpoint, so one test's
    // answer about 127.0.0.1:8001 would otherwise stand in for the next's.
    gatewayEffortProbeCache.forget();
  });

  it("lists models from a configured endpoint instead of ollama", async () => {
    const fetchMock = vi.fn(async () =>
      vllmCatalog(["deepseek-v4-flash", "deepseek-v4-flash-0731"]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);

    // The catalog states no effort vocabulary — no OpenAI-compatible row does —
    // so the levels come from what YA knows about the model family.
    const deepseekEffort = {
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "max"],
      supportedReasoningEfforts: [
        { reasoningEffort: "none" },
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
        { reasoningEffort: "max" },
      ],
      defaultEffortLevel: "high",
      defaultReasoningEffort: "high",
      supportsAdaptiveThinking: true,
    };
    await expect(provider.getAvailableModels()).resolves.toEqual([
      {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        contextWindow: 252_000,
        ...deepseekEffort,
      },
      {
        id: "deepseek-v4-flash-0731",
        name: "deepseek-v4-flash-0731",
        contextWindow: 252_000,
        ...deepseekEffort,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8001/v1/models",
      expect.anything(),
    );
  });

  it("reports itself usable with a configured endpoint and no ollama", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);

    await expect(provider.isAuthenticated()).resolves.toBe(true);
  });

  it("launches through a model provider override, not --oss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([
      service({ codexWireApi: "responses", contextWindowTokens: 252_000 }),
    ]);
    await provider.getAvailableModels();

    const args = provider.firstTurnArgs("deepseek-v4-flash");
    expect(args).toEqual([
      "exec",
      "-c",
      'model_providers.ya_vllm.name="DeepSeek V4 Flash"',
      "-c",
      'model_providers.ya_vllm.base_url="http://127.0.0.1:8001/v1"',
      "-c",
      'model_providers.ya_vllm.wire_api="responses"',
      "-c",
      'model_provider="ya_vllm"',
      "--json",
      "--model",
      "deepseek-v4-flash",
      "-s",
      "workspace-write",
    ]);
    expect(args).not.toContain("--oss");

    expect(provider.resumeTurnArgs("deepseek-v4-flash", "thread-1")).toEqual([
      "exec",
      "resume",
      "thread-1",
      "go",
      "--json",
      "-c",
      'model_providers.ya_vllm.name="DeepSeek V4 Flash"',
      "-c",
      'model_providers.ya_vllm.base_url="http://127.0.0.1:8001/v1"',
      "-c",
      'model_providers.ya_vllm.wire_api="responses"',
      "-c",
      'model_provider="ya_vllm"',
      "-c",
      'model="deepseek-v4-flash"',
    ]);
  });

  it("keeps an endpoint's routes when a later catalog read fails", async () => {
    const fetchMock = vi.fn(async () => vllmCatalog(["deepseek-v4-flash"]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    await provider.getAvailableModels();

    // Unreadable answers teach nothing; the session's next turn still goes to
    // the endpoint it was using rather than to the local provider.
    for (const unreadable of [
      async () => new Response("overloaded", { status: 503 }),
      async () => new Response(JSON.stringify({ object: "list" })),
      async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ]) {
      fetchMock.mockImplementationOnce(unreadable);
      await expect(provider.getAvailableModels()).resolves.toEqual([]);
      expect(
        provider.resumeTurnArgs("deepseek-v4-flash", "thread-1"),
      ).toContain('model_provider="ya_vllm"');
    }

    // A successful read is authoritative, including one that no longer lists
    // the model.
    fetchMock.mockImplementationOnce(async () => vllmCatalog(["other-model"]));
    await provider.getAvailableModels();
    expect(provider.resumeTurnArgs("deepseek-v4-flash", "thread-1")).toContain(
      'model_provider="ollama"',
    );
  });

  it("underscores a hyphenated service id into the provider key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service({ id: "local-vllm" })]);
    await provider.getAvailableModels();

    // The same key the export writes into ya-local-vllm.config.toml, which is
    // why both spell it through the shared `codexProviderKey`.
    expect(provider.firstTurnArgs("deepseek-v4-flash")).toContain(
      'model_provider="ya_local_vllm"',
    );
  });

  it("quotes a label and a model id that carry TOML metacharacters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(['deepseek\\v4 "flash"'])),
    );
    const provider = new ExposedCodexOSSProvider();
    // Both are values the user or the endpoint can supply: a label only has to
    // be trimmed and free of control characters, and a model id is whatever
    // the catalog row says.
    provider.setGatewayServices([service({ label: 'My "vLLM" \\ box' })]);
    await provider.getAvailableModels();

    expect(provider.firstTurnArgs('deepseek\\v4 "flash"')).toContain(
      'model_providers.ya_vllm.name="My \\"vLLM\\" \\\\ box"',
    );
    expect(
      provider.resumeTurnArgs('deepseek\\v4 "flash"', "thread-1"),
    ).toContain('model="deepseek\\\\v4 \\"flash\\""');
  });

  it("carries the selected effort to the endpoint, and nothing when unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    await provider.getAvailableModels();

    expect(
      provider.firstTurnArgs("deepseek-v4-flash", { effort: "max" }),
    ).toContain('model_reasoning_effort="max"');
    expect(
      provider.resumeTurnArgs("deepseek-v4-flash", "thread-1", {
        effort: "low",
      }),
    ).toContain('model_reasoning_effort="low"');

    // A vanilla turn states no effort, so the endpoint keeps its own default.
    expect(provider.firstTurnArgs("deepseek-v4-flash").join(" ")).not.toContain(
      "model_reasoning_effort",
    );
  });

  it("snaps an unlisted effort down rather than asking for it", async () => {
    // DeepSeek V4 treats medium exactly as low, so it lists only the levels
    // that reach a distinct behavior; a session carrying medium from another
    // model must not end up buying more thinking than was asked for.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    await provider.getAvailableModels();

    expect(
      provider.firstTurnArgs("deepseek-v4-flash", { effort: "medium" }),
    ).toContain('model_reasoning_effort="low"');
    expect(
      provider.firstTurnArgs("deepseek-v4-flash", { effort: "xhigh" }),
    ).toContain('model_reasoning_effort="high"');
  });

  it("turns thinking off through the effort the wire does carry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    await provider.getAvailableModels();

    expect(
      provider.firstTurnArgs("deepseek-v4-flash", {
        thinking: { type: "disabled" },
      }),
    ).toContain('model_reasoning_effort="none"');
  });

  it("takes configured levels over the model family YA knows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([
      service({ effortLevels: ["low", "medium"], defaultEffortLevel: "low" }),
    ]);
    const [model] = await provider.getAvailableModels();

    expect(model?.supportedEffortLevels).toEqual(["low", "medium"]);
    expect(model?.defaultEffortLevel).toBe("low");
    expect(
      provider.firstTurnArgs("deepseek-v4-flash", { effort: "medium" }),
    ).toContain('model_reasoning_effort="medium"');
  });

  it("states no effort for a model nothing describes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["qwen3-coder-30b"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    const [model] = await provider.getAvailableModels();

    // Said explicitly rather than left unstated: the client offers a thinking
    // control for a model that says nothing, so silence would show one here.
    expect(model?.supportsEffort).toBe(false);
    expect(model?.supportsAdaptiveThinking).toBe(false);
    expect(model?.supportedEffortLevels).toBeUndefined();
    expect(
      provider.firstTurnArgs("qwen3-coder-30b", { effort: "high" }).join(" "),
    ).not.toContain("model_reasoning_effort");
  });

  it("offers the effort a copilot-style row advertises, as Claude Gateway does", async () => {
    // The asymmetry this covers: CodexOSS used to ignore a row's own claim, so
    // the same endpoint offered effort through one provider and not the other.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "gpt-5-codex",
              capabilities: { supports: { reasoning_effort: ["low", "high"] } },
            },
          ],
        }),
      ),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    const [model] = await provider.getAvailableModels();

    expect(model).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAdaptiveThinking: true,
    });
    expect(provider.firstTurnArgs("gpt-5-codex", { effort: "high" })).toContain(
      'model_reasoning_effort="high"',
    );
  });

  it("offers what the endpoint answered when nothing else describes the model", async () => {
    // A vLLM row for an unknown family states nothing, so without the probe
    // this model would carry no effort control at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/v1/models")
          ? vllmCatalog(["qwen3-coder-30b"])
          : new Response(
              JSON.stringify({
                error: {
                  message:
                    "{'loc': 'body.reasoning_effort', 'msg': \"Input should " +
                    "be 'none', 'low', 'high'\"}",
                },
              }),
              { status: 400 },
            ),
      ),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    const [model] = await provider.getAvailableModels();

    expect(model).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAdaptiveThinking: true,
      // The Responses API carries "none", so thinking-off is expressible.
      supportedReasoningEfforts: [
        { reasoningEffort: "none" },
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
    });
    // A launch must reach the same answer the catalog read published, which it
    // cannot re-derive from configuration alone.
    expect(
      provider.firstTurnArgs("qwen3-coder-30b", { effort: "high" }),
    ).toContain('model_reasoning_effort="high"');
  });

  it("does not ask an endpoint whose levels are already configured", async () => {
    const fetchMock = vi.fn(async () => vllmCatalog(["qwen3-coder-30b"]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service({ effortLevels: ["low", "high"] })]);
    await provider.getAvailableModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/chat/completions"),
      expect.anything(),
    );
  });

  it("still emits the legacy chat wire API when one is configured", async () => {
    // Current Codex refuses `chat`, but an older CLI needs it, so an explicit
    // choice is passed through rather than silently upgraded.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service({ codexWireApi: "chat" })]);
    await provider.getAvailableModels();

    expect(provider.firstTurnArgs("deepseek-v4-flash")).toContain(
      'model_providers.ya_vllm.wire_api="chat"',
    );
  });

  it("keeps the ollama path when no endpoint is configured", () => {
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([]);

    expect(provider.firstTurnArgs("qwen2.5-coder:32b-32k")).toEqual([
      "exec",
      "--oss",
      "--local-provider",
      "ollama",
      "--json",
      "--model",
      "qwen2.5-coder:32b-32k",
      "-s",
      "workspace-write",
    ]);
  });

  it("ignores an endpoint that did not opt into CodexOSS", async () => {
    const fetchMock = vi.fn(async () => vllmCatalog(["deepseek-v4-flash"]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service({ codexEnabled: false })]);

    // No endpoint is available to it, so it falls back to asking Ollama.
    await provider.getAvailableModels();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("launches a collision-qualified model under its plain name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("http://127.0.0.1:8001")
          ? vllmCatalog(["shared-model"])
          : vllmCatalog(["shared-model"], 32_768),
      ),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([
      service(),
      service({ id: "second", label: "", url: "http://127.0.0.1:8002" }),
    ]);

    const models = await provider.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual([
      "vllm::shared-model",
      "second::shared-model",
    ]);

    const args = provider.firstTurnArgs("second::shared-model");
    expect(args).toContain(
      'model_providers.ya_second.base_url="http://127.0.0.1:8002/v1"',
    );
    expect(args[args.indexOf("--model") + 1]).toBe("shared-model");
  });

  it("launches a worker that never read its catalog against the endpoint the server chose", async () => {
    // A provider-host worker: the same configuration, and no catalog read.
    const fetchMock = vi.fn(async () => {
      throw new Error("a worker must not read the catalog");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider({
      installationCoordinator: noInstallation,
    });
    provider.setGatewayServices([service()]);
    const chosen = { serviceId: "vllm", modelId: "deepseek-v4-flash" };

    // Resolved from its own empty catalog, the model looks local.
    expect(provider.firstTurnArgs("deepseek-v4-flash")).toContain("--oss");

    const route = await provider.launchRoute({
      model: "deepseek-v4-flash",
      gatewayRoute: chosen,
    });
    expect(route).toEqual(chosen);
    expect(provider.firstTurnArgs("deepseek-v4-flash", {}, route)).toContain(
      'model_provider="ya_vllm"',
    );
    await expect(
      provider.launchRoute({ model: "llama3.2", gatewayRoute: null }),
    ).resolves.toBeNull();

    const session = await provider.startSession({
      cwd: "/tmp",
      model: "deepseek-v4-flash",
      gatewayRoute: chosen,
    });
    expect(session.gatewayServiceId).toBe("vllm");
    await session.abort();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads its catalog once to place a model it has not seen", async () => {
    const fetchMock = vi.fn(async () => vllmCatalog(["deepseek-v4-flash"]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ExposedCodexOSSProvider({
      installationCoordinator: noInstallation,
    });
    // Stated levels keep the read from also probing the endpoint's efforts,
    // so every request counted here is a catalog read.
    provider.setGatewayServices([service({ effortLevels: ["low", "high"] })]);

    // After a server restart nothing has read the catalog yet.
    const session = await provider.startSession({
      cwd: "/tmp",
      model: "deepseek-v4-flash",
    });
    expect(session.gatewayServiceId).toBe("vllm");
    await session.abort();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      provider.launchRoute({ model: "deepseek-v4-flash" }),
    ).resolves.toEqual({ serviceId: "vllm", modelId: "deepseek-v4-flash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a session on its launch endpoint after a second one starts serving its model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => vllmCatalog(["deepseek-v4-flash"])),
    );
    const provider = new ExposedCodexOSSProvider();
    provider.setGatewayServices([service()]);
    await provider.getAvailableModels();
    const launched = await provider.launchRoute({ model: "deepseek-v4-flash" });

    provider.setGatewayServices([
      service(),
      service({ id: "second", label: "", url: "http://127.0.0.1:8002" }),
    ]);
    const models = await provider.getAvailableModels();
    // The catalog now names the model only with a service prefix, so the bare
    // id the session launched with places nowhere.
    expect(models.map((model) => model.id)).toEqual([
      "vllm::deepseek-v4-flash",
      "second::deepseek-v4-flash",
    ]);
    expect(provider.resumeTurnArgs("deepseek-v4-flash", "thread-1")).toContain(
      'model_provider="ollama"',
    );

    expect(
      provider.resumeTurnArgs("deepseek-v4-flash", "thread-1", {}, launched),
    ).toContain('model_provider="ya_vllm"');
  });
});
