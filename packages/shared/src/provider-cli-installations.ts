/** Installation choices belong to the target server, shared by provider aliases. */
export type CliInstallationFamily = "codex" | "antigravity";
export type CliInstallationSelections = Partial<
  Record<CliInstallationFamily, string>
>;
export type CliVerificationState =
  | "unverified"
  | "verified"
  | "failed"
  | "unsupported";

export interface CliLaunchDescriptor {
  command: string;
  args: string[];
}

export interface CliInstallationCandidate {
  path: string;
  launch: CliLaunchDescriptor;
  source: string;
  version?: string;
  error?: string;
  selected: boolean;
  verification: CliVerificationState;
  verifiedAt?: number;
  /** Kept separate from account authentication and actual model access. */
  verificationError?: string;
}

export interface CliInstallationInventory {
  family: CliInstallationFamily;
  selection: string | null;
  managed: boolean;
  candidates: CliInstallationCandidate[];
}
