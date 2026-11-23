import { getLogger } from "../logging/logger.js";
import {
  ProviderMemoryBudget,
  ProviderMemoryCapacityError,
} from "../sdk/providers/provider-memory-budget.mjs";
import type { AgentProvider, AuthStatus } from "../sdk/providers/types.js";
import { RouterRefusedBeforeProvider } from "../services/AgentAuthRouter.js";
import type {
  CreationAttemptFence,
  SavedSessionCreation,
  SessionCreationStore,
} from "../sessions/SessionCreationStore.js";
import type { Process } from "./Process.js";

const budgets = new WeakMap<
  ReadonlyMap<string, Process>,
  ProviderMemoryBudget
>();

export class ClaudeExecutableUnavailable extends Error {
  readonly outcome = "claude-executable-unavailable";

  constructor() {
    super(
      "The Claude Code executable is missing or cannot run. If you just updated dependencies, reload the Yep Anywhere server and retry. If you configured a custom executable, check its path and permissions.",
    );
  }
}

/** An installed provider refused before any effect, with the user's next step. */
export class ProviderStartupUnavailable extends Error {
  readonly outcome = "startup-unavailable";
}

export function assertSavedProviderLaunch(
  provider: AgentProvider | null,
  hosted: boolean,
  hasInlineImage: boolean,
): asserts provider is AgentProvider {
  if (hasInlineImage && !provider?.supportsInlineImages)
    throw new Error(
      "This provider does not accept inline images; use uploaded file references instead",
    );
  if (
    !provider ||
    (provider.runtimeOwner ?? "local") !== (hosted ? "host" : "local")
  )
    throw new Error("Saved creation cannot switch its selected runtime owner");
  if (!provider.getNewSessionNamespace)
    throw new Error("Provider has no durable namespace contract");
}

export function resolveSavedCreationNamespace(
  provider: AgentProvider,
  projectPath: string,
  sessionSandbox: Parameters<
    NonNullable<AgentProvider["getNewSessionNamespace"]>
  >[1],
  routed: boolean,
) {
  return provider.getNewSessionNamespace!(projectPath, sessionSandbox, {
    routed,
  });
}

export function assertSavedProviderReady(
  store: SessionCreationStore,
  fence: CreationAttemptFence,
  providerName: AgentProvider["name"],
  auth: AuthStatus,
  routed: boolean,
): void {
  store.assertCurrent(fence);
  if (!auth.installed && providerName === "claude") {
    const error = new ClaudeExecutableUnavailable();
    store.failBeforeEffects(fence, error.outcome);
    throw error;
  }
  if (!auth.installed && auth.unavailableReason) {
    const error = new ProviderStartupUnavailable(auth.unavailableReason);
    store.failBeforeEffects(fence, error.outcome, error.message);
    throw error;
  }
  if (
    !auth.installed ||
    (!routed && (!auth.authenticated || auth.enabled === false))
  ) {
    store.failBeforeEffects(fence, "startup-unavailable");
    throw new Error("Provider startup is unavailable");
  }
}

export function reserveLocalMemory(
  processes: ReadonlyMap<string, Process>,
  provider: AgentProvider,
): Promise<() => void> | undefined {
  if (provider.runtimeOwner === "host") return;
  let budget = budgets.get(processes);
  if (!budget) {
    budget = new ProviderMemoryBudget();
    budgets.set(processes, budget);
  }
  return budget.reserve(provider.name, () =>
    Array.from(processes.values(), (process) => ({
      provider: process.provider,
      pid: process.pid,
    })),
  );
}

export function recordKnownProviderRefusal(
  store: SessionCreationStore,
  fence: CreationAttemptFence,
  creation: SavedSessionCreation,
  error: unknown,
): boolean {
  if (
    creation.attempt.state !== "dispatching" ||
    creation.attempt.delivery !== "not-admitted"
  )
    return false;
  if (error instanceof ProviderMemoryCapacityError) {
    store.failBeforeProvider(fence, "launch-refused", error.message);
    return true;
  }
  if (!(error instanceof RouterRefusedBeforeProvider)) return false;
  store.failBeforeProvider(
    fence,
    error.loginRequired ? "router-login-required" : "router-refused",
    error.message,
  );
  getLogger().warn(
    {
      event: "agent_auth_router_refused",
      sessionId: creation.sessionId,
      routerStatus: error.status,
      code: error.code,
      loginRequired: error.loginRequired,
      error: error.message,
    },
    "Agent Auth Router refused a new session before provider start",
  );
  return true;
}
