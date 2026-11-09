/** What owns the server's detected Codex executable. */
export type CodexInstallSource =
  | "npm"
  | "standalone"
  | "homebrew"
  | "cargo"
  | "desktop-app"
  | "unknown";

/** Status from the server's Codex CLI update checker */
export interface CodexUpdateStatus {
  installed: string | null;
  installedPath: string | null;
  installedPackage: string | null;
  /** Absent on servers that predate install-source reporting. */
  installSource?: CodexInstallSource;
  /** Any value but "manual" is an update the server can run itself. */
  updateMethod: "npm" | "standalone" | "manual";
  manualInstallCommand: string | null;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  /** Oldest supported release; absent on older servers, null if none. */
  minimumSupported?: string | null;
  /** Installed CLI is below `minimumSupported`; absent on older servers. */
  belowMinimum?: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}

export function canServerUpdateCodex(status: CodexUpdateStatus): boolean {
  return status.updateMethod === "npm" || status.updateMethod === "standalone";
}
