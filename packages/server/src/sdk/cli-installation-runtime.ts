import {
  CODEX_INSTALLATION_FAMILY,
  type ProviderInstallationCoordinator,
} from "../services/ProviderInstallationCoordinator.js";
import type { CliInstallationSelections } from "@yep-anywhere/shared/provider-cli-installations";
import { CliInstallationService } from "../services/CliInstallationService.js";
import {
  antigravityInstallationAdapter,
  codexInstallationAdapter,
} from "./cli-installation-adapters.js";
import {
  getCliInstallationService,
  setCliInstallationService,
} from "./cli-installation-context.js";
import {
  findCodexCliPath,
  type InstallationReadCoordinator,
} from "./cli-detection.js";

export function configureCliInstallations(
  dataDir: string,
  selections: () => CliInstallationSelections,
  managed: () => CliInstallationSelections,
): CliInstallationService {
  const service = new CliInstallationService(
    dataDir,
    [codexInstallationAdapter, antigravityInstallationAdapter],
    selections,
    managed,
  );
  setCliInstallationService(service);
  return service;
}

export async function verifiedCodexLaunchPath(
  explicit?: string,
  coordinator?: InstallationReadCoordinator,
): Promise<string> {
  const service = getCliInstallationService();
  if (service) return (await service.resolve("codex", explicit)).command;
  // Standalone adapters without a server installation owner keep their existing
  // lazy launch behavior. Full YA servers install the verification gate above.
  return (
    explicit ?? (await findCodexCliPath(undefined, coordinator)) ?? "codex"
  );
}

export const codexCli = {
  find: findCodexCliPath,
  launch: (explicit?: string, coordinator?: InstallationReadCoordinator) =>
    getCliInstallationService()
      ? verifiedCodexLaunchPath(explicit, coordinator)
      : findCodexCliPath(explicit, coordinator),
  catalogKey: (
    coordinator: Pick<ProviderInstallationCoordinator, "getSourceVersion">,
  ) =>
    `${coordinator.getSourceVersion(CODEX_INSTALLATION_FAMILY)}\0${getCliInstallationService()?.selectedPath("codex") ?? "auto"}`,
};
