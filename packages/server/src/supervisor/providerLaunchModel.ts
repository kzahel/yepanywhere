import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelSettings } from "./SessionActivationCoordinator.js";

export async function resolveProviderLaunchModel(
  provider: AgentProvider,
  settings: ModelSettings | undefined,
  resuming: boolean,
): Promise<ModelSettings | undefined> {
  const requestedModel = settings?.model;
  if (provider.name !== "claude-gateway" || resuming) return settings;
  if (!requestedModel || requestedModel === "default") {
    throw new Error("Claude Gateway requires a model from its current catalog");
  }
  const models = await provider.getAvailableModels();
  if (!models.some((model) => model.id === requestedModel)) {
    throw new Error(
      `Claude Gateway no longer advertises model ${JSON.stringify(requestedModel)}`,
    );
  }
  return settings;
}
