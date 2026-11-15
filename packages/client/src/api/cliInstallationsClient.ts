import type {
  CliInstallationFamily,
  CliInstallationInventory,
} from "@yep-anywhere/shared/provider-cli-installations";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import type { ClientSummarySourceKey } from "../lib/clientSummaryStore";

export function cliInstallationsApi(sourceKey: ClientSummarySourceKey) {
  const fetchJSON = <T>(path: string, options?: RequestInit) =>
    getSourceRuntimeRegistry()
      .getOrCreateSourceRuntime(sourceKey)
      .transport.fetch<T>(path, options);
  return {
    rescan: (family: CliInstallationFamily) =>
      fetchJSON<CliInstallationInventory>(
        `/settings/cli-installations/${family}/rescan`,
        { method: "POST" },
      ),
    inventory: (family: CliInstallationFamily) =>
      fetchJSON<CliInstallationInventory>(
        `/settings/cli-installations/${family}`,
      ),
    select: (family: CliInstallationFamily, path: string | null) =>
      fetchJSON<CliInstallationInventory & { error?: string }>(
        `/settings/cli-installations/${family}`,
        { method: "PUT", body: JSON.stringify({ path }) },
      ),
    test: (family: CliInstallationFamily) =>
      fetchJSON<CliInstallationInventory & { error?: string }>(
        `/settings/cli-installations/${family}/test`,
        { method: "POST" },
      ),
  };
}
