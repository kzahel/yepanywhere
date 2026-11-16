import { join } from "node:path";
import { codexInstallationAdapter } from "../../../server/src/sdk/cli-installation-adapters.js";
import { CliInstallationService } from "../../../server/src/services/CliInstallationService.js";
import { ProviderInstallationCoordinator } from "../../../server/src/services/ProviderInstallationCoordinator.js";
import type { YaServerProfilePaths } from "./ya-server-process.js";

export async function preverifyOwnedCodexFixture(
  paths: YaServerProfilePaths,
  cli: string,
): Promise<void> {
  // Controlled protocol peers cannot execute the native shell recipe, which
  // native-cli-installation tests exercise with the real executable instead.
  const installations = new CliInstallationService(
    paths.dataDir,
    [{ ...codexInstallationAdapter, verify: async () => {} }],
    () => ({}),
    () => ({}),
    new ProviderInstallationCoordinator({
      rootDir: join(
        paths.profileDir,
        ".yep-anywhere",
        "provider-installations",
      ),
    }),
  );
  await installations.resolve("codex", cli);
}
