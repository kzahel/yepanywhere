import { join } from "node:path";
import { setAntigravityRoutedHomeDir } from "./providers/antigravity-runtime.js";
import {
  configureProviderRuntime,
  type ProviderRuntimeConfig,
} from "./providers/index.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { configureCliInstallations } from "./cli-installation-runtime.js";
import {
  getCliInstallationService,
  setCliInstallationService,
} from "./cli-installation-context.js";
import {
  createVersionRoutes,
  type VersionRouteOptions,
} from "../routes/version.js";

export function configureAppProviderRuntime(
  options: {
    dataDir?: string;
    codexCliPath?: string;
    serverSettingsService?: ServerSettingsService;
  },
  config: ProviderRuntimeConfig,
): void {
  const settings = options.serverSettingsService;
  const resolvedDataDir = settings?.dataDirectory ?? options.dataDir;
  const antigravityRoutedHomeDir = resolvedDataDir
    ? join(resolvedDataDir, "agent-auth-router", "antigravity-home")
    : undefined;
  setAntigravityRoutedHomeDir(antigravityRoutedHomeDir);
  if (!settings) setCliInstallationService(undefined);
  if (settings) {
    const dataDir = settings.dataDirectory ?? options.dataDir;
    if (!dataDir)
      throw new Error(
        "Provider installation settings require a YA data directory",
      );
    configureCliInstallations(
      dataDir,
      () => settings.getSetting("cliInstallations") ?? {},
      () => ({
        codex: options.codexCliPath,
        antigravity: process.env.ANTIGRAVITY_ACP_PATH,
      }),
    );
    const snapshot = config.getProviderRuntimeSnapshot;
    config = {
      ...config,
      getProviderRuntimeSnapshot: () => ({
        ...snapshot?.(),
        cliInstallationDataDir: dataDir,
        cliInstallations: settings.getSetting("cliInstallations"),
        ...(antigravityRoutedHomeDir ? { antigravityRoutedHomeDir } : {}),
      }),
    };
  } else if (antigravityRoutedHomeDir) {
    const snapshot = config.getProviderRuntimeSnapshot;
    config = {
      ...config,
      getProviderRuntimeSnapshot: () => ({
        ...snapshot?.(),
        antigravityRoutedHomeDir,
      }),
    };
  }
  configureProviderRuntime(config);
}

export const appProviderRuntime = {
  configure: configureAppProviderRuntime,
  versionRoutes: (options: VersionRouteOptions) =>
    createVersionRoutes({
      ...options,
      cliInstallationsAvailable: Boolean(getCliInstallationService()),
    }),
};
