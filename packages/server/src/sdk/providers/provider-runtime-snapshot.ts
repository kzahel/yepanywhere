import { configureCliInstallations } from "../cli-installation-runtime.js";
/**
 * Applying a launch snapshot inside a provider worker process.
 *
 * A worker starts the session in its own process, so every provider setting
 * the server holds in module state has to be re-established here from the
 * cloneable snapshot the launch carried. A setting missing from this function
 * is not a setting the worker falls back on — it is one the worker silently
 * ignores, since nothing else in the process ever hears about it.
 */

import { setAntigravityRoutedHomeDir } from "./antigravity-runtime.js";
import { ClaudeGatewayProvider } from "./claude-gateway.js";
import { ClaudeOllamaProvider } from "./claude-ollama.js";
import { codexOSSProvider } from "./codex-oss.js";
import { grokACPProvider } from "./grok-acp.js";
import {
  configureProviderRuntime,
  type ProviderRuntimeSnapshot,
} from "./index.js";
import { gatewayEffortProbeCache } from "../../services/GatewayEffortProbe.js";

export async function applyProviderRuntimeSnapshot(
  config: ProviderRuntimeSnapshot,
): Promise<void> {
  if (config.cliInstallationDataDir)
    configureCliInstallations(
      config.cliInstallationDataDir,
      () => config.cliInstallations ?? {},
      () => ({
        codex: config.codexCliPath,
        antigravity: process.env.ANTIGRAVITY_ACP_PATH,
      }),
    );
  configureProviderRuntime({
    codexCliPath: config.codexCliPath,
    getClaudeAdditionalModels: () => config.claudeAdditionalModels ?? [],
    isClaudeOllamaVisible: () => true,
    getProviderRuntimeSnapshot: () => config,
  });
  setAntigravityRoutedHomeDir(config.antigravityRoutedHomeDir);
  ClaudeOllamaProvider.setOllamaUrl(config.ollamaUrl);
  ClaudeOllamaProvider.setSystemPrompt(config.ollamaSystemPrompt);
  ClaudeOllamaProvider.setUseFullSystemPrompt(
    config.ollamaUseFullSystemPrompt ?? false,
  );
  grokACPProvider.setAmbientXaiApiKey(config.ambientXaiApiKey);
  grokACPProvider.setUseAmbientXaiApiKey(config.grokBuildUseXaiApiKey ?? false);
  // Applied before the services are, as it is on the server, so a catalog read
  // triggered by configuring them already knows whether to ask.
  gatewayEffortProbeCache.setEnabled(
    config.gatewayServiceEffortDetection ?? true,
  );
  codexOSSProvider.setGatewayServices(config.gatewayServices ?? []);
  await ClaudeGatewayProvider.configureGatewayServices({
    services: config.gatewayServices ?? [],
    ...(config.defaultGatewayServiceId
      ? { defaultServiceId: config.defaultGatewayServiceId }
      : {}),
    disableAgent: config.claudeGatewayDisableAgent ?? true,
    disablePlanMode: config.claudeGatewayDisablePlanMode ?? true,
  });
}
